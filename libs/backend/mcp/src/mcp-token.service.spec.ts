import type { McpTokenEntity } from '@plaudern/persistence';
import { McpTokenService } from './mcp-token.service';

function build(): { service: McpTokenService; store: Map<string, McpTokenEntity> } {
  const store = new Map<string, McpTokenEntity>();
  const matches = (row: McpTokenEntity, where: Partial<McpTokenEntity>) =>
    Object.entries(where).every(([k, v]) => (row as never)[k] === v);
  const repo = {
    findOne: jest.fn(({ where }: { where: Partial<McpTokenEntity> }) =>
      Promise.resolve([...store.values()].find((row) => matches(row, where)) ?? null),
    ),
    create: jest.fn((partial: Partial<McpTokenEntity>) => ({
      id: `row-${store.size + 1}`,
      createdAt: new Date('2026-07-04T00:00:00.000Z'),
      lastUsedAt: null,
      ...partial,
    })),
    save: jest.fn((entity: McpTokenEntity) => {
      store.set(entity.id, entity);
      return Promise.resolve(entity);
    }),
    update: jest.fn((where: Partial<McpTokenEntity>, patch: Partial<McpTokenEntity>) => {
      const row = [...store.values()].find((r) => matches(r, where));
      if (row) Object.assign(row, patch);
      return Promise.resolve({ affected: row ? 1 : 0 });
    }),
    delete: jest.fn((where: Partial<McpTokenEntity>) => {
      for (const [id, row] of store) if (matches(row, where)) store.delete(id);
      return Promise.resolve({ affected: 1 });
    }),
  };
  const service = new McpTokenService(repo as never);
  return { service, store };
}

describe('McpTokenService', () => {
  it('reports unconfigured when no token exists yet', async () => {
    const { service } = build();
    expect(service.toStatusDto(await service.getEntity('user-1'))).toEqual({
      configured: false,
      tokenPrefix: null,
      createdAt: null,
      lastUsedAt: null,
    });
  });

  it('mints a token, returns the plaintext once, and stores only its hash', async () => {
    const { service, store } = build();
    const created = await service.mint('user-1');

    expect(created.configured).toBe(true);
    expect(created.token).toMatch(/^mcp_[A-Za-z0-9_-]+$/);
    expect(created.tokenPrefix).toBe(created.token.slice(0, 8));

    const row = [...store.values()][0];
    // The plaintext is never stored — only a hash and a short display prefix.
    expect((row as { tokenHash: string }).tokenHash).not.toContain(created.token);
    expect(row.tokenPrefix).toBe(created.token.slice(0, 8));
  });

  it('resolves a valid token to its owner and rejects unknown tokens', async () => {
    const { service } = build();
    const { token } = await service.mint('user-1');

    expect(await service.resolveUserId(token)).toBe('user-1');
    expect(await service.resolveUserId('mcp_bogus')).toBeNull();
    expect(await service.resolveUserId('')).toBeNull();
  });

  it('rotating replaces the token so the old one stops resolving', async () => {
    const { service } = build();
    const first = await service.mint('user-1');
    const second = await service.mint('user-1');

    expect(second.token).not.toBe(first.token);
    expect(await service.resolveUserId(first.token)).toBeNull();
    expect(await service.resolveUserId(second.token)).toBe('user-1');
  });

  it('revoking deletes the token so it no longer resolves', async () => {
    const { service } = build();
    const { token } = await service.mint('user-1');

    await service.revoke('user-1');

    expect(await service.resolveUserId(token)).toBeNull();
    expect(service.toStatusDto(await service.getEntity('user-1')).configured).toBe(false);
  });

  it('records lastUsedAt on first use', async () => {
    const { service } = build();
    const { token } = await service.mint('user-1');
    expect(service.toStatusDto(await service.getEntity('user-1')).lastUsedAt).toBeNull();

    await service.resolveUserId(token);

    expect(service.toStatusDto(await service.getEntity('user-1')).lastUsedAt).not.toBeNull();
  });
});
