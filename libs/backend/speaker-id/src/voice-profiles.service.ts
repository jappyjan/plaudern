import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  summaryPayloadSchema,
  type UpdateVoiceProfileRequest,
  type VoiceProfileDetailDto,
  type VoiceProfileDto,
} from '@plaudern/contracts';
import {
  ExtractedPayloadEntity,
  RecordingMergeEntity,
  SpeakerOccurrenceEntity,
  VoiceProfileEntity,
} from '@plaudern/persistence';
import { SummarizationService } from '@plaudern/summarization';

interface OccurrenceWithItem extends SpeakerOccurrenceEntity {
  occurredAt: string;
}

/**
 * Contact book: CRUD over voice profiles plus per-profile recording lists.
 * Aggregates only count occurrences from each item's LATEST succeeded
 * diarization extraction, so append-only reprocessing supersedes old links.
 */
@Injectable()
export class VoiceProfilesService {
  constructor(
    @InjectRepository(VoiceProfileEntity)
    private readonly profiles: Repository<VoiceProfileEntity>,
    @InjectRepository(SpeakerOccurrenceEntity)
    private readonly occurrences: Repository<SpeakerOccurrenceEntity>,
    @InjectRepository(ExtractedPayloadEntity)
    private readonly extractions: Repository<ExtractedPayloadEntity>,
    @InjectRepository(RecordingMergeEntity)
    private readonly merges: Repository<RecordingMergeEntity>,
    private readonly summarization: SummarizationService,
  ) {}

  async list(userId: string): Promise<VoiceProfileDto[]> {
    const profiles = await this.profiles.find({ where: { userId } });
    if (profiles.length === 0) return [];
    const byProfile = await this.currentOccurrences(profiles.map((p) => p.id));
    return profiles
      .map((profile) => this.toDto(profile, byProfile.get(profile.id) ?? []))
      .sort((a, b) => (b.lastHeardAt ?? '').localeCompare(a.lastHeardAt ?? ''));
  }

  async detail(userId: string, id: string): Promise<VoiceProfileDetailDto> {
    const profile = await this.getOwned(userId, id);
    const occurrences = (await this.currentOccurrences([id])).get(id) ?? [];
    const titleByItem = await this.summaryTitles([
      ...new Set(occurrences.map((occ) => occ.inboxItemId)),
    ]);
    return {
      ...this.toDto(profile, occurrences),
      recordings: occurrences
        .slice()
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
        .map((occ) => ({
          inboxItemId: occ.inboxItemId,
          occurredAt: occ.occurredAt,
          title: titleByItem.get(occ.inboxItemId) ?? null,
          label: occ.label,
          speakingSeconds: occ.speakingSeconds,
          similarity: occ.similarity,
        })),
    };
  }

  async update(
    userId: string,
    id: string,
    req: UpdateVoiceProfileRequest,
  ): Promise<VoiceProfileDetailDto> {
    const profile = await this.getOwned(userId, id);
    if (req.name !== undefined) {
      profile.name = req.name;
      // Giving a voice a name is the strongest confirmation there is.
      profile.status = 'confirmed';
    }
    if (req.status === 'confirmed') profile.status = 'confirmed';
    if (req.consentStatus !== undefined) profile.consentStatus = req.consentStatus;

    const redactionChanged = req.redacted !== undefined && req.redacted !== profile.redacted;
    if (req.redacted !== undefined) profile.redacted = req.redacted;

    await this.profiles.save(profile);

    // Redaction affects every summary this speaker appears in. The transcript
    // read model recomputes at read time, but stored summaries do not — so
    // regenerate them (best-effort) whenever redaction is toggled.
    if (redactionChanged) {
      const itemIds = await this.itemIdsForProfile(id);
      await this.summarization.regenerateForItems(itemIds);
    }

    return this.detail(userId, id);
  }

  /** Distinct inbox items whose latest diarization currently links this profile. */
  private async itemIdsForProfile(profileId: string): Promise<string[]> {
    const occurrences = (await this.currentOccurrences([profileId])).get(profileId) ?? [];
    return [...new Set(occurrences.map((o) => o.inboxItemId))];
  }

  /** Merge `sourceId` into `targetId` (occurrences re-linked, source deleted). */
  async merge(userId: string, targetId: string, sourceId: string): Promise<VoiceProfileDetailDto> {
    if (targetId === sourceId) {
      throw new BadRequestException('cannot merge a profile into itself');
    }
    const target = await this.getOwned(userId, targetId);
    const source = await this.getOwned(userId, sourceId);

    await this.profiles.manager.transaction(async (manager) => {
      await manager.update(
        SpeakerOccurrenceEntity,
        { voiceProfileId: source.id },
        { voiceProfileId: target.id },
      );
      // Keep the merged person auto-matchable: adopt the source's voiceprint
      // when the target has none.
      if (!target.voiceprint && source.voiceprint) target.voiceprint = source.voiceprint;
      if (!target.name && source.name) target.name = source.name;
      // Consent is a safety property: the merged person inherits the stricter
      // of the two states so a merge never silently un-redacts a declined voice.
      if (source.redacted) target.redacted = true;
      if (source.consentStatus === 'declined' || target.consentStatus === 'declined') {
        target.consentStatus = 'declined';
      } else if (target.consentStatus === 'unknown' && source.consentStatus === 'consented') {
        target.consentStatus = 'consented';
      }
      await manager.save(target);
      await manager.delete(VoiceProfileEntity, { id: source.id });
    });
    return this.detail(userId, targetId);
  }

  private async getOwned(userId: string, id: string): Promise<VoiceProfileEntity> {
    const profile = await this.profiles.findOne({ where: { id, userId } });
    if (!profile) throw new NotFoundException('voice profile not found');
    return profile;
  }

  private toDto(profile: VoiceProfileEntity, occurrences: OccurrenceWithItem[]): VoiceProfileDto {
    const itemIds = new Set(occurrences.map((o) => o.inboxItemId));
    const lastHeardAt = occurrences.reduce<string | null>(
      (max, o) => (max === null || o.occurredAt > max ? o.occurredAt : max),
      null,
    );
    return {
      id: profile.id,
      name: profile.name,
      status: profile.status,
      consentStatus: profile.consentStatus,
      redacted: profile.redacted,
      recordingCount: itemIds.size,
      totalSpeakingSeconds: occurrences.reduce((sum, o) => sum + o.speakingSeconds, 0),
      lastHeardAt,
      createdAt: profile.createdAt.toISOString(),
    };
  }

  /**
   * Occurrences per profile, restricted to each inbox item's latest succeeded
   * diarization extraction and enriched with the item's occurredAt. Recordings
   * hidden inside a merged recording are excluded — the merged item carries its
   * own stitched diarization, so the contact still shows the merged recording
   * (and reappears with the sources the moment the merge is split).
   */
  private async currentOccurrences(
    profileIds: string[],
  ): Promise<Map<string, OccurrenceWithItem[]>> {
    const rows = await this.occurrences.find({
      where: { voiceProfileId: In(profileIds) },
      relations: { inboxItem: true },
    });
    const result = new Map<string, OccurrenceWithItem[]>();
    if (rows.length === 0) return result;

    const itemIds = [...new Set(rows.map((r) => r.inboxItemId))];
    const hidden = new Set(
      (
        await this.merges.find({ select: { sourceItemId: true }, where: { sourceItemId: In(itemIds) } })
      ).map((link) => link.sourceItemId),
    );
    const extractionRows = await this.extractions.find({
      where: { inboxItemId: In(itemIds), kind: 'diarization', status: 'succeeded' },
    });
    const latestByItem = new Map<string, ExtractedPayloadEntity>();
    for (const row of extractionRows) {
      const current = latestByItem.get(row.inboxItemId);
      if (!current || row.createdAt > current.createdAt) latestByItem.set(row.inboxItemId, row);
    }
    const latestExtractionIds = new Set([...latestByItem.values()].map((r) => r.id));

    for (const row of rows) {
      if (!latestExtractionIds.has(row.extractionId)) continue;
      if (hidden.has(row.inboxItemId)) continue;
      const list = result.get(row.voiceProfileId) ?? [];
      list.push(Object.assign(row, { occurredAt: row.inboxItem.occurredAt }));
      result.set(row.voiceProfileId, list);
    }
    return result;
  }

  /**
   * AI summary title per inbox item, taken from each item's latest succeeded
   * summary extraction. Items without a (parseable) summary are absent from
   * the map, so callers fall back to another label.
   */
  private async summaryTitles(itemIds: string[]): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    if (itemIds.length === 0) return titles;
    const rows = await this.extractions.find({
      where: { inboxItemId: In(itemIds), kind: 'summary', status: 'succeeded' },
    });
    const latestByItem = new Map<string, ExtractedPayloadEntity>();
    for (const row of rows) {
      const current = latestByItem.get(row.inboxItemId);
      if (!current || row.createdAt > current.createdAt) latestByItem.set(row.inboxItemId, row);
    }
    for (const [itemId, row] of latestByItem) {
      if (!row.content) continue;
      try {
        const parsed = summaryPayloadSchema.safeParse(JSON.parse(row.content));
        if (parsed.success && parsed.data.title) titles.set(itemId, parsed.data.title);
      } catch {
        // Non-JSON / malformed content — leave the item without a title.
      }
    }
    return titles;
  }
}
