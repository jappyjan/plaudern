import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardBody, CardHeader, Chip, Spinner } from '@heroui/react';
import type { CommitmentDto, CommitmentStatus, ItemCommitmentsResponse } from '@plaudern/contracts';
import { getItemCommitments, retryItemCommitments, updateCommitmentStatus } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { PeopleIcon } from './icons';

/** Extraction is async — poll for the outcome while it is in flight. */
const POLL_INTERVAL_MS = 10_000;

/**
 * An item's extracted commitments (JJ-36) — what the owner owes and what others
 * owe the owner. Mirrors ItemTopicsCard's pipeline-state handling (spinner while
 * running, error + retry on failure, a manual "Extract" affordance for items
 * that predate the feature). Each commitment can be advanced through its
 * lifecycle (open → done / dismissed) inline.
 */
export function ItemCommitmentsCard({ itemId }: { itemId: string }) {
  const [data, setData] = useState<ItemCommitmentsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getItemCommitments(itemId));
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [itemId]);

  useEffect(() => {
    void load();
  }, [load]);

  // While extraction is queued/processing (fresh item, or right after a retry —
  // the retry endpoint answers `queued` immediately), keep refetching until it
  // settles. Every poll stores a new `data` object, so this effect re-arms
  // itself; the cleanup stops the chain on unmount or item change.
  useEffect(() => {
    if (!data || (data.status !== 'queued' && data.status !== 'processing')) return;
    const timer = setTimeout(() => void load(), POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [data, load]);

  const retry = async () => {
    setBusy(true);
    setActionError(null);
    try {
      setData(await retryItemCommitments(itemId));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (id: string, status: CommitmentStatus) => {
    setActionError(null);
    try {
      const updated = await updateCommitmentStatus(id, { status });
      setData((prev) =>
        prev
          ? { ...prev, commitments: prev.commitments.map((c) => (c.id === id ? updated : c)) }
          : prev,
      );
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // A module failure must not break the item page — surface it quietly.
  if (loadError) return null;

  const status = data?.status ?? null;
  const commitments = data?.commitments ?? [];
  const owedByMe = commitments.filter((c) => c.direction === 'owed_by_me');
  const owedToMe = commitments.filter((c) => c.direction === 'owed_to_me');

  return (
    <Card>
      <CardHeader className="flex items-center justify-between pb-0">
        <h2 className="text-sm font-semibold">Commitments</h2>
        {status === 'succeeded' && (
          <Button
            size="sm"
            variant="light"
            isLoading={busy}
            isDisabled={busy}
            onPress={() => void retry()}
          >
            Re-extract
          </Button>
        )}
      </CardHeader>
      <CardBody className="gap-3 text-sm">
        {!data && (
          <div className="flex items-center gap-2 text-default-500">
            <Spinner size="sm" /> Loading…
          </div>
        )}

        {data && (status === 'queued' || status === 'processing') && (
          <div className="flex items-center gap-2 text-default-500">
            <Spinner size="sm" /> Extracting commitments…
          </div>
        )}

        {data && status === 'failed' && (
          <div className="flex flex-col gap-2">
            <p className="text-danger">{data.error ?? 'Commitment extraction failed.'}</p>
            <Button
              size="sm"
              color="primary"
              variant="flat"
              className="self-start"
              isLoading={busy}
              isDisabled={busy}
              onPress={() => void retry()}
            >
              Retry extraction
            </Button>
          </div>
        )}

        {data && status === null && (
          <div className="flex flex-col gap-2">
            <p className="text-default-500">Commitments have not been extracted yet.</p>
            <Button
              size="sm"
              color="primary"
              variant="flat"
              className="self-start"
              startContent={<PeopleIcon className="h-4 w-4" />}
              isLoading={busy}
              isDisabled={busy}
              onPress={() => void retry()}
            >
              Extract now
            </Button>
          </div>
        )}

        {data && status === 'succeeded' && commitments.length === 0 && (
          <p className="text-default-500">No commitments were found in this item.</p>
        )}

        {owedByMe.length > 0 && (
          <CommitmentGroup title="You owe" commitments={owedByMe} onSetStatus={setStatus} />
        )}
        {owedToMe.length > 0 && (
          <CommitmentGroup title="Owed to you" commitments={owedToMe} onSetStatus={setStatus} />
        )}

        {actionError && <p className="text-xs text-danger">{actionError}</p>}
      </CardBody>
    </Card>
  );
}

function CommitmentGroup({
  title,
  commitments,
  onSetStatus,
}: {
  title: string;
  commitments: CommitmentDto[];
  onSetStatus: (id: string, status: CommitmentStatus) => void | Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-default-500">{title}</h3>
      <ul className="flex flex-col gap-2">
        {commitments.map((c) => (
          <CommitmentRow key={c.id} commitment={c} onSetStatus={onSetStatus} />
        ))}
      </ul>
    </div>
  );
}

function CommitmentRow({
  commitment,
  onSetStatus,
}: {
  commitment: CommitmentDto;
  onSetStatus: (id: string, status: CommitmentStatus) => void | Promise<void>;
}) {
  const settled = commitment.status !== 'open';
  const meta: string[] = [];
  if (commitment.counterpartyName) meta.push(commitment.counterpartyName);
  if (commitment.dueDate) meta.push(`due ${formatDateTime(commitment.dueDate)}`);

  return (
    <li className="flex flex-col gap-1 rounded-medium bg-default-50 p-3">
      <div className="flex items-start justify-between gap-2">
        <p className={settled ? 'text-default-400 line-through' : ''}>{commitment.description}</p>
        {commitment.status === 'fulfilled' && (
          <Chip size="sm" variant="flat" color="success">
            Done
          </Chip>
        )}
        {commitment.status === 'dismissed' && (
          <Chip size="sm" variant="flat" color="default">
            Dismissed
          </Chip>
        )}
      </div>
      {meta.length > 0 && <p className="text-xs text-default-500">{meta.join(' · ')}</p>}
      <div className="flex gap-1">
        {commitment.status === 'open' ? (
          <>
            <Button
              size="sm"
              variant="light"
              color="success"
              onPress={() => void onSetStatus(commitment.id, 'fulfilled')}
            >
              Mark done
            </Button>
            <Button
              size="sm"
              variant="light"
              onPress={() => void onSetStatus(commitment.id, 'dismissed')}
            >
              Dismiss
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="light"
            onPress={() => void onSetStatus(commitment.id, 'open')}
          >
            Reopen
          </Button>
        )}
      </div>
    </li>
  );
}
