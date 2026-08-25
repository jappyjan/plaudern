import 'reflect-metadata';
import {
  AppDataSource,
  assertStrongEncryptionSecret,
  rotateEncryptionSecret,
} from '../src';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const oldSecret = process.env.APP_ENCRYPTION_SECRET_OLD;
  const newSecret = process.env.APP_ENCRYPTION_SECRET;
  if (!oldSecret) throw new Error('APP_ENCRYPTION_SECRET_OLD is required');
  assertStrongEncryptionSecret(newSecret);

  await AppDataSource.initialize();
  try {
    const rotated = await rotateEncryptionSecret(AppDataSource, oldSecret, newSecret);
    console.log(`Rotated ${rotated} encrypted database values`);
  } finally {
    await AppDataSource.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Encryption secret rotation failed');
  process.exitCode = 1;
});
