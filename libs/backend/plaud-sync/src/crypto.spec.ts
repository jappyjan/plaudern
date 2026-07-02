import { decryptSecret, encryptSecret } from './crypto';

describe('crypto', () => {
  it('round-trips a secret', () => {
    const ciphertext = encryptSecret('plaud-password-123', 'app-secret');
    expect(ciphertext).toMatch(/^v1:/);
    expect(ciphertext).not.toContain('plaud-password-123');
    expect(decryptSecret(ciphertext, 'app-secret')).toBe('plaud-password-123');
  });

  it('produces a fresh IV per encryption', () => {
    const a = encryptSecret('same-input', 'app-secret');
    const b = encryptSecret('same-input', 'app-secret');
    expect(a).not.toBe(b);
  });

  it('throws when decrypting with the wrong secret', () => {
    const ciphertext = encryptSecret('plaud-password-123', 'app-secret');
    expect(() => decryptSecret(ciphertext, 'rotated-secret')).toThrow();
  });

  it('rejects unrecognized ciphertext formats', () => {
    expect(() => decryptSecret('not-a-ciphertext', 'app-secret')).toThrow(
      'unrecognized ciphertext format',
    );
  });
});
