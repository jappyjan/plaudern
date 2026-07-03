import { authUserSchema, meResponseSchema, usernameSchema } from './auth';

// Must match DEFAULT_USER_ID in @plaudern/persistence. Kept as a literal here
// so the contracts library stays free of a backend dependency.
const OWNER_SENTINEL_ID = '00000000-0000-0000-0000-000000000001';

describe('authUserSchema', () => {
  it('accepts the fixed owner sentinel id (regression: Zod v4 .uuid() rejected it)', () => {
    // The first registered account is created with this id. It is a valid GUID
    // but not a valid RFC-9562 UUID (version nibble 0), so `.uuid()` used to
    // fail-parse every /auth/me and register/login response for the root user.
    const parsed = authUserSchema.parse({ id: OWNER_SENTINEL_ID, username: 'jappy' });
    expect(parsed.id).toBe(OWNER_SENTINEL_ID);
  });

  it('accepts a random v4 uuid (subsequent accounts)', () => {
    const id = '3f1e6a2c-9b7d-4c3a-8e2f-1a2b3c4d5e6f';
    expect(authUserSchema.parse({ id, username: 'bob' }).id).toBe(id);
  });

  it('still rejects a non-GUID id', () => {
    expect(() => authUserSchema.parse({ id: 'not-a-guid', username: 'x' })).toThrow();
  });

  it('parses the /auth/me envelope for the owner', () => {
    expect(
      meResponseSchema.parse({ user: { id: OWNER_SENTINEL_ID, username: 'jappy' } }).user.id,
    ).toBe(OWNER_SENTINEL_ID);
  });
});

describe('usernameSchema', () => {
  it('normalizes case and trims', () => {
    expect(usernameSchema.parse('  Jappy ')).toBe('jappy');
  });

  it('rejects too-short usernames', () => {
    expect(() => usernameSchema.parse('ab')).toThrow();
  });
});
