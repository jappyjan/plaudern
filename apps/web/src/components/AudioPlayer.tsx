import { useEffect, useRef } from 'react';

interface AudioPlayerProps {
  src: string;
  className?: string;
  /**
   * Optional deep-link position (seconds): once the element knows its real
   * duration, jump there — used by memory-chat/search citations so a click
   * lands on the cited moment. Null/undefined = start at the beginning.
   */
  seekToSeconds?: number | null;
}

/**
 * Native `<audio>` with a workaround for the iOS Safari / MediaRecorder bug where
 * a recorded blob carries no total-duration in its container header (the total
 * isn't known until recording stops, so the streaming writer never backfills it).
 * Safari then reports `duration` as `Infinity` and, for very short clips, wedges
 * the element in a permanent "loading" state — spinner, 0:00 — even though the
 * audio itself decodes fine (which is why transcription still works).
 *
 * The repair: once metadata loads with a non-finite/zero duration, seek far past
 * the end. Safari scans to the real end, learns the duration, fires
 * `durationchange`, and we snap back to the start (or to the requested
 * deep-link position).
 */
export function AudioPlayer({ src, className, seekToSeconds }: AudioPlayerProps) {
  const ref = useRef<HTMLAudioElement | null>(null);
  // The position playback should land on once the duration is known. A ref so
  // the repair handler below always sees the latest requested position.
  const desiredStart = useRef<number | null>(seekToSeconds ?? null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let repairing = false;

    const hasUnknownDuration = () => !Number.isFinite(el.duration) || el.duration === 0;

    const applyDesiredStart = () => {
      el.currentTime = desiredStart.current ?? 0;
      desiredStart.current = null;
    };

    const onDurationChange = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) {
        el.removeEventListener('durationchange', onDurationChange);
        repairing = false;
        // The seek was only to force measurement — land on the requested start.
        applyDesiredStart();
      }
    };

    const startRepair = () => {
      if (repairing) return;
      if (!hasUnknownDuration()) {
        // Healthy file: honor a pending deep-link position right away.
        if (desiredStart.current !== null) applyDesiredStart();
        return;
      }
      repairing = true;
      el.addEventListener('durationchange', onDurationChange);
      // A finite-but-enormous target; MAX_SAFE_INTEGER makes some browsers throw.
      try {
        el.currentTime = 1e101;
      } catch {
        repairing = false;
        el.removeEventListener('durationchange', onDurationChange);
      }
    };

    el.addEventListener('loadedmetadata', startRepair);
    // Metadata may already be loaded by the time this effect runs.
    if (el.readyState >= 1 /* HAVE_METADATA */) startRepair();

    return () => {
      el.removeEventListener('loadedmetadata', startRepair);
      el.removeEventListener('durationchange', onDurationChange);
    };
  }, [src]);

  // React to seek requests after load too (e.g. tapping another citation of
  // the same recording): seek immediately when the metadata is already there,
  // otherwise leave it for the loadedmetadata/repair path above.
  useEffect(() => {
    if (seekToSeconds === null || seekToSeconds === undefined) return;
    const el = ref.current;
    desiredStart.current = seekToSeconds;
    if (el && el.readyState >= 1 && Number.isFinite(el.duration) && el.duration > 0) {
      el.currentTime = seekToSeconds;
      desiredStart.current = null;
    }
  }, [seekToSeconds, src]);

  return <audio ref={ref} controls src={src} className={className} preload="metadata" />;
}
