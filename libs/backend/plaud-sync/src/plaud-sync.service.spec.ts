import type { PlaudSettingsEntity } from '@plaudern/persistence';
import { PlaudApiError, type PlaudRecording } from './plaud-api.client';
import { PlaudSyncService } from './plaud-sync.service';

type Fakes = {
  settings: {
    getEntity: jest.Mock;
    getDecryptedPassword: jest.Mock;
    saveToken: jest.Mock;
    recordSyncResult: jest.Mock;
  };
  client: {
    login: jest.Mock;
    listRecordings: jest.Mock;
    downloadRecording: jest.Mock;
  };
  inbox: { findByIdempotencyKey: jest.Mock; isIdempotencyKeyTombstoned: jest.Mock };
  ingestion: { ingestBlob: jest.Mock };
};

function recording(id: string, overrides: Partial<PlaudRecording> = {}): PlaudRecording {
  return {
    id,
    filename: `${id}.mp3`,
    startTime: '2026-07-01T09:00:00.000Z',
    duration: 60000,
    fileSize: 100,
    serialNumber: 'SN1',
    isTrash: false,
    ...overrides,
  };
}

function entity(overrides: Partial<PlaudSettingsEntity> = {}): PlaudSettingsEntity {
  return {
    id: 'settings-1',
    userId: 'user-1',
    email: 'me@example.com',
    passwordEncrypted: 'v1:iv:tag:data',
    region: 'us',
    enabled: true,
    accessToken: 'cached-token',
    // far in the future so the cached token is considered fresh
    accessTokenExpiresAt: new Date(Date.now() + 200 * 24 * 60 * 60 * 1000).toISOString(),
    lastSyncAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    lastSyncImportedCount: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as PlaudSettingsEntity;
}

function build(overrides: Partial<PlaudSettingsEntity> = {}): { service: PlaudSyncService; fakes: Fakes } {
  const fakes: Fakes = {
    settings: {
      getEntity: jest.fn().mockResolvedValue(entity(overrides)),
      getDecryptedPassword: jest.fn().mockReturnValue('pw'),
      saveToken: jest.fn().mockResolvedValue(undefined),
      recordSyncResult: jest.fn().mockResolvedValue(undefined),
    },
    client: {
      login: jest.fn().mockResolvedValue({
        accessToken: 'fresh-token',
        expiresAt: new Date(Date.now() + 300 * 24 * 60 * 60 * 1000).toISOString(),
      }),
      listRecordings: jest.fn().mockResolvedValue([]),
      downloadRecording: jest
        .fn()
        .mockResolvedValue({ body: Buffer.from('audio'), contentType: 'audio/mpeg' }),
    },
    inbox: {
      findByIdempotencyKey: jest.fn().mockResolvedValue(null),
      isIdempotencyKeyTombstoned: jest.fn().mockResolvedValue(false),
    },
    ingestion: { ingestBlob: jest.fn().mockResolvedValue({ id: 'item-1' }) },
  };
  const service = new PlaudSyncService(
    fakes.settings as never,
    fakes.client as never,
    fakes.inbox as never,
    fakes.ingestion as never,
  );
  return { service, fakes };
}

describe('PlaudSyncService', () => {
  it('does nothing when settings are missing', async () => {
    const { service, fakes } = build();
    fakes.settings.getEntity.mockResolvedValue(null);
    expect(await service.syncNow('user-1')).toEqual({ started: false, alreadyRunning: false });
    expect(fakes.client.listRecordings).not.toHaveBeenCalled();
  });

  it('does nothing when sync is disabled', async () => {
    const { service, fakes } = build({ enabled: false });
    expect(await service.syncNow('user-1')).toEqual({ started: false, alreadyRunning: false });
    expect(fakes.client.listRecordings).not.toHaveBeenCalled();
  });

  it('imports new recordings through ingestBlob with the plaud idempotency key', async () => {
    const { service, fakes } = build();
    fakes.client.listRecordings.mockResolvedValue([recording('rec-1')]);

    expect(await service.syncNow('user-1')).toEqual({ started: true, alreadyRunning: false });

    expect(fakes.ingestion.ingestBlob).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        sourceType: 'plaud',
        idempotencyKey: 'plaud:rec-1',
        occurredAt: '2026-07-01T09:00:00.000Z',
        originalFilename: 'rec-1.mp3',
        contentType: 'audio/mpeg',
        metadata: expect.objectContaining({
          plaudFileId: 'rec-1',
          serialNumber: 'SN1',
          importedVia: 'plaud-cloud-sync',
        }),
      }),
    );
    expect(fakes.settings.recordSyncResult).toHaveBeenCalledWith('settings-1', {
      status: 'ok',
      error: null,
      importedCount: 1,
    });
    // cached token was fresh — no login needed
    expect(fakes.client.login).not.toHaveBeenCalled();
  });

  it('skips already-imported recordings without downloading them', async () => {
    const { service, fakes } = build();
    fakes.client.listRecordings.mockResolvedValue([recording('old'), recording('new')]);
    fakes.inbox.findByIdempotencyKey.mockImplementation((_user: string, key: string) =>
      Promise.resolve(key === 'plaud:old' ? { id: 'existing' } : null),
    );

    await service.syncNow('user-1');

    expect(fakes.client.downloadRecording).toHaveBeenCalledTimes(1);
    expect(fakes.client.downloadRecording).toHaveBeenCalledWith('us', 'cached-token', 'new');
    expect(fakes.ingestion.ingestBlob).toHaveBeenCalledTimes(1);
  });

  it('skips tombstoned (deleted) recordings without downloading them', async () => {
    const { service, fakes } = build();
    fakes.client.listRecordings.mockResolvedValue([recording('deleted'), recording('kept')]);
    fakes.inbox.isIdempotencyKeyTombstoned.mockImplementation((_user: string, key: string) =>
      Promise.resolve(key === 'plaud:deleted'),
    );

    await service.syncNow('user-1');

    expect(fakes.client.downloadRecording).toHaveBeenCalledTimes(1);
    expect(fakes.client.downloadRecording).toHaveBeenCalledWith('us', 'cached-token', 'kept');
    expect(fakes.ingestion.ingestBlob).toHaveBeenCalledTimes(1);
    expect(fakes.settings.recordSyncResult).toHaveBeenCalledWith('settings-1', {
      status: 'ok',
      error: null,
      importedCount: 1,
    });
  });

  it('ignores trashed recordings', async () => {
    const { service, fakes } = build();
    fakes.client.listRecordings.mockResolvedValue([recording('trashed', { isTrash: true })]);
    await service.syncNow('user-1');
    expect(fakes.ingestion.ingestBlob).not.toHaveBeenCalled();
    expect(fakes.settings.recordSyncResult).toHaveBeenCalledWith('settings-1', {
      status: 'ok',
      error: null,
      importedCount: 0,
    });
  });

  it('continues past a failing recording and records a partial-error result', async () => {
    const { service, fakes } = build();
    fakes.client.listRecordings.mockResolvedValue([recording('bad'), recording('good')]);
    fakes.client.downloadRecording.mockImplementation((_r: string, _t: string, id: string) =>
      id === 'bad'
        ? Promise.reject(new Error('download exploded'))
        : Promise.resolve({ body: Buffer.from('audio'), contentType: 'audio/mpeg' }),
    );

    await service.syncNow('user-1');

    expect(fakes.ingestion.ingestBlob).toHaveBeenCalledTimes(1);
    expect(fakes.settings.recordSyncResult).toHaveBeenCalledWith('settings-1', {
      status: 'error',
      error: expect.stringContaining('download exploded'),
      importedCount: 1,
    });
  });

  it('logs in when the cached token is missing or expiring soon', async () => {
    const { service, fakes } = build({ accessToken: null, accessTokenExpiresAt: null });
    await service.syncNow('user-1');
    expect(fakes.client.login).toHaveBeenCalledWith('us', 'me@example.com', 'pw');
    expect(fakes.settings.saveToken).toHaveBeenCalledWith(
      'settings-1',
      'fresh-token',
      expect.any(String),
    );
    expect(fakes.client.listRecordings).toHaveBeenCalledWith('us', 'fresh-token');
  });

  it('re-logins once when the cached token is rejected with 401', async () => {
    const { service, fakes } = build();
    fakes.client.listRecordings
      .mockRejectedValueOnce(new PlaudApiError(401, 'revoked'))
      .mockResolvedValueOnce([recording('rec-1')]);

    await service.syncNow('user-1');

    expect(fakes.client.login).toHaveBeenCalledTimes(1);
    expect(fakes.client.listRecordings).toHaveBeenLastCalledWith('us', 'fresh-token');
    expect(fakes.ingestion.ingestBlob).toHaveBeenCalledTimes(1);
  });

  it('records the failure when login/list dies entirely', async () => {
    const { service, fakes } = build();
    fakes.client.listRecordings.mockRejectedValue(new PlaudApiError(500, 'plaud is down'));

    // still resolves — the error lands in the sync result, not the caller
    expect(await service.syncNow('user-1')).toEqual({ started: true, alreadyRunning: false });
    expect(fakes.settings.recordSyncResult).toHaveBeenCalledWith('settings-1', {
      status: 'error',
      error: expect.stringContaining('plaud is down'),
      importedCount: 0,
    });
  });

  it('rejects a concurrent sync with alreadyRunning', async () => {
    const { service, fakes } = build();
    let release!: (value: PlaudRecording[]) => void;
    fakes.client.listRecordings.mockReturnValue(
      new Promise<PlaudRecording[]>((resolve) => (release = resolve)),
    );

    const first = service.syncNow('user-1');
    const second = await service.syncNow('user-1');
    expect(second).toEqual({ started: false, alreadyRunning: true });

    release([]);
    expect(await first).toEqual({ started: true, alreadyRunning: false });
    expect(service.isRunning).toBe(false);
  });
});
