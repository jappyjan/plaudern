import { BadRequestException, Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import {
  aiCapabilityKindSchema,
  aiCapabilitySchema,
  updateAiCapabilityGroupRequestSchema,
  updateAiCapabilityRequestSchema,
  type AiCapabilitiesResponseDto,
  type AiCapabilityGroupDto,
  type AiCapabilityGroupsResponseDto,
  type AiCapabilitySettingDto,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { AiCapabilityService } from './ai-capability.service';

/**
 * The signed-in user's AI capability configuration.
 *
 * The simplified, kind-level *groups* (Reasoning/Chat, Vision, …) are the
 * primary surface: `GET capability-groups`, `PUT capability-groups/:kind`, and
 * `DELETE capability-groups/:kind/overrides` (reset). The per-capability
 * endpoints back the Advanced per-task overrides.
 */
@Controller({ path: 'settings/ai', version: '1' })
export class AiCapabilityController {
  constructor(private readonly capabilities: AiCapabilityService) {}

  @Get('capability-groups')
  getGroups(@CurrentUser() user: AuthenticatedUser): Promise<AiCapabilityGroupsResponseDto> {
    return this.capabilities.getGroups(user.id);
  }

  @Put('capability-groups/:kind')
  updateGroup(
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind') kind: string,
    @Body() body: unknown,
  ): Promise<AiCapabilityGroupDto> {
    const kindParsed = aiCapabilityKindSchema.safeParse(kind);
    if (!kindParsed.success) {
      throw new BadRequestException(`unknown capability kind '${kind}'`);
    }
    const parsed = updateAiCapabilityGroupRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid group setting');
    }
    return this.capabilities.updateGroup(user.id, kindParsed.data, parsed.data);
  }

  @Delete('capability-groups/:kind/overrides')
  resetGroup(
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind') kind: string,
  ): Promise<AiCapabilityGroupDto> {
    const kindParsed = aiCapabilityKindSchema.safeParse(kind);
    if (!kindParsed.success) {
      throw new BadRequestException(`unknown capability kind '${kind}'`);
    }
    return this.capabilities.resetGroupOverrides(user.id, kindParsed.data);
  }

  @Get('capabilities')
  get(@CurrentUser() user: AuthenticatedUser): Promise<AiCapabilitiesResponseDto> {
    return this.capabilities.getResponse(user.id);
  }

  @Put('capabilities/:capability')
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
