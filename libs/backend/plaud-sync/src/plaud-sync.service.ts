import { Injectable, Logger } from '@nestjs/common';
import type { PlaudSyncNowResponse } from '@plaudern/contracts';
import { PlaudSettingsEntity } from '@plaudern/persistence';
import { InboxService } from '@plaudern/inbox';
import { IngestionService } from '@plaudern/ingestion';
import { PlaudApiClient, PlaudApiError, type PlaudRecording } from './plaud-api.client';
import { PlaudSettingsService } from './plaud-settings.service';

/** Re-login this long before the JWT's actual expiry. */
const TOKEN_REFRESH_BUFFER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Pulls new recordings from the Plaud cloud into the inbox, per user (each
 * user has their own Plaud credentials and their recordings land only in
 * their own inbox). Everything flows through the regular ingestion path
 * (`sourceType: 'plaud'`), so dedupe comes from the idempotency key and
 * transcription fires via the existing adapter. Recordings whose key is
 * tombstoned (deleted from the inbox by the user) are never re-imported.
 */
@Injectable()
export class PlaudSyncService {
  private readonly logger = new Logger(PlaudSyncService.name);
  /** In-process mutex; the app is single-instance by design. */
  private running = false;

  constructor(
    private readonly settings: PlaudSettingsService,
    private readonly client: PlaudApiClient,
    private readonly inbox: InboxService,
    private readonly ingestion: IngestionService,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Entry point for the interval (no userId: every user's enabled settings,
   * sequentially), the manual trigger and save-with-enabled (userId: just
   * that user).
   */
  async syncNow(userId?: string): Promise<PlaudSyncNowResponse> {
    if (this.running) return { started: false, alreadyRunning: true };
    // Claim the mutex synchronously with the check so concurrent callers
    // can't both pass it before the first await.
    this.running = true;
    try {
      const entities = userId
        ? [await this.settings.getEntity(userId)]
        : await this.settings.listEnabled();
      const enabled = entities.filter(
        (entity): entity is PlaudSettingsEntity => Boolean(entity?.enabled),
      );
      if (enabled.length === 0) return { started: false, alreadyRunning: false };
      for (const entity of enabled) {
        await this.runSync(entity);
      }
      return { started: true, alreadyRunning: false };
    } finally {
      this.running = false;
    }
  }

  private async runSync(entity: PlaudSettingsEntity): Promise<void> {
    let imported = 0;
    let failed = 0;
    let firstError: string | null = null;

    try {
      let token = await this.getToken(entity);

      let recordings: PlaudRecording[];
      try {
        recordings = await this.client.listRecordings(entity.region, token);
      } catch (err) {
        // Cached token may have been revoked server-side — re-login once.
        if (!(err instanceof PlaudApiError) || err.status !== 401) throw err;
        token = await this.refreshToken(entity);
        recordings = await this.client.listRecordings(entity.region, token);
      }

      const active = recordings.filter((rec) => !rec.isTrash);
      this.logger.log(`plaud sync: ${active.length} recordings listed`);

      // Sequential on purpose: bounds memory to one file and is kind to the API.
      for (const rec of active) {
        const idempotencyKey = `plaud:${rec.id}`;
        try {
          const existing = await this.inbox.findByIdempotencyKey(entity.userId, idempotencyKey);
          if (existing) continue;
          // The user deleted this recording from the inbox — never re-import
          // it. (A delete racing a mid-download sync can still recreate the
          // item once; sync is sequential and minutes-scale, so acceptable.)
          if (await this.inbox.isIdempotencyKeyTombstoned(entity.userId, idempotencyKey)) {
            continue;
          }

          const { body, contentType } = await this.client.downloadRecording(
            entity.region,
            token,
            rec.id,
          );
          await this.ingestion.ingestBlob(entity.userId, {
            sourceType: 'plaud',
            body,
            contentType,
            occurredAt: rec.startTime,
            idempotencyKey,
            originalFilename: rec.filename,
            metadata: {
              plaudFileId: rec.id,
              plaudFilename: rec.filename,
              durationMs: rec.duration,
              serialNumber: rec.serialNumber,
              importedVia: 'plaud-cloud-sync',
            },
          });
          imported += 1;
        } catch (err) {
          failed += 1;
          const message = err instanceof Error ? err.message : String(err);
          firstError ??= `recording ${rec.id} (${rec.filename}): ${message}`;
          this.logger.warn(`plaud sync: failed to import recording ${rec.id}: ${message}`);
        }
      }

      await this.settings.recordSyncResult(entity.id, {
        status: failed > 0 ? 'error' : 'ok',
        error:
          failed > 0 ? `${failed} of ${active.length} recordings failed — first: ${firstError}` : null,
        importedCount: imported,
      });
      this.logger.log(`plaud sync: done, ${imported} imported, ${failed} failed`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`plaud sync: aborted — ${message}`);
      await this.settings.recordSyncResult(entity.id, {
        status: 'error',
        error: message,
        importedCount: imported,
      });
    }
  }

  /** Cached token unless missing or within 30 days of expiry. */
  private async getToken(entity: PlaudSettingsEntity): Promise<string> {
    if (
      entity.accessToken &&
      entity.accessTokenExpiresAt &&
      new Date(entity.accessTokenExpiresAt).getTime() - Date.now() > TOKEN_REFRESH_BUFFER_MS
    ) {
      return entity.accessToken;
    }
    return this.refreshToken(entity);
  }

  private async refreshToken(entity: PlaudSettingsEntity): Promise<string> {
    const password = this.settings.getDecryptedPassword(entity);
    const { accessToken, expiresAt } = await this.client.login(
      entity.region,
      entity.email,
      password,
    );
    await this.settings.saveToken(entity.id, accessToken, expiresAt);
    entity.accessToken = accessToken;
    entity.accessTokenExpiresAt = expiresAt;
    return accessToken;
  }
}
