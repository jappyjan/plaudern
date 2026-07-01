import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import { Link, useFocusEffect, useRouter } from 'expo-router';
import { Button } from 'heroui-native';
import type { InboxItemDto } from '@plaudern/contracts';
import { StatusBadge } from '@plaudern/mobile-ui';
import { createClient } from '../src/client';

/** Home screen: the immutable inbox, newest first (plan §4). */
export default function InboxScreen() {
  const router = useRouter();
  const [items, setItems] = useState<InboxItemDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const client = await createClient();
      const res = await client.listInbox(50);
      setItems(res.items);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <View className="flex-1 bg-background px-4 pt-2">
      <View className="flex-row gap-2 py-2">
        <Button size="sm" variant="secondary" onPress={() => router.push('/pair')}>
          Pair device
        </Button>
        <Button size="sm" variant="secondary" onPress={() => router.push('/dev/upload')}>
          Dev upload
        </Button>
      </View>

      {error ? (
        <View className="rounded-lg bg-danger/10 p-3">
          <Text className="text-danger">{error}</Text>
        </View>
      ) : null}

      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
        ListEmptyComponent={
          <Text className="py-8 text-center text-muted-foreground">
            Inbox is empty. Upload audio to get started.
          </Text>
        }
        renderItem={({ item }) => <InboxRow item={item} />}
      />
    </View>
  );
}

function InboxRow({ item }: { item: InboxItemDto }) {
  const transcript = item.extractions.find((e) => e.kind === 'transcription');
  return (
    <Link href={`/item/${item.id}`} asChild>
      <View className="mb-2 rounded-xl border border-border bg-card p-4">
        <View className="flex-row items-center justify-between">
          <Text className="font-semibold capitalize text-foreground">{item.sourceType}</Text>
          <View className="flex-row items-center gap-2">
            {transcript ? <StatusBadge status={transcript.status} /> : null}
            <Text className="text-xs text-muted-foreground">
              {new Date(item.occurredAt).toLocaleDateString()}
            </Text>
          </View>
        </View>
        <Text className="mt-1 text-sm text-muted-foreground" numberOfLines={2}>
          {transcript
            ? transcript.status === 'succeeded'
              ? transcript.content
              : `transcription ${transcript.status}…`
            : item.sourceType === 'text'
              ? 'text note'
              : 'no transcription'}
        </Text>
      </View>
    </Link>
  );
}
