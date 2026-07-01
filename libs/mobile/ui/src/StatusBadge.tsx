import { Text, View } from 'react-native';
import type { ExtractionStatus } from '@plaudern/contracts';

const TONE: Record<ExtractionStatus, string> = {
  queued: 'bg-muted',
  processing: 'bg-warning/20',
  succeeded: 'bg-success/20',
  failed: 'bg-danger/20',
};

/** Small pill showing an extraction's status, styled via Uniwind/HeroUI tokens. */
export function StatusBadge({ status }: { status: ExtractionStatus }) {
  return (
    <View className={`rounded-full px-2 py-0.5 ${TONE[status]}`}>
      <Text className="text-xs capitalize text-foreground">{status}</Text>
    </View>
  );
}
