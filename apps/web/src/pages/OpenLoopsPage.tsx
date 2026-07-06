import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, CardBody, Chip, Spinner, Switch } from '@heroui/react';
import { Link } from 'react-router-dom';
import type {
  CommitmentDirection,
  NudgeDto,
  OpenLoopDto,
  OpenLoopKind,
  OpenLoopState,
} from '@plaudern/contracts';
import { actOnNudge, listNudges, listOpenLoops, updateOpenLoopState } from '../lib/api';
import { LoopIcon } from '../components/icons';

type KindFilter = 'all' | 'task' | 'commitment' | 'question';
type DirectionFilter = 'all' | CommitmentDirection;

/** Commitments and (normalized) questions carry a who-owes-whom direction. */
const DIRECTIONAL_KINDS: KindFilter[] = ['commitment', 'question'];

/**
 * The unified open-loop ledger (JJ-29) — the "Zeigarnik list". Every unresolved
 * thread across all recordings (open tasks, open commitments both ways, and
 * unanswered questions), ranked server-side by age + importance, with one-tap
 * done/dropped and a link back to the source recording. State mutations
 * delegate to each item's source, so they survive re-extraction.
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
        direction:
          DIRECTIONAL_KINDS.includes(kind) && direction !== 'all' ? direction : undefined,
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

      <NudgesSection />

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
          <FilterButton active={kind === 'question'} onPress={() => setKind('question')}>
            Questions
          </FilterButton>
        </div>
        {DIRECTIONAL_KINDS.includes(kind) && (
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
                {loop.kind === 'question' ? 'answered' : 'done'}
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
                {loop.kind === 'question' ? 'Answered' : 'Done'}
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
    // Direction is normalized server-side: owed_by_me = I owe the answer.
    const mine = loop.direction === 'owed_by_me';
    return (
      <Chip size="sm" variant="flat" color={mine ? 'warning' : 'secondary'}>
        {mine ? 'question · I owe an answer' : 'question · awaiting answer'}
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

const SNOOZE_OPTIONS: { label: string; days: number }[] = [
  { label: '1 day', days: 1 },
  { label: '3 days', days: 3 },
  { label: '1 week', days: 7 },
];

/**
 * Proactive commitment nudges (JJ-26), surfaced above the ledger: promises whose
 * deadline is approaching with no evidence you followed through, and stale
 * incoming promises worth chasing. Only unresolved commitments appear (a later
 * recording mentioning it was done drops it). Each nudge can be snoozed or
 * dismissed, and carries a ready-to-copy follow-up draft.
 */
function NudgesSection() {
  const [nudges, setNudges] = useState<NudgeDto[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [snoozeOpenFor, setSnoozeOpenFor] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listNudges()
      .then((res) => {
        if (!cancelled) setNudges(res.nudges);
      })
      .catch(() => {
        // A nudge fetch failure must never break the ledger — just show nothing.
        if (!cancelled) setNudges([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const act = async (n: NudgeDto, days?: number) => {
    setBusyId(n.commitmentId);
    setSnoozeOpenFor(null);
    try {
      await actOnNudge(n.commitmentId, days ? { action: 'snooze', snoozeDays: days } : { action: 'dismiss' });
      setNudges((existing) => existing?.filter((x) => x.commitmentId !== n.commitmentId) ?? existing);
    } catch {
      // Leave the nudge in place on failure; the next load reconciles.
    } finally {
      setBusyId(null);
    }
  };

  if (!nudges || nudges.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">Nudges</h2>
        <Chip size="sm" variant="flat" color="warning">
          {nudges.length}
        </Chip>
      </div>
      <div className="flex flex-col gap-2">
        {nudges.map((n) => (
          <NudgeCard
            key={n.commitmentId}
            nudge={n}
            busy={busyId === n.commitmentId}
            snoozeOpen={snoozeOpenFor === n.commitmentId}
            onToggleSnooze={() =>
              setSnoozeOpenFor((cur) => (cur === n.commitmentId ? null : n.commitmentId))
            }
            onSnooze={(days) => void act(n, days)}
            onDismiss={() => void act(n)}
          />
        ))}
      </div>
    </div>
  );
}

function NudgeCard({
  nudge,
  busy,
  snoozeOpen,
  onToggleSnooze,
  onSnooze,
  onDismiss,
}: {
  nudge: NudgeDto;
  busy: boolean;
  snoozeOpen: boolean;
  onToggleSnooze: () => void;
  onSnooze: (days: number) => void;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const mine = nudge.direction === 'owed_by_me';

  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(nudge.draftText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — no-op.
    }
  };

  return (
    <Card className="border border-warning-200 bg-warning-50/40">
      <CardBody className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">{nudge.description}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip size="sm" variant="flat" color={mine ? 'warning' : 'secondary'}>
              {mine ? 'I owe' : 'Owed to me'}
            </Chip>
            <NudgeReasonChip reason={nudge.reason} dueDate={nudge.dueDate} />
          </div>
          <p className="text-xs text-default-400">
            {nudge.counterpartyName ? `${nudge.counterpartyName} · ` : ''}
            promised {relativeAge(nudge.occurredAt)}
          </p>
        </div>

        <div className="rounded-medium bg-default-100 p-2.5">
          <p className="text-xs text-default-600">{nudge.draftText}</p>
          <Button size="sm" variant="light" className="mt-1 h-7 min-w-0 px-2" onPress={() => void copyDraft()}>
            {copied ? 'Copied' : 'Copy draft'}
          </Button>
        </div>

        <div className="relative flex flex-wrap items-center gap-2">
          <Button size="sm" variant="flat" isDisabled={busy} onPress={onToggleSnooze}>
            Snooze
          </Button>
          {snoozeOpen && (
            // Plain toggled div (not a HeroUI dropdown/popover) so the overlay
            // opens reliably on iOS PWA.
            <div className="absolute bottom-full left-0 z-10 mb-1 flex flex-col gap-0.5 rounded-medium border border-default-200 bg-content1 p-1 shadow-medium">
              {SNOOZE_OPTIONS.map((opt) => (
                <button
                  key={opt.days}
                  type="button"
                  className="rounded-small px-3 py-1.5 text-left text-sm hover:bg-default-100"
                  onClick={() => onSnooze(opt.days)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
          <Button size="sm" variant="flat" isLoading={busy} onPress={onDismiss}>
            Dismiss
          </Button>
          {nudge.inboxItemId && (
            <Button
              as={Link}
              to={`/items/${nudge.inboxItemId}`}
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

function NudgeReasonChip({ reason, dueDate }: { reason: NudgeDto['reason']; dueDate: string | null }) {
  if (reason === 'overdue') {
    return (
      <Chip size="sm" variant="flat" color="danger">
        overdue{dueDate ? ` · ${formatDate(dueDate)}` : ''}
      </Chip>
    );
  }
  if (reason === 'due_soon') {
    return (
      <Chip size="sm" variant="flat" color="warning">
        due {dueDate ? formatDate(dueDate) : 'soon'}
      </Chip>
    );
  }
  return (
    <Chip size="sm" variant="flat">
      stale
    </Chip>
  );
}
