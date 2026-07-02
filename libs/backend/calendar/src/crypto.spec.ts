import { decryptSecret, encryptSecret } from './crypto';

describe('calendar crypto', () => {
  it('round-trips a feed URL', () => {
    const url = 'https://calendar.google.com/calendar/ical/user%40example.com/private-abc123/basic.ics';
    const ciphertext = encryptSecret(url, 'app-secret');
    expect(ciphertext).toMatch(/^v1:/);
    expect(ciphertext).not.toContain('google');
    expect(decryptSecret(ciphertext, 'app-secret')).toBe(url);
  });

  it('rejects a wrong secret', () => {
    const ciphertext = encryptSecret('payload', 'secret-a');
    expect(() => decryptSecret(ciphertext, 'secret-b')).toThrow();
  });

  it('rejects unknown formats', () => {
    expect(() => decryptSecret('v0:zzzz', 'secret')).toThrow('unrecognized ciphertext format');
  });
});
