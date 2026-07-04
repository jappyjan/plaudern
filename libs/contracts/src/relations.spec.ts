import { entityConnectQuerySchema } from './relations';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

describe('entityConnectQuerySchema', () => {
  it('parses a comma-separated id list with defaults', () => {
    const parsed = entityConnectQuerySchema.parse({ ids: `${A},${B}` });
    expect(parsed.ids).toEqual([A, B]);
    expect(parsed.maxDepth).toBe(3);
    expect(parsed.includeCooccurrence).toBe(true);
  });

  it('rejects duplicate ids that collapse below two distinct entities', () => {
    expect(entityConnectQuerySchema.safeParse({ ids: `${A},${A}` }).success).toBe(false);
    // Three ids with one duplicate still name two distinct entities — fine.
    expect(entityConnectQuerySchema.safeParse({ ids: `${A},${A},${B}` }).success).toBe(true);
  });

  it('rejects fewer than 2 or more than 3 ids and non-uuids', () => {
    expect(entityConnectQuerySchema.safeParse({ ids: A }).success).toBe(false);
    expect(
      entityConnectQuerySchema.safeParse({ ids: `${A},${B},${C},${A}` }).success,
    ).toBe(false);
    expect(entityConnectQuerySchema.safeParse({ ids: `${A},nope` }).success).toBe(false);
  });

  it('parses includeCooccurrence as a boolean and rejects junk', () => {
    expect(
      entityConnectQuerySchema.parse({ ids: `${A},${B}`, includeCooccurrence: 'false' })
        .includeCooccurrence,
    ).toBe(false);
    expect(
      entityConnectQuerySchema.safeParse({ ids: `${A},${B}`, includeCooccurrence: 'nope' })
        .success,
    ).toBe(false);
  });

  it('bounds maxDepth to 1..3', () => {
    expect(entityConnectQuerySchema.safeParse({ ids: `${A},${B}`, maxDepth: '9' }).success).toBe(
      false,
    );
    expect(entityConnectQuerySchema.parse({ ids: `${A},${B}`, maxDepth: '2' }).maxDepth).toBe(2);
  });
});
