/**
 * The app is single-user and unauthenticated (self-hosted per user), but
 * `inbox_items` keeps its `userId` column so per-user indexes/idempotency
 * still work and multi-user can return later without schema surgery. Every
 * row is owned by this fixed id.
 */
export const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000001';
