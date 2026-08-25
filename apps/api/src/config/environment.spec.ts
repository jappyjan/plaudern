import { randomBytes } from 'node:crypto';
import { validateEnvironment } from './environment';

describe('validateEnvironment', () => {
  const strongSecret = randomBytes(32).toString('base64');
  const historicalTestSecret = Buffer.from(
    Array.from({ length: 32 }, (_, index) => index),
  ).toString('base64');

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
    historicalTestSecret,
  ])(
    'rejects a missing, default, or weak encryption secret (%p)',
    (secret) => {
      expect(() =>
        validateEnvironment({ NODE_ENV: 'production', APP_ENCRYPTION_SECRET: secret }),
      ).toThrow('APP_ENCRYPTION_SECRET');
    },
  );

  it('rejects a non-canonical alias of a forbidden encryption secret', () => {
    const alias = `${historicalTestSecret.slice(0, -2)}9=`;
    expect(Buffer.from(alias, 'base64')).toEqual(
      Buffer.from(historicalTestSecret, 'base64'),
    );
    expect(() =>
      validateEnvironment({ NODE_ENV: 'production', APP_ENCRYPTION_SECRET: alias }),
    ).toThrow('APP_ENCRYPTION_SECRET');
  });

  it('accepts a strong encryption secret without exposing it', () => {
    const environment = { NODE_ENV: 'production', APP_ENCRYPTION_SECRET: strongSecret };
    expect(validateEnvironment(environment)).toBe(environment);
  });

  it('requires an explicit strong secret outside production too', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'test' })).toThrow('APP_ENCRYPTION_SECRET');
  });
});
