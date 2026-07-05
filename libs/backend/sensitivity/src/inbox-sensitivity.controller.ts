import { BadRequestException, Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { setSensitivityOverrideSchema, type ItemSensitivityDto } from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { SentinelService } from './sentinel.service';

/**
 * An item's sensitivity read model + the user's manual tier override (JJ-21).
 * Mounted on /inbox/:id for symmetry with the other per-item extraction routes;
 * lives in this module so the inbox lib stays free of any sensitivity
 * dependency.
 */
@Controller({ path: 'inbox', version: '1' })
export class InboxSensitivityController {
  constructor(private readonly sentinel: SentinelService) {}

  @Get(':id/sensitivity')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ItemSensitivityDto> {
    return this.sentinel.getItemSensitivity(user.id, id);
  }

  @Patch(':id/sensitivity')
  setOverride(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ItemSensitivityDto> {
    const parsed = setSensitivityOverrideSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid tier');
    }
    return this.sentinel.setManualTier(user.id, id, parsed.data.manualTier);
  }
}
