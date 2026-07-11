import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import {
  mergeVoiceProfilesRequestSchema,
  updateConsentSettingsRequestSchema,
  updateVoiceProfileRequestSchema,
  type ConsentSettingsDto,
  type InboxItemDto,
  type SpeakerTranscriptDto,
  type VoiceProfileDetailDto,
  type VoiceProfileListResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { InboxService, toInboxItemDto } from '@plaudern/inbox';
import { ConsentSettingsService } from './consent-settings.service';
import { SpeakerIdService } from './speaker-id.service';
import { SpeakerReassignmentService } from './speaker-reassignment.service';
import { SpeakerTranscriptService } from './speaker-transcript.service';
import { VoiceProfilesService } from './voice-profiles.service';

/** Contact book: voice profiles and the recordings each voice appears in. */
@Controller({ path: 'speakers', version: '1' })
export class SpeakersController {
  constructor(private readonly profiles: VoiceProfilesService) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser): Promise<VoiceProfileListResponse> {
    return { profiles: await this.profiles.list(user.id) };
  }

  @Get(':id')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<VoiceProfileDetailDto> {
    return this.profiles.detail(user.id, id);
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<VoiceProfileDetailDto> {
    const req = updateVoiceProfileRequestSchema.parse(body);
    return this.profiles.update(user.id, id, req);
  }

  @Post(':id/merge')
  async merge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<VoiceProfileDetailDto> {
    const req = mergeVoiceProfilesRequestSchema.parse(body);
    return this.profiles.merge(user.id, id, req.sourceProfileId);
  }
}

/**
 * Speaker-attributed transcript read model. Lives here (not in the inbox lib)
 * so the immutable inbox aggregate stays untouched; Nest happily mounts a
 * second controller on the same base path.
 */
@Controller({ path: 'inbox', version: '1' })
export class SpeakerTranscriptController {
  constructor(
    private readonly transcripts: SpeakerTranscriptService,
    private readonly speakerId: SpeakerIdService,
    private readonly inbox: InboxService,
    private readonly reassignment: SpeakerReassignmentService,
  ) {}

  @Get(':id/speaker-transcript')
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<SpeakerTranscriptDto> {
    return this.transcripts.getSpeakerTranscript(user.id, id);
  }

  /**
   * Detach a mis-matched speaker (diarization `label`) in this recording into a
   * fresh voice profile and re-enroll their voiceprint — the "Not X?" correction
   * for when a new voice was wrongly folded onto an existing person.
   */
  @Post(':id/speakers/:label/split')
  async split(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('label') label: string,
  ): Promise<SpeakerTranscriptDto> {
    return this.reassignment.reassign(user.id, id, label);
  }

  /** Re-run speaker diarization only; the transcript merge and summary follow. */
  @Post(':id/diarization/retry')
  async retryDiarization(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<InboxItemDto> {
    await this.speakerId.retryDiarization(user.id, id);
    return toInboxItemDto(await this.inbox.getItem(user.id, id));
  }
}

/** Per-user consent-guardian policy (§ 201 StGB, ATT-663). */
@Controller({ path: 'settings/consent', version: '1' })
export class ConsentSettingsController {
  constructor(private readonly settings: ConsentSettingsService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<ConsentSettingsDto> {
    return this.settings.getDto(user.id);
  }

  @Put()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<ConsentSettingsDto> {
    // No global ZodError filter exists, so a raw .parse() would surface as 500.
    const parsed = updateConsentSettingsRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid settings');
    }
    return this.settings.upsert(user.id, parsed.data);
  }
}
