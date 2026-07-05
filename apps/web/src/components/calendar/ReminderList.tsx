import { Button, Chip } from '@heroui/react';
import { Link } from 'react-router-dom';
import type { ReminderDto } from '@plaudern/contracts';
import { formatTime } from '../../lib/format';

interface ReminderListProps {
  reminders: ReminderDto[];
  onUpdate: (id: string, status: 'done' | 'dismissed' | 'active') => void;
}

/**
 * The selected day's prospective-memory reminders (JJ-25). Plain positioned
 * divs — no HeroUI modal/accordion — so the row toggles reliably on iOS PWA.
 * Each reminder can be marked done or dismissed; a resolved reminder is shown
 * struck-through with a one-tap reopen.
 */
export function ReminderList({ reminders, onUpdate }: ReminderListProps) {
  if (reminders.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <span className="h-2 w-2 rounded-full bg-warning" />
        Reminders
      </h3>
      {reminders.map((reminder) => {
        const resolved = reminder.status !== 'active';
        return (
          <div
            key={reminder.id}
            className="flex items-start justify-between gap-3 rounded-medium border border-default-200 bg-content1 p-3"
          >
            <div className="flex min-w-0 flex-col gap-1">
              <span
                className={`text-sm font-medium ${resolved ? 'text-default-400 line-through' : ''}`}
              >
                {reminder.title}
              </span>
              <span className="text-xs text-default-500">
                Due {formatTime(reminder.dueAt)}
                {' · '}
                <Link to={`/items/${reminder.inboxItemId}`} className="text-primary">
                  source
                </Link>
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {reminder.status === 'done' && (
                <Chip size="sm" variant="flat" color="success">
                  Done
                </Chip>
              )}
              {reminder.status === 'dismissed' && (
                <Chip size="sm" variant="flat">
                  Dismissed
                </Chip>
              )}
              {resolved ? (
                <Button size="sm" variant="light" onPress={() => onUpdate(reminder.id, 'active')}>
                  Reopen
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="flat"
                    color="success"
                    onPress={() => onUpdate(reminder.id, 'done')}
                  >
                    Done
                  </Button>
                  <Button
                    size="sm"
                    variant="light"
                    onPress={() => onUpdate(reminder.id, 'dismissed')}
                  >
                    Dismiss
                  </Button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
