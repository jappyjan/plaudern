import 'reflect-metadata';

// Configure the app for hardware-free, infra-free verification BEFORE the
// modules load (ConfigModule reads process.env at init). See plan §6 Path A.
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_URL = ':memory:';
process.env.STORAGE_DRIVER = 'memory';
process.env.QUEUE_DRIVER = 'inline';
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
    delete process.env.TRANSCRIPTION_PROVIDER;
    delete process.env.SPEAKER_ID_PROVIDER;
    delete process.env.OPENAI_API_KEY;
  });

  it('boots with the real-provider defaults (no provider env set)', async () => {
    await expect(bootAttempt()).resolves.toBeUndefined();
  });

  it('rejects the removed TRANSCRIPTION_PROVIDER=stub', async () => {
    process.env.TRANSCRIPTION_PROVIDER = 'stub';
    await expect(bootAttempt()).rejects.toThrow('TRANSCRIPTION_PROVIDER=stub was removed');
  });

  it('rejects an unknown TRANSCRIPTION_PROVIDER', async () => {
    process.env.TRANSCRIPTION_PROVIDER = 'whisper';
    await expect(bootAttempt()).rejects.toThrow("unknown TRANSCRIPTION_PROVIDER 'whisper'");
  });

  it('rejects TRANSCRIPTION_PROVIDER=openai without OPENAI_API_KEY', async () => {
    process.env.TRANSCRIPTION_PROVIDER = 'openai';
    await expect(bootAttempt()).rejects.toThrow(
      'TRANSCRIPTION_PROVIDER=openai requires OPENAI_API_KEY',
    );
  });

  it('accepts TRANSCRIPTION_PROVIDER=openai with OPENAI_API_KEY', async () => {
    process.env.TRANSCRIPTION_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';
    await expect(bootAttempt()).resolves.toBeUndefined();
  });

  it('rejects the removed SPEAKER_ID_PROVIDER=stub', async () => {
    process.env.SPEAKER_ID_PROVIDER = 'stub';
    await expect(bootAttempt()).rejects.toThrow('SPEAKER_ID_PROVIDER=stub was removed');
  });

  it('accepts SPEAKER_ID_PROVIDER=off', async () => {
    process.env.SPEAKER_ID_PROVIDER = 'off';
    await expect(bootAttempt()).resolves.toBeUndefined();
  });
});
