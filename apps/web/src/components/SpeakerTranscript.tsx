import { useEffect, useState } from 'react';
import { Chip, Spinner } from '@heroui/react';
import type { ExtractedPayloadDto, SpeakerTranscriptDto } from '@plaudern/contracts';
import { Link } from 'react-router-dom';
import { getSpeakerTranscript } from '../lib/api';
import { formatDuration } from '../lib/format';
import { speakerColor, speakerDisplayName } from '../lib/speakerColors';
import { CollapsibleText } from './CollapsibleText';
import { CollapsibleContent } from './CollapsibleContent';

const POLL_INTERVAL_MS = 3000;

/**
 * Speaker-attributed transcript. Fetches the merged read model and keeps
 * polling while diarization is still running, so speaker names appear as soon
 * as the sidecar finishes — the flat transcript shows immediately meanwhile.
 */
export function SpeakerTranscript({
  itemId,
  transcription,
}: {
  itemId: string;
  transcription: ExtractedPayloadDto;
}) {
  const [view, setView] = useState<SpeakerTranscriptDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      try {
        const fetched = await getSpeakerTranscript(itemId);
        if (cancelled) return;
        setView(fetched);
        if (fetched.diarizationStatus && ['queued', 'processing'].includes(fetched.diarizationStatus)) {
          timer = setTimeout(load, POLL_INTERVAL_MS);
        }
      } catch {
        /* fall back to the flat transcript below */
      }
    };
    void load();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [itemId]);

  // Until (or unless) the speaker view loads, show the plain transcript text.
  if (!view || view.mode === 'none') {
    return (
      <CollapsibleText
        text={transcription.content ?? ''}
        className="whitespace-pre-wrap text-sm"
      />
    );
  }

  const speakerIndex = new Map(view.speakers.map((s, i) => [s.profileId, i]));

  return (
    <div className="flex flex-col gap-3">
      {view.speakers.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {view.speakers.map((speaker) => (
            <Chip
              key={speaker.profileId}
              as={Link}
              to={`/contacts/${speaker.profileId}`}
              size="sm"
              variant="flat"
              className={speakerColor(speaker.profileId)}
            >
              {speakerDisplayName(speaker, speakerIndex.get(speaker.profileId))}
              {speaker.status === 'unconfirmed' && ' ?'}
            </Chip>
          ))}
          {view.diarizationStatus &&
            ['queued', 'processing'].includes(view.diarizationStatus) && (
              <span className="flex items-center gap-1 text-xs text-default-500">
                <Spinner size="sm" /> identifying speakers…
              </span>
            )}
        </div>
      )}

      {view.mode === 'segmented' ? (
        <CollapsibleContent className="flex flex-col gap-3">
          {view.segments.map((segment, i) => (
            <div key={i} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                {segment.speaker ? (
                  <Link
                    to={`/contacts/${segment.speaker.profileId}`}
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${speakerColor(segment.speaker.profileId)}`}
                  >
                    {speakerDisplayName(
                      segment.speaker,
                      speakerIndex.get(segment.speaker.profileId),
                    )}
                  </Link>
                ) : (
                  <span className="rounded-full bg-default-100 px-2 py-0.5 text-xs text-default-500">
                    Unknown
                  </span>
                )}
                <span className="text-xs text-default-400">{formatDuration(segment.start)}</span>
              </div>
              <p className="whitespace-pre-wrap text-sm">{segment.text}</p>
            </div>
          ))}
        </CollapsibleContent>
      ) : (
        <CollapsibleText
          text={view.text ?? transcription.content ?? ''}
          className="whitespace-pre-wrap text-sm"
        />
      )}
    </div>
  );
}
