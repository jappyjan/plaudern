import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, CardBody, Chip, Spinner, Switch } from '@heroui/react';
import { Link } from 'react-router-dom';
import type { CommitmentDirection, OpenLoopDto, OpenLoopKind, OpenLoopState } from '@plaudern/contracts';
import { listOpenLoops, updateOpenLoopState } from '../lib/api';
import { LoopIcon } from '../components/icons';

type KindFilter = 'all' | 'task' | 'commitment';
type DirectionFilter = 'all' | CommitmentDirection;

/**
 * The unified open-loop ledger (JJ-29) — the "Zeigarnik list". Every unresolved
 * thread across all recordings (open tasks + open commitments both ways, later
 * questions), ranked server-side by age + importance, with one-tap done/dropped
 * and a link back to the source recording. State mutations delegate to each
 * item's source, so they survive re-extraction.
 */
export function OpenLoopsPage() {
  const [loops, setLoops] = useState<OpenLoopDto[] | null>(null);
  const [needsOwner, setNeedsOwner] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<KindFilter>('all');
  const [direction, setDirection] = useState<DirectionFilter>('all');
  const [includeResolved, setIncludeResolved] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoops(null);
    try {
      const res = await listOpenLoops({
        kind: kind === 'all' ? undefined : kind,
        direction: kind === 'commitment' && direction !== 'all' ? direction : undefined,
        includeResolved,
      });
      setLoops(res.openLoops);
      setNeedsOwner(res.needsOwner);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [kind, direction, includeResolved]);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = async (loop: OpenLoopDto, state: OpenLoopState) => {
    setBusyId(loop.id);
    try {
      const updated = await updateOpenLoopState(loop.kind, loop.id, state);
      setLoops((existing) => {
        if (!existing) return existing;
        // When resolved rows are hidden, a done/dropped loop leaves the list;
        // reopening keeps it. When resolved rows are shown, update in place.
        if (!includeResolved && updated.state !== 'open') {
          return existing.filter((l) => !(l.id === loop.id && l.kind === loop.kind));
        }
        return existing.map((l) =>
          l.id === loop.id && l.kind === loop.kind ? { ...l, state: updated.state } : l,
        );
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const rowKey = (l: OpenLoopDto) => `${l.kind}:${l.id}`;

  return (
    <div className="flex flex-col gap-5 pb-28">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Open loops</h1>
        <p className="text-sm text-default-500">
          Every unresolved thread across your recordings, oldest and most pressing first.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-1.5">
          <FilterButton active={kind === 'all'} onPress={() => setKind('all')}>
            All
          </FilterButton>
          <FilterButton active={kind === 'task'} onPress={() => setKind('task')}>
            Tasks
          </FilterButton>
          <FilterButton active={kind === 'commitment'} onPress={() => setKind('commitment')}>
            Commitments
          </FilterButton>
        </div>
        {kind === 'commitment' && (
          <div className="flex flex-wrap gap-1.5">
            <FilterButton active={direction === 'all'} onPress={() => setDirection('all')}>
              Both ways
            </FilterButton>
            <FilterButton
              active={direction === 'owed_by_me'}
              onPress={() => setDirection('owed_by_me')}
            >
              I owe
            </FilterButton>
            <FilterButton
              active={direction === 'owed_to_me'}
              onPress={() => setDirection('owed_to_me')}
            >
              Owed to me
            </FilterButton>
          </div>
        )}
        <Switch
          size="sm"
          isSelected={includeResolved}
          onValueChange={setIncludeResolved}
          classNames={{ label: 'text-sm text-default-500' }}
        >
          Show resolved
        </Switch>
      </div>

      {error && (
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>
      )}

      {loops === null && !error && (
        <div className="flex justify-center py-12">
          <Spinner label="Loading…" />
        </div>
      )}

      {loops && needsOwner && (
        <Card>
          <CardBody className="flex flex-col items-center gap-3 py-10 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-default-100 text-default-500">
              <LoopIcon className="h-6 w-6" />
            </span>
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">Tell Plaudern who you are</p>
              <p className="max-w-sm text-sm text-default-500">
                Open loops are your tasks and the commitments you owe or are owed. Mark which
                contact is you and Plaudern will fill this in from your recordings.
              </p>
            </div>
            <Button as={Link} to="/contacts" size="sm" color="primary" variant="flat">
              Choose “me” in Contacts
            </Button>
          </CardBody>
        </Card>
      )}

      {loops && !needsOwner && loops.length === 0 && (
        <Card>
          <CardBody className="flex flex-col items-center gap-3 py-10 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-default-100 text-default-500">
              <LoopIcon className="h-6 w-6" />
            </span>
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">No open loops</p>
              <p className="max-w-sm text-sm text-default-500">
                Nothing unresolved right now. Tasks and commitments extracted from your recordings
                show up here until you mark them done or dropped.
              </p>
            </div>
          </CardBody>
        </Card>
      )}

      {loops && loops.length > 0 && (
        <div className="flex flex-col gap-3">
          {loops.map((loop) => (
            <OpenLoopCard
              key={rowKey(loop)}
              loop={loop}
              busy={busyId === loop.id}
              onDone={() => void mutate(loop, 'done')}
              onDrop={() => void mutate(loop, 'dropped')}
              onReopen={() => void mutate(loop, 'open')}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterButton({
  active,
  onPress,
  children,
}: {
  active: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      size="sm"
      variant={active ? 'solid' : 'flat'}
      color={active ? 'primary' : 'default'}
      onPress={onPress}
    >
      {children}
    </Button>
  );
}

function OpenLoopCard({
  loop,
  busy,
  onDone,
  onDrop,
  onReopen,
}: {
  loop: OpenLoopDto;
  busy: boolean;
  onDone: () => void;
  onDrop: () => void;
  onReopen: () => void;
}) {
  const resolved = loop.state !== 'open';
  return (
    <Card className={resolved ? 'opacity-70' : ''}>
      <CardBody className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">{loop.title}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <KindChip loop={loop} />
            {loop.dueDate && <DueChip dueDate={loop.dueDate} overdue={loop.overdue} />}
            {loop.citationCount > 1 && (
              <Chip size="sm" variant="flat">
                mentioned {loop.citationCount}×
              </Chip>
            )}
            {loop.state === 'done' && (
              <Chip size="sm" variant="flat" color="success">
                done
              </Chip>
            )}
            {loop.state === 'dropped' && (
              <Chip size="sm" variant="flat">
                dropped
              </Chip>
            )}
          </div>
          <p className="text-xs text-default-400">
            {loop.counterpartyName ? `${loop.counterpartyName} · ` : ''}
            opened {relativeAge(loop.firstSeenAt)}
          </p>
          {loop.completionHint && (
            <p className="text-xs text-warning-600">{loop.completionHint}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!resolved ? (
            <>
              <Button size="sm" color="success" variant="flat" isLoading={busy} onPress={onDone}>
                Done
              </Button>
              <Button size="sm" variant="flat" isLoading={busy} onPress={onDrop}>
                Drop
              </Button>
            </>
          ) : (
            <Button size="sm" variant="flat" isLoading={busy} onPress={onReopen}>
              Reopen
            </Button>
          )}
          {loop.inboxItemId && (
            <Button
              as={Link}
              to={`/items/${loop.inboxItemId}`}
              size="sm"
              variant="light"
              className="ml-auto"
            >
              Open recording
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function KindChip({ loop }: { loop: OpenLoopDto }) {
  if (loop.kind === 'commitment') {
    const mine = loop.direction === 'owed_by_me';
    return (
      <Chip size="sm" variant="flat" color={mine ? 'warning' : 'secondary'}>
        {mine ? 'I owe' : 'Owed to me'}
      </Chip>
    );
  }
  if (loop.kind === 'question') {
    return (
      <Chip size="sm" variant="flat" color="primary">
        question
      </Chip>
    );
  }
  return (
    <Chip size="sm" variant="flat" color="primary">
      task
    </Chip>
  );
}

function DueChip({ dueDate, overdue }: { dueDate: string; overdue: boolean }) {
  return (
    <Chip size="sm" variant="flat" color={overdue ? 'danger' : 'default'}>
      {overdue ? 'overdue · ' : 'due '}
      {formatDate(dueDate)}
    </Chip>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Coarse "N days/weeks/months ago" — enough to convey a loop's age. */
function relativeAge(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'recently';
  const days = Math.floor((Date.now() - then) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}
