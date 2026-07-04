import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardBody, CardHeader, Chip, Spinner, Tooltip } from '@heroui/react';
import type { ItemTopicsResponse } from '@plaudern/contracts';
import { Link } from 'react-router-dom';
import { getItemTopics, retryItemTopics } from '../lib/api';
import { TagIcon } from './icons';

/**
 * An item's topic assignments. Mirrors how the transcript/summary surface their
 * pipeline state: a spinner while classification runs, an error + retry when it
 * failed, and the matched topics as chips (confidence in the tooltip). A manual
 * "Classify" affordance covers items that predate the taxonomy.
 */
export function ItemTopicsCard({ itemId }: { itemId: string }) {
  const [data, setData] = useState<ItemTopicsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getItemTopics(itemId));
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [itemId]);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = async () => {
    setBusy(true);
    setActionError(null);
    try {
      setData(await retryItemTopics(itemId));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  // A calendar/topics module failure must not break the item page — surface it
  // quietly and move on.
  if (loadError) return null;

  const status = data?.status ?? null;
  const assignments = data?.assignments ?? [];

  return (
    <Card>
      <CardHeader className="flex items-center justify-between pb-0">
        <h2 className="text-sm font-semibold">Topics</h2>
        {status === 'succeeded' && (
          <Button
            size="sm"
            variant="light"
            isLoading={busy}
            isDisabled={busy}
            onPress={() => void retry()}
          >
            Reclassify
          </Button>
        )}
      </CardHeader>
      <CardBody className="gap-2 text-sm">
        {!data && (
          <div className="flex items-center gap-2 text-default-500">
            <Spinner size="sm" /> Loading…
          </div>
        )}

        {data && (status === 'queued' || status === 'processing') && (
          <div className="flex items-center gap-2 text-default-500">
            <Spinner size="sm" /> Classifying…
          </div>
        )}

        {data && status === 'failed' && (
          <div className="flex flex-col gap-2">
            <p className="text-danger">{data.error ?? 'Topic classification failed.'}</p>
            <Button
              size="sm"
              color="primary"
              variant="flat"
              className="self-start"
              isLoading={busy}
              isDisabled={busy}
              onPress={() => void retry()}
            >
              Retry classification
            </Button>
          </div>
        )}

        {data && status === null && (
          <div className="flex flex-col gap-2">
            <p className="text-default-500">This item has not been classified yet.</p>
            <Button
              size="sm"
              color="primary"
              variant="flat"
              className="self-start"
              startContent={<TagIcon className="h-4 w-4" />}
              isLoading={busy}
              isDisabled={busy}
              onPress={() => void retry()}
            >
              Classify now
            </Button>
          </div>
        )}

        {data && status === 'succeeded' && assignments.length === 0 && (
          <p className="text-default-500">No topics matched this item.</p>
        )}

        {assignments.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {assignments.map((assignment) => (
              <Tooltip
                key={assignment.topicId}
                content={`${(assignment.confidence * 100).toFixed(0)}% confidence`}
              >
                <Chip
                  as={Link}
                  to={`/topics/${assignment.topicId}`}
                  size="sm"
                  variant="flat"
                  color="primary"
                  className="cursor-pointer"
                >
                  {assignment.name}
                </Chip>
              </Tooltip>
            ))}
          </div>
        )}

        {actionError && <p className="text-xs text-danger">{actionError}</p>}
      </CardBody>
    </Card>
  );
}
