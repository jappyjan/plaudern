import { ingestInitRequestSchema } from './ingestion';
import { isAudioBearing } from './source-type';

describe('ingestInitRequestSchema', () => {
  const valid = {
    sourceType: 'plaud' as const,
    contentType: 'audio/mpeg',
    byteSize: 1024,
    occurredAt: '2026-07-01T10:00:00.000Z',
    idempotencyKey: 'plaud:serial-123:file-9',
  };

  it('accepts a valid plaud init request', () => {
    expect(ingestInitRequestSchema.parse(valid)).toMatchObject({ sourceType: 'plaud' });
  });

  it('rejects a non-positive byteSize', () => {
    expect(() => ingestInitRequestSchema.parse({ ...valid, byteSize: 0 })).toThrow();
  });

  it('rejects an unknown source type', () => {
    expect(() => ingestInitRequestSchema.parse({ ...valid, sourceType: 'video' })).toThrow();
  });
});

describe('isAudioBearing', () => {
  it('treats audio and plaud as audio-bearing', () => {
    expect(isAudioBearing('audio')).toBe(true);
    expect(isAudioBearing('plaud')).toBe(true);
  });
  it('treats text and file as not audio-bearing', () => {
    expect(isAudioBearing('text')).toBe(false);
    expect(isAudioBearing('file')).toBe(false);
  });
});
