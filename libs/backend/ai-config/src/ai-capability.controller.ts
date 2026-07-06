import { BadRequestException, Body, Controller, Get, Param, Put } from '@nestjs/common';
import {
  aiCapabilitySchema,
  updateAiCapabilityRequestSchema,
  type AiCapabilitiesResponseDto,
  type AiCapabilitySettingDto,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { AiCapabilityService } from './ai-capability.service';

/**
 * The signed-in user's capability→provider assignments. GET returns the static
 * capability catalog plus the user's current settings; PUT :capability upserts
 * one assignment.
 */
@Controller({ path: 'settings/ai/capabilities', version: '1' })
export class AiCapabilityController {
  constructor(private readonly capabilities: AiCapabilityService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<AiCapabilitiesResponseDto> {
    return this.capabilities.getResponse(user.id);
  }

  @Put(':capability')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('capability') capability: string,
    @Body() body: unknown,
  ): Promise<AiCapabilitySettingDto> {
    const capabilityParsed = aiCapabilitySchema.safeParse(capability);
    if (!capabilityParsed.success) {
      throw new BadRequestException(`unknown capability '${capability}'`);
    }
    const parsed = updateAiCapabilityRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid capability setting');
    }
    return this.capabilities.upsert(user.id, capabilityParsed.data, parsed.data);
  }
}
