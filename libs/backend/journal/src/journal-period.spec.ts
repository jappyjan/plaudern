import {
  dayKeyOf,
  isValidPeriodKey,
  monthKeyOf,
  parentKeyOfDay,
  periodHasEnded,
  periodLabel,
  periodRange,
  weekKeyOf,
  yearKeyOf,
} from './journal-period';

describe('journal-period', () => {
  it('derives UTC period keys from a timestamp', () => {
    const ts = '2026-06-14T22:30:00.000Z';
    expect(dayKeyOf(ts)).toBe('2026-06-14');
    expect(monthKeyOf(ts)).toBe('2026-06');
    expect(yearKeyOf(ts)).toBe('2026');
  });

  it('computes ISO week keys (Thursday rule, Monday start)', () => {
    // 2026-01-01 is a Thursday → ISO week 1 of 2026.
    expect(weekKeyOf('2026-01-01T12:00:00Z')).toBe('2026-W01');
    // 2026-06-14 is a Sunday → still week 24 (Mon 2026-06-08 .. Sun 2026-06-14).
    expect(weekKeyOf('2026-06-14T12:00:00Z')).toBe('2026-W24');
    expect(weekKeyOf('2026-06-15T00:00:00Z')).toBe('2026-W25');
  });

  it('maps a day to its parent week/month/year keys', () => {
    expect(parentKeyOfDay('2026-06-14', 'week')).toBe('2026-W24');
    expect(parentKeyOfDay('2026-06-14', 'month')).toBe('2026-06');
    expect(parentKeyOfDay('2026-06-14', 'year')).toBe('2026');
  });

  it('returns half-open UTC ranges per granularity', () => {
    expect(periodRange('day', '2026-06-14')).toEqual({
      startIso: '2026-06-14T00:00:00.000Z',
      endExclusiveIso: '2026-06-15T00:00:00.000Z',
    });
    expect(periodRange('month', '2026-06')).toEqual({
      startIso: '2026-06-01T00:00:00.000Z',
      endExclusiveIso: '2026-07-01T00:00:00.000Z',
    });
    expect(periodRange('year', '2026')).toEqual({
      startIso: '2026-01-01T00:00:00.000Z',
      endExclusiveIso: '2027-01-01T00:00:00.000Z',
    });
    // Week 24 of 2026 opens Monday 2026-06-08.
    expect(periodRange('week', '2026-W24')).toEqual({
      startIso: '2026-06-08T00:00:00.000Z',
      endExclusiveIso: '2026-06-15T00:00:00.000Z',
    });
  });

  it('knows when a period has ended relative to now', () => {
    const now = new Date('2026-06-15T09:00:00Z');
    expect(periodHasEnded('day', '2026-06-14', now)).toBe(true);
    expect(periodHasEnded('day', '2026-06-15', now)).toBe(false);
    expect(periodHasEnded('month', '2026-05', now)).toBe(true);
    expect(periodHasEnded('month', '2026-06', now)).toBe(false);
    expect(periodHasEnded('year', '2025', now)).toBe(true);
  });

  it('validates period keys per granularity', () => {
    expect(isValidPeriodKey('day', '2026-06-14')).toBe(true);
    expect(isValidPeriodKey('day', '2026-6-1')).toBe(false);
    expect(isValidPeriodKey('day', 'nonsense')).toBe(false);
    expect(isValidPeriodKey('week', '2026-W24')).toBe(true);
    expect(isValidPeriodKey('week', '2026-24')).toBe(false);
    expect(isValidPeriodKey('month', '2026-06')).toBe(true);
    expect(isValidPeriodKey('year', '2026')).toBe(true);
    expect(isValidPeriodKey('year', '20260')).toBe(false);
  });

  it('formats human labels', () => {
    expect(periodLabel('month', '2026-06')).toBe('June 2026');
    expect(periodLabel('year', '2026')).toBe('2026');
    expect(periodLabel('week', '2026-W24')).toBe('Week 24, 2026');
    expect(periodLabel('day', '2026-06-14')).toContain('June');
  });
});
