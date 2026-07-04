import type { NotificationCategory, NotificationChannel } from '@plaudern/contracts';

/**
 * Channel-agnostic content of a single notification. Every proactive feature
 * produces one of these and hands it to the engine, which fans it out to the
 * user's opted-in channels.
 */
export interface NotificationMessage {
  category: NotificationCategory;
  title: string;
  body: string;
  /** Deep link the client opens when the notification is activated. */
  url?: string;
  /** Arbitrary structured payload passed through to the client. */
  data?: Record<string, unknown>;
}

/** Per-user context the channels need to resolve a delivery target. */
export interface ChannelSendContext {
  userId: string;
  /** The user's email delivery address, when set (used by the email channel). */
  emailAddress: string | null;
}

/** Outcome of attempting delivery on one channel for one user. */
export type ChannelSendResult =
  | { status: 'sent'; detail?: string }
  | { status: 'not_configured'; detail?: string }
  | { status: 'no_target'; detail?: string }
  | { status: 'failed'; detail: string };

/**
 * A pluggable delivery channel. `isConfigured()` reports whether the server
 * has the credentials to use the channel at all (independent of any user);
 * `send()` attempts delivery for one user and never throws — transport errors
 * come back as a `failed` result so one dead channel can't abort a fan-out.
 */
export interface NotificationChannelHandler {
  readonly channel: NotificationChannel;
  isConfigured(): boolean;
  send(ctx: ChannelSendContext, message: NotificationMessage): Promise<ChannelSendResult>;
}

/** DI token for the array of registered channel handlers. */
export const NOTIFICATION_CHANNELS = Symbol('NOTIFICATION_CHANNELS');
