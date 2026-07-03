import { useEffect, useRef } from 'react';

interface AudioPlayerProps {
  src: string;
  className?: string;
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
 * `durationchange`, and we snap back to the start. This unwedges playback and
 * fixes the timeline without re-encoding the file.
 */
export function AudioPlayer({ src, className }: AudioPlayerProps) {
  const ref = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let repairing = false;

    const hasUnknownDuration = () => !Number.isFinite(el.duration) || el.duration === 0;

    const onDurationChange = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) {
        el.removeEventListener('durationchange', onDurationChange);
        repairing = false;
        // The seek was only to force measurement — return to the start.
        el.currentTime = 0;
      }
    };

    const startRepair = () => {
      if (repairing || !hasUnknownDuration()) return;
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

  return <audio ref={ref} controls src={src} className={className} preload="metadata" />;
}
