import { useCallback, useEffect, useState } from 'react';
import { Button, Spinner } from '@heroui/react';
import { Link } from 'react-router-dom';
import type { AuditLogListResponse } from '@plaudern/contracts';
import { fetchAuditLog } from '../lib/api';
import { formatBytes, formatDateTime } from '../lib/format';

const PAGE_SIZE = 50;

/**
 * The AI-provider audit log (JJ-42): every call this instance made to an
 * external AI provider on the user's behalf — which item, which kind, which
 * provider + endpoint, when, how many bytes were sent, and the payload's
 * content hash. Reached from Settings; deliberately NOT a bottom-nav tab.
 */
export function AuditLogPage() {
  const [data, setData] = useState<AuditLogListResponse | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchAuditLog(p, PAGE_SIZE));
      setPage(p);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(1);
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">AI-provider audit log</h1>
          <p className="text-sm text-default-500">
            Every byte this instance sent to an external AI provider on your behalf. Only metadata,
            size and a content hash are recorded — never the payload itself.
          </p>
        </div>
        <Button as={Link} to="/settings" size="sm" variant="flat">
          Back
        </Button>
      </div>

      {error && (
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>
      )}

      {data === null && loading ? (
        <div className="flex justify-center py-12">
          <Spinner label="Loading audit log…" />
        </div>
      ) : data && data.entries.length === 0 ? (
        <p className="rounded-medium bg-default-50 p-4 text-sm text-default-500">
          No external AI-provider calls have been recorded yet.
        </p>
      ) : (
        data && (
          <>
            <div className="flex flex-col gap-2">
              {data.entries.map((e) => (
                <div key={e.id} className="flex flex-col gap-1 rounded-medium bg-default-50 p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{e.provider}</span>
                    <span className="text-xs text-default-500">{formatDateTime(e.createdAt)}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-default-500">
                    <span className="rounded bg-default-200 px-1.5 py-0.5 text-default-700">
                      {e.kind}
                    </span>
                    <span>{formatBytes(e.bytesSent)} sent</span>
                    {e.itemId && (
                      <Link to={`/items/${e.itemId}`} className="text-primary underline">
                        item
                      </Link>
                    )}
                    {e.hasPayload && <span className="text-warning">payload stored</span>}
                  </div>
                  <code className="truncate text-xs text-default-400">{e.endpoint}</code>
                  <code className="truncate text-[10px] text-default-400">sha256:{e.contentHash}</code>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between pt-2">
              <span className="text-xs text-default-500">
                Page {data.page} · {data.total} call{data.total === 1 ? '' : 's'} total
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="flat"
                  isDisabled={page <= 1 || loading}
                  onPress={() => void load(page - 1)}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="flat"
                  isDisabled={!data.hasMore || loading}
                  onPress={() => void load(page + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )
      )}
    </div>
  );
}
