import { BadRequestException } from '@nestjs/common';
import type { EmailSettingsEntity } from '@plaudern/persistence';
import { EmailSettingsService } from './email-settings.service';

type Fakes = {
  repo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  config: { get: jest.Mock };
};

function build(env: Record<string, string> = {}): { service: EmailSettingsService; fakes: Fakes } {
  const store = new Map<string, EmailSettingsEntity>();
  const fakes: Fakes = {
    repo: {
      findOne: jest.fn(({ where }: { where: Partial<EmailSettingsEntity> }) => {
        const match = [...store.values()].find((row) =>
          Object.entries(where).every(([k, v]) => (row as never)[k] === v),
        );
        return Promise.resolve(match ?? null);
      }),
      create: jest.fn((partial: Partial<EmailSettingsEntity>) => ({
        id: `row-${store.size + 1}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...partial,
      })) as unknown as jest.Mock,
      save: jest.fn((entity: EmailSettingsEntity) => {
        store.set(entity.id, entity);
        return Promise.resolve(entity);
      }),
    },
    config: {
      get: jest.fn((key: string, fallback: string) => env[key] ?? fallback),
    },
  };
  const service = new EmailSettingsService(fakes.repo as never, fakes.config as never);
  return { service, fakes };
}

const ENV = { APP_ENCRYPTION_SECRET: 'super-secret', EMAIL_INBOUND_DOMAIN: 'in.example.com' };

describe('EmailSettingsService', () => {
  it('reports unconfigured when no row exists yet', async () => {
    const { service } = build(ENV);
    expect(service.toDto(await service.getEntity('user-1'))).toEqual({
      configured: false,
      enabled: false,
      address: null,
    });
  });

  it('generates a token on first call and derives a stable, decryptable address', async () => {
    const { service } = build(ENV);

    const entity = await service.generateOrRotateToken('user-1');
    const dto = service.toDto(entity);

    expect(dto.configured).toBe(true);
    expect(dto.enabled).toBe(true);
    expect(dto.address).toMatch(/^inbox\+[A-Za-z0-9_-]+@in\.example\.com$/);

    // Reading it back later returns the exact same address.
    const reread = service.toDto(await service.getEntity('user-1'));
    expect(reread.address).toBe(dto.address);
  });

  it('rotating replaces the token so the old address stops resolving', async () => {
    const { service } = build(ENV);
    await service.generateOrRotateToken('user-1');
    const before = service.toDto(await service.getEntity('user-1'));
    const beforeToken = before.address!.match(/^inbox\+([^@]+)@/)![1];

    const rotated = service.toDto(await service.generateOrRotateToken('user-1'));
    const afterToken = rotated.address!.match(/^inbox\+([^@]+)@/)![1];

    expect(afterToken).not.toBe(beforeToken);
    expect(await service.resolveUserId(beforeToken)).toBeNull();
    expect(await service.resolveUserId(afterToken)).toBe('user-1');
  });

  it('resolveUserId returns null for an unknown token', async () => {
    const { service } = build(ENV);
    expect(await service.resolveUserId('does-not-exist')).toBeNull();
  });

  it('resolveUserId returns null once the address is disabled', async () => {
    const { service } = build(ENV);
    const entity = await service.generateOrRotateToken('user-1');
    const token = service.toDto(entity).address!.match(/^inbox\+([^@]+)@/)![1];

    await service.setEnabled('user-1', false);

    expect(await service.resolveUserId(token)).toBeNull();
  });

  it('setEnabled without a generated token first is rejected', async () => {
    const { service } = build(ENV);
    await expect(service.setEnabled('user-1', true)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('generateOrRotateToken requires APP_ENCRYPTION_SECRET to be configured', async () => {
    const { service } = build({ EMAIL_INBOUND_DOMAIN: 'in.example.com' });
    await expect(service.generateOrRotateToken('user-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('address is null when EMAIL_INBOUND_DOMAIN is not configured, even once a token exists', async () => {
    const { service } = build({ APP_ENCRYPTION_SECRET: 'super-secret' });
    const entity = await service.generateOrRotateToken('user-1');
    expect(service.toDto(entity).address).toBeNull();
  });
});
