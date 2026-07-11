import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiConfigService } from '@plaudern/ai-config';
import type { SpeakerTranscriptDto } from '@plaudern/contracts';
import { InboxService } from '@plaudern/inbox';
import {
  ExtractedPayloadEntity,
  SpeakerOccurrenceEntity,
  VoiceProfileEntity,
} from '@plaudern/persistence';
import { PyannoteAiClient } from './providers/pyannoteai-client';
import { SpeakerTranscriptService } from './speaker-transcript.service';
import { VoiceprintMatcherService } from './voiceprint-matcher.service';

/**
 * Manual correction for a mis-matched speaker: pyannoteAI's /identify can fold a
 * genuinely new voice onto an existing profile when its confidence clears the
 * match threshold. `reassign` detaches one such speaker (a diarization label in
 * one recording) into a fresh voice profile and re-enrolls a voiceprint for them
 * from this recording's audio, so the same voice stops matching the wrong person
 * on the next recording. The inverse of VoiceProfilesService.merge.
 */
@Injectable()
export class SpeakerReassignmentService {
  private readonly logger = new Logger(SpeakerReassignmentService.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly aiConfig: AiConfigService,
    private readonly matcher: VoiceprintMatcherService,
    private readonly transcripts: SpeakerTranscriptService,
    @InjectRepository(VoiceProfileEntity)
    private readonly profiles: Repository<VoiceProfileEntity>,
    @InjectRepository(SpeakerOccurrenceEntity)
    private readonly occurrences: Repository<SpeakerOccurrenceEntity>,
  ) {}

  async reassign(
    userId: string,
    inboxItemId: string,
    label: string,
  ): Promise<SpeakerTranscriptDto> {
    const item = await this.inbox.getItem(userId, inboxItemId);
    const diarization = latestSucceededDiarization(item.extractions ?? []);
    if (!diarization) {
      throw new BadRequestException('this recording has no completed diarization to correct');
    }

    const occurrence = await this.occurrences.findOne({
      where: { extractionId: diarization.id, label },
    });
    if (!occurrence) {
      throw new NotFoundException(`no speaker "${label}" in this recording`);
    }

    // A fresh, unnamed profile for the split-off voice; re-point the occurrence
    // and drop its match score — this link is a user correction, not a match.
    const profile = await this.profiles.save(
      this.profiles.create({ userId, name: null, status: 'unconfirmed', voiceprint: null }),
    );
    occurrence.voiceProfileId = profile.id;
    occurrence.similarity = null;
    await this.occurrences.save(occurrence);

    await this.enrollBestEffort(userId, profile, item.source?.storageKey, diarization, label);

    return this.transcripts.getSpeakerTranscript(userId, inboxItemId);
  }

  /**
   * Give the new profile its own voiceprint from this recording so future
   * recordings identify the split-off voice as this person, not the one it was
   * wrongly matched to. Best-effort: any failure (no audio, too brief, provider
   * error) just leaves the profile without a voiceprint.
   */
  private async enrollBestEffort(
    userId: string,
    profile: VoiceProfileEntity,
    storageKey: string | undefined,
    diarization: ExtractedPayloadEntity,
    label: string,
  ): Promise<void> {
    if (!storageKey) return;
    const segments = (diarization.segments ?? [])
      .filter((s) => s.speaker === label)
      .map((s) => ({ start: s.start, end: s.end }));
    if (segments.length === 0) return;

    const cfg = await this.aiConfig.resolve(userId, 'speaker_id');
    if (!cfg) return;
    const client = PyannoteAiClient.fromResolvedConfig(cfg);
    try {
      const voiceprint = await this.matcher.enrollVoiceprintForLabel(
        storageKey,
        label,
        segments,
        client,
        cfg,
      );
      if (voiceprint) {
        profile.voiceprint = voiceprint;
        await this.profiles.save(profile);
      }
    } catch (err) {
      this.logger.warn(
        `re-enrollment after split failed for profile ${profile.id}: ${(err as Error).message}`,
      );
    }
  }
}

/** Latest succeeded diarization extraction, newest first — mirrors the read model. */
function latestSucceededDiarization(
  extractions: ExtractedPayloadEntity[],
): ExtractedPayloadEntity | undefined {
  return extractions
    .filter((e) => e.kind === 'diarization' && e.status === 'succeeded')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}
