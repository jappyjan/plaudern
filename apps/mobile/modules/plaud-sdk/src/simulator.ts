import type {
  PlaudDevice,
  PlaudExportResult,
  PlaudRecording,
  PlaudSdkInterface,
} from './PlaudSdk.types';

/**
 * JS simulator used when the native Plaud module isn't present (iOS Simulator,
 * Expo Go, tests). It surfaces fake devices/recordings so the UI can be built
 * and demoed, but cannot export real audio — that needs hardware, which is why
 * the hardware-free path is the dev/upload screen + document picker (plan §4/§6).
 */
export class PlaudSimulator implements PlaudSdkInterface {
  isNativeAvailable(): boolean {
    return false;
  }

  async initialize(): Promise<void> {
    /* no-op */
  }

  async scanDevices(): Promise<PlaudDevice[]> {
    return [{ id: 'sim-device-1', name: 'Plaud NotePin (Simulator)', serial: 'SIM-0001', rssi: -42 }];
  }

  async connect(): Promise<void> {
    /* no-op */
  }

  async listRecordings(): Promise<PlaudRecording[]> {
    return [
      { id: 'sim-rec-1', durationSec: 65, byteSize: 520_000, recordedAt: '2026-07-01T08:15:00.000Z' },
      { id: 'sim-rec-2', durationSec: 210, byteSize: 1_680_000, recordedAt: '2026-07-01T09:40:00.000Z' },
    ];
  }

  async exportRecording(): Promise<PlaudExportResult> {
    throw new Error(
      'Plaud audio export requires a physical device and the native SDK. ' +
        'Use the dev upload screen to ingest a local file instead.',
    );
  }

  async disconnect(): Promise<void> {
    /* no-op */
  }
}
