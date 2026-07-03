import { authUserSchema, meResponseSchema, usernameSchema } from './auth';

// The static owner id the buggy build assigned to the first account. It is a
// valid GUID but NOT a valid RFC-9562 UUID (version nibble 0), and — more to
// the point — no real account should ever carry a guessable, static id. The
// schema must keep rejecting it so a regression can't quietly reintroduce it.
const LEGACY_SENTINEL_ID = '00000000-0000-0000-0000-000000000001';

describe('authUserSchema', () => {
  it('accepts a real random v4 uuid (what every account now gets)', () => {
    const id = '3f1e6a2c-9b7d-4c3a-8e2f-1a2b3c4d5e6f';
    expect(authUserSchema.parse({ id, username: 'jappy' }).id).toBe(id);
  });

  it('rejects the legacy static owner sentinel id', () => {
    expect(() => authUserSchema.parse({ id: LEGACY_SENTINEL_ID, username: 'jappy' })).toThrow();
  });

  it('rejects a non-uuid id', () => {
    expect(() => authUserSchema.parse({ id: 'not-a-uuid', username: 'x' })).toThrow();
  });

  it('parses the /auth/me envelope', () => {
    const id = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    expect(meResponseSchema.parse({ user: { id, username: 'jappy' } }).user.id).toBe(id);
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
