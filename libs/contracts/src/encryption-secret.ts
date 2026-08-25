const MIN_SECRET_BYTES = 32;
const MIN_DISTINCT_CHARACTERS = 12;
const INSECURE_SECRETS = new Set(['change-me', 'test-secret', 'secret', 'password']);
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function assertStrongEncryptionSecret(secret: unknown): asserts secret is string {
  const decodedBytes =
    typeof secret === 'string'
      ? (secret.length / 4) * 3 - (secret.endsWith('==') ? 2 : secret.endsWith('=') ? 1 : 0)
      : 0;
  if (
    typeof secret !== 'string' ||
    secret !== secret.trim() ||
    !BASE64_PATTERN.test(secret) ||
    decodedBytes < MIN_SECRET_BYTES
  ) {
    throw new Error(
      `APP_ENCRYPTION_SECRET must be base64 encoding of at least ${MIN_SECRET_BYTES} bytes`,
    );
  }
  if (INSECURE_SECRETS.has(secret.trim().toLowerCase())) {
    throw new Error('APP_ENCRYPTION_SECRET uses a known insecure default');
  }
  if (new Set(secret).size < MIN_DISTINCT_CHARACTERS) {
    throw new Error('APP_ENCRYPTION_SECRET does not contain enough character diversity');
  }
}
