/**
 * Best-effort recording duration from free-form inbox metadata. Plaud imports
 * set `durationMs`; browser file uploads carry `tags.durationSeconds`. When
 * neither is present the recording is treated as instantaneous for matching.
 */
export function recordingDurationMs(metadata: Record<string, unknown> | null): number | null {
  if (!metadata) return null;
  const durationMs = metadata['durationMs'];
  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0) {
    return Math.round(durationMs);
  }
  const tags = metadata['tags'];
  if (tags && typeof tags === 'object') {
    const seconds = (tags as Record<string, unknown>)['durationSeconds'];
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }
  }
  return null;
}
