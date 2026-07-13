import { useCallback, useEffect, useState } from 'react';
import { Accordion, AccordionItem, Button, Chip, Spinner } from '@heroui/react';
import type { SummaryDto, SummaryLayout } from '@plaudern/contracts';
import { getSummary, retrySummary } from '../lib/api';
import { CorrectionNotes } from './CorrectionNotes';
import { Markdown } from './Markdown';
import { SpeakerRosterContext } from './SpeakerMention';

const POLL_INTERVAL_MS = 3000;

const LAYOUT_LABELS: Record<SummaryLayout, string> = {
  meeting: 'Meeting',
  interview: 'Interview',
  lecture: 'Lecture',
  conversation: 'Conversation',
  note: 'Note',
  todo: 'To-dos',
  general: 'Summary',
};

/**
 * The Summary tab. Fetches the AI-generated title + Markdown summary and keeps
 * polling while it is still being generated, so it appears as soon as the
 * pipeline finishes. Renders markdown with mermaid diagrams and clickable
 * speaker mentions, and offers a manual (re)generate action.
 */
export function SummaryView({ itemId }: { itemId: string }) {
  const [summary, setSummary] = useState<SummaryDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  // Bumped when a correction note queues a regeneration server-side, so the
  // fetch-and-poll effect re-arms and picks up the fresh in-flight summary.
  const [pollNonce, setPollNonce] = useState(0);

  const load = useCallback(async (): Promise<SummaryDto | null> => {
    try {
      const fetched = await getSummary(itemId);
      setSummary(fetched);
      setLoadError(null);
      return fetched;
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, [itemId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const fetched = await load();
      if (cancelled) return;
      if (fetched && (fetched.status === 'queued' || fetched.status === 'processing')) {
        timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load, pollNonce]);

  const regenerate = useCallback(async () => {
    setRegenerating(true);
    setLoadError(null);
    try {
      setSummary(await retrySummary(itemId));
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRegenerating(false);
    }
  }, [itemId]);

  if (loadError && !summary) {
    return <p className="text-sm text-danger">{loadError}</p>;
  }

  if (!summary) {
    return (
      <div className="flex items-center gap-2 text-sm text-default-500">
        <Spinner size="sm" /> Loading…
      </div>
    );
  }

  if (summary.status === 'queued' || summary.status === 'processing') {
    return (
      <div className="flex items-center gap-2 text-sm text-default-500">
        <Spinner size="sm" /> Generating summary…
      </div>
    );
  }

  if (summary.status === 'failed') {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-danger">{summary.error ?? 'Summarization failed.'}</p>
        <Button
          size="sm"
          color="primary"
          variant="flat"
          className="self-start"
          isLoading={regenerating}
          onPress={regenerate}
        >
          Try again
        </Button>
      </div>
    );
  }

  if (summary.status === null || !summary.markdown) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-default-500">
          No summary yet. It is generated automatically once the content is ready — or you can
          create one now.
        </p>
        <Button
          size="sm"
          color="primary"
          variant="flat"
          className="self-start"
          isLoading={regenerating}
          onPress={regenerate}
        >
          Generate summary
        </Button>
        {loadError && <p className="text-xs text-danger">{loadError}</p>}
      </div>
    );
  }

  return (
    <SpeakerRosterContext.Provider value={summary.speakers}>
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            {summary.title && <h3 className="text-base font-semibold">{summary.title}</h3>}
            {summary.layout && (
              <Chip size="sm" variant="flat" color="secondary" className="self-start">
                {LAYOUT_LABELS[summary.layout]}
              </Chip>
            )}
          </div>
          <Button
            size="sm"
            variant="light"
            isLoading={regenerating}
            onPress={regenerate}
            className="shrink-0"
          >
            Regenerate
          </Button>
        </div>

        <Markdown>{summary.markdown}</Markdown>

        {summary.offTopic && (
          <Accordion isCompact className="rounded-medium border border-default-200 px-3">
            <AccordionItem
              key="off-topic"
              aria-label="Off-topic"
              title={<span className="text-sm font-medium text-default-500">Off-topic</span>}
              subtitle={
                <span className="text-xs text-default-400">
                  Tangents kept out of the main summary
                </span>
              }
            >
              <div className="pb-2 text-sm text-default-600">
                <Markdown>{summary.offTopic}</Markdown>
              </div>
            </AccordionItem>
          </Accordion>
        )}

        <Accordion isCompact className="rounded-medium border border-default-200 px-3">
          <AccordionItem
            key="corrections"
            aria-label="Corrections & notes"
            title={
              <span className="text-sm font-medium text-default-500">Corrections & notes</span>
            }
            subtitle={
              <span className="text-xs text-default-400">
                Fix mistakes in the summary without touching the original
              </span>
            }
          >
            <div className="pb-2">
              <CorrectionNotes
                itemId={itemId}
                onSummaryQueued={() => setPollNonce((nonce) => nonce + 1)}
              />
            </div>
          </AccordionItem>
        </Accordion>

        {loadError && <p className="text-xs text-danger">{loadError}</p>}
      </div>
    </SpeakerRosterContext.Provider>
  );
}
