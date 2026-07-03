import 'reflect-metadata';
import { Logger, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { resolveAuthConfig } from '@plaudern/auth';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI });
  // Sessions live in cookies, so CORS is locked to the configured web origins
  // (same-origin deployments behind the nginx proxy never hit CORS at all).
  app.enableCors({
    origin: resolveAuthConfig(app.get(ConfigService)).origins,
    credentials: true,
  });
  // Behind the bundled nginx/reverse proxy: trust X-Forwarded-Proto so the
  // session cookie is marked Secure on HTTPS deployments.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  Logger.log(`plaudern-api listening on http://localhost:${port}/api`, 'Bootstrap');
}

bootstrap();
