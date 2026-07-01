import { useCallback, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import type { InboxItemDto } from '@plaudern/contracts';
import { createClient } from '../../src/client';

/** Item detail: source metadata + append-only extractions (plan §4). */
export default function ItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [item, setItem] = useState<InboxItemDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const client = await createClient();
      setItem(await client.getItem(String(id)));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (error) return <Centered text={error} tone="danger" />;
  if (!item) return <Centered text="Loading…" />;

  return (
    <ScrollView className="flex-1 bg-background p-4">
      <Text className="text-lg font-bold capitalize text-foreground">{item.sourceType}</Text>
      <Text className="text-xs text-muted-foreground">
        captured {new Date(item.occurredAt).toLocaleString()} · ingested{' '}
        {new Date(item.ingestedAt).toLocaleString()}
      </Text>

      {item.source ? (
        <View className="mt-4 rounded-xl border border-border bg-card p-4">
          <Text className="font-semibold text-foreground">Source payload</Text>
          <Text className="text-sm text-muted-foreground">
            {item.source.contentType} · {item.source.byteSize} bytes ·{' '}
            {item.source.uploadStatus}
          </Text>
        </View>
      ) : null}

      <Text className="mt-6 font-semibold text-foreground">Extractions</Text>
      {item.extractions.length === 0 ? (
        <Text className="text-sm text-muted-foreground">none yet</Text>
      ) : (
        item.extractions.map((ex) => (
          <View key={ex.id} className="mt-2 rounded-xl border border-border bg-card p-4">
            <View className="flex-row justify-between">
              <Text className="font-medium capitalize text-foreground">{ex.kind}</Text>
              <Text className="text-xs text-muted-foreground">{ex.status}</Text>
            </View>
            <Text className="mt-1 text-xs text-muted-foreground">{ex.provider}</Text>
            {ex.content ? (
              <Text className="mt-2 text-sm text-foreground">{ex.content}</Text>
            ) : null}
            {ex.error ? <Text className="mt-2 text-sm text-danger">{ex.error}</Text> : null}
          </View>
        ))
      )}
    </ScrollView>
  );
}

function Centered({ text, tone }: { text: string; tone?: 'danger' }) {
  return (
    <View className="flex-1 items-center justify-center bg-background p-6">
      <Text className={tone === 'danger' ? 'text-danger' : 'text-muted-foreground'}>{text}</Text>
    </View>
  );
}
