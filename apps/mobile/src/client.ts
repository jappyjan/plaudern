import { PlaudernClient } from '@plaudern/mobile-api-client';
import { API_BASE_URL } from './config';
import { getDeviceApiKey } from './session';

/** Build a client bound to the stored device API key. Throws if unregistered. */
export async function createClient(): Promise<PlaudernClient> {
  const apiKey = await getDeviceApiKey();
  if (!apiKey) {
    throw new Error('device is not registered — pair a device or set an API key first');
  }
  return new PlaudernClient({ baseUrl: API_BASE_URL, apiKey });
}
