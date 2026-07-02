import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Select, SelectItem, Spinner, Switch } from '@heroui/react';
import type { PlaudRegion, PlaudSettingsDto } from '@plaudern/contracts';
import { getPlaudSettings, testPlaudConnection, triggerPlaudSync, updatePlaudSettings } from '../lib/api';
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
      <div>
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
    </div>
  );
}
