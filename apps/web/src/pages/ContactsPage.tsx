import { useCallback, useEffect, useState } from 'react';
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
import { listSpeakers, mergeSpeakers, updateSpeaker } from '../lib/api';
import { speakerColor, speakerDisplayName } from '../lib/speakerColors';
import { formatDateTime } from '../lib/format';

/**
 * Contact book: every person the system has heard, plus a review queue for
 * newly detected voices (name them, merge them into an existing person, or
 * keep them as a new one).
 */
export function ContactsPage() {
  const [profiles, setProfiles] = useState<VoiceProfileDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await listSpeakers();
      setProfiles(res.profiles);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>;
  }
  if (!profiles) {
    return (
      <div className="flex justify-center py-12">
        <Spinner label="Loading…" />
      </div>
    );
  }

  const confirmed = profiles.filter((p) => p.status === 'confirmed');
  const unconfirmed = profiles.filter((p) => p.status === 'unconfirmed');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">People</h2>
        {confirmed.length === 0 && (
          <p className="text-sm text-default-500">
            No confirmed people yet. Voices detected in your recordings show up below for review.
          </p>
        )}
        {confirmed.map((profile) => (
          <Card key={profile.id} as={Link} to={`/contacts/${profile.id}`} isPressable>
            <CardBody className="flex flex-row items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <Avatar profile={profile} />
                <div>
                  <p className="text-sm font-medium">{speakerDisplayName(profile)}</p>
                  <p className="text-xs text-default-500">
                    {profile.recordingCount} recording{profile.recordingCount === 1 ? '' : 's'}
                    {profile.lastHeardAt &&
                      ` · last heard ${formatDateTime(profile.lastHeardAt)}`}
                  </p>
                </div>
              </div>
            </CardBody>
          </Card>
        ))}
      </div>

      {unconfirmed.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Needs review</h2>
            <Chip size="sm" color="warning" variant="flat">
              {unconfirmed.length}
            </Chip>
          </div>
          <p className="text-sm text-default-500">
            New voices that could not be matched to a known person.
          </p>
          {unconfirmed.map((profile) => (
            <ReviewCard key={profile.id} profile={profile} confirmed={confirmed} onDone={load} />
          ))}
        </div>
      )}
    </div>
  );
}

function Avatar({ profile }: { profile: VoiceProfileDto }) {
  const initial = (profile.name ?? '?').charAt(0).toUpperCase();
  return (
    <span
      className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold ${speakerColor(profile.id)}`}
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
            <Avatar profile={profile} />
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
