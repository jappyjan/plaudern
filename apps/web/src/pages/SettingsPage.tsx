import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Input, Select, SelectItem, Spinner, Switch } from '@heroui/react';
import {
  NOTIFICATION_CATEGORY_DESCRIPTIONS,
  NOTIFICATION_CATEGORY_LABELS,
  NOTIFICATION_CHANNEL_LABELS,
  notificationChannelSchema,
  type NotificationCategoryPreference,
  type NotificationChannel,
  type NotificationPreferencesDto,
  type QuietHours,
  SUMMARY_LANGUAGE_LABELS,
  summaryLanguagePreferenceSchema,
  type CalendarFeedsResponse,
  type EmailSettingsDto,
  type GooglePendingResponse,
  type PasskeyDto,
  type PlaudRegion,
  type PlaudSettingsDto,
  type SummaryLanguagePreference,
} from '@plaudern/contracts';
import { useAuth } from '../auth/AuthContext';
import { addPasskey, deletePasskey, listPasskeys } from '../lib/auth';
import {
  createCalendarFeed,
  createGoogleFeeds,
  deleteCalendarFeed,
  getConsentSettings,
  getEmailSettings,
  getNotificationPreferences,
  getGoogleAuthUrl,
  getGooglePending,
  getPlaudSettings,
  getSummarizationSettings,
  listCalendarFeeds,
  purgeAllData,
  reconnectGoogle,
  rotateEmailToken,
  sendTestNotification,
  testCalendarFeed,
  testPlaudConnection,
  triggerCalendarSync,
  triggerPlaudSync,
  updateCalendarFeed,
  updateConsentSettings,
  updateEmailSettings,
  updateNotificationPreferences,
  updatePlaudSettings,
  updateSummarizationSettings,
} from '../lib/api';
import { disablePush, enablePush, isPushSupported } from '../lib/push';
import { formatDateTime } from '../lib/format';
import { ConfirmDeleteModal } from '../components/ConfirmDeleteModal';
import { MoonIcon, SunIcon } from '../components/icons';
import type { Theme } from '../App';

const REGIONS: { key: PlaudRegion; label: string }[] = [
  { key: 'us', label: 'US (api.plaud.ai)' },
  { key: 'eu', label: 'EU (api-euc1.plaud.ai)' },
];

export function SettingsPage({
  theme,
  onToggleTheme,
}: {
  theme: Theme;
  onToggleTheme: () => void;
}) {
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

      <div className="flex flex-col gap-4 border-t border-default-200 pt-6">
        <div>
          <h2 className="text-lg font-semibold">Appearance</h2>
          <p className="text-sm text-default-500">Switch between light and dark mode.</p>
        </div>
        <Switch
          isSelected={theme === 'dark'}
          onValueChange={onToggleTheme}
          thumbIcon={({ isSelected, className }) =>
            isSelected ? <MoonIcon className={className} /> : <SunIcon className={className} />
          }
        >
          Dark mode
        </Switch>
      </div>

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

      <EmailSettingsSection />

      <SummarizationSection />

      <ConsentSection />

      <NotificationsSection />

      <CalendarFeedsSection />

      <DangerZoneSection
        plaudEnabled={settings?.enabled ?? false}
        onPurged={() => void refresh()}
      />
    </div>
  );
}

/**
 * Email-in (plan §2, `sources/email`): every user gets a personal
 * `inbox+<token>@<domain>` address. Forwarding anything to it becomes an
 * inbox item, attachments included — the address itself is safe to display
 * (unlike the Plaud password) since the backend can always re-derive it.
 */
function EmailSettingsSection() {
  const [settings, setSettings] = useState<EmailSettingsDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSettings(await getEmailSettings());
      setLoadError(null);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const generateOrRotate = async () => {
    setBusy(true);
    setActionError(null);
    try {
      setSettings(await rotateEmailToken());
      setCopied(false);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (enabled: boolean) => {
    setActionError(null);
    try {
      setSettings(await updateEmailSettings({ enabled }));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const copyAddress = async () => {
    if (!settings?.address) return;
    try {
      await navigator.clipboard.writeText(settings.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard access denied — the address is still visible to copy by hand */
    }
  };

  return (
    <div className="flex flex-col gap-4 border-t border-default-200 pt-6">
      <div>
        <h2 className="text-lg font-semibold">Email capture</h2>
        <p className="text-sm text-default-500">
          Forward anything — confirmations, tickets, letters — to your personal address below and
          it becomes an inbox item, with attachments stored alongside it.
        </p>
      </div>

      {loadError && (
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">
          Failed to load settings: {loadError}
        </div>
      )}
      {actionError && (
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{actionError}</div>
      )}

      {settings?.configured ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 rounded-medium bg-default-50 p-3">
            <code className="min-w-0 flex-1 truncate text-sm">{settings.address}</code>
            <Button size="sm" variant="flat" onPress={() => void copyAddress()}>
              {copied ? 'Copied!' : 'Copy'}
            </Button>
          </div>
          <Switch isSelected={settings.enabled} onValueChange={(v) => void toggleEnabled(v)}>
            Accept email into this address
          </Switch>
          <Button
            size="sm"
            variant="flat"
            color="warning"
            className="self-start"
            isLoading={busy}
            onPress={() => void generateOrRotate()}
          >
            Rotate address
          </Button>
          <p className="text-xs text-default-400">
            Rotating generates a brand-new address and immediately invalidates the one above.
          </p>
        </div>
      ) : (
        <Button color="primary" className="self-start" isLoading={busy} onPress={() => void generateOrRotate()}>
          Generate my email address
        </Button>
      )}
    </div>
  );
}

/**
 * AI summary preferences. Currently the output language, applied to every
 * future summary (and to any summary you regenerate). "Automatic" follows the
 * language spoken in each recording.
 */
function SummarizationSection() {
  const [language, setLanguage] = useState<SummaryLanguagePreference>('auto');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getSummarizationSettings()
      .then((s) => setLanguage(s.language))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoaded(true));
  }, []);

  const save = async (next: SummaryLanguagePreference) => {
    setLanguage(next);
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateSummarizationSettings({ language: next });
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 border-t border-default-200 pt-6">
      <div>
        <h2 className="text-lg font-semibold">AI summaries</h2>
        <p className="text-sm text-default-500">
          Recordings are automatically given a title and summary once transcribed. Choose the
          language summaries are written in — this applies to every future summary.
        </p>
      </div>

      <Select
        label="Summary language"
        isDisabled={!loaded || saving}
        selectedKeys={[language]}
        onSelectionChange={(keys) => {
          const key = Array.from(keys)[0];
          if (typeof key === 'string') void save(key as SummaryLanguagePreference);
        }}
        disallowEmptySelection
      >
        {summaryLanguagePreferenceSchema.options.map((code) => (
          <SelectItem key={code}>{SUMMARY_LANGUAGE_LABELS[code]}</SelectItem>
        ))}
      </Select>

      {error && (
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>
      )}
      {saved && !error && <span className="text-sm text-success">Saved.</span>}
    </div>
  );
}

/**
 * Proactive-notification preferences: per-category channel opt-in, frequency
 * caps, quiet hours, the email delivery address, plus enabling web push on this
 * device and firing a test notification. Backed by the notification engine
 * (ATT-661).
 */
function NotificationsSection() {
  const [prefs, setPrefs] = useState<NotificationPreferencesDto | null>(null);
  const [timezone, setTimezone] = useState('UTC');
  const [emailAddress, setEmailAddress] = useState('');
  const [quietHours, setQuietHours] = useState<QuietHours>({
    enabled: true,
    start: '22:00',
    end: '07:00',
  });
  const [categories, setCategories] = useState<NotificationCategoryPreference[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const apply = useCallback((next: NotificationPreferencesDto) => {
    setPrefs(next);
    setTimezone(next.timezone);
    setEmailAddress(next.emailAddress ?? '');
    setQuietHours(next.quietHours);
    setCategories(next.categories);
  }, []);

  useEffect(() => {
    getNotificationPreferences()
      .then(apply)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoaded(true));
  }, [apply]);

  const setCategoryChannel = (
    category: string,
    channel: NotificationChannel,
    on: boolean,
  ) => {
    setCategories((prev) =>
      prev.map((c) =>
        c.category === category
          ? {
              ...c,
              channels: on
                ? [...new Set([...c.channels, channel])]
                : c.channels.filter((ch) => ch !== channel),
            }
          : c,
      ),
    );
  };

  const setCategoryCap = (category: string, value: string) => {
    const parsed = value.trim() === '' ? null : Math.max(0, Math.floor(Number(value)));
    setCategories((prev) =>
      prev.map((c) =>
        c.category === category
          ? { ...c, maxPerDay: parsed !== null && Number.isFinite(parsed) ? parsed : null }
          : c,
      ),
    );
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      apply(
        await updateNotificationPreferences({
          timezone,
          emailAddress: emailAddress.trim() === '' ? null : emailAddress.trim(),
          quietHours,
          categories,
        }),
      );
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const togglePush = async (enable: boolean) => {
    setPushBusy(true);
    setPushMsg(null);
    try {
      if (enable) {
        await enablePush();
        setPushMsg('Web push enabled on this device.');
      } else {
        await disablePush();
        setPushMsg('Web push disabled on this device.');
      }
      apply(await getNotificationPreferences());
    } catch (cause) {
      setPushMsg(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPushBusy(false);
    }
  };

  const sendTest = async () => {
    setTestMsg(null);
    try {
      const result = await sendTestNotification({});
      const parts = result.channels.map((c) => `${c.channel}: ${c.status}`);
      setTestMsg(`Test dispatch (${result.outcome}) — ${parts.join(', ') || 'no channels'}`);
    } catch (cause) {
      setTestMsg(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const channelConfigured = (channel: NotificationChannel): boolean =>
    prefs?.channelStatus[channel] ?? false;

  return (
    <div className="flex flex-col gap-4 border-t border-default-200 pt-6">
      <div>
        <h2 className="text-lg font-semibold">Notifications</h2>
        <p className="text-sm text-default-500">
          Proactive briefings, nudges and digests are delivered through a shared engine. Choose
          which channels each category may use, cap how often each can fire, and set quiet hours —
          nothing is sent while you sleep or beyond your caps.
        </p>
      </div>

      {!loaded ? (
        <Spinner size="sm" />
      ) : (
        <>
          <Input
            type="text"
            label="Timezone"
            description="IANA name (e.g. Europe/Berlin) — quiet hours are evaluated here."
            value={timezone}
            onValueChange={setTimezone}
          />

          <Input
            type="email"
            label="Email delivery address"
            description="Where email notifications are sent. Leave empty to disable email delivery."
            value={emailAddress}
            onValueChange={setEmailAddress}
          />

          <div className="flex flex-col gap-3 rounded-medium bg-default-50 p-4">
            <Switch
              isSelected={quietHours.enabled}
              onValueChange={(enabled) => setQuietHours((q) => ({ ...q, enabled }))}
            >
              Quiet hours
            </Switch>
            <div className="flex gap-3">
              <Input
                type="time"
                label="From"
                isDisabled={!quietHours.enabled}
                value={quietHours.start}
                onValueChange={(start) => setQuietHours((q) => ({ ...q, start }))}
              />
              <Input
                type="time"
                label="To"
                isDisabled={!quietHours.enabled}
                value={quietHours.end}
                onValueChange={(end) => setQuietHours((q) => ({ ...q, end }))}
              />
            </div>
          </div>

          <div className="flex flex-col gap-4">
            {categories.map((cat) => (
              <div
                key={cat.category}
                className="flex flex-col gap-2 rounded-medium border border-default-200 p-4"
              >
                <div>
                  <p className="font-medium">
                    {NOTIFICATION_CATEGORY_LABELS[
                      cat.category as keyof typeof NOTIFICATION_CATEGORY_LABELS
                    ] ?? cat.category}
                  </p>
                  <p className="text-sm text-default-500">
                    {NOTIFICATION_CATEGORY_DESCRIPTIONS[
                      cat.category as keyof typeof NOTIFICATION_CATEGORY_DESCRIPTIONS
                    ] ?? ''}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  {notificationChannelSchema.options.map((channel) => (
                    <Checkbox
                      key={channel}
                      isSelected={cat.channels.includes(channel)}
                      isDisabled={!channelConfigured(channel)}
                      onValueChange={(on) => setCategoryChannel(cat.category, channel, on)}
                    >
                      {NOTIFICATION_CHANNEL_LABELS[channel]}
                      {!channelConfigured(channel) && (
                        <span className="text-default-400"> (unavailable)</span>
                      )}
                    </Checkbox>
                  ))}
                  <Input
                    type="number"
                    size="sm"
                    className="max-w-[10rem]"
                    label="Max / day"
                    placeholder="∞"
                    min={0}
                    value={cat.maxPerDay === null ? '' : String(cat.maxPerDay)}
                    onValueChange={(v) => setCategoryCap(cat.category, v)}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button color="primary" isLoading={saving} onPress={() => void save()}>
              Save
            </Button>
            {isPushSupported() && (
              <>
                <Button
                  variant="flat"
                  isLoading={pushBusy}
                  isDisabled={!channelConfigured('web_push')}
                  onPress={() => void togglePush(true)}
                >
                  Enable push on this device
                </Button>
                <Button
                  variant="flat"
                  isDisabled={pushBusy}
                  onPress={() => void togglePush(false)}
                >
                  Disable push
                </Button>
              </>
            )}
            <Button variant="flat" onPress={() => void sendTest()}>
              Send test notification
            </Button>
          </div>

          {prefs && (
            <p className="text-xs text-default-400">
              {prefs.pushSubscriptionCount} device(s) subscribed · channels configured:{' '}
              {notificationChannelSchema.options
                .filter((c) => channelConfigured(c))
                .map((c) => NOTIFICATION_CHANNEL_LABELS[c])
                .join(', ') || 'none'}
            </p>
          )}
          {error && <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>}
          {saved && !error && <span className="text-sm text-success">Saved.</span>}
          {pushMsg && <span className="text-sm text-default-600">{pushMsg}</span>}
          {testMsg && <span className="text-sm text-default-600">{testMsg}</span>}
        </>
      )}
    </div>
  );
}
/**
 * Consent guardian policy (§ 201 StGB). When auto-delete is on, a recording is
 * deleted whole as soon as diarization detects a voice marked as having
 * declined consent in the contact book. Enforced at the API layer.
 */
function ConsentSection() {
  const [autoDelete, setAutoDelete] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getConsentSettings()
      .then((s) => setAutoDelete(s.autoDeleteDeclined))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoaded(true));
  }, []);

  const save = async (next: boolean) => {
    setAutoDelete(next);
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateConsentSettings({ autoDeleteDeclined: next });
      setSaved(true);
    } catch (cause) {
      setAutoDelete(!next);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 border-t border-default-200 pt-6">
      <div>
        <h2 className="text-lg font-semibold">Consent guardian</h2>
        <p className="text-sm text-default-500">
          Recording confidential speech without consent is a criminal offence in Germany
          (§ 201 StGB). Mark each person's consent in the contact book; redacted speakers are kept
          out of every transcript, summary and search.
        </p>
      </div>

      <Switch
        isSelected={autoDelete}
        isDisabled={!loaded || saving}
        onValueChange={(next) => void save(next)}
      >
        Auto-delete recordings that contain a declined voice
      </Switch>
      <p className="text-xs text-default-500">
        When on, a new recording is deleted whole as soon as speaker identification detects someone
        marked as having declined consent. This cannot be undone.
      </p>

      {error && (
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>
      )}
      {saved && !error && <span className="text-sm text-success">Saved.</span>}
    </div>
  );
}

/**
 * Destructive per-user actions, fenced off visually. "Purge all data" wipes
 * every recording and all recording-derived data, then — if Plaud sync is
 * enabled — kicks off a re-sync that reloads the recordings and triggers a
 * fresh round of processing. Primarily a testing aid.
 */
function DangerZoneSection({
  plaudEnabled,
  onPurged,
}: {
  plaudEnabled: boolean;
  onPurged: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [purging, setPurging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const purge = async () => {
    setPurging(true);
    setError(null);
    setResult(null);
    try {
      const { deletedItems } = await purgeAllData();
      let message = `Purged ${deletedItems} recording${deletedItems === 1 ? '' : 's'} and all derived data.`;
      // Reload from Plaud so a fresh round of processing fires. Only meaningful
      // when sync is enabled; the endpoint 400s otherwise, so guard on it.
      if (plaudEnabled) {
        await triggerPlaudSync();
        message += ' Plaud re-sync started — recordings will reappear as they import.';
      }
      setResult(message);
      setConfirmOpen(false);
      onPurged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPurging(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 rounded-medium border border-danger-200 bg-danger-50/40 p-4">
      <div>
        <h2 className="text-lg font-semibold text-danger">Danger zone</h2>
        <p className="text-sm text-default-500">
          Permanently delete every recording, transcript, speaker and calendar link in your account.
          {plaudEnabled
            ? ' A Plaud re-sync then reloads the recordings and triggers a fresh round of processing.'
            : ' Enable Plaud sync above first if you want them reloaded afterwards.'}{' '}
          This cannot be undone.
        </p>
      </div>

      {result && (
        <div className="rounded-medium bg-success-50 p-3 text-sm text-success">{result}</div>
      )}
      {error && !confirmOpen && (
        <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>
      )}

      <Button
        color="danger"
        variant="flat"
        className="self-start"
        onPress={() => {
          setError(null);
          setResult(null);
          setConfirmOpen(true);
        }}
      >
        Purge all data
      </Button>

      <ConfirmDeleteModal
        isOpen={confirmOpen}
        title="Purge all data?"
        message={
          'This permanently deletes every recording, transcript, speaker profile and calendar link in your account' +
          (plaudEnabled
            ? ', then re-syncs from Plaud to reload and reprocess them.'
            : '. Nothing will be reloaded unless Plaud sync is enabled.') +
          ' This cannot be undone.'
        }
        isDeleting={purging}
        error={error}
        onConfirm={() => void purge()}
        onClose={() => setConfirmOpen(false)}
      />
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

  const [pending, setPending] = useState<GooglePendingResponse | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [reconnectMode, setReconnectMode] = useState(false);

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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('googlePending');
    if (!id) return;
    setPendingId(id);
    const isReconnect = sessionStorage.getItem('googleReconnect') === '1';
    setReconnectMode(isReconnect);
    sessionStorage.removeItem('googleReconnect');
    getGooglePending(id)
      .then((p) => {
        setPending(p);
        setChecked(new Set(p.calendars.filter((c) => c.primary).map((c) => c.id)));
      })
      .catch((cause) => setActionError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

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

  const connectGoogle = async () => {
    setActionError(null);
    try {
      const { url } = await getGoogleAuthUrl();
      window.location.href = url;
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const clearPendingParam = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('googlePending');
    window.history.replaceState({}, '', url.toString());
  };

  const confirmGoogle = async () => {
    if (!pendingId) return;
    setActionError(null);
    try {
      if (reconnectMode) {
        await reconnectGoogle(pendingId);
      } else {
        await createGoogleFeeds(pendingId, [...checked]);
      }
      setPending(null);
      setPendingId(null);
      clearPendingParam();
      await refresh();
      setTimeout(() => void refresh(), 1500);
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

      {pending && (
        <div className="flex flex-col gap-2 rounded-medium bg-default-50 p-3">
          <p className="text-sm font-medium">Connected as {pending.email}</p>
          {reconnectMode ? (
            <p className="text-sm text-default-500">Reconnect this account to resume syncing.</p>
          ) : (
            pending.calendars.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  isSelected={checked.has(c.id)}
                  onValueChange={(on) =>
                    setChecked((prev) => {
                      const next = new Set(prev);
                      if (on) next.add(c.id);
                      else next.delete(c.id);
                      return next;
                    })
                  }
                />
                {c.summary}
              </label>
            ))
          )}
          <Button
            color="primary"
            className="self-start"
            isDisabled={!reconnectMode && checked.size === 0}
            onPress={confirmGoogle}
          >
            {reconnectMode ? 'Reconnect' : 'Add selected calendars'}
          </Button>
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
                  {feed.providerType === 'google' && feed.lastSyncStatus === 'error' && (
                    <Button
                      size="sm"
                      variant="flat"
                      color="warning"
                      onPress={() => {
                        sessionStorage.setItem('googleReconnect', '1');
                        void connectGoogle();
                      }}
                    >
                      Reconnect
                    </Button>
                  )}
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

      {feeds?.googleConfigured && (
        <div className="flex flex-col gap-2 border-t border-default-200 pt-4">
          <p className="text-sm text-default-500">
            Or connect a Google account directly — works when ICS export is disabled by your
            organization.
          </p>
          <Button variant="flat" className="self-start" onPress={connectGoogle}>
            Connect Google Calendar
          </Button>
        </div>
      )}
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
