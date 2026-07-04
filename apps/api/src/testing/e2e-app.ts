import { INestApplication, VersioningType } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { json, raw, urlencoded } from 'express';
import { CLIP_EXTRACTOR, PyannoteAiClient } from '@plaudern/speaker-id';
import { TRANSCRIPTION_PROVIDER } from '@plaudern/transcription';
import { AUDIO_CONCATENATOR } from '@plaudern/ingestion';
import { AppModule } from '../app/app.module';
import {
  FakeAudioConcatenator,
  FakeClipExtractor,
  FakePyannoteAiClient,
  FakeTranscriptionProvider,
} from './fake-providers';

/**
 * Boot the full AppModule for a spec, wired to the deterministic fakes (no
 * network, no ffmpeg) and configured like production (global /api prefix + URI
 * versioning). Specs still own their process.env block — set it BEFORE
 * importing this module resolves into a compile, i.e. at the top of the spec.
 *
 * `customize` lets a spec add its own overrides (e.g. a fake Plaud client).
 */
export async function createE2eApp(
  customize: (builder: TestingModuleBuilder) => TestingModuleBuilder = (builder) => builder,
): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TRANSCRIPTION_PROVIDER)
    .useValue(new FakeTranscriptionProvider())
    .overrideProvider(PyannoteAiClient)
    .useValue(new FakePyannoteAiClient())
    .overrideProvider(CLIP_EXTRACTOR)
    .useValue(new FakeClipExtractor())
    .overrideProvider(AUDIO_CONCATENATOR)
    .useValue(new FakeAudioConcatenator());

  const moduleRef = await customize(builder).compile();
  const app = moduleRef.createNestApplication({ bodyParser: false });
  // Mirror main.ts's body parser setup (raised JSON limit + raw MIME support
  // for the email-in webhook) so e2e specs see production request handling.
  app.use(json({ limit: '25mb' }));
  app.use(urlencoded({ extended: true, limit: '25mb' }));
  app.use(raw({ type: ['message/rfc822', 'text/plain'], limit: '25mb' }));
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI });
  await app.init();
  return app;
}
