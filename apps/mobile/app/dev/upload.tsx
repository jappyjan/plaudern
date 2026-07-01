import { useState } from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button } from 'heroui-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { createClient } from '../../src/client';
import { uploadFile } from '../../src/upload';

/**
 * Hardware-free ingestion path (plan §6, Path B): pick any local audio file and
 * push it through the exact same init -> upload -> commit flow the Plaud path
 * uses. This is how the whole slice is demoed without a Plaud device.
 */
export default function DevUploadScreen() {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);

  const pickAndUpload = async () => {
    const picked = await DocumentPicker.getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true });
    if (picked.canceled || !picked.assets?.length) return;

    const asset = picked.assets[0];
    setStatus('uploading…');
    try {
      const info = await FileSystem.getInfoAsync(asset.uri);
      const byteSize = info.exists && 'size' in info ? info.size : (asset.size ?? 0);
      const client = await createClient();
      const item = await client.uploadAudioFile(
        {
          fileUri: asset.uri,
          contentType: asset.mimeType ?? 'audio/mpeg',
          byteSize,
          occurredAt: new Date().toISOString(),
          idempotencyKey: `dev:${asset.name}:${byteSize}`,
          sourceType: 'audio',
          originalFilename: asset.name,
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
    <View className="flex-1 gap-4 bg-background p-4">
      <Text className="text-muted-foreground">
        Pick a local audio file to ingest through the real ingestion pipeline — no Plaud
        hardware required.
      </Text>
      <Button onPress={pickAndUpload}>Pick audio & upload</Button>
      {status ? <Text className="text-sm text-muted-foreground">{status}</Text> : null}
    </View>
  );
}
