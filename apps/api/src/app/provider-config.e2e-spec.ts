import 'reflect-metadata';

// Configure the app for hardware-free, infra-free verification BEFORE the
// modules load (ConfigModule reads process.env at init). See plan §6 Path A.
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_URL = ':memory:';
process.env.STORAGE_DRIVER = 'memory';
process.env.QUEUE_DRIVER = 'inline';
process.env.AUTH_DISABLED = 'true'; // single-user mode — auth has its own spec
process.env.GEOCODER = 'stub';

import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';

// The provider factories read env at app init, so flipping process.env per
// test is enough (same pattern as the geocoding e2e).
async function bootAttempt(): Promise<void> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  await app.close();
}

describe('Provider config fail-fast (e2e, Path A)', () => {
  afterEach(() => {
    delete process.env.SPEAKER_ID_PROVIDER;
  });

  it('boots with the real-provider defaults (no provider env set)', async () => {
    await expect(bootAttempt()).resolves.toBeUndefined();
  });

  it('rejects the removed local-sidecar SPEAKER_ID_PROVIDER=pyannote', async () => {
    process.env.SPEAKER_ID_PROVIDER = 'pyannote';
    await expect(bootAttempt()).rejects.toThrow('SPEAKER_ID_PROVIDER=pyannote was removed');
  });

  it('rejects the removed SPEAKER_ID_PROVIDER=stub', async () => {
    process.env.SPEAKER_ID_PROVIDER = 'stub';
    await expect(bootAttempt()).rejects.toThrow('SPEAKER_ID_PROVIDER=stub was removed');
  });

  it('rejects an unknown SPEAKER_ID_PROVIDER', async () => {
    process.env.SPEAKER_ID_PROVIDER = 'nonsense';
    await expect(bootAttempt()).rejects.toThrow("unknown SPEAKER_ID_PROVIDER 'nonsense'");
  });

  it('accepts SPEAKER_ID_PROVIDER=off', async () => {
    process.env.SPEAKER_ID_PROVIDER = 'off';
    await expect(bootAttempt()).resolves.toBeUndefined();
  });
});
