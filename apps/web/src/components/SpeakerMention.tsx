import { createContext, useContext } from 'react';
import { Link } from 'react-router-dom';
import type { SummarySpeakerDto } from '@plaudern/contracts';
import { speakerColor, speakerDisplayName } from '../lib/speakerColors';

/**
 * Provides the summary's speaker roster to the markdown renderer so `@[LABEL]`
 * mentions resolve to the same clickable people shown in the transcript. Index
 * order gives the stable "Speaker N" fallback for unnamed profiles.
 */
export const SpeakerRosterContext = createContext<SummarySpeakerDto[]>([]);

/**
 * Renders one `@[LABEL]` mention as a clickable chip linking to the contact,
 * mirroring the transcript's speaker chips. Unknown labels degrade to plain
 * text so a stray token never breaks the summary.
 */
export function SpeakerMention({ label }: { label?: string }) {
  const roster = useContext(SpeakerRosterContext);
  if (!label) return null;
  const index = roster.findIndex((s) => s.label === label);
  const speaker = index >= 0 ? roster[index] : undefined;

  if (!speaker) {
    return <span className="font-medium">{label}</span>;
  }

  return (
    <Link
      to={`/contacts/${speaker.profileId}`}
      className={`mx-0.5 inline-block rounded-full px-1.5 py-0.5 align-baseline text-xs font-medium ${speakerColor(speaker.profileId)}`}
    >
      {speakerDisplayName(speaker, index)}
      {speaker.status === 'unconfirmed' && ' ?'}
    </Link>
  );
}
