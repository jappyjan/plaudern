import { parseDocMetaResponse, buildUserPrompt } from './openai.provider';

describe('parseDocMetaResponse', () => {
  it('parses a well-formed document object', () => {
    const doc = parseDocMetaResponse(
      JSON.stringify({
        documentType: 'invoice',
        title: 'Invoice R-1',
        amount: 42,
        currency: 'EUR',
        fields: [{ label: 'No.', value: 'R-1' }],
      }),
    );
    expect(doc?.documentType).toBe('invoice');
    expect(doc?.amount).toBe(42);
    expect(doc?.fields).toEqual([{ label: 'No.', value: 'R-1' }]);
    // Defaulted fields from the schema:
    expect(doc?.contact).toBeNull();
    expect(doc?.expiryDate).toBeNull();
  });

  it('tolerates code-fence wrapping and surrounding prose', () => {
    const doc = parseDocMetaResponse(
      'Here you go:\n```json\n{"documentType":"letter","title":"A letter"}\n```',
    );
    expect(doc?.documentType).toBe('letter');
    expect(doc?.title).toBe('A letter');
  });

  it('returns null for an unclassifiable / empty reply', () => {
    expect(parseDocMetaResponse('not json at all')).toBeNull();
    expect(parseDocMetaResponse('{}')).toBeNull();
  });

  it('returns null when the document type is invalid', () => {
    expect(
      parseDocMetaResponse(JSON.stringify({ documentType: 'nonsense', title: 'x' })),
    ).toBeNull();
  });

  it('builds a user prompt including the scan date and OCR text', () => {
    const prompt = buildUserPrompt({ text: 'RECHNUNG', occurredAt: '2026-01-10T00:00:00.000Z' });
    expect(prompt).toContain('scan date: 2026-01-10T00:00:00.000Z');
    expect(prompt).toContain('RECHNUNG');
  });
});
