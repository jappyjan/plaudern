import { useCallback, useEffect, useState } from 'react';
import { Button, Chip, Spinner } from '@heroui/react';
import type {
  ExtractedPayloadDto,
  SpeakerTranscriptDto,
  TranscriptSpeakerDto,
} from '@plaudern/contracts';
import { Link } from 'react-router-dom';
import { getSpeakerTranscript, splitSpeaker, updateSpeaker } from '../lib/api';
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
  const [reloadKey, setReloadKey] = useState(0);
  const [busyProfileId, setBusyProfileId] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);

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
  }, [itemId, reloadKey]);

  // Consent actions update the profile globally, then refetch this read model.
  const act = useCallback(
    async (profileId: string, patch: Parameters<typeof updateSpeaker>[1]) => {
      setBusyProfileId(profileId);
      try {
        await updateSpeaker(profileId, patch);
        setReloadKey((k) => k + 1);
      } finally {
        setBusyProfileId(null);
      }
    },
    [],
  );

  // "Not X?": detach a wrongly-matched speaker into a fresh voice profile. The
  // endpoint re-enrolls their voiceprint and returns the refreshed transcript.
  const split = useCallback(
    async (label: string) => {
      setBusyLabel(label);
      try {
        setView(await splitSpeaker(itemId, label));
      } finally {
        setBusyLabel(null);
      }
    },
    [itemId],
  );

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
  const unconsented = view.speakers.filter(
    (s) => s.consentStatus === 'unknown' || s.consentStatus === 'declined',
  );

  return (
    <div className="flex flex-col gap-3">
      {view.needsConsentReview && (
        <div className="flex flex-col gap-2 rounded-medium border border-warning-200 bg-warning-50 p-3">
          <p className="text-sm font-semibold text-warning-700">
            Does everyone here know they're being recorded?
          </p>
          <p className="text-xs text-warning-700">
            Recording confidential speech without consent is a criminal offence in Germany
            (§ 201 StGB). Confirm consent for each voice, or redact anyone who did not agree.
          </p>
          {unconsented.map((speaker) => (
            <div
              key={speaker.profileId}
              className="flex flex-wrap items-center gap-2 rounded-medium bg-background/60 p-2"
            >
              <Chip
                as={Link}
                to={`/contacts/${speaker.profileId}`}
                size="sm"
                variant="flat"
                className={speakerColor(speaker.profileId)}
              >
                {speakerDisplayName(speaker, speakerIndex.get(speaker.profileId))}
              </Chip>
              <span className="text-xs text-default-500">consent: {speaker.consentStatus}</span>
              <div className="ml-auto flex gap-1">
                <Button
                  size="sm"
                  variant="flat"
                  color="success"
                  isDisabled={busyProfileId !== null}
                  isLoading={busyProfileId === speaker.profileId}
                  onPress={() => void act(speaker.profileId, { consentStatus: 'consented' })}
                >
                  Consented
                </Button>
                <Button
                  size="sm"
                  variant="flat"
                  isDisabled={busyProfileId !== null}
                  onPress={() => void act(speaker.profileId, { consentStatus: 'declined' })}
                >
                  Declined
                </Button>
                <Button
                  size="sm"
                  variant="flat"
                  color="danger"
                  isDisabled={busyProfileId !== null}
                  onPress={() =>
                    void act(speaker.profileId, { consentStatus: 'declined', redacted: true })
                  }
                >
                  Redact
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {view.redactedSpeakers.length > 0 && (
        <div className="flex flex-col gap-2 rounded-medium bg-default-100 p-3">
          <p className="text-xs font-semibold text-default-600">
            {view.redactedSpeakers.length} speaker
            {view.redactedSpeakers.length === 1 ? '' : 's'} redacted from this transcript
          </p>
          {view.mode === 'flat' && (
            <p className="text-xs text-warning-700">
              This transcript has no per-segment timing, so redacted speech cannot be removed from
              the plain text below. Delete the recording to remove it entirely.
            </p>
          )}
          <div className="flex flex-wrap gap-1">
            {view.redactedSpeakers.map((speaker) => (
              <RedactedSpeakerChip
                key={speaker.profileId}
                speaker={speaker}
                busy={busyProfileId !== null}
                onUndo={() => void act(speaker.profileId, { redacted: false })}
              />
            ))}
          </div>
        </div>
      )}

      {view.speakers.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {view.speakers.map((speaker) => (
            <div key={speaker.profileId} className="flex items-center gap-0.5">
              <Chip
                as={Link}
                to={`/contacts/${speaker.profileId}`}
                size="sm"
                variant="flat"
                className={speakerColor(speaker.profileId)}
              >
                {speakerDisplayName(speaker, speakerIndex.get(speaker.profileId))}
                {speaker.status === 'unconfirmed' && ' ?'}
              </Chip>
              {/* Only auto-matched voices (similarity set) can be a wrong match. */}
              {speaker.similarity !== null && (
                <Button
                  size="sm"
                  variant="light"
                  className="h-6 min-w-0 px-1.5 text-xs text-default-500"
                  isDisabled={busyLabel !== null}
                  isLoading={busyLabel === speaker.label}
                  onPress={() => void split(speaker.label)}
                >
                  Not {speakerDisplayName(speaker, speakerIndex.get(speaker.profileId))}?
                </Button>
              )}
            </div>
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
                  <Chip
                    as={Link}
                    to={`/contacts/${segment.speaker.profileId}`}
                    size="sm"
                    variant="flat"
                    className={`font-medium ${speakerColor(segment.speaker.profileId)}`}
                  >
                    {speakerDisplayName(
                      segment.speaker,
                      speakerIndex.get(segment.speaker.profileId),
                    )}
                  </Chip>
                ) : (
                  <Chip size="sm" variant="flat" className="text-default-500">
                    Unknown
                  </Chip>
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

/** A redacted speaker shown as a removable chip; closing it un-redacts them. */
function RedactedSpeakerChip({
  speaker,
  busy,
  onUndo,
}: {
  speaker: TranscriptSpeakerDto;
  busy: boolean;
  onUndo: () => void;
}) {
  return (
    <Chip size="sm" variant="flat" color="default" onClose={busy ? undefined : onUndo}>
      {speakerDisplayName(speaker)} · undo
    </Chip>
  );
}
