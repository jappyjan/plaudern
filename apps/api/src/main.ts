import 'reflect-metadata';
import { INestApplication, Logger, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AuthService } from '@plaudern/auth';
import { AppModule } from './app/app.module';

/**
 * Environments without shell access to the container (e.g. Coolify) can set
 * SEED_ON_BOOT=true to get the same dev user + device key as `nx run api:seed`,
 * printed once to the container logs. No-op when the user already has devices.
 */
async function seedOnBoot(app: INestApplication) {
  if (process.env.SEED_ON_BOOT !== 'true') return;
  const auth = app.get(AuthService);
  const user = await auth.ensureUser(process.env.SEED_EMAIL ?? 'dev@plaudern.local');
  if (await auth.hasDevices(user.id)) return;
  const { apiKey } = await auth.registerDevice(user.id, 'generic');
  Logger.log(`SEED_ON_BOOT device api key (shown once, then never again): ${apiKey}`, 'Bootstrap');
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI });
  app.enableCors();
  await seedOnBoot(app);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  Logger.log(`plaudern-api listening on http://localhost:${port}/api`, 'Bootstrap');
}

bootstrap();
