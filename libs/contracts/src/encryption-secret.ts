const MIN_SECRET_LENGTH = 32;
const MIN_DISTINCT_CHARACTERS = 12;
const INSECURE_SECRETS = new Set(['change-me', 'test-secret', 'secret', 'password']);

export function assertStrongEncryptionSecret(secret: unknown): asserts secret is string {
  if (typeof secret !== 'string' || secret.trim().length < MIN_SECRET_LENGTH) {
    throw new Error(`APP_ENCRYPTION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (INSECURE_SECRETS.has(secret.trim().toLowerCase())) {
    throw new Error('APP_ENCRYPTION_SECRET uses a known insecure default');
  }
  if (new Set(secret).size < MIN_DISTINCT_CHARACTERS) {
    throw new Error('APP_ENCRYPTION_SECRET does not contain enough character diversity');
  }
}
