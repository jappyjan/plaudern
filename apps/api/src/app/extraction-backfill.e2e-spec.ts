import 'reflect-metadata';

// Hardware-free, infra-free verification (see plan §6 Path A). Must run before
// the modules load — ConfigModule reads process.env at init.
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_URL = ':memory:';
process.env.STORAGE_DRIVER = 'memory';
process.env.QUEUE_DRIVER = 'inline';
process.env.AUTH_DISABLED = 'true';
process.env.GEOCODER = 'stub';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { ExtractionRunDto, ExtractorNodeDto } from '@plaudern/contracts';
import { InMemoryStorageService, StorageService } from '@plaudern/storage';
import { SUMMARIZATION_PROVIDER } from '@plaudern/summarization';
import { createE2eApp } from '../testing/e2e-app';
import { FakeSummarizationProvider } from '../testing/fake-providers';

/**
 * The extraction-pipeline DAG (VISION §8): graph introspection, per-kind
 * versioning on every appended row, and backfill runs that re-run one kind
 * over past items — append-only, existing rows are never mutated.
 */
describe('Extraction DAG & backfill runs (e2e, Path A)', () => {
  let app: INestApplication;
  let storage: InMemoryStorageService;

  beforeAll(async () => {
    app = await createE2eApp((builder) =>
      builder.overrideProvider(SUMMARIZATION_PROVIDER).useValue(new FakeSummarizationProvider()),
    );
    storage = app.get(StorageService) as InMemoryStorageService;
  });

  afterAll(async () => {
    await app.close();
  });

  async function ingestAudio(idempotencyKey: string, occurredAt: string): Promise<string> {
    const audio = Buffer.from(`fake-audio-${idempotencyKey}`);
    const init = await request(app.getHttpServer())
      .post('/api/v1/ingest/init')
      .send({
        sourceType: 'audio',
        contentType: 'audio/mpeg',
        byteSize: audio.byteLength,
        occurredAt,
        idempotencyKey,
      })
      .expect(201);
    await storage.putObject(init.body.storageKey, audio, 'audio/mpeg');
    await request(app.getHttpServer())
      .post(`/api/v1/ingest/${init.body.inboxItemId}/commit`)
      .expect(201);
    return init.body.inboxItemId;
  }

  async function ingestText(idempotencyKey: string, occurredAt: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/ingest/text')
      .send({ text: 'plain note', occurredAt, idempotencyKey })
      .expect(201);
    return res.body.id;
  }

  async function getItem(id: string) {
    const res = await request(app.getHttpServer()).get(`/api/v1/inbox/${id}`).expect(200);
    return res.body;
  }

  type Extraction = { id: string; kind: string; status: string; version: number };
  const byKind = (extractions: Extraction[], kind: string) =>
    extractions.filter((e) => e.kind === kind);

  /** Runs execute in the background; with inline queues they settle quickly. */
  async function awaitRun(runId: string): Promise<ExtractionRunDto> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/extractions/backfills/${runId}`)
        .expect(200);
      if (res.body.status !== 'running') return res.body;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`backfill run ${runId} did not settle`);
  }

  /** Retry an assertion for a short while (event-driven cascades settle async). */
  async function expectEventually(assertion: () => Promise<void>): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await assertion();
        return;
      } catch (err) {
        if (attempt >= 50) throw err;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  it('exposes the declarative extractor graph', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/extractions/graph').expect(200);
    const extractors: ExtractorNodeDto[] = res.body.extractors;
    const byKindMap = new Map(extractors.map((e) => [e.kind, e]));

    expect(byKindMap.get('transcription')).toEqual({
      kind: 'transcription',
      version: 1,
      enabled: true,
      dependsOn: [],
    });
    expect(byKindMap.get('diarization')).toEqual({
      kind: 'diarization',
      version: 1,
      enabled: true,
      dependsOn: [],
    });
    expect(byKindMap.get('summary')).toEqual({
      kind: 'summary',
      version: 1,
      enabled: true,
      dependsOn: [
        { kind: 'transcription', requires: 'succeeded' },
        { kind: 'diarization', requires: 'settled' },
      ],
    });
  });

  it('records the extractor version on every appended row', async () => {
    const itemId = await ingestAudio('dag-version-1', '2029-01-01T10:00:00.000Z');
    const item = await getItem(itemId);
    expect(item.extractions.length).toBeGreaterThanOrEqual(3); // transcription+diarization+summary
    for (const extraction of item.extractions as Extraction[]) {
      expect(extraction.version).toBe(1);
    }
  });

  it('force-backfills a kind over past items, appending rows (never mutating)', async () => {
    const audioA = await ingestAudio('dag-backfill-a', '2030-01-01T10:00:00.000Z');
    const audioB = await ingestAudio('dag-backfill-b', '2030-01-02T10:00:00.000Z');
    const textC = await ingestText('dag-backfill-c', '2030-01-03T10:00:00.000Z');

    const before = await getItem(audioA);
    const beforeIds = (before.extractions as Extraction[]).map((e) => e.id).sort();

    // Generation dedupe compares createdAt timestamps, whose granularity is
    // one second on sqlite — step past it so the backfill rows form a NEW
    // generation, as any real backfill (run long after ingest) would.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const started = await request(app.getHttpServer())
      .post('/api/v1/extractions/backfills')
      .send({
        kind: 'transcription',
        force: true,
        occurredFrom: '2030-01-01T00:00:00.000Z',
        occurredTo: '2030-01-31T00:00:00.000Z',
      })
      .expect(201);
    expect(started.body.status).toMatch(/running|completed/);
    expect(started.body.targetVersion).toBe(1);

    const run = await awaitRun(started.body.id);
    expect(run.status).toBe('completed');
    expect(run.itemsMatched).toBe(3);
    expect(run.itemsQueued).toBe(2); // both audio items
    expect(run.itemsSkipped).toBe(1); // the text item — transcription doesn't apply
    expect(run.itemsFailed).toBe(0);
    expect(run.completedAt).not.toBeNull();

    for (const itemId of [audioA, audioB]) {
      const item = await getItem(itemId);
      const transcriptions = byKind(item.extractions, 'transcription');
      expect(transcriptions).toHaveLength(2); // append-only: fresh row, old kept
      expect(transcriptions.every((t) => t.status === 'succeeded')).toBe(true);
    }
    // The pre-existing rows survived untouched (same ids still present).
    const after = await getItem(audioA);
    const afterIds = (after.extractions as Extraction[]).map((e) => e.id);
    for (const id of beforeIds) expect(afterIds).toContain(id);

    // The re-run transcription is a new generation, so the DAG cascades a
    // fresh summary too — same as a manual transcription retry today. The
    // cascade is event-driven (fire-and-forget), so poll briefly.
    await expectEventually(async () => {
      const cascaded = await getItem(audioA);
      expect(byKind(cascaded.extractions, 'summary').length).toBeGreaterThanOrEqual(2);
    });

    // The text item got nothing.
    const text = await getItem(textC);
    expect(text.extractions).toHaveLength(0);
  });

  it('skips items already at the target version when not forced', async () => {
    await ingestAudio('dag-uptodate-a', '2031-01-01T10:00:00.000Z');

    const started = await request(app.getHttpServer())
      .post('/api/v1/extractions/backfills')
      .send({
        kind: 'transcription',
        occurredFrom: '2031-01-01T00:00:00.000Z',
        occurredTo: '2031-01-31T00:00:00.000Z',
      })
      .expect(201);

    const run = await awaitRun(started.body.id);
    expect(run.status).toBe('completed');
    expect(run.itemsMatched).toBe(1);
    expect(run.itemsQueued).toBe(0); // latest succeeded row is already version 1
    expect(run.itemsSkipped).toBe(1);
  });

  it('honors the occurredAt window', async () => {
    const inWindow = await ingestAudio('dag-window-in', '2032-03-10T10:00:00.000Z');
    const outOfWindow = await ingestAudio('dag-window-out', '2032-06-10T10:00:00.000Z');

    const started = await request(app.getHttpServer())
      .post('/api/v1/extractions/backfills')
      .send({
        kind: 'summary',
        force: true,
        occurredFrom: '2032-03-01T00:00:00.000Z',
        occurredTo: '2032-03-31T00:00:00.000Z',
      })
      .expect(201);

    const run = await awaitRun(started.body.id);
    expect(run.status).toBe('completed');
    expect(run.itemsMatched).toBe(1);
    expect(run.itemsQueued).toBe(1);

    const summarized = await getItem(inWindow);
    expect(byKind(summarized.extractions, 'summary')).toHaveLength(2);
    // A summary backfill leaves the upstream kinds untouched.
    expect(byKind(summarized.extractions, 'transcription')).toHaveLength(1);
    const untouched = await getItem(outOfWindow);
    expect(byKind(untouched.extractions, 'summary')).toHaveLength(1);
  });

  it('lists the user runs newest first', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/extractions/backfills').expect(200);
    expect(res.body.runs.length).toBeGreaterThanOrEqual(3);
    const created = res.body.runs.map((run: ExtractionRunDto) => run.createdAt);
    expect([...created].sort().reverse()).toEqual(created);
  });

  it('rejects a backfill for a kind without a registered extractor', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/extractions/backfills')
      .send({ kind: 'ocr' })
      .expect(400);
  });

  it('rejects an invalid request body and an inverted window', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/extractions/backfills')
      .send({ kind: 'not-a-kind' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/extractions/backfills')
      .send({
        kind: 'transcription',
        occurredFrom: '2030-02-01T00:00:00.000Z',
        occurredTo: '2030-01-01T00:00:00.000Z',
      })
      .expect(400);
  });

  it('404s for an unknown run id', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/extractions/backfills/00000000-0000-0000-0000-00000000dead')
      .expect(404);
  });
});
