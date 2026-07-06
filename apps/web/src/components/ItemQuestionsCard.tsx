import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardBody, CardHeader, Chip, Spinner } from '@heroui/react';
import { Link } from 'react-router-dom';
import type { QuestionDto, QuestionStatus, ItemQuestionsResponse } from '@plaudern/contracts';
import { getItemQuestions, retryItemQuestions, updateQuestionStatus } from '../lib/api';
import { formatDuration, itemDeepLink } from '../lib/format';
import { PeopleIcon, PlayIcon } from './icons';

/** Extraction is async — poll for the outcome while it is in flight. */
const POLL_INTERVAL_MS = 10_000;

/**
 * An item's extracted open questions (JJ-34) — questions the owner asked that
 * got no answer, and questions asked of the owner that they deferred. Mirrors
 * ItemCommitmentsCard's pipeline-state handling (spinner while running, error +
 * retry on failure, a manual "Extract" affordance for items that predate the
 * feature). Each question can be advanced through its lifecycle (open →
 * answered / dropped) inline.
 */
export function ItemQuestionsCard({ itemId }: { itemId: string }) {
  const [data, setData] = useState<ItemQuestionsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getItemQuestions(itemId));
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
      setData(await retryItemQuestions(itemId));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (id: string, status: QuestionStatus) => {
    setActionError(null);
    try {
      const updated = await updateQuestionStatus(id, { status });
      setData((prev) =>
        prev
          ? { ...prev, questions: prev.questions.map((q) => (q.id === id ? updated : q)) }
          : prev,
      );
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // A module failure must not break the item page — surface it quietly.
  if (loadError) return null;

  const status = data?.status ?? null;
  const questions = data?.questions ?? [];
  const askedByMe = questions.filter((q) => q.direction === 'asked_by_me');
  const askedOfMe = questions.filter((q) => q.direction === 'asked_of_me');

  return (
    <Card>
      <CardHeader className="flex items-center justify-between pb-0">
        <h2 className="text-sm font-semibold">Open questions</h2>
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
            <Spinner size="sm" /> Extracting questions…
          </div>
        )}

        {data && status === 'failed' && (
          <div className="flex flex-col gap-2">
            <p className="text-danger">{data.error ?? 'Question extraction failed.'}</p>
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
            <p className="text-default-500">Questions have not been extracted yet.</p>
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

        {data && status === 'succeeded' && questions.length === 0 && (
          <p className="text-default-500">No open questions were found in this item.</p>
        )}

        {askedByMe.length > 0 && (
          <QuestionGroup title="You asked" questions={askedByMe} onSetStatus={setStatus} />
        )}
        {askedOfMe.length > 0 && (
          <QuestionGroup title="Asked of you" questions={askedOfMe} onSetStatus={setStatus} />
        )}

        {actionError && <p className="text-xs text-danger">{actionError}</p>}
      </CardBody>
    </Card>
  );
}

function QuestionGroup({
  title,
  questions,
  onSetStatus,
}: {
  title: string;
  questions: QuestionDto[];
  onSetStatus: (id: string, status: QuestionStatus) => void | Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-default-500">{title}</h3>
      <ul className="flex flex-col gap-2">
        {questions.map((q) => (
          <QuestionRow key={q.id} question={q} onSetStatus={onSetStatus} />
        ))}
      </ul>
    </div>
  );
}

function QuestionRow({
  question,
  onSetStatus,
}: {
  question: QuestionDto;
  onSetStatus: (id: string, status: QuestionStatus) => void | Promise<void>;
}) {
  const settled = question.status !== 'open';

  return (
    <li className="flex flex-col gap-1 rounded-medium bg-default-50 p-3">
      <div className="flex items-start justify-between gap-2">
        <p className={settled ? 'text-default-400 line-through' : ''}>{question.question}</p>
        {question.status === 'answered' && (
          <Chip size="sm" variant="flat" color="success">
            Answered
          </Chip>
        )}
        {question.status === 'dropped' && (
          <Chip size="sm" variant="flat" color="default">
            Dropped
          </Chip>
        )}
      </div>
      {question.counterpartyName && (
        <p className="text-xs text-default-500">{question.counterpartyName}</p>
      )}
      {question.sourceTimestamp !== null && (
        <Button
          as={Link}
          to={itemDeepLink(question.inboxItemId, question.sourceTimestamp)}
          size="sm"
          variant="light"
          className="h-6 min-w-0 self-start px-2 text-xs text-default-500"
          startContent={<PlayIcon className="h-3 w-3" />}
        >
          Jump to {formatDuration(question.sourceTimestamp)}
        </Button>
      )}
      <div className="flex gap-1">
        {question.status === 'open' ? (
          <>
            <Button
              size="sm"
              variant="light"
              color="success"
              onPress={() => void onSetStatus(question.id, 'answered')}
            >
              Mark answered
            </Button>
            <Button
              size="sm"
              variant="light"
              onPress={() => void onSetStatus(question.id, 'dropped')}
            >
              Drop
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="light"
            onPress={() => void onSetStatus(question.id, 'open')}
          >
            Reopen
          </Button>
        )}
      </div>
    </li>
  );
}
