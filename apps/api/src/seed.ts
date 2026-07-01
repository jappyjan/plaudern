import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AuthService } from '@plaudern/auth';
import { AppModule } from './app/app.module';

/**
 * Seeds a dev user + a generic device and prints the device API key. Use the
 * printed key as `x-device-key` when driving the ingestion API manually (plan §6).
 *
 *   nx run api:seed
 */
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const auth = app.get(AuthService);

  const email = process.env.SEED_EMAIL ?? 'dev@plaudern.local';
  const user = await auth.ensureUser(email);
  const { device, apiKey } = await auth.registerDevice(user.id, 'generic');

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      { userId: user.id, deviceId: device.id, email, apiKey },
      null,
      2,
    ),
  );
  await app.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
