export type PlaudTransport = 'ble' | 'wifi';
export type PlaudAudioFormat = 'mp3' | 'wav' | 'opus' | 'pcm';

export interface PlaudDevice {
  id: string;
  name: string;
  /** Device serial — used to derive the ingestion idempotency key. */
  serial: string;
  rssi?: number;
}

export interface PlaudRecording {
  /** Plaud file id — combined with the serial for idempotency. */
  id: string;
  durationSec: number;
  byteSize: number;
  /** Capture time reported by the device, ISO 8601. */
  recordedAt: string;
}

export interface PlaudExportResult {
  fileUri: string;
  contentType: string;
  byteSize: number;
}

export interface PlaudTransferProgress {
  recordingId: string;
  transferredBytes: number;
  totalBytes: number;
}

export interface PlaudSdkInterface {
  isNativeAvailable(): boolean;
  initialize(clientId: string, clientSecret: string): Promise<void>;
  scanDevices(timeoutMs?: number): Promise<PlaudDevice[]>;
  connect(deviceId: string, transport: PlaudTransport): Promise<void>;
  listRecordings(): Promise<PlaudRecording[]>;
  exportRecording(recordingId: string, format: PlaudAudioFormat): Promise<PlaudExportResult>;
  disconnect(): Promise<void>;
}
