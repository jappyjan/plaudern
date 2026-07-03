import { BadRequestException, Body, Controller, Get, Logger, Post, Put } from '@nestjs/common';
import {
  plaudTestConnectionRequestSchema,
  updatePlaudSettingsRequestSchema,
  type PlaudSettingsDto,
  type PlaudSyncNowResponse,
  type PlaudTestConnectionResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { PlaudApiClient } from './plaud-api.client';
import { PlaudSettingsService } from './plaud-settings.service';
import { PlaudSyncService } from './plaud-sync.service';

@Controller({ path: 'settings/plaud', version: '1' })
export class SettingsController {
  private readonly logger = new Logger(SettingsController.name);

  constructor(
    private readonly settings: PlaudSettingsService,
    private readonly sync: PlaudSyncService,
    private readonly client: PlaudApiClient,
  ) {}

  @Get()
  async get(@CurrentUser() user: AuthenticatedUser): Promise<PlaudSettingsDto> {
    return this.settings.toDto(await this.settings.getEntity(user.id), this.sync.isRunning);
  }

  @Put()
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<PlaudSettingsDto> {
    const req = updatePlaudSettingsRequestSchema.parse(body);
    const entity = await this.settings.upsert(user.id, req);
    if (entity.enabled) {
      // Fire-and-forget so saving feels instant; progress is visible via GET.
      void this.sync
        .syncNow(user.id)
        .catch((err: unknown) =>
          this.logger.error(
            `post-save plaud sync failed: ${err instanceof Error ? err.message : err}`,
          ),
        );
    }
    return this.settings.toDto(entity, this.sync.isRunning);
  }

  @Post('test')
  async test(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<PlaudTestConnectionResponse> {
    const req = plaudTestConnectionRequestSchema.parse(body ?? {});
    try {
      const stored = await this.settings.getEntity(user.id);
      const email = req.email ?? stored?.email;
      const region = req.region ?? stored?.region;
      const password =
        req.password ?? (stored ? this.settings.getDecryptedPassword(stored) : undefined);
      if (!email || !password || !region) {
        throw new BadRequestException('email, password and region are required (none stored yet)');
      }
      const { accessToken } = await this.client.login(region, email, password);
      await this.client.getMe(region, accessToken);
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  @Post('sync')
  async syncNow(@CurrentUser() user: AuthenticatedUser): Promise<PlaudSyncNowResponse> {
    const entity = await this.settings.getEntity(user.id);
    if (!entity) throw new BadRequestException('Plaud credentials are not configured');
    if (!entity.enabled) throw new BadRequestException('Plaud sync is disabled');
    // Fire-and-forget: a full sync can take minutes on the first run.
    const state = this.sync.isRunning
      ? { started: false, alreadyRunning: true }
      : { started: true, alreadyRunning: false };
    void this.sync
      .syncNow(user.id)
      .catch((err: unknown) =>
        this.logger.error(`manual plaud sync failed: ${err instanceof Error ? err.message : err}`),
      );
    return state;
  }
}
