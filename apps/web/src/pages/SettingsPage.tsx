import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Select, SelectItem, Spinner, Switch } from '@heroui/react';
import type {
  CalendarFeedsResponse,
  PasskeyDto,
  PlaudRegion,
  PlaudSettingsDto,
} from '@plaudern/contracts';
import { useAuth } from '../auth/AuthContext';
import { addPasskey, deletePasskey, listPasskeys } from '../lib/auth';
import {
  createCalendarFeed,
  deleteCalendarFeed,
  getPlaudSettings,
  listCalendarFeeds,
  testCalendarFeed,
  testPlaudConnection,
  triggerCalendarSync,
  triggerPlaudSync,
  updateCalendarFeed,
  updatePlaudSettings,
} from '../lib/api';
import { formatDateTime } from '../lib/format';

const REGIONS: { key: PlaudRegion; label: string }[] = [
  { key: 'us', label: 'US (api.plaud.ai)' },
  { key: 'eu', label: 'EU (api-euc1.plaud.ai)' },
];

export function SettingsPage() {
  const [settings, setSettings] = useState<PlaudSettingsDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [region, setRegion] = useState<PlaudRegion>('us');
  const [enabled, setEnabled] = useState(false);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; error: string | null } | null>(null);

  // Seed the form from the server exactly once (and after an explicit save);
  // the status poll must never clobber in-progress edits.
  const formSeeded = useRef(false);
  const applySettings = useCallback((next: PlaudSettingsDto, seedForm: boolean) => {
    setSettings(next);
    if (seedForm || !formSeeded.current) {
      formSeeded.current = true;
      setEmail(next.email ?? '');
      if (next.region) setRegion(next.region);
      setEnabled(next.enabled);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      applySettings(await getPlaudSettings(), false);
      setLoadError(null);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [applySettings]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live feedback while a sync runs in the background.
  useEffect(() => {
    if (!settings?.syncRunning) return;
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [settings?.syncRunning, refresh]);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const next = await updatePlaudSettings({
        email,
        password: password || undefined,
        region,
        enabled,
      });
      applySettings(next, true);
      setPassword('');
      // Saving with sync enabled kicks off a background sync — pick it up.
      if (next.enabled) setTimeout(() => void refresh(), 1000);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(
        await testPlaudConnection({
          email: email || undefined,
          password: password || undefined,
          region,
        }),
      );
    } catch (cause) {
      setTestResult({ ok: false, error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setTesting(false);
    }
  };

  const syncNow = async () => {
    setSaveError(null);
    try {
      await triggerPlaudSync();
      await refresh();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (settings === null && !loadError) {
    return (
      <div className="flex justify-center py-12">
        <Spinner label="Loading settings…" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <AccountSection />

      <div className="border-t border-default-200 pt-6">
        <h2 className="text-lg font-semibold">Plaud sync</h2>
        <p className="text-sm text-default-500">
          Connect your Plaud account to automatically pull recordings into the inbox. Your Plaud
          account must have a password set — the Plaud app defaults to code-based login.
        </p>
      </div>

      {loadError && (
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">
          Failed to load settings: {loadError}
        </div>
      )}

      <div className="flex flex-col gap-4">
        <Input
          label="Email"
          type="email"
          value={email}
          onValueChange={setEmail}
          autoComplete="off"
        />
        <Input
          label="Password"
          type="password"
          value={password}
          onValueChange={setPassword}
          placeholder={settings?.hasPassword ? '••••••••  (unchanged)' : ''}
          description={
            settings?.hasPassword ? 'Leave empty to keep the stored password.' : undefined
          }
          autoComplete="new-password"
        />
        <Select
          label="Region"
          selectedKeys={[region]}
          onSelectionChange={(keys) => {
            const key = Array.from(keys)[0];
            if (key === 'us' || key === 'eu') setRegion(key);
          }}
          disallowEmptySelection
        >
          {REGIONS.map((r) => (
            <SelectItem key={r.key}>{r.label}</SelectItem>
          ))}
        </Select>
        <Switch isSelected={enabled} onValueChange={setEnabled}>
          Automatically sync new recordings
        </Switch>
      </div>

      {saveError && (
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{saveError}</div>
      )}
      {testResult && (
        <div
          className={
            testResult.ok
              ? 'rounded-medium bg-success-50 p-3 text-sm text-success'
              : 'rounded-medium bg-danger-50 p-3 text-sm text-danger'
          }
        >
          {testResult.ok ? 'Connection to Plaud succeeded.' : `Connection failed: ${testResult.error}`}
        </div>
      )}

      <div className="flex gap-3">
        <Button variant="flat" isLoading={testing} isDisabled={!email} onPress={test}>
          Test connection
        </Button>
        <Button color="primary" className="flex-1" isLoading={saving} isDisabled={!email} onPress={save}>
          Save
        </Button>
      </div>

      {settings?.configured && (
        <div className="flex flex-col gap-2 rounded-medium bg-default-50 p-4 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-medium">Sync status</span>
            <Button
              size="sm"
              variant="flat"
              isDisabled={!settings.enabled}
              isLoading={settings.syncRunning}
              onPress={syncNow}
            >
              {settings.syncRunning ? 'Syncing…' : 'Sync now'}
            </Button>
          </div>
          {settings.lastSyncAt ? (
            <>
              <span className="text-default-500">
                Last sync {formatDateTime(settings.lastSyncAt)}
                {settings.lastSyncImportedCount !== null &&
                  ` — ${settings.lastSyncImportedCount} recording${settings.lastSyncImportedCount === 1 ? '' : 's'} imported`}
              </span>
              {settings.lastSyncStatus === 'error' && settings.lastSyncError && (
                <div className="rounded-medium bg-danger-50 p-3 text-danger">
                  {settings.lastSyncError}
                </div>
              )}
            </>
          ) : (
            <span className="text-default-500">No sync has run yet.</span>
          )}
        </div>
      )}

      <CalendarFeedsSection />
    </div>
  );
}

function CalendarFeedsSection() {
  const [feeds, setFeeds] = useState<CalendarFeedsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    error: string | null;
    eventCount: number | null;
    calendarName: string | null;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setFeeds(await listCalendarFeeds());
      setLoadError(null);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live feedback while a sync runs in the background.
  useEffect(() => {
    if (!feeds?.syncRunning) return;
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [feeds?.syncRunning, refresh]);

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testCalendarFeed(url));
    } catch (cause) {
      setTestResult({
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
        eventCount: null,
        calendarName: null,
      });
    } finally {
      setTesting(false);
    }
  };

  const add = async () => {
    setAdding(true);
    setActionError(null);
    try {
      await createCalendarFeed({ name, url, enabled: true });
      setName('');
      setUrl('');
      setTestResult(null);
      await refresh();
      // Feed creation kicks off a background sync — pick up its result.
      setTimeout(() => void refresh(), 1500);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAdding(false);
    }
  };

  const toggle = async (id: string, enabled: boolean) => {
    setActionError(null);
    try {
      await updateCalendarFeed(id, { enabled });
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const toggleAutoLink = async (id: string, autoLink: boolean) => {
    setActionError(null);
    try {
      await updateCalendarFeed(id, { autoLink });
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const remove = async (id: string) => {
    setActionError(null);
    try {
      await deleteCalendarFeed(id);
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const syncNow = async () => {
    setActionError(null);
    try {
      await triggerCalendarSync();
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="flex flex-col gap-4 border-t border-default-200 pt-6">
      <div>
        <h2 className="text-lg font-semibold">Calendar feeds</h2>
        <p className="text-sm text-default-500">
          Subscribe to iCal/ICS feed URLs (Google Calendar&apos;s “secret address”, Outlook, iCloud,
          …). Recordings made during an event are linked to it automatically.
        </p>
      </div>

      {loadError && (
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">
          Failed to load calendar feeds: {loadError}
        </div>
      )}

      {feeds && feeds.feeds.length > 0 && (
        <div className="flex flex-col gap-2">
          {feeds.feeds.map((feed) => (
            <div key={feed.id} className="flex flex-col gap-1 rounded-medium bg-default-50 p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{feed.name}</p>
                  <p className="truncate text-xs text-default-500">{feed.urlMasked}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Switch
                    size="sm"
                    isSelected={feed.enabled}
                    onValueChange={(enabled) => void toggle(feed.id, enabled)}
                    aria-label={`Enable ${feed.name}`}
                  />
                  <Button size="sm" variant="light" color="danger" onPress={() => void remove(feed.id)}>
                    Remove
                  </Button>
                </div>
              </div>
              <span className="text-xs text-default-500">
                {feed.lastSyncAt
                  ? `Last sync ${formatDateTime(feed.lastSyncAt)}${
                      feed.lastSyncEventCount !== null ? ` — ${feed.lastSyncEventCount} events` : ''
                    }`
                  : 'Not synced yet.'}
              </span>
              <Switch
                size="sm"
                isSelected={feed.autoLink}
                onValueChange={(autoLink) => void toggleAutoLink(feed.id, autoLink)}
                classNames={{ label: 'text-xs text-default-500' }}
              >
                Auto-link recordings to these events
              </Switch>
              {feed.lastSyncStatus === 'error' && feed.lastSyncError && (
                <div className="rounded-medium bg-danger-50 p-2 text-xs text-danger">
                  {feed.lastSyncError}
                </div>
              )}
            </div>
          ))}
          <Button
            size="sm"
            variant="flat"
            className="self-start"
            isLoading={feeds.syncRunning}
            onPress={syncNow}
          >
            {feeds.syncRunning ? 'Syncing…' : 'Sync now'}
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <Input label="Name" value={name} onValueChange={setName} placeholder="Work calendar" />
        <Input
          label="ICS feed URL"
          value={url}
          onValueChange={setUrl}
          placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
          description="The URL is stored encrypted and never displayed again."
          autoComplete="off"
        />
        {actionError && (
          <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{actionError}</div>
        )}
        {testResult && (
          <div
            className={
              testResult.ok
                ? 'rounded-medium bg-success-50 p-3 text-sm text-success'
                : 'rounded-medium bg-danger-50 p-3 text-sm text-danger'
            }
          >
            {testResult.ok
              ? `Feed OK${testResult.calendarName ? ` — “${testResult.calendarName}”` : ''}${
                  testResult.eventCount !== null
                    ? `, ${testResult.eventCount} events in the next weeks`
                    : ''
                }`
              : `Feed test failed: ${testResult.error}`}
          </div>
        )}
        <div className="flex gap-3">
          <Button variant="flat" isLoading={testing} isDisabled={!url} onPress={test}>
            Test feed
          </Button>
          <Button
            color="primary"
            className="flex-1"
            isLoading={adding}
            isDisabled={!name || !url}
            onPress={add}
          >
            Add feed
          </Button>
        </div>
      </div>
    </div>
  );
}

function AccountSection() {
  const { user, status, logout } = useAuth();
  const [passkeys, setPasskeys] = useState<PasskeyDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');

  const authDisabled = status?.authDisabled ?? false;

  const refresh = useCallback(async () => {
    if (authDisabled) return;
    try {
      setPasskeys((await listPasskeys()).passkeys);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [authDisabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = async () => {
    setAdding(true);
    setError(null);
    try {
      await addPasskey(newLabel.trim() || undefined);
      setNewLabel('');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name === 'NotAllowedError'
          ? 'The passkey prompt was dismissed.'
          : cause instanceof Error
            ? cause.message
            : String(cause),
      );
    } finally {
      setAdding(false);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await deletePasskey(id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Account</h2>
          <p className="text-sm text-default-500">
            {authDisabled
              ? 'Authentication is disabled on this instance (AUTH_DISABLED).'
              : `Signed in as ${user?.username ?? '…'}. All data is private to this account.`}
          </p>
        </div>
        {!authDisabled && (
          <Button size="sm" variant="flat" color="danger" onPress={() => void logout()}>
            Sign out
          </Button>
        )}
      </div>

      {error && (
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>
      )}

      {!authDisabled && passkeys && (
        <div className="flex flex-col gap-2">
          {passkeys.map((key) => (
            <div
              key={key.id}
              className="flex items-center justify-between gap-2 rounded-medium bg-default-50 p-3 text-sm"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {key.label ?? `Passkey ${key.id.slice(0, 8)}…`}
                </p>
                <p className="truncate text-xs text-default-500">
                  {key.deviceType === 'multiDevice' ? 'Synced passkey' : 'Device-bound passkey'}
                  {' · added '}
                  {formatDateTime(key.createdAt)}
                  {key.lastUsedAt ? ` · last used ${formatDateTime(key.lastUsedAt)}` : ''}
                </p>
              </div>
              <Button
                size="sm"
                variant="light"
                color="danger"
                isDisabled={passkeys.length <= 1}
                onPress={() => void remove(key.id)}
              >
                Remove
              </Button>
            </div>
          ))}
          <div className="flex items-end gap-3">
            <Input
              size="sm"
              label="New passkey name (optional)"
              value={newLabel}
              onValueChange={setNewLabel}
              placeholder="e.g. Phone"
            />
            <Button size="sm" variant="flat" isLoading={adding} onPress={() => void add()}>
              Add passkey
            </Button>
          </div>
          <p className="text-xs text-default-400">
            Add a passkey on every device you use. The last passkey cannot be removed.
          </p>
        </div>
      )}
    </div>
  );
}
