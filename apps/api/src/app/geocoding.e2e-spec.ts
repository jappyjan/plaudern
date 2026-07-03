import 'reflect-metadata';

// Configure the app for hardware-free, infra-free verification BEFORE the
// modules load (ConfigModule reads process.env at init). See plan §6 Path A.
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_URL = ':memory:';
process.env.STORAGE_DRIVER = 'memory';
process.env.QUEUE_DRIVER = 'inline';
process.env.AUTH_DISABLED = 'true'; // single-user mode — auth has its own spec
process.env.GEOCODER = 'stub';

import { INestApplication, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { GeocodeCacheEntity } from '@plaudern/persistence';
import { composePlace, NominatimProvider } from '@plaudern/geocoding';
import { AppModule } from './app.module';

async function createApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI });
  await app.init();
  return app;
}

describe('Geocoding (e2e, Path A, stub provider)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('resolves coordinates to a label and caches the result', async () => {
    const first = await request(app.getHttpServer())
      .get('/api/v1/geocode?lat=52.52&lon=13.405')
      .expect(200);
    expect(first.body.label).toBe('Stub City (52.5200, 13.4050)');
    expect(first.body.city).toBe('Stub City');

    const second = await request(app.getHttpServer())
      .get('/api/v1/geocode?lat=52.52&lon=13.405')
      .expect(200);
    expect(second.body).toEqual(first.body);

    const cache = app.get(DataSource).getRepository(GeocodeCacheEntity);
    const rows = await cache.find();
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe('52.5200,13.4050');
    expect(rows[0].provider).toBe('stub');
  });

  it('rejects out-of-range or missing coordinates', async () => {
    await request(app.getHttpServer()).get('/api/v1/geocode?lat=999&lon=0').expect(400);
    await request(app.getHttpServer()).get('/api/v1/geocode?lat=1').expect(400);
    await request(app.getHttpServer()).get('/api/v1/geocode').expect(400);
  });
});

describe('Geocoding (e2e, Path A, GEOCODER=off)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // The provider factory reads env at app init, so flipping it here is enough.
    process.env.GEOCODER = 'off';
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
    process.env.GEOCODER = 'stub';
  });

  it('returns a null label without calling any provider', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/geocode?lat=52.52&lon=13.405')
      .expect(200);
    expect(res.body).toEqual({ label: null, city: null });
  });
});

describe('NominatimProvider (unit)', () => {
  it('composes a short label and bare city from address parts', () => {
    expect(
      composePlace({
        address: { road: 'Unter den Linden', city: 'Berlin', country: 'Germany' },
      }),
    ).toEqual({ label: 'Unter den Linden, Berlin, Germany', city: 'Berlin' });
    expect(
      composePlace({ address: { suburb: 'Mitte', town: 'Kleinstadt' } }),
    ).toEqual({ label: 'Mitte, Kleinstadt', city: 'Kleinstadt' });
    expect(composePlace({ display_name: 'A, B, C, D, E' })).toEqual({
      label: 'A, B, C',
      city: null,
    });
    expect(composePlace({})).toBeNull();
  });

  it('deduplicates concurrent lookups for the same coordinates', async () => {
    const fetchMock = jest.fn(async () =>
      new Response(JSON.stringify({ address: { city: 'Berlin', country: 'Germany' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const original = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      const provider = new NominatimProvider('https://nominatim.example', 'test-agent');
      const [a, b, c] = await Promise.all([
        provider.reverse(52.52, 13.405),
        provider.reverse(52.52, 13.405),
        provider.reverse(52.52, 13.405),
      ]);
      const expected = { label: 'Berlin, Germany', city: 'Berlin' };
      expect(a).toEqual(expected);
      expect(b).toEqual(expected);
      expect(c).toEqual(expected);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
      expect(String(url)).toContain('lat=52.52');
      expect((init.headers as Record<string, string>)['User-Agent']).toBe('test-agent');
    } finally {
      global.fetch = original;
    }
  });

  it('returns null on an upstream error response', async () => {
    const original = global.fetch;
    global.fetch = jest.fn(
      async () => new Response('slow down', { status: 429 }),
    ) as unknown as typeof fetch;
    try {
      const provider = new NominatimProvider('https://nominatim.example', 'test-agent');
      await expect(provider.reverse(1, 2)).resolves.toBeNull();
    } finally {
      global.fetch = original;
    }
  });
});
