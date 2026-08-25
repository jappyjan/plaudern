const MIN_SECRET_BYTES = 32;
const MIN_DISTINCT_CHARACTERS = 12;
const INSECURE_SECRETS = new Set(['change-me', 'test-secret', 'secret', 'password']);
const INSECURE_ENCODED_SECRETS = new Set([
  ['AAECAwQF', 'BgcICQoL', 'DA0ODxAR', 'EhMUFRYX', 'GBkaGxwd', 'Hh8='].join(''),
]);
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function assertStrongEncryptionSecret(secret: unknown): asserts secret is string {
  if (
    typeof secret !== 'string' ||
    secret !== secret.trim() ||
    !BASE64_PATTERN.test(secret)
  ) {
    throw new Error(
      `APP_ENCRYPTION_SECRET must be base64 encoding of at least ${MIN_SECRET_BYTES} bytes`,
    );
  }
  const decodedSecret = Buffer.from(secret, 'base64');
  const canonicalSecret = decodedSecret.toString('base64');
  if (
    canonicalSecret !== secret ||
    INSECURE_ENCODED_SECRETS.has(canonicalSecret) ||
    decodedSecret.length < MIN_SECRET_BYTES
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
