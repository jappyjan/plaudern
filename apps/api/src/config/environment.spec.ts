import { validateEnvironment } from './environment';

describe('validateEnvironment', () => {
  const strongSecret = '0123456789abcdef0123456789abcdef';

  it.each([undefined, '', 'change-me', 'test-secret', 'short', 'a'.repeat(32), 'change-me'.repeat(4)])(
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
