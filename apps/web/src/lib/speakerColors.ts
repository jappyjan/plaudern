/**
 * Deterministic per-person colors so a voice profile looks the same wherever
 * it appears (transcript blocks, contact book). Hashing the profile id keeps
 * the color stable across renders and pages without storing anything.
 */
const PALETTE = [
  'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300',
  'bg-secondary-100 text-secondary-700 dark:bg-secondary-900/40 dark:text-secondary-300',
  'bg-success-100 text-success-700 dark:bg-success-900/40 dark:text-success-300',
  'bg-warning-100 text-warning-700 dark:bg-warning-900/40 dark:text-warning-300',
  'bg-danger-100 text-danger-700 dark:bg-danger-900/40 dark:text-danger-300',
  'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
  'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  'bg-lime-100 text-lime-700 dark:bg-lime-900/40 dark:text-lime-300',
] as const;

export function speakerColor(profileId: string): string {
  let hash = 0;
  for (let i = 0; i < profileId.length; i++) {
    hash = (hash * 31 + profileId.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

/** Fallback display name for unnamed profiles, e.g. "Speaker 2". */
export function speakerDisplayName(
  profile: { name: string | null; label?: string },
  index?: number,
): string {
  if (profile.name) return profile.name;
  if (index !== undefined) return `Speaker ${index + 1}`;
  return profile.label ? `Speaker ${profile.label.replace(/^SPEAKER_0?/, '')}` : 'Unknown speaker';
}
