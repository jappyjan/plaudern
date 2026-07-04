import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import webpush from 'web-push';

/** A web-push delivery target (one browser/device subscription). */
export interface WebPushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Low-level web-push transport — the seam tests replace with a fake. Keeps the
 * VAPID/encryption specifics out of the channel and engine so those stay
 * deterministic and infra-free under test.
 */
export interface WebPushSender {
  isConfigured(): boolean;
  /** The VAPID public key browsers need to `PushManager.subscribe()`. */
  getPublicKey(): string | null;
  /** Deliver an (already-serialized) payload; throws on transport failure. */
  send(target: WebPushTarget, payload: string): Promise<void>;
}

export const WEB_PUSH_SENDER = Symbol('WEB_PUSH_SENDER');

/**
 * Thrown when a push service reports the subscription is gone (HTTP 404/410),
 * so the channel can prune the dead subscription instead of retrying it.
 */
export class PushSubscriptionGoneError extends Error {
  constructor(readonly endpoint: string) {
    super(`push subscription gone: ${endpoint}`);
    this.name = 'PushSubscriptionGoneError';
  }
}

/**
 * Real VAPID web-push sender. Configured via `VAPID_PUBLIC_KEY` /
 * `VAPID_PRIVATE_KEY` (generate with `npx web-push generate-vapid-keys`); when
 * either is missing the channel reports itself unconfigured and the engine
 * skips it — mirroring how summarization stays disabled without an API key.
 */
@Injectable()
export class VapidWebPushSender implements WebPushSender {
  private readonly logger = new Logger(VapidWebPushSender.name);
  private readonly publicKey: string;
  private readonly privateKey: string;
  private readonly configured: boolean;

  constructor(config: ConfigService) {
    this.publicKey = config.get<string>('VAPID_PUBLIC_KEY', '');
    this.privateKey = config.get<string>('VAPID_PRIVATE_KEY', '');
    const subject = config.get<string>('VAPID_SUBJECT', 'mailto:admin@plaudern.local');
    this.configured = Boolean(this.publicKey && this.privateKey);
    if (this.configured) {
      webpush.setVapidDetails(subject, this.publicKey, this.privateKey);
      this.logger.log('web push configured (VAPID keys present)');
    }
  }

  isConfigured(): boolean {
    return this.configured;
  }

  getPublicKey(): string | null {
    return this.publicKey || null;
  }

  async send(target: WebPushTarget, payload: string): Promise<void> {
    if (!this.configured) throw new Error('web push not configured');
    try {
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: target.keys },
        payload,
      );
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        throw new PushSubscriptionGoneError(target.endpoint);
      }
      throw err;
    }
  }
}
