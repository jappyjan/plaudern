import { getVapidPublicKey, registerPushSubscription, unregisterPushSubscription } from './api';

/** Whether this browser can register for web push at all. */
export function isPushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Decode a base64url VAPID key into the byte array `subscribe()` expects. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

/**
 * Ask permission, subscribe this device via the service worker, and register
 * the subscription with the backend. Throws a user-readable error if anything
 * is missing (unsupported browser, server unconfigured, permission denied, or
 * no active service worker — the latter only exists in the built/installed app).
 */
export async function enablePush(): Promise<void> {
  if (!isPushSupported()) {
    throw new Error('Push notifications are not supported in this browser.');
  }
  const { publicKey, configured } = await getVapidPublicKey();
  if (!configured || !publicKey) {
    throw new Error('Web push is not configured on the server (missing VAPID keys).');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted.');
  }
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) {
    throw new Error(
      'The service worker is not active yet — web push works in the installed/production app.',
    );
  }
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('The browser returned an incomplete push subscription.');
  }
  await registerPushSubscription({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
}

/** Unsubscribe this device and drop the subscription from the backend. */
export async function disablePush(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) {
    await unregisterPushSubscription(subscription.endpoint);
    await subscription.unsubscribe();
  }
}
