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
  ios: {
    bundleIdentifier: 'ai.plaudern.app',
    supportsTablet: false,
    infoPlist: {
      // ponytail: API + MinIO are plain HTTP (sslip.io); drop this once they get a real domain + TLS
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
    },
  },
  android: {
    // Required for `expo prebuild -p android`, which CI uses to produce an
    // installable APK. The Plaud native module is iOS-only, so on Android the
    // app transparently falls back to the JS simulator (modules/plaud-sdk).
    package: 'ai.plaudern.app',
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
