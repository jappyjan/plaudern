import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  Chip,
  Input,
  Select,
  SelectItem,
  Spinner,
} from '@heroui/react';
import type { VoiceProfileDto } from '@plaudern/contracts';
import { Link } from 'react-router-dom';
import { autoLinkEntities, listEntities, listSpeakers, mergeSpeakers, updateSpeaker } from '../lib/api';
import { mergePeople, type UnifiedPerson } from '../lib/mergePeople';
import { speakerColor, speakerDisplayName } from '../lib/speakerColors';
import { formatDateTime } from '../lib/format';

/**
 * People hub: every person the system knows — whether it *heard* them (a voice
 * profile / contact) or merely saw them *mentioned* in a transcript (a `person`
 * knowledge-graph entity). The two are one real person, already linked by
 * `entity.voiceProfileId`, so they are merged into a single card here (see
 * `mergePeople`) instead of the two separate lists they used to live in. A
 * review queue at the bottom handles newly detected, still-unnamed voices.
 */
export function ContactsPage() {
  const [profiles, setProfiles] = useState<VoiceProfileDto[] | null>(null);
  const [people, setPeople] = useState<UnifiedPerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [linkResult, setLinkResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // Person entities that no current extraction mentions stay hidden (the
      // API default) — the list should reflect who the recordings talk about
      // today. Both calls are flat GETs, so a client-side merge is cheap.
      const [speakers, entities] = await Promise.all([
        listSpeakers(),
        listEntities('person'),
      ]);
      setProfiles(speakers.profiles);
      setPeople(mergePeople(speakers.profiles, entities.entities));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Heard voices still awaiting a name/confirmation, and not already folded into
  // a merged card via an entity link — those go to the review queue below.
  const reviewQueue = useMemo(
    () => (people ?? []).filter((p) => p.provenance === 'heard' && p.unconfirmed),
    [people],
  );
  const listed = useMemo(
    () => (people ?? []).filter((p) => !(p.provenance === 'heard' && p.unconfirmed)),
    [people],
  );
  // People known only from mentions can be linked to a heard voice — offer the
  // sweep when there's at least one such person and at least one contact.
  const mentionedOnly = useMemo(
    () => (people ?? []).filter((p) => p.provenance === 'mentioned').length,
    [people],
  );
  const confirmedProfiles = useMemo(
    () => (profiles ?? []).filter((p) => p.status === 'confirmed'),
    [profiles],
  );

  const runAutoLink = async () => {
    setLinking(true);
    setLinkResult(null);
    try {
      const { linked } = await autoLinkEntities();
      if (linked > 0) await load();
      setLinkResult(
        linked > 0
          ? `Linked ${linked} ${linked === 1 ? 'person' : 'people'} to a contact.`
          : 'No new matches — name more contacts to link more people.',
      );
    } catch (cause) {
      setLinkResult(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLinking(false);
    }
  };

  if (error) {
    return <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>;
  }
  if (!people) {
    return (
      <div className="flex justify-center py-12">
        <Spinner label="Loading…" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">People</h2>
          {mentionedOnly > 0 && confirmedProfiles.length > 0 && (
            <Button size="sm" variant="flat" isLoading={linking} onPress={() => void runAutoLink()}>
              Auto-link
            </Button>
          )}
        </div>
        {linkResult && <p className="text-xs text-default-500">{linkResult}</p>}
        {listed.length === 0 ? (
          <p className="text-sm text-default-500">
            No people yet. Voices detected in your recordings show up below for review, and people
            mentioned in your recordings are added automatically as they are processed.
          </p>
        ) : (
          listed.map((person) => <PersonCard key={person.key} person={person} />)
        )}
      </div>

      {reviewQueue.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Needs review</h2>
            <Chip size="sm" color="warning" variant="flat">
              {reviewQueue.length}
            </Chip>
          </div>
          <p className="text-sm text-default-500">
            New voices that could not be matched to a known person.
          </p>
          {reviewQueue.map((person) => (
            <ReviewCard
              key={person.key}
              profile={person.voiceProfile!}
              confirmed={confirmedProfiles}
              onDone={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Concise provenance line: how many recordings heard / mentioned in. */
function provenanceLabel(person: UnifiedPerson): string {
  const parts: string[] = [];
  if (person.recordingCount > 0) {
    parts.push(`heard in ${person.recordingCount} recording${person.recordingCount === 1 ? '' : 's'}`);
  }
  if (person.mentionCount > 0) {
    parts.push(`mentioned in ${person.mentionCount} recording${person.mentionCount === 1 ? '' : 's'}`);
  }
  if (parts.length === 0) return 'no current recordings';
  return parts.join(' · ');
}

function displayName(person: UnifiedPerson): string {
  if (person.name) return person.name;
  if (person.voiceProfile) return speakerDisplayName(person.voiceProfile);
  return 'Unknown person';
}

function PersonCard({ person }: { person: UnifiedPerson }) {
  const name = displayName(person);
  return (
    <Card as={Link} to={person.detailTo} isPressable>
      <CardBody className="flex flex-row items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar seed={person.key} name={name} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="text-xs text-default-500">
              {provenanceLabel(person)}
              {person.lastActivityAt && ` · ${formatDateTime(person.lastActivityAt)}`}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {person.isSelf && (
            <Chip size="sm" variant="flat" color="primary">
              You
            </Chip>
          )}
          {person.provenance === 'mentioned' && (
            <Chip size="sm" variant="flat" title="Mentioned in recordings; not matched to a voice yet">
              mentioned
            </Chip>
          )}
          {person.unconfirmed && (
            <Chip size="sm" variant="flat" color="warning">
              unconfirmed
            </Chip>
          )}
          {person.consentStatus === 'declined' && (
            <Chip size="sm" variant="flat" color="danger">
              declined
            </Chip>
          )}
          {person.consentStatus === 'consented' && (
            <Chip size="sm" variant="flat" color="success">
              consented
            </Chip>
          )}
          {person.redacted && (
            <Chip size="sm" variant="flat" color="danger">
              redacted
            </Chip>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function Avatar({ seed, name }: { seed: string; name: string }) {
  const initial = (name || '?').charAt(0).toUpperCase();
  return (
    <span
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${speakerColor(seed)}`}
    >
      {initial}
    </span>
  );
}

function ReviewCard({
  profile,
  confirmed,
  onDone,
}: {
  profile: VoiceProfileDto;
  confirmed: VoiceProfileDto[];
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Avatar seed={profile.id} name={profile.name ?? '?'} />
            <div>
              <p className="text-sm font-medium">Unknown voice</p>
              <p className="text-xs text-default-500">
                heard in {profile.recordingCount} recording
                {profile.recordingCount === 1 ? '' : 's'}
                {profile.lastHeardAt && ` · ${formatDateTime(profile.lastHeardAt)}`}
              </p>
            </div>
          </div>
          <Button as={Link} to={`/contacts/${profile.id}`} size="sm" variant="light">
            Details
          </Button>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <Input
            size="sm"
            label="Name this person"
            value={name}
            onValueChange={setName}
            className="max-w-48"
          />
          <Button
            size="sm"
            color="primary"
            isDisabled={!name.trim() || busy}
            onPress={() => run(() => updateSpeaker(profile.id, { name: name.trim() }))}
          >
            Save
          </Button>

          {confirmed.length > 0 && (
            <Select
              size="sm"
              label="This is…"
              className="max-w-48"
              isDisabled={busy}
              onSelectionChange={(keys) => {
                const targetId = [...keys][0];
                if (typeof targetId === 'string') {
                  void run(() => mergeSpeakers(targetId, profile.id));
                }
              }}
            >
              {confirmed.map((candidate) => (
                <SelectItem key={candidate.id}>{speakerDisplayName(candidate)}</SelectItem>
              ))}
            </Select>
          )}

          <Button
            size="sm"
            variant="flat"
            isDisabled={busy}
            onPress={() => run(() => updateSpeaker(profile.id, { status: 'confirmed' }))}
          >
            Keep as new person
          </Button>
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
      </CardBody>
    </Card>
  );
}
