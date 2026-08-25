import { assertStrongEncryptionSecret } from '@plaudern/contracts';

export function validateEnvironment(environment: Record<string, unknown>): Record<string, unknown> {
  assertStrongEncryptionSecret(environment.APP_ENCRYPTION_SECRET);
  return environment;
}
