import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  mergeVoiceProfilesRequestSchema,
  updateVoiceProfileRequestSchema,
  type SpeakerTranscriptDto,
  type VoiceProfileDetailDto,
  type VoiceProfileListResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
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
  constructor(private readonly transcripts: SpeakerTranscriptService) {}

  @Get(':id/speaker-transcript')
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<SpeakerTranscriptDto> {
    return this.transcripts.getSpeakerTranscript(user.id, id);
  }
}
