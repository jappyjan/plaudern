import { z } from 'zod';

/**
 * Proactive-notification contracts — the shared seam for the notification
 * engine (ATT-661). One delivery abstraction backs every proactive feature
 * (briefings, nudges, drift alerts, digests); this file defines the channels,
 * categories, and per-user preference model they all speak.
 */

/** Delivery channels the engine can fan out to. `bot` is a stub until ATT-693. */
export const notificationChannelSchema = z.enum(['web_push', 'email', 'bot']);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

export const NOTIFICATION_CHANNEL_LABELS: Record<NotificationChannel, string> = {
  web_push: 'Web push',
  email: 'Email',
  bot: 'Messaging bot',
};

/**
 * Proactive categories. Each is independently opt-in/out per channel and has
 * its own frequency cap, so a chatty category can never drown out a rare one.
 * The blocking tickets (briefings, nudges, drift alerts, digests) each map to
 * one of these.
 */
export const notificationCategorySchema = z.enum([
  'morning_briefing',
  'evening_review',
  'pre_meeting_briefing',
  'commitment_nudge',
  'drift_alert',
  'weekly_digest',
  'dead_mans_switch',
]);
export type NotificationCategory = z.infer<typeof notificationCategorySchema>;

export const NOTIFICATION_CATEGORY_LABELS: Record<NotificationCategory, string> = {
  morning_briefing: 'Morning briefing',
  evening_review: 'Evening review',
  pre_meeting_briefing: 'Pre-meeting briefings',
  commitment_nudge: 'Commitment nudges',
  drift_alert: 'Relationship drift alerts',
  weekly_digest: 'Weekly digest',
  dead_mans_switch: 'Emergency-access switch',
};

export const NOTIFICATION_CATEGORY_DESCRIPTIONS: Record<NotificationCategory, string> = {
  morning_briefing: 'A short start-of-day rundown of what is on your plate.',
  evening_review: 'An end-of-day recap and a look at tomorrow.',
  pre_meeting_briefing: 'Context pulled together shortly before a meeting starts.',
  commitment_nudge: 'Reminders about promises you made or are owed.',
  drift_alert: 'A heads-up when you have not been in touch with someone in a while.',
  weekly_digest: 'A weekly summary email of everything that happened.',
  dead_mans_switch:
    'Alerts when your dead-man’s switch is about to release, or has released, emergency access to your archive.',
};

/** `HH:MM` 24-hour local time. */
export const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'expected HH:MM (24-hour)');
export type TimeOfDay = z.infer<typeof timeOfDaySchema>;

/**
 * Quiet hours during which no proactive notification is delivered. The window
 * may wrap past midnight (e.g. 22:00 → 07:00). Interpreted in the user's
 * `timezone`.
 */
export const quietHoursSchema = z.object({
  enabled: z.boolean(),
  start: timeOfDaySchema,
  end: timeOfDaySchema,
});
export type QuietHours = z.infer<typeof quietHoursSchema>;

/** Per-category preference: which channels are opted in + a daily frequency cap. */
export const notificationCategoryPreferenceSchema = z.object({
  category: notificationCategorySchema,
  /** Channels the user opted into for this category. Empty = category muted. */
  channels: z.array(notificationChannelSchema),
  /** Max deliveries per rolling 24h for this category; null = unlimited. */
  maxPerDay: z.number().int().min(0).nullable(),
});
export type NotificationCategoryPreference = z.infer<typeof notificationCategoryPreferenceSchema>;

/** Full per-user preferences as returned to the client (read model). */
export const notificationPreferencesSchema = z.object({
  /** IANA timezone the quiet-hours window is evaluated in. */
  timezone: z.string(),
  /** Delivery address for the email channel; null until the user sets one. */
  emailAddress: z.string().nullable(),
  quietHours: quietHoursSchema,
  categories: z.array(notificationCategoryPreferenceSchema),
  /** Server-side capability: which channels are actually configured & usable. */
  channelStatus: z.object({
    web_push: z.boolean(),
    email: z.boolean(),
    bot: z.boolean(),
  }),
  /** How many web-push subscriptions (devices) are currently registered. */
  pushSubscriptionCount: z.number().int().nonnegative(),
});
export type NotificationPreferencesDto = z.infer<typeof notificationPreferencesSchema>;

export const updateNotificationPreferencesRequestSchema = z
  .object({
    timezone: z.string().min(1),
    emailAddress: z.email().nullable(),
    quietHours: quietHoursSchema,
    categories: z.array(notificationCategoryPreferenceSchema),
  })
  .partial();
export type UpdateNotificationPreferencesRequest = z.infer<
  typeof updateNotificationPreferencesRequestSchema
>;

/** A W3C Push API subscription, as produced by `PushManager.subscribe()`. */
export const pushSubscriptionSchema = z.object({
  endpoint: z.url(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
export type PushSubscriptionDto = z.infer<typeof pushSubscriptionSchema>;

export const registerPushSubscriptionRequestSchema = pushSubscriptionSchema;
export type RegisterPushSubscriptionRequest = z.infer<
  typeof registerPushSubscriptionRequestSchema
>;

export const unregisterPushSubscriptionRequestSchema = z.object({ endpoint: z.url() });
export type UnregisterPushSubscriptionRequest = z.infer<
  typeof unregisterPushSubscriptionRequestSchema
>;

/** The VAPID public key the browser needs to subscribe to web push. */
export const vapidPublicKeyResponseSchema = z.object({
  publicKey: z.string().nullable(),
  configured: z.boolean(),
});
export type VapidPublicKeyResponse = z.infer<typeof vapidPublicKeyResponseSchema>;

export const sendTestNotificationRequestSchema = z.object({
  category: notificationCategorySchema.optional(),
  channels: z.array(notificationChannelSchema).optional(),
  title: z.string().max(200).optional(),
  body: z.string().max(1000).optional(),
});
export type SendTestNotificationRequest = z.infer<typeof sendTestNotificationRequestSchema>;

/** Per-channel outcome of a single dispatch. */
export const channelDeliveryStatusSchema = z.enum([
  'sent',
  'failed',
  'not_configured',
  'no_target',
  'opted_out',
]);
export type ChannelDeliveryStatus = z.infer<typeof channelDeliveryStatusSchema>;

export const channelDeliveryResultSchema = z.object({
  channel: notificationChannelSchema,
  status: channelDeliveryStatusSchema,
  detail: z.string().nullable(),
});
export type ChannelDeliveryResult = z.infer<typeof channelDeliveryResultSchema>;

/** Overall result of a `notify()` call. */
export const notificationDispatchOutcomeSchema = z.enum([
  'sent',
  'suppressed_quiet_hours',
  'frequency_capped',
  'no_channels',
  'failed',
]);
export type NotificationDispatchOutcome = z.infer<typeof notificationDispatchOutcomeSchema>;

export const notificationDispatchResultSchema = z.object({
  category: notificationCategorySchema,
  outcome: notificationDispatchOutcomeSchema,
  channels: z.array(channelDeliveryResultSchema),
  /** When suppressed by quiet hours, the ISO time the window ends (retry hint). */
  retryAfter: z.string().nullable(),
});
export type NotificationDispatchResult = z.infer<typeof notificationDispatchResultSchema>;

/** Sensible defaults for a brand-new user (nothing is spammy out of the box). */
export const DEFAULT_TIMEZONE = 'UTC';
export const DEFAULT_QUIET_HOURS: QuietHours = { enabled: true, start: '22:00', end: '07:00' };

export const DEFAULT_CATEGORY_PREFERENCES: Record<
  NotificationCategory,
  { channels: NotificationChannel[]; maxPerDay: number | null }
> = {
  morning_briefing: { channels: ['web_push'], maxPerDay: 1 },
  evening_review: { channels: ['web_push'], maxPerDay: 1 },
  pre_meeting_briefing: { channels: ['web_push'], maxPerDay: 10 },
  commitment_nudge: { channels: ['web_push'], maxPerDay: 5 },
  drift_alert: { channels: ['email'], maxPerDay: 2 },
  weekly_digest: { channels: ['email'], maxPerDay: 1 },
  // Safety-critical and rare: reach the owner on every channel, never capped.
  dead_mans_switch: { channels: ['web_push', 'email'], maxPerDay: null },
};

/** The default per-category preference array, in stable category order. */
export function defaultNotificationCategoryPreferences(): NotificationCategoryPreference[] {
  return notificationCategorySchema.options.map((category) => ({
    category,
    channels: [...DEFAULT_CATEGORY_PREFERENCES[category].channels],
    maxPerDay: DEFAULT_CATEGORY_PREFERENCES[category].maxPerDay,
  }));
}
