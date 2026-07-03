/**
 * Owner of all rows created while the instance ran without authentication
 * (the app used to be single-user and unauthenticated). The FIRST user to
 * register a passkey is created with this id, adopting that pre-auth data.
 * It is also the acting user when AUTH_DISABLED=true restores the old
 * single-user mode (and in tests).
 */
export const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000001';
