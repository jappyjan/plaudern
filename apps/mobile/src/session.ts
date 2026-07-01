import * as SecureStore from 'expo-secure-store';

const API_KEY = 'plaudern.deviceApiKey';

/**
 * The device API key is stored in the iOS keychain via expo-secure-store. It is
 * issued when the device registers with the backend and used to authenticate
 * every ingestion/inbox request (plan §4).
 */
export async function getDeviceApiKey(): Promise<string | null> {
  return SecureStore.getItemAsync(API_KEY);
}

export async function setDeviceApiKey(apiKey: string): Promise<void> {
  await SecureStore.setItemAsync(API_KEY, apiKey);
}

export async function clearDeviceApiKey(): Promise<void> {
  await SecureStore.deleteItemAsync(API_KEY);
}
