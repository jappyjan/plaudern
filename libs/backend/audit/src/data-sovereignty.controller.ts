import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  panicDeleteRequestSchema,
  updateDeadMansSwitchRequestSchema,
  type AccountExport,
  type DeadMansSwitchDto,
  type DeadMansSwitchReleaseDto,
  type DeadMansSwitchReleasesResponse,
  type PanicDeleteResponse,
} from '@plaudern/contracts';
import { CurrentUser, Public, type AuthenticatedUser } from '@plaudern/auth';
import { DataSovereigntyService } from './data-sovereignty.service';
import { DeadMansSwitchReleaseService } from './dead-mans-switch-release.service';

/**
 * Data-sovereignty controls for the signed-in user (JJ-42): export-everything,
 * panic-delete, and the dead-man's-switch scaffold. Every handler derives the
 * user id from the session (`@CurrentUser`), never the request body — these are
 * the most destructive endpoints in the app and must never be cross-user.
 */
@Controller({ path: 'account', version: '1' })
export class DataSovereigntyController {
  constructor(
    private readonly sovereignty: DataSovereigntyService,
    private readonly releases: DeadMansSwitchReleaseService,
  ) {}

  /**
   * Download the whole archive as one JSON bundle (items + extractions +
   * presigned assets + a combined Markdown rendering). Served as an attachment.
   */
  @Get('export')
  @Header('Content-Type', 'application/json; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="plaudern-export.json"')
  export(@CurrentUser() user: AuthenticatedUser): Promise<AccountExport> {
    return this.sovereignty.exportEverything(user.id);
  }

  /**
   * DANGER: irreversibly wipe the user's archive. Requires the exact
   * confirmation phrase in the body so it can't be triggered accidentally.
   */
  @Post('panic-delete')
  panicDelete(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<PanicDeleteResponse> {
    const parsed = panicDeleteRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        'panic-delete requires an explicit confirmation phrase',
      );
    }
    return this.sovereignty.panicDelete(user.id);
  }

  @Get('dead-mans-switch')
  getDeadMansSwitch(@CurrentUser() user: AuthenticatedUser): Promise<DeadMansSwitchDto> {
    return this.sovereignty.getDeadMansSwitch(user.id);
  }

  @Put('dead-mans-switch')
  updateDeadMansSwitch(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<DeadMansSwitchDto> {
    const parsed = updateDeadMansSwitchRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid request');
    }
    return this.sovereignty.updateDeadMansSwitch(user.id, parsed.data);
  }

  /**
   * Record that the owner is present. This also CANCELS any grace-window release
   * (JJ-80): a re-check-in before the grant fires must stop it. Composed here
   * rather than inside the service so neither service injects the other — the
   * check-in write and the release cancel stay one-directional and cycle-free.
   */
  @Post('dead-mans-switch/check-in')
  async checkIn(@CurrentUser() user: AuthenticatedUser): Promise<DeadMansSwitchDto> {
    const dto = await this.sovereignty.checkInDeadMansSwitch(user.id);
    await this.releases.cancelPendingReleases(user.id);
    return dto;
  }

  /** The owner's release history, so they can see and revoke granted access. */
  @Get('dead-mans-switch/releases')
  async listReleases(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeadMansSwitchReleasesResponse> {
    return { releases: await this.releases.listReleases(user.id) };
  }

  /** Owner revokes a granted (or still-pending) release. */
  @Post('dead-mans-switch/releases/:id/revoke')
  revokeRelease(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<DeadMansSwitchReleaseDto> {
    return this.releases.revokeRelease(user.id, id);
  }

  /**
   * Emergency access (JJ-80). PUBLIC by design: the trusted contact is not a user
   * of this instance, so they authenticate with the one-time capability token
   * emailed to them — nothing else. The token grants read-only access to exactly
   * one owner's export bundle and only while the grant is active (owner-revocable).
   */
  @Public()
  @Get('emergency-access/:token')
  @Header('Content-Type', 'application/json; charset=utf-8')
  async emergencyAccess(@Param('token') token: string): Promise<AccountExport> {
    const bundle = await this.releases.resolveEmergencyAccess(token);
    if (!bundle) throw new NotFoundException('invalid or revoked emergency-access token');
    return bundle;
  }
}
