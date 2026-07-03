import { z } from 'zod';
import { sourceTypeSchema } from './source-type';

/** Calendar providers. `ics` = read-only iCal feed URL; more (google, …) later. */
export const calendarProviderTypeSchema = z.enum(['ics']);
export type CalendarProviderType = z.infer<typeof calendarProviderTypeSchema>;

export const calendarSyncStatusSchema = z.enum(['ok', 'error']);
export type CalendarSyncStatus = z.infer<typeof calendarSyncStatusSchema>;

/** Who created a recording↔event link. Manual links are never touched by sync. */
export const linkOriginSchema = z.enum(['auto', 'manual']);
export type LinkOrigin = z.infer<typeof linkOriginSchema>;

/** Feed URLs are secrets (they grant read access) — DTOs only carry a mask. */
export const calendarFeedSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  providerType: calendarProviderTypeSchema,
  enabled: z.boolean(),
  /** When false, recordings are never auto-linked to this feed's events. */
  autoLink: z.boolean(),
  color: z.string().nullable(),
  urlMasked: z.string(),
  lastSyncAt: z.string().nullable(),
  lastSyncStatus: calendarSyncStatusSchema.nullable(),
  lastSyncError: z.string().nullable(),
  lastSyncEventCount: z.number().int().nullable(),
});
export type CalendarFeedDto = z.infer<typeof calendarFeedSchema>;

/** http(s) or webcal (normalized to https server-side). */
const feedUrlSchema = z
  .string()
  .url()
  .refine((url) => /^(https?|webcal):\/\//i.test(url), {
    message: 'feed url must use http(s) or webcal',
  });

export const createCalendarFeedRequestSchema = z.object({
  name: z.string().min(1),
  url: feedUrlSchema,
  color: z.string().max(32).optional(),
  enabled: z.boolean().default(true),
  /** Omitted => off (the entity default); auto-linking is opt-in per feed. */
  autoLink: z.boolean().optional(),
});
export type CreateCalendarFeedRequest = z.infer<typeof createCalendarFeedRequestSchema>;

export const updateCalendarFeedRequestSchema = z.object({
  name: z.string().min(1).optional(),
  /** Omitted => keep the stored URL. */
  url: feedUrlSchema.optional(),
  color: z.string().max(32).nullable().optional(),
  enabled: z.boolean().optional(),
  autoLink: z.boolean().optional(),
});
export type UpdateCalendarFeedRequest = z.infer<typeof updateCalendarFeedRequestSchema>;

export const calendarFeedsResponseSchema = z.object({
  feeds: z.array(calendarFeedSchema),
  syncRunning: z.boolean(),
});
export type CalendarFeedsResponse = z.infer<typeof calendarFeedsResponseSchema>;

export const calendarFeedTestRequestSchema = z.object({
  url: feedUrlSchema,
});
export type CalendarFeedTestRequest = z.infer<typeof calendarFeedTestRequestSchema>;

export const calendarFeedTestResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  eventCount: z.number().int().nullable(),
  calendarName: z.string().nullable(),
});
export type CalendarFeedTestResponse = z.infer<typeof calendarFeedTestResponseSchema>;

export const calendarSyncNowResponseSchema = z.object({
  started: z.boolean(),
  alreadyRunning: z.boolean(),
});
export type CalendarSyncNowResponse = z.infer<typeof calendarSyncNowResponseSchema>;

export const calendarEventSchema = z.object({
  id: z.string().uuid(),
  feedId: z.string().uuid(),
  feedName: z.string(),
  feedColor: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  /** ISO 8601 UTC. All-day events are stored as UTC calendar-date midnights. */
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  isAllDay: z.boolean(),
  /** Active links only — suppressed tombstones are invisible to clients. */
  linkedRecordingIds: z.array(z.string().uuid()),
});
export type CalendarEventDto = z.infer<typeof calendarEventSchema>;

/** Range query for the month grid; capped so a bad client can't scan years. */
export const calendarRangeQuerySchema = z
  .object({
    from: z.string().datetime(),
    to: z.string().datetime(),
  })
  .refine((range) => new Date(range.to).getTime() > new Date(range.from).getTime(), {
    message: 'to must be after from',
  })
  .refine(
    (range) =>
      new Date(range.to).getTime() - new Date(range.from).getTime() <=
      400 * 24 * 60 * 60 * 1000,
    { message: 'range must be at most 400 days' },
  );
export type CalendarRangeQuery = z.infer<typeof calendarRangeQuerySchema>;

export const calendarEventsResponseSchema = z.object({
  events: z.array(calendarEventSchema),
});
export type CalendarEventsResponse = z.infer<typeof calendarEventsResponseSchema>;

/** Slim inbox projection for calendar views — full detail stays on /v1/inbox. */
export const recordingSummarySchema = z.object({
  id: z.string().uuid(),
  sourceType: sourceTypeSchema,
  occurredAt: z.string().datetime(),
  durationMs: z.number().int().nullable(),
  originalFilename: z.string().nullable(),
  linkedEventIds: z.array(z.string().uuid()),
});
export type RecordingSummaryDto = z.infer<typeof recordingSummarySchema>;

export const calendarRecordingsResponseSchema = z.object({
  recordings: z.array(recordingSummarySchema),
});
export type CalendarRecordingsResponse = z.infer<typeof calendarRecordingsResponseSchema>;

export const calendarEventDetailSchema = calendarEventSchema.extend({
  recordings: z.array(recordingSummarySchema),
});
export type CalendarEventDetailDto = z.infer<typeof calendarEventDetailSchema>;

export const itemEventsResponseSchema = z.object({
  events: z.array(calendarEventSchema),
});
export type ItemEventsResponse = z.infer<typeof itemEventsResponseSchema>;

export const createLinkRequestSchema = z.object({
  inboxItemId: z.string().uuid(),
  eventId: z.string().uuid(),
});
export type CreateLinkRequest = z.infer<typeof createLinkRequestSchema>;

export const linkResponseSchema = z.object({
  inboxItemId: z.string().uuid(),
  eventId: z.string().uuid(),
  origin: linkOriginSchema,
});
export type LinkResponse = z.infer<typeof linkResponseSchema>;
