import type { ExpoConfig } from 'expo/config';

/**
 * Expo app config. The Plaud native module is enabled via its config plugin,
 * which means the app must be run as a DEV BUILD (not Expo Go). Plaud
 * credentials come from env / EAS secrets, never hardcoded (plan §4).
 */
const config: ExpoConfig = {
  name: 'Plaudern',
  slug: 'plaudern',
  scheme: 'plaudern',
  version: '0.1.0',
  orientation: 'portrait',
  newArchEnabled: true,
  ios: {
    bundleIdentifier: 'ai.plaudern.app',
    supportsTablet: false,
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    [
      './modules/plaud-sdk/plugin/withPlaudSdk',
      {
        clientId: process.env.PLAUD_CLIENT_ID,
        clientSecret: process.env.PLAUD_CLIENT_SECRET,
      },
    ],
  ],
  extra: {
    apiBaseUrl: process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000',
  },
};

export default config;
