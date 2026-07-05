import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ALL_ENTITIES, ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
import type { InboxService } from '@plaudern/inbox';
import type { AiConfigService } from '@plaudern/ai-config';
import type { ExtractionKind } from '@plaudern/contracts';
import type { RelationExtractionProvider } from './relations.provider';
import type { RelationExtractionJob, RelationExtractionQueue } from './relations.job';
import { RelationsService, RELATIONS_EXTRACTOR_VERSION } from './relations.service';

const USER = '00000000-0000-0000-0000-0000000000aa';
const OTHER_USER = '00000000-0000-0000-0000-0000000000bb';

/**
 * Minimal InboxService stand-in backed by the same sqlite repositories — the
 * service only calls getItem (user-scoped read) and addExtraction (append).
 */
function fakeInbox(dataSource: DataSource): InboxService {
  const items = dataSource.getRepository(InboxItemEntity);
  const extractions = dataSource.getRepository(ExtractedPayloadEntity);
  return {
    async getItem(userId: string, id: string) {
      const item = await items.findOne({
        where: { id, userId },
        relations: { source: true, extractions: true },
      });
      if (!item) throw new NotFoundException('inbox item not found');
      return item;
    },
    async addExtraction(inboxItemId: string, kind: ExtractionKind, provider: string, version: number) {
      return extractions.save({ inboxItemId, kind, version, provider, status: 'queued' });
    },
  } as unknown as InboxService;
}

function fakeProvider(): RelationExtractionProvider {
  return {
    id: 'test:relations',
    extract: async () => ({ relations: [] }),
  };
}

/** Enablement now comes from AiConfigService (capability entity_relations), not the provider. */
function fakeAiConfig(enabled = true): AiConfigService {
  return {
    isEnabled: async () => enabled,
    resolve: async () => (enabled ? ({} as never) : null),
    invalidate() {},
  } as unknown as AiConfigService;
}

describe('RelationsService', () => {
  let dataSource: DataSource;
  let service: RelationsService;
  let enqueued: RelationExtractionJob[];

  function buildService(enabled = true): RelationsService {
    const queue: RelationExtractionQueue = {
      enqueue: async (job) => {
        enqueued.push(job);
      },
    };
    return new RelationsService(fakeInbox(dataSource), fakeAiConfig(enabled), fakeProvider(), queue);
  }

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
    enqueued = [];
    service = buildService();
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  async function createItem(userId = USER): Promise<string> {
    const item = await dataSource.getRepository(InboxItemEntity).save({
      userId,
      deviceId: null,
      sourceType: 'plaud',
      occurredAt: '2026-07-01T10:00:00Z',
      idempotencyKey: `key-${Math.random()}`,
      metadata: null,
    });
    return item.id;
  }

  async function createExtraction(
    inboxItemId: string,
    kind: ExtractedPayloadEntity['kind'],
    status: ExtractedPayloadEntity['status'],
    createdAt = new Date(),
  ): Promise<string> {
    const row = await dataSource.getRepository(ExtractedPayloadEntity).save({
      inboxItemId,
      kind,
      version: 1,
      provider: 'test',
      status,
      createdAt,
    });
    return row.id;
  }

  describe('retry', () => {
    it('appends a fresh queued relations row and enqueues the job', async () => {
      const item = await createItem();
      await createExtraction(item, 'entities', 'succeeded');

      const extractionId = await service.retry(USER, item);

      expect(enqueued).toEqual([{ extractionId, inboxItemId: item }]);
      const row = await dataSource
        .getRepository(ExtractedPayloadEntity)
        .findOneByOrFail({ id: extractionId });
      expect(row).toMatchObject({
        kind: 'relations',
        status: 'queued',
        provider: 'test:relations',
        version: RELATIONS_EXTRACTOR_VERSION,
      });
    });

    it('rejects when relation extraction is not configured', async () => {
      service = buildService(false);
      const item = await createItem();
      await createExtraction(item, 'entities', 'succeeded');
      await expect(service.retry(USER, item)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when the item has no completed entity extraction (dependency guard)', async () => {
      const item = await createItem();
      // Transcription alone is not enough — relations require entities.
      await createExtraction(item, 'transcription', 'succeeded');
      await expect(service.retry(USER, item)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when entities are only in flight, not yet succeeded', async () => {
      const item = await createItem();
      await createExtraction(item, 'entities', 'processing');
      await expect(service.retry(USER, item)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects while relation extraction is already in flight', async () => {
      const item = await createItem();
      await createExtraction(item, 'entities', 'succeeded', new Date('2026-07-01T10:00:00Z'));
      await createExtraction(item, 'relations', 'processing', new Date('2026-07-01T10:05:00Z'));
      await expect(service.retry(USER, item)).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects a foreign user\'s item with NotFound', async () => {
      const item = await createItem(OTHER_USER);
      await createExtraction(item, 'entities', 'succeeded');
      await expect(service.retry(USER, item)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
