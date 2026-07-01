import { useCallback, useEffect, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Button } from 'heroui-native';
import { PlaudSdk, type PlaudRecording } from '../../modules/plaud-sdk/src';
import { createClient } from '../../src/client';
import { uploadFile } from '../../src/upload';

/**
 * Lists recordings on the connected Plaud device and pushes a selected one into
 * the inbox: export via the native SDK (manual path) -> presigned upload ->
 * commit. Idempotency key = plaud file id + device serial (plan §2/§4).
 */
export default function RecordingsScreen() {
  const router = useRouter();
  const { serial } = useLocalSearchParams<{ serial: string }>();
  const [recordings, setRecordings] = useState<PlaudRecording[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRecordings(await PlaudSdk.listRecordings());
    } catch (e) {
      setStatus((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const ingest = async (rec: PlaudRecording) => {
    setStatus(`exporting ${rec.id}…`);
    try {
      const exported = await PlaudSdk.exportRecording(rec.id, 'mp3');
      setStatus('uploading…');
      const client = await createClient();
      const item = await client.uploadAudioFile(
        {
          fileUri: exported.fileUri,
          contentType: exported.contentType,
          byteSize: exported.byteSize,
          occurredAt: rec.recordedAt,
          idempotencyKey: `plaud:${serial}:${rec.id}`,
          sourceType: 'plaud',
          originalFilename: `${rec.id}.mp3`,
          metadata: { plaudRecordingId: rec.id, deviceSerial: serial },
        },
        uploadFile,
      );
      setStatus('done');
      router.push(`/item/${item.id}`);
    } catch (e) {
      setStatus((e as Error).message);
    }
  };

  return (
    <View className="flex-1 bg-background p-4">
      <FlatList
        data={recordings}
        keyExtractor={(r) => r.id}
        ListEmptyComponent={
          <Text className="py-8 text-center text-muted-foreground">No recordings found.</Text>
        }
        renderItem={({ item }) => (
          <View className="mb-2 rounded-xl border border-border bg-card p-4">
            <Text className="font-medium text-foreground">{item.id}</Text>
            <Text className="text-xs text-muted-foreground">
              {item.durationSec}s · {item.byteSize} bytes ·{' '}
              {new Date(item.recordedAt).toLocaleString()}
            </Text>
            <Button size="sm" className="mt-2" onPress={() => ingest(item)}>
              Send to inbox
            </Button>
          </View>
        )}
      />
      {status ? <Text className="text-sm text-muted-foreground">{status}</Text> : null}
    </View>
  );
}
