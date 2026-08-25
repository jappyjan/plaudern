import { validateEnvironment } from './environment';

describe('validateEnvironment', () => {
  const strongSecret = Buffer.from('plaudern explicit test-only encryption key material').toString(
    'base64',
  );

  it.each([
    undefined,
    '',
    'change-me',
    'test-secret',
    'short',
    'a'.repeat(32),
    'change-me'.repeat(4),
    'abcdefghijklmnopqrstuvwx12345678',
    'A'.repeat(44),
  ])(
    'rejects a missing, default, or weak encryption secret (%p)',
    (secret) => {
      expect(() =>
        validateEnvironment({ NODE_ENV: 'production', APP_ENCRYPTION_SECRET: secret }),
      ).toThrow('APP_ENCRYPTION_SECRET');
    },
  );

  it('accepts a strong encryption secret without exposing it', () => {
    const environment = { NODE_ENV: 'production', APP_ENCRYPTION_SECRET: strongSecret };
    expect(validateEnvironment(environment)).toBe(environment);
  });

  it('requires an explicit strong secret outside production too', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'test' })).toThrow('APP_ENCRYPTION_SECRET');
  });
});
