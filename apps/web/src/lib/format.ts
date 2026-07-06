export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 'B';
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(1)} ${unit}`;
}

export function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The date to show for an item: for a scanned document with an extracted date
 * printed on it, prefer that; otherwise the capture/upload time. Keeps a single
 * rule so every date display stays consistent.
 */
export function itemDate(item: { documentDate?: string | null; occurredAt: string }): string {
  return item.documentDate ?? item.occurredAt;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(undefined, { timeStyle: 'short' });
}

export function formatTimeRange(startIso: string, endIso: string): string {
  return startIso === endIso ? formatTime(startIso) : `${formatTime(startIso)} – ${formatTime(endIso)}`;
}

/** Day key in the browser's local timezone — timed things bucket by the day the user experienced. */
export function localDayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** UTC day key — all-day events are stored as UTC calendar-date midnights. */
export function utcDayKey(iso: string): string {
  return iso.slice(0, 10);
}

export interface MonthGridDay {
  key: string; // YYYY-MM-DD (local)
  dayOfMonth: number;
  inMonth: boolean;
  date: Date; // local midnight
}

/** 42-cell Monday-start month grid including adjacent-month filler days. */
export function monthGridDays(year: number, month: number): MonthGridDay[] {
  const first = new Date(year, month, 1);
  // getDay(): 0 = Sunday; shift so Monday is column 0.
  const lead = (first.getDay() + 6) % 7;
  const days: MonthGridDay[] = [];
  for (let i = 0; i < 42; i += 1) {
    const date = new Date(year, month, 1 - lead + i);
    days.push({
      key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
      dayOfMonth: date.getDate(),
      inMonth: date.getMonth() === month,
      date,
    });
  }
  return days;
}
