import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button } from 'heroui-native';
import { PlaudSdk, type PlaudDevice } from '../modules/plaud-sdk/src';
import { PLAUD_CLIENT_ID, PLAUD_CLIENT_SECRET } from '../src/config';
import { getDeviceApiKey, setDeviceApiKey } from '../src/session';

/**
 * Onboarding: store the device API key (issued by the backend seed / device
 * registration) and pair a Plaud device over BLE. In the iOS Simulator the
 * native SDK is unavailable, so scanning returns a simulated device (plan §4/§6).
 */
export default function PairScreen() {
  const router = useRouter();
  const [apiKey, setApiKey] = useState('');
  const [devices, setDevices] = useState<PlaudDevice[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const nativeAvailable = PlaudSdk.isNativeAvailable();

  useEffect(() => {
    void getDeviceApiKey().then((k) => k && setApiKey(k));
  }, []);

  const saveKey = async () => {
    await setDeviceApiKey(apiKey.trim());
    setStatus('API key saved');
  };

  const scan = async () => {
    setStatus('scanning…');
    try {
      await PlaudSdk.initialize(PLAUD_CLIENT_ID, PLAUD_CLIENT_SECRET);
      setDevices(await PlaudSdk.scanDevices());
      setStatus(nativeAvailable ? 'select a device' : 'simulator: showing sample device');
    } catch (e) {
      setStatus((e as Error).message);
    }
  };

  const connect = async (device: PlaudDevice) => {
    setStatus(`connecting to ${device.name}…`);
    try {
      await PlaudSdk.connect(device.id, 'ble');
      router.push({ pathname: '/device/recordings', params: { serial: device.serial } });
    } catch (e) {
      setStatus((e as Error).message);
    }
  };

  return (
    <View className="flex-1 gap-4 bg-background p-4">
      <View className="gap-2">
        <Text className="font-semibold text-foreground">Device API key</Text>
        <TextInput
          value={apiKey}
          onChangeText={setApiKey}
          placeholder="pk_…"
          autoCapitalize="none"
          className="rounded-lg border border-border bg-card px-3 py-2 text-foreground"
        />
        <Button size="sm" onPress={saveKey}>
          Save key
        </Button>
      </View>

      <View className="gap-2">
        <Text className="font-semibold text-foreground">Plaud device</Text>
        <Button variant="secondary" onPress={scan}>
          Scan for devices
        </Button>
        {devices.map((d) => (
          <Button key={d.id} variant="tertiary" onPress={() => connect(d)}>
            {d.name} ({d.serial})
          </Button>
        ))}
      </View>

      {status ? <Text className="text-sm text-muted-foreground">{status}</Text> : null}
    </View>
  );
}
