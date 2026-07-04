import { resolveDueDate } from './date-resolver';

// Anchor: Wednesday, 2026-07-01T09:00:00Z.
const ANCHOR = '2026-07-01T09:00:00.000Z';

/** The date (YYYY-MM-DD) portion of a resolved instant, for readable asserts. */
function day(iso: string | null): string | null {
  return iso ? iso.slice(0, 10) : null;
}

describe('resolveDueDate', () => {
  it('returns null for empty/unresolvable input', () => {
    expect(resolveDueDate(null, ANCHOR)).toBeNull();
    expect(resolveDueDate('', ANCHOR)).toBeNull();
    expect(resolveDueDate('sometime soon', ANCHOR)).toBeNull();
    expect(resolveDueDate('Friday', null)).toBeNull();
    expect(resolveDueDate('Friday', 'not-a-date')).toBeNull();
  });

  it('resolves today/tomorrow/day after tomorrow', () => {
    expect(day(resolveDueDate('today', ANCHOR))).toBe('2026-07-01');
    expect(day(resolveDueDate('tonight', ANCHOR))).toBe('2026-07-01');
    expect(day(resolveDueDate('tomorrow', ANCHOR))).toBe('2026-07-02');
    expect(day(resolveDueDate('day after tomorrow', ANCHOR))).toBe('2026-07-03');
  });

  it('strips promissory prepositions', () => {
    expect(day(resolveDueDate('by Friday', ANCHOR))).toBe('2026-07-03');
    expect(day(resolveDueDate('before tomorrow', ANCHOR))).toBe('2026-07-02');
    expect(day(resolveDueDate('due Monday', ANCHOR))).toBe('2026-07-06');
  });

  it('resolves the next occurrence of a weekday (never the anchor day itself)', () => {
    // Anchor is a Wednesday; "Friday" is 2 days out.
    expect(day(resolveDueDate('Friday', ANCHOR))).toBe('2026-07-03');
    // "Wednesday" on a Wednesday jumps a full week.
    expect(day(resolveDueDate('Wednesday', ANCHOR))).toBe('2026-07-08');
    // "Monday" is the following Monday.
    expect(day(resolveDueDate('Monday', ANCHOR))).toBe('2026-07-06');
  });

  it('treats "next <weekday>" as the following week', () => {
    // Plain Friday = 07-03; next Friday = 07-10.
    expect(day(resolveDueDate('next Friday', ANCHOR))).toBe('2026-07-10');
  });

  it('resolves next week / next month', () => {
    expect(day(resolveDueDate('next week', ANCHOR))).toBe('2026-07-08');
    expect(day(resolveDueDate('next month', ANCHOR))).toBe('2026-08-01');
  });

  it('resolves "in N days/weeks/months"', () => {
    expect(day(resolveDueDate('in 3 days', ANCHOR))).toBe('2026-07-04');
    expect(day(resolveDueDate('in 2 weeks', ANCHOR))).toBe('2026-07-15');
    expect(day(resolveDueDate('in 1 month', ANCHOR))).toBe('2026-08-01');
  });

  it('resolves end of week / end of month', () => {
    // End of week = upcoming Friday.
    expect(day(resolveDueDate('end of the week', ANCHOR))).toBe('2026-07-03');
    expect(day(resolveDueDate('end of the month', ANCHOR))).toBe('2026-07-31');
  });

  it('accepts an already-absolute ISO date', () => {
    expect(day(resolveDueDate('2026-09-15', ANCHOR))).toBe('2026-09-15');
    expect(day(resolveDueDate('2026-09-15T12:00:00Z', ANCHOR))).toBe('2026-09-15');
  });

  it('pins resolved dates to a stable 17:00 UTC instant', () => {
    expect(resolveDueDate('tomorrow', ANCHOR)).toBe('2026-07-02T17:00:00.000Z');
  });
});
