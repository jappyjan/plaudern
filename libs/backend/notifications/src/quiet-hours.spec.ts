import {
  isWithinQuietHours,
  localMinutesInZone,
  parseTimeOfDay,
  quietHoursEndsAt,
} from './quiet-hours';

describe('parseTimeOfDay', () => {
  it('parses HH:MM into minutes since midnight', () => {
    expect(parseTimeOfDay('00:00')).toBe(0);
    expect(parseTimeOfDay('07:30')).toBe(450);
    expect(parseTimeOfDay('23:59')).toBe(1439);
  });

  it('rejects malformed values', () => {
    expect(() => parseTimeOfDay('24:00')).toThrow();
    expect(() => parseTimeOfDay('7:5')).toThrow();
    expect(() => parseTimeOfDay('noon')).toThrow();
  });
});

describe('localMinutesInZone', () => {
  it('shifts UTC into the target timezone', () => {
    // 12:00 UTC is 13:00 in Berlin (CET, winter) → 780 minutes.
    const noonUtc = new Date('2026-01-15T12:00:00Z');
    expect(localMinutesInZone(noonUtc, 'Europe/Berlin')).toBe(13 * 60);
    expect(localMinutesInZone(noonUtc, 'UTC')).toBe(12 * 60);
  });

  it('falls back to UTC on an invalid timezone', () => {
    const d = new Date('2026-01-15T09:15:00Z');
    expect(localMinutesInZone(d, 'Not/AZone')).toBe(9 * 60 + 15);
  });
});

describe('isWithinQuietHours', () => {
  it('handles a same-day window', () => {
    const tz = 'UTC';
    expect(isWithinQuietHours(new Date('2026-01-15T13:00:00Z'), tz, '12:00', '14:00')).toBe(true);
    expect(isWithinQuietHours(new Date('2026-01-15T11:59:00Z'), tz, '12:00', '14:00')).toBe(false);
    // End is exclusive.
    expect(isWithinQuietHours(new Date('2026-01-15T14:00:00Z'), tz, '12:00', '14:00')).toBe(false);
  });

  it('handles an overnight (wrapping) window', () => {
    const tz = 'UTC';
    expect(isWithinQuietHours(new Date('2026-01-15T23:30:00Z'), tz, '22:00', '07:00')).toBe(true);
    expect(isWithinQuietHours(new Date('2026-01-15T03:00:00Z'), tz, '22:00', '07:00')).toBe(true);
    expect(isWithinQuietHours(new Date('2026-01-15T12:00:00Z'), tz, '22:00', '07:00')).toBe(false);
  });

  it('evaluates the window in the user timezone', () => {
    // 05:00 UTC = 06:00 Berlin, inside 22:00→07:00 quiet hours.
    expect(
      isWithinQuietHours(new Date('2026-01-15T05:00:00Z'), 'Europe/Berlin', '22:00', '07:00'),
    ).toBe(true);
    // 07:00 UTC = 08:00 Berlin, past the window.
    expect(
      isWithinQuietHours(new Date('2026-01-15T07:00:00Z'), 'Europe/Berlin', '22:00', '07:00'),
    ).toBe(false);
  });

  it('treats an empty window as never quiet', () => {
    expect(isWithinQuietHours(new Date('2026-01-15T09:00:00Z'), 'UTC', '09:00', '09:00')).toBe(
      false,
    );
  });
});

describe('quietHoursEndsAt', () => {
  it('returns the next occurrence of the end time', () => {
    const now = new Date('2026-01-15T23:30:00Z'); // 23:30 UTC, quiet until 07:00
    const end = quietHoursEndsAt(now, 'UTC', '07:00');
    expect(end.toISOString()).toBe('2026-01-16T07:00:00.000Z');
  });
});
