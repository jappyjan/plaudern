import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Input,
  Select,
  SelectItem,
  Spinner,
} from '@heroui/react';
import type { ConsentStatus, VoiceProfileDetailDto, VoiceProfileDto } from '@plaudern/contracts';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getSpeaker, listSpeakers, mergeSpeakers, updateSpeaker } from '../lib/api';
import { speakerColor, speakerDisplayName } from '../lib/speakerColors';
import { formatDateTime, formatDuration } from '../lib/format';
import { BackIcon } from '../components/icons';

/** Chip colour per consent state — declined is a warning the user should see. */
const CONSENT_COLOR: Record<ConsentStatus, 'default' | 'success' | 'danger'> = {
  unknown: 'default',
  consented: 'success',
  declined: 'danger',
};

/** One person from the contact book: identity + every recording they appear in. */
export function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<VoiceProfileDetailDto | null>(null);
  const [others, setOthers] = useState<VoiceProfileDto[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [fetched, all] = await Promise.all([getSpeaker(id), listSpeakers()]);
      setProfile(fetched);
      setName(fetched.name ?? '');
      setOthers(all.profiles.filter((p) => p.id !== id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>
      </div>
    );
  }
  if (!profile || !id) {
    return (
      <div className="flex justify-center py-12">
        <Spinner label="Loading…" />
      </div>
    );
  }

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <BackLink />

      <Card>
        <CardBody className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span
              className={`flex h-12 w-12 items-center justify-center rounded-full text-lg font-semibold ${speakerColor(profile.id)}`}
            >
              {(profile.name ?? '?').charAt(0).toUpperCase()}
            </span>
            <div>
              <p className="text-lg font-semibold">{speakerDisplayName(profile)}</p>
              <div className="flex items-center gap-2 text-xs text-default-500">
                <Chip
                  size="sm"
                  variant="flat"
                  color={profile.status === 'confirmed' ? 'success' : 'warning'}
                >
                  {profile.status}
                </Chip>
                <Chip size="sm" variant="flat" color={CONSENT_COLOR[profile.consentStatus]}>
                  consent: {profile.consentStatus}
                </Chip>
                {profile.redacted && (
                  <Chip size="sm" variant="flat" color="danger">
                    redacted
                  </Chip>
                )}
                <span>
                  {profile.recordingCount} recording{profile.recordingCount === 1 ? '' : 's'} ·{' '}
                  {formatDuration(profile.totalSpeakingSeconds)} of speech
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <Input
              size="sm"
              label="Name"
              value={name}
              onValueChange={setName}
              className="max-w-56"
            />
            <Button
              size="sm"
              color="primary"
              isDisabled={busy || !name.trim() || name.trim() === profile.name}
              onPress={() => run(() => updateSpeaker(id, { name: name.trim() }))}
            >
              Save
            </Button>
            {profile.status === 'unconfirmed' && (
              <Button
                size="sm"
                variant="flat"
                isDisabled={busy}
                onPress={() => run(() => updateSpeaker(id, { status: 'confirmed' }))}
              >
                Confirm
              </Button>
            )}
          </div>

          {/* Consent guardian (§ 201 StGB): record whether this person knows
              they're being recorded, and redact their speech if not. */}
          <div className="flex flex-col gap-2 rounded-medium bg-default-50 p-3">
            <p className="text-xs font-semibold text-default-600">Recording consent</p>
            <p className="text-xs text-default-500">
              Recording someone's confidential speech without consent is a criminal offence in
              Germany (§ 201 StGB). Record whether this person knows they're being recorded.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <Select
                size="sm"
                label="Consent"
                className="max-w-48"
                isDisabled={busy}
                selectedKeys={[profile.consentStatus]}
                onSelectionChange={(keys) => {
                  const next = [...keys][0];
                  if (
                    (next === 'unknown' || next === 'consented' || next === 'declined') &&
                    next !== profile.consentStatus
                  ) {
                    void run(() => updateSpeaker(id, { consentStatus: next }));
                  }
                }}
              >
                <SelectItem key="unknown">Unknown</SelectItem>
                <SelectItem key="consented">Consented</SelectItem>
                <SelectItem key="declined">Declined</SelectItem>
              </Select>
              <Button
                size="sm"
                variant="flat"
                color={profile.redacted ? 'default' : 'danger'}
                isDisabled={busy}
                onPress={() => run(() => updateSpeaker(id, { redacted: !profile.redacted }))}
              >
                {profile.redacted ? 'Un-redact speaker' : 'Redact this speaker'}
              </Button>
            </div>
            {profile.redacted && (
              <p className="text-xs text-default-500">
                This person's segments are excluded from all transcripts, summaries and search. The
                original recordings are untouched.
              </p>
            )}
          </div>

          {others.length > 0 && (
            <div className="flex flex-wrap items-end gap-2">
              <Select
                size="sm"
                label="Same person as…"
                description="Merges this profile into the selected person."
                className="max-w-56"
                isDisabled={busy}
                onSelectionChange={(keys) => {
                  const targetId = [...keys][0];
                  if (typeof targetId === 'string') {
                    void (async () => {
                      setBusy(true);
                      try {
                        await mergeSpeakers(targetId, id);
                        navigate(`/contacts/${targetId}`);
                      } catch (cause) {
                        setError(cause instanceof Error ? cause.message : String(cause));
                        setBusy(false);
                      }
                    })();
                  }
                }}
              >
                {others.map((candidate) => (
                  <SelectItem key={candidate.id}>{speakerDisplayName(candidate)}</SelectItem>
                ))}
              </Select>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="pb-0">
          <h2 className="text-sm font-semibold">Recordings</h2>
        </CardHeader>
        <CardBody className="gap-2">
          {profile.recordings.length === 0 && (
            <p className="text-sm text-default-500">
              This voice does not appear in any current recording.
            </p>
          )}
          {profile.recordings.map((recording) => (
            <Link
              key={`${recording.inboxItemId}-${recording.label}`}
              to={`/items/${recording.inboxItemId}`}
              className="flex items-center justify-between gap-3 rounded-medium p-2 text-sm hover:bg-default-100"
            >
              <span className="truncate">
                {recording.title ?? formatDateTime(recording.occurredAt)}
              </span>
              <span className="shrink-0 text-xs text-default-500">
                {recording.title && `${formatDateTime(recording.occurredAt)} · `}
                {formatDuration(recording.speakingSeconds)} spoken
                {recording.similarity !== null &&
                  ` · ${(recording.similarity * 100).toFixed(0)}% match`}
              </span>
            </Link>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}

function BackLink() {
  return (
    <Button
      as={Link}
      to="/contacts"
      variant="light"
      size="sm"
      className="self-start"
      startContent={<BackIcon className="h-4 w-4" />}
    >
      Contacts
    </Button>
  );
}
