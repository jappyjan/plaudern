import { resolveDueAt } from './reminder-date';

describe('resolveDueAt', () => {
  // A fixed source timestamp; every relative phrase must resolve against THIS,
  // never against the wall clock.
  const occurredAt = '2025-03-10T09:00:00Z';
  const day = (iso: string | null) => iso?.slice(0, 10) ?? null;

  it('resolves absolute ISO dates verbatim', () => {
    expect(day(resolveDueAt('2025-08-14', occurredAt))).toBe('2025-08-14');
    expect(resolveDueAt('2025-12-31T17:00:00Z', occurredAt)).toBe('2025-12-31T17:00:00.000Z');
    expect(day(resolveDueAt('2026/01/05', occurredAt))).toBe('2026-01-05');
  });

  it('anchors relative phrases to the source timestamp, not now', () => {
    // "next month" from 2025-03-10 is 2025-04-10 — a date already in the PAST
    // relative to the real clock, which proves it did not anchor to now.
    expect(day(resolveDueAt('next month', occurredAt))).toBe('2025-04-10');
    expect(day(resolveDueAt('next week', occurredAt))).toBe('2025-03-17');
    expect(day(resolveDueAt('tomorrow', occurredAt))).toBe('2025-03-11');
    expect(day(resolveDueAt('in 3 days', occurredAt))).toBe('2025-03-13');
    expect(day(resolveDueAt('in 2 weeks', occurredAt))).toBe('2025-03-24');
    expect(day(resolveDueAt('next year', occurredAt))).toBe('2026-03-10');
  });

  it('rolls a day-of-month forward when it already passed this month', () => {
    // Said on the 10th: "the 14th" is this month; "the 5th" already passed → next.
    expect(day(resolveDueAt('the results are due by the 14th', occurredAt))).toBe('2025-03-14');
    expect(day(resolveDueAt('let us reconcile on the 5th', occurredAt))).toBe('2025-04-05');
  });

  it('resolves month-name dates, rolling the year forward when needed', () => {
    expect(day(resolveDueAt('August 14', occurredAt))).toBe('2025-08-14');
    expect(day(resolveDueAt('14 August 2027', occurredAt))).toBe('2027-08-14');
    // "February 1" already passed in 2025 → next year.
    expect(day(resolveDueAt('Feb 1st', occurredAt))).toBe('2026-02-01');
  });

  it('resolves weekdays to the next occurrence', () => {
    // 2025-03-10 is a Monday. "Friday" → 2025-03-14; "next Monday" → 2025-03-17.
    expect(day(resolveDueAt('on Friday', occurredAt))).toBe('2025-03-14');
    expect(day(resolveDueAt('next Monday', occurredAt))).toBe('2025-03-17');
  });

  it('clamps day overflow when adding months (Jan 31 + 1 month → Feb 28)', () => {
    expect(day(resolveDueAt('next month', '2025-01-31T09:00:00Z'))).toBe('2025-02-28');
  });

  it('drops dates in the past relative to the source', () => {
    expect(resolveDueAt('2020-01-01', occurredAt)).toBeNull();
    // A raw month/day that already passed with an EXPLICIT past year stays past.
    expect(resolveDueAt('January 5 2025', occurredAt)).toBeNull();
  });

  it('returns null for unparseable input rather than throwing', () => {
    expect(resolveDueAt('someday', occurredAt)).toBeNull();
    expect(resolveDueAt('', occurredAt)).toBeNull();
    expect(resolveDueAt('later', occurredAt)).toBeNull();
    expect(resolveDueAt('next month', 'not-a-date')).toBeNull();
  });
});
