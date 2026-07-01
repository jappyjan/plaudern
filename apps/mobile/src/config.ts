import Constants from 'expo-constants';

/** API base URL, from app.config.ts `extra` (override with EXPO_PUBLIC_API_URL). */
export const API_BASE_URL: string =
  (Constants.expoConfig?.extra?.apiBaseUrl as string | undefined) ??
  process.env.EXPO_PUBLIC_API_URL ??
  'http://localhost:3000';

// Plaud dev-console credentials, injected via env/EAS secrets (never hardcode).
export const PLAUD_CLIENT_ID = process.env.EXPO_PUBLIC_PLAUD_CLIENT_ID ?? '';
export const PLAUD_CLIENT_SECRET = process.env.EXPO_PUBLIC_PLAUD_CLIENT_SECRET ?? '';
