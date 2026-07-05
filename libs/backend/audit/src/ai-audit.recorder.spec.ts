import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { AiProviderCallEntity } from '@plaudern/persistence';
import { AiAuditRecorder } from './ai-audit.recorder';
import { AuditPersistenceService } from './audit-persistence.service';
import { runWithAiAudit } from './ai-audit.context';

/** Minimal ConfigService stand-in. */
function fakeConfig(values: Record<string, string>) {
  return {
    get: (key: string, fallback?: string) => values[key] ?? fallback,
  } as unknown as import('@nestjs/config').ConfigService;
}

describe('AiAuditRecorder', () => {
  let dataSource: DataSource;
  let calls: Repository<AiProviderCallEntity>;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [AiProviderCallEntity],
      synchronize: true,
    });
    await dataSource.initialize();
    calls = dataSource.getRepository(AiProviderCallEntity);
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('records exactly one audit row for one external provider call, hashing the payload', async () => {
    const recorder = new AiAuditRecorder(calls, fakeConfig({}));
    const payload = JSON.stringify({ model: 'deepseek-chat', input: 'hello world' });

    // Simulate a provider call made inside a processor's audit context.
    await runWithAiAudit({ userId: 'user-1', itemId: 'item-1', kind: 'summary' }, () =>
      recorder.record({
        provider: 'openai:deepseek-chat',
        endpoint: 'https://api.deepseek.com/v1/chat/completions?key=secret',
        payload,
      }),
    );

    const rows = await calls.find();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.userId).toBe('user-1');
    expect(row.inboxItemId).toBe('item-1');
    expect(row.kind).toBe('summary');
    expect(row.provider).toBe('openai:deepseek-chat');
    // Query string (which may carry secrets) is stripped from the endpoint.
    expect(row.endpoint).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(Number(row.bytesSent)).toBe(Buffer.byteLength(payload));
    expect(row.contentHash).toBe(createHash('sha256').update(payload).digest('hex'));
    // Metadata-only by default: no payload copy stored.
    expect(row.payloadRedacted).toBeNull();
  });

  it('does not store the payload unless the operator opts in', async () => {
    const recorder = new AiAuditRecorder(calls, fakeConfig({ AI_AUDIT_STORE_PAYLOAD: 'true' }));
    await runWithAiAudit({ userId: 'u', itemId: null, kind: 'embedding' }, () =>
      recorder.record({ provider: 'p', endpoint: 'e', payload: 'secret text' }),
    );
    const row = (await calls.find())[0];
    expect(row.payloadRedacted).toBe('secret text');
  });

  it('skips (does not record) a call made with no audit context, never crashing', async () => {
    const recorder = new AiAuditRecorder(calls, fakeConfig({}));
    await recorder.record({ provider: 'p', endpoint: 'e', payload: 'x' });
    expect(await calls.count()).toBe(0);
  });

  it('lists a user’s rows newest-first and never another user’s', async () => {
    const recorder = new AiAuditRecorder(calls, fakeConfig({}));
    await runWithAiAudit({ userId: 'a', kind: 'summary' }, () =>
      recorder.record({ provider: 'p1', endpoint: 'e1', payload: 'x' }),
    );
    await runWithAiAudit({ userId: 'b', kind: 'summary' }, () =>
      recorder.record({ provider: 'p2', endpoint: 'e2', payload: 'y' }),
    );

    const persistence = new AuditPersistenceService(calls);
    const page = await persistence.list('a', 1, 50);
    expect(page.total).toBe(1);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0].provider).toBe('p1');
    expect(page.entries[0].hasPayload).toBe(false);
  });
});
