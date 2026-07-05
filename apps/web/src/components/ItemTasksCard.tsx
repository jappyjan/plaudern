import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardBody, CardHeader, Chip, Spinner, Tooltip } from '@heroui/react';
import { Link } from 'react-router-dom';
import type { ItemTasksResponse, TaskStatus } from '@plaudern/contracts';
import { getItemTasks, retryItemTasks, updateTaskStatus } from '../lib/api';

/** Extraction is async — poll for the outcome while it is in flight. */
const POLL_INTERVAL_MS = 10_000;

/**
 * An item's extracted tasks (JJ-35). Mirrors ItemTopicsCard: a spinner while
 * extraction runs, an error + retry when it failed, a manual "Extract" for items
 * that predate the feature, and the deduped tasks as interactive rows — each can
 * be completed or dismissed, and a due date shows as a chip. The task's canonical
 * title comes from the shared list, so completing it here reflects everywhere.
 */
export function ItemTasksCard({ itemId }: { itemId: string }) {
  const [data, setData] = useState<ItemTasksResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getItemTasks(itemId));
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [itemId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep refetching while extraction is queued/processing (fresh item, or right
  // after a retry). Every poll stores a new `data` object, so this effect
  // re-arms itself; the cleanup stops the chain on unmount or item change.
  useEffect(() => {
    if (!data || (data.status !== 'queued' && data.status !== 'processing')) return;
    const timer = setTimeout(() => void load(), POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [data, load]);

  const retry = async () => {
    setBusy(true);
    setActionError(null);
    try {
      setData(await retryItemTasks(itemId));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (taskId: string, status: TaskStatus) => {
    setPendingTaskId(taskId);
    setActionError(null);
    try {
      const updated = await updateTaskStatus(taskId, status);
      setData((prev) =>
        prev
          ? {
              ...prev,
              tasks: prev.tasks.map((t) =>
                t.taskId === taskId ? { ...t, status: updated.status } : t,
              ),
            }
          : prev,
      );
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPendingTaskId(null);
    }
  };

  // A tasks-module failure must not break the item page — surface it quietly.
  if (loadError) return null;

  const status = data?.status ?? null;
  const tasks = data?.tasks ?? [];

  return (
    <Card>
      <CardHeader className="flex items-center justify-between pb-0">
        <h2 className="text-sm font-semibold">Tasks</h2>
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
      <CardBody className="gap-2 text-sm">
        {!data && (
          <div className="flex items-center gap-2 text-default-500">
            <Spinner size="sm" /> Loading…
          </div>
        )}

        {data?.needsOwner && (
          <div className="flex flex-col gap-2">
            <p className="text-default-500">
              Tell Plaudern which contact is you to extract your tasks — only your own tasks are
              listed, never other people's.
            </p>
            <Button
              as={Link}
              to="/contacts"
              size="sm"
              color="primary"
              variant="flat"
              className="self-start"
            >
              Choose “me” in Contacts
            </Button>
          </div>
        )}

        {data && !data.needsOwner && (status === 'queued' || status === 'processing') && (
          <div className="flex items-center gap-2 text-default-500">
            <Spinner size="sm" /> Extracting tasks…
          </div>
        )}

        {data && status === 'failed' && (
          <div className="flex flex-col gap-2">
            <p className="text-danger">{data.error ?? 'Task extraction failed.'}</p>
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

        {data && !data.needsOwner && status === null && (
          <div className="flex flex-col gap-2">
            <p className="text-default-500">This item has not been processed for tasks yet.</p>
            <Button
              size="sm"
              color="primary"
              variant="flat"
              className="self-start"
              isLoading={busy}
              isDisabled={busy}
              onPress={() => void retry()}
            >
              Extract now
            </Button>
          </div>
        )}

        {data && status === 'succeeded' && tasks.length === 0 && (
          <p className="text-default-500">No tasks found in this item.</p>
        )}

        {tasks.length > 0 && (
          <ul className="flex flex-col gap-2">
            {tasks.map((task) => {
              const done = task.status !== 'open';
              const pending = pendingTaskId === task.taskId;
              return (
                <li key={task.taskId} className="flex items-start justify-between gap-2">
                  <div className="flex flex-col gap-1">
                    <Tooltip
                      isDisabled={!task.quote}
                      content={task.quote ?? ''}
                      className="max-w-xs"
                    >
                      <span
                        className={
                          done
                            ? 'line-through text-default-400'
                            : 'text-default-700 dark:text-default-300'
                        }
                      >
                        {task.title}
                      </span>
                    </Tooltip>
                    <div className="flex flex-wrap items-center gap-1">
                      {task.dueDate && (
                        <Chip size="sm" variant="flat" color="warning">
                          Due {task.dueDate}
                        </Chip>
                      )}
                      {task.status === 'completed' && (
                        <Chip size="sm" variant="flat" color="success">
                          Completed
                        </Chip>
                      )}
                      {task.status === 'dismissed' && (
                        <Chip size="sm" variant="flat" color="default">
                          Dismissed
                        </Chip>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {task.status === 'open' ? (
                      <>
                        <Button
                          size="sm"
                          variant="flat"
                          color="success"
                          isLoading={pending}
                          isDisabled={pending}
                          onPress={() => void setStatus(task.taskId, 'completed')}
                        >
                          Done
                        </Button>
                        <Button
                          size="sm"
                          variant="light"
                          isDisabled={pending}
                          onPress={() => void setStatus(task.taskId, 'dismissed')}
                        >
                          Dismiss
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="light"
                        isLoading={pending}
                        isDisabled={pending}
                        onPress={() => void setStatus(task.taskId, 'open')}
                      >
                        Reopen
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {actionError && <p className="text-xs text-danger">{actionError}</p>}
      </CardBody>
    </Card>
  );
}
