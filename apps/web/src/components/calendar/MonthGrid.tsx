import { Button } from '@heroui/react';
import { monthGridDays } from '../../lib/format';
import { BackIcon } from '../icons';

export interface DayMarkers {
  hasEvents: boolean;
  hasRecordings: boolean;
}

interface MonthGridProps {
  year: number;
  month: number; // 0-based
  markers: Map<string, DayMarkers>;
  selectedKey: string;
  todayKey: string;
  onSelect: (dayKey: string) => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onToday: () => void;
}

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

export function MonthGrid({
  year,
  month,
  markers,
  selectedKey,
  todayKey,
  onSelect,
  onPrevMonth,
  onNextMonth,
  onToday,
}: MonthGridProps) {
  const days = monthGridDays(year, month);
  const monthLabel = new Date(year, month, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{monthLabel}</h2>
        <div className="flex items-center gap-1">
          <Button isIconOnly variant="light" size="sm" aria-label="Previous month" onPress={onPrevMonth}>
            <BackIcon className="h-4 w-4" />
          </Button>
          <Button variant="light" size="sm" onPress={onToday}>
            Today
          </Button>
          <Button isIconOnly variant="light" size="sm" aria-label="Next month" onPress={onNextMonth}>
            <BackIcon className="h-4 w-4 rotate-180" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-xs text-default-500">
        {WEEKDAYS.map((weekday) => (
          <div key={weekday} className="py-1">
            {weekday}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {days.map((day) => {
          const mark = markers.get(day.key);
          const isSelected = day.key === selectedKey;
          const isToday = day.key === todayKey;
          return (
            <button
              key={day.key}
              type="button"
              onClick={() => onSelect(day.key)}
              aria-label={day.date.toLocaleDateString()}
              aria-pressed={isSelected}
              className={[
                'flex aspect-square flex-col items-center justify-center rounded-medium text-sm transition-colors',
                day.inMonth ? '' : 'text-default-400',
                isSelected ? 'bg-primary text-primary-foreground' : 'hover:bg-default-100',
                isToday && !isSelected ? 'ring-1 ring-primary' : '',
              ].join(' ')}
            >
              <span>{day.dayOfMonth}</span>
              <span className="flex h-1.5 items-center gap-0.5">
                {mark?.hasEvents && (
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${isSelected ? 'bg-primary-foreground' : 'bg-primary'}`}
                  />
                )}
                {mark?.hasRecordings && (
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${isSelected ? 'bg-primary-foreground/60' : 'bg-success'}`}
                  />
                )}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-4 text-xs text-default-500">
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" /> Events
        </span>
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-success" /> Recordings
        </span>
      </div>
    </div>
  );
}
