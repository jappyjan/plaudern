import { resolveDocumentDate } from './document-date';

describe('resolveDocumentDate', () => {
  // The scan date only matters for expanding 2-digit years.
  const scan = '2026-07-06T12:00:00Z';
  const day = (iso: string | null) => iso?.slice(0, 10) ?? null;

  it('resolves absolute ISO dates (including past ones — no future guard)', () => {
    expect(day(resolveDocumentDate('2026-03-14', scan))).toBe('2026-03-14');
    expect(day(resolveDocumentDate('2019-11-02', scan))).toBe('2019-11-02');
    expect(day(resolveDocumentDate('2026/01/05', scan))).toBe('2026-01-05');
    expect(day(resolveDocumentDate('2026-03-14T00:00:00Z', scan))).toBe('2026-03-14');
  });

  it('resolves day-first German/European dates', () => {
    expect(day(resolveDocumentDate('14.03.2026', scan))).toBe('2026-03-14');
    expect(day(resolveDocumentDate('14/03/2026', scan))).toBe('2026-03-14');
    expect(day(resolveDocumentDate('9.8.2020', scan))).toBe('2020-08-09');
  });

  it('expands 2-digit years to the scan century', () => {
    expect(day(resolveDocumentDate('14.03.24', scan))).toBe('2024-03-14');
    // "98" is in the past century relative to a 2026 scan.
    expect(day(resolveDocumentDate('02.01.98', scan))).toBe('1998-01-02');
  });

  it('resolves month-name dates with an explicit year (EN + DE)', () => {
    expect(day(resolveDocumentDate('August 14, 2026', scan))).toBe('2026-08-14');
    expect(day(resolveDocumentDate('14 August 2026', scan))).toBe('2026-08-14');
    expect(day(resolveDocumentDate('14. März 2026', scan))).toBe('2026-03-14');
  });

  it('returns null for phrases with no absolute date', () => {
    expect(resolveDocumentDate('the 14th', scan)).toBeNull();
    expect(resolveDocumentDate('next month', scan)).toBeNull();
    expect(resolveDocumentDate('August 14', scan)).toBeNull(); // no year → ambiguous for history
    expect(resolveDocumentDate('sometime last spring', scan)).toBeNull();
    expect(resolveDocumentDate('', scan)).toBeNull();
    expect(resolveDocumentDate(null, scan)).toBeNull();
  });

  it('rejects impossible dates', () => {
    expect(resolveDocumentDate('2026-02-30', scan)).toBeNull();
    expect(resolveDocumentDate('32.01.2026', scan)).toBeNull();
    expect(resolveDocumentDate('2026-13-01', scan)).toBeNull();
  });
});
