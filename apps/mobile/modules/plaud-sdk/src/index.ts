import { NativeModulesProxy, requireNativeModule } from 'expo-modules-core';
import type {
  PlaudAudioFormat,
  PlaudDevice,
  PlaudExportResult,
  PlaudRecording,
  PlaudSdkInterface,
  PlaudTransport,
} from './PlaudSdk.types';
import { PlaudSimulator } from './simulator';

export * from './PlaudSdk.types';

/**
 * Resolves the native Expo module `PlaudSdk` when present (a Plaud dev build on
 * a real device), else falls back to the JS simulator. This boundary is the
 * only place the app touches native code (plan §4).
 */
function resolveNative(): PlaudSdkInterface | null {
  try {
    const native = requireNativeModule('PlaudSdk');
    if (!native) return null;
    return {
      isNativeAvailable: () => true,
      initialize: (clientId: string, clientSecret: string) =>
        native.initialize(clientId, clientSecret),
      scanDevices: (timeoutMs?: number) => native.scanDevices(timeoutMs ?? 8000),
      connect: (deviceId: string, transport: PlaudTransport) =>
        native.connect(deviceId, transport),
      listRecordings: () => native.listRecordings(),
      exportRecording: (recordingId: string, format: PlaudAudioFormat) =>
        native.exportRecording(recordingId, format),
      disconnect: () => native.disconnect(),
    };
  } catch {
    return null;
  }
}

const impl: PlaudSdkInterface =
  (NativeModulesProxy?.PlaudSdk && resolveNative()) || new PlaudSimulator();

export const PlaudSdk: PlaudSdkInterface = impl;

export type {
  PlaudDevice,
  PlaudRecording,
  PlaudExportResult,
  PlaudAudioFormat,
  PlaudTransport,
};
