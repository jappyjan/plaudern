/**
 * Sentinel owner of all rows created while the instance ran without
 * authentication (the app used to be single-user and unauthenticated). This
 * is NOT a real account id — the first user to register a passkey gets a
 * fresh random UUID and *adopts* this pre-auth data by re-pointing it at their
 * real id (see AuthService.adoptPreAuthData). It remains the acting user when
 * AUTH_DISABLED=true restores the old single-user mode (and in tests).
 */
export const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Every table that scopes rows to an owner via a plain `"userId"` column (no
 * FK to `users` — these predate the auth tables). When the first account
 * adopts the pre-auth data, or the de-sentinelize migration re-keys the owner,
 * every one of these must be re-pointed. Keep this list exhaustive: a missing
 * table means silently orphaned, invisible rows.
 */
export const USER_OWNED_DATA_TABLES = [
  'inbox_items',
  'plaud_settings',
  'email_settings',
  'voice_profiles',
  'calendar_feeds',
  'calendar_events',
  'recording_event_links',
  'inbox_tombstones',
] as const;
