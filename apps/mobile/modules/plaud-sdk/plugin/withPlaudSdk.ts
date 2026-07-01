import {
  type ConfigPlugin,
  withInfoPlist,
  createRunOncePlugin,
} from 'expo/config-plugins';

export interface PlaudSdkPluginProps {
  /** Plaud dev-console Client ID (inject via env/EAS secret, never hardcode). */
  clientId?: string;
  clientSecret?: string;
}

/**
 * Expo config plugin for the Plaud native module (plan §4). On `expo prebuild`
 * it injects the iOS permission strings the SDK needs (BLE + local network for
 * WiFi fast transfer) and passes the Plaud credentials through to the native
 * layer. Linking the vendored XCFrameworks happens via the module's podspec
 * (see ios/PlaudSdk.podspec) once the frameworks are dropped into ios/Frameworks.
 *
 * Because these are native frameworks, the app MUST run as an Expo dev build —
 * Expo Go cannot load them.
 */
const withPlaudSdk: ConfigPlugin<PlaudSdkPluginProps> = (config, props = {}) => {
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.NSBluetoothAlwaysUsageDescription =
      cfg.modResults.NSBluetoothAlwaysUsageDescription ??
      'Connect to your Plaud device to transfer recordings.';
    cfg.modResults.NSBluetoothPeripheralUsageDescription =
      cfg.modResults.NSBluetoothPeripheralUsageDescription ??
      'Connect to your Plaud device to transfer recordings.';
    cfg.modResults.NSLocalNetworkUsageDescription =
      cfg.modResults.NSLocalNetworkUsageDescription ??
      'Transfer recordings from your Plaud device over WiFi.';

    if (props.clientId) {
      cfg.modResults.PlaudClientId = props.clientId;
    }
    if (props.clientSecret) {
      cfg.modResults.PlaudClientSecret = props.clientSecret;
    }
    return cfg;
  });

  return config;
};

export default createRunOncePlugin(withPlaudSdk, 'plaud-sdk', '0.1.0');
