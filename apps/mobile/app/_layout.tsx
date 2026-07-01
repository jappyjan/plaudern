import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { HeroUINativeProvider } from 'heroui-native';
import { Stack } from 'expo-router';
import '../global.css';

/** Root layout: HeroUI Native provider (plan §4) + expo-router stack. */
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <HeroUINativeProvider>
        <Stack>
          <Stack.Screen name="index" options={{ title: 'Inbox' }} />
          <Stack.Screen name="item/[id]" options={{ title: 'Item' }} />
          <Stack.Screen name="pair" options={{ title: 'Pair device' }} />
          <Stack.Screen name="device/recordings" options={{ title: 'Recordings' }} />
          <Stack.Screen name="dev/upload" options={{ title: 'Dev upload' }} />
        </Stack>
      </HeroUINativeProvider>
    </GestureHandlerRootView>
  );
}
