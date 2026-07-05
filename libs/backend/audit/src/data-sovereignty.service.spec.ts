import 'reflect-metadata';
import { DataSource } from 'typeorm';
import type { InboxService } from '@plaudern/inbox';
import type { StorageService } from '@plaudern/storage';
import {
  AiProviderCallEntity,
  ALL_ENTITIES,
  DeadMansSwitchEntity,
} from '@plaudern/persistence';
import { DataSovereigntyService } from './data-sovereignty.service';

async function seedAudit(dataSource: DataSource, userId: string, provider: string) {
  await dataSource.getRepository(AiProviderCallEntity).save(
    dataSource.getRepository(AiProviderCallEntity).create({
      userId,
      inboxItemId: null,
      kind: 'summary',
      provider,
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      direction: 'outbound',
      bytesSent: 42,
      contentHash: 'abc',
      payloadRedacted: null,
    }),
  );
}

describe('DataSovereigntyService', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('panic-delete wipes the user’s audit + switch rows and leaves other users untouched', async () => {
    await seedAudit(dataSource, 'victim', 'p1');
    await seedAudit(dataSource, 'victim', 'p2');
    await seedAudit(dataSource, 'bystander', 'p3');
    await dataSource
      .getRepository(DeadMansSwitchEntity)
      .save(dataSource.getRepository(DeadMansSwitchEntity).create({ userId: 'victim' }));

    const inbox = {
      purgeAllForUser: jest.fn(async () => ({ deletedItems: 3 })),
    } as unknown as InboxService;
    const storage = {} as unknown as StorageService;
    const service = new DataSovereigntyService(inbox, storage, dataSource);

    const result = await service.panicDelete('victim');

    expect(inbox.purgeAllForUser).toHaveBeenCalledWith('victim');
    expect(result.deletedItems).toBe(3);
    expect(result.deletedAuditEntries).toBe(2);

    const audits = dataSource.getRepository(AiProviderCallEntity);
    expect(await audits.countBy({ userId: 'victim' })).toBe(0);
    // Strictly self-scoped: the other user's trail is intact.
    expect(await audits.countBy({ userId: 'bystander' })).toBe(1);
    expect(
      await dataSource.getRepository(DeadMansSwitchEntity).countBy({ userId: 'victim' }),
    ).toBe(0);
  });

  it('exports only the signed-in user’s items, with a markdown rendering', async () => {
    const inbox = {
      listItems: jest.fn(async () => ({
        items: [
          {
            id: 'i1',
            sourceType: 'recording',
            occurredAt: '2026-01-01T00:00:00.000Z',
            ingestedAt: new Date('2026-01-02T00:00:00.000Z'),
            metadata: null,
            source: {
              storageKey: 'audio/1',
              contentType: 'audio/mp4',
              byteSize: 100,
              originalFilename: 'a.mp4',
            },
            extractions: [
              {
                id: 'e1',
                kind: 'summary',
                version: 1,
                provider: 'openai:deepseek-chat',
                status: 'succeeded',
                content: JSON.stringify({ title: 'My Meeting', markdown: '- did things' }),
                language: 'en',
                createdAt: new Date('2026-01-02T00:00:00.000Z'),
                completedAt: new Date('2026-01-02T00:01:00.000Z'),
              },
            ],
          },
        ],
        nextCursor: null,
      })),
    } as unknown as InboxService;
    const storage = {
      createPresignedGetUrl: jest.fn(async (key: string) => `https://storage/${key}?sig=x`),
    } as unknown as StorageService;
    const service = new DataSovereigntyService(inbox, storage, dataSource);

    const dump = await service.exportEverything('me');

    expect(dump.userId).toBe('me');
    expect(dump.itemCount).toBe(1);
    expect(dump.items[0].source?.downloadUrl).toBe('https://storage/audio/1?sig=x');
    expect(dump.items[0].extractions[0].kind).toBe('summary');
    expect(dump.markdown).toContain('# Plaudern export');
    expect(dump.markdown).toContain('My Meeting');
    expect(dump.markdown).toContain('- did things');
  });

  it('dead-man’s-switch check-in stamps lastCheckInAt and reports triggersAt', async () => {
    const service = new DataSovereigntyService(
      {} as unknown as InboxService,
      {} as unknown as StorageService,
      dataSource,
    );

    await service.updateDeadMansSwitch('me', {
      enabled: true,
      contactEmail: 'trustee@example.com',
      checkInIntervalDays: 30,
    });
    const dto = await service.checkInDeadMansSwitch('me');

    expect(dto.configured).toBe(true);
    expect(dto.enabled).toBe(true);
    expect(dto.contactEmail).toBe('trustee@example.com');
    expect(dto.lastCheckInAt).not.toBeNull();
    expect(dto.triggersAt).not.toBeNull();
  });
});
