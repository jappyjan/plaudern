import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardBody, CardHeader, Chip, Spinner } from '@heroui/react';
import type { SimilarItem, SimilarResponse } from '@plaudern/contracts';
import { getSimilarItems } from '../lib/api';

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

/**
 * "More like this" (JJ-38): items nearest this item's embedding centroid
 * (semantic/vector leg only). Renders nothing when semantic search is
 * unavailable (embeddings provider unconfigured) or the item has no neighbours,
 * so it never shows an empty shell — the reason is only surfaced while loading
 * completes and there is genuinely something to say.
 */
export function MoreLikeThisCard({ itemId }: { itemId: string }) {
  const [data, setData] = useState<SimilarResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
    getSimilarItems(itemId)
      .then((res) => !cancelled && setData(res))
      .catch(() => !cancelled && setData(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  // Hide the section entirely when semantic search can't run or found nothing —
  // no point showing an empty card on deployments without embeddings.
  if (!loading && (!data || !data.available || data.results.length === 0)) return null;

  return (
    <Card>
      <CardHeader className="pb-0">
        <h2 className="text-sm font-semibold">More like this</h2>
      </CardHeader>
      <CardBody className="gap-2">
        {loading && (
          <div className="flex justify-center py-4">
            <Spinner size="sm" label="Finding related memories…" />
          </div>
        )}
        {data?.results.map((r: SimilarItem) => (
          <Card key={r.itemId} as={Link} to={`/items/${r.itemId}`} isPressable shadow="sm">
            <CardBody className="gap-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{r.title ?? 'Untitled'}</span>
                <span className="shrink-0 text-xs text-default-400">
                  {formatDate(r.occurredAt)}
                </span>
              </div>
              {r.snippet && <p className="line-clamp-2 text-sm text-default-600">{r.snippet}</p>}
              <div className="mt-1">
                <Chip size="sm" variant="flat" color="secondary">
                  {Math.round(r.score * 100)}% match
                </Chip>
              </div>
            </CardBody>
          </Card>
        ))}
      </CardBody>
    </Card>
  );
}
