import 'reflect-metadata';
import { Logger, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { json, raw, urlencoded } from 'express';
import { resolveAuthConfig } from '@plaudern/auth';
import { AppModule } from './app/app.module';

/**
 * Every recording/file upload goes through the presigned S3 flow, so the
 * default JSON body limit was never raised — until the email-in webhook,
 * whose SendGrid/SES-style JSON payload embeds attachments as base64. Bump
 * the limit generously and also accept a raw MIME body (`message/rfc822`,
 * used when a relay forwards the email byte-for-byte instead of wrapping it
 * in JSON) so `EmailWebhookController` gets a plain string/Buffer body either
 * way.
 */
const BODY_LIMIT = '25mb';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(json({ limit: BODY_LIMIT }));
  app.use(urlencoded({ extended: true, limit: BODY_LIMIT }));
  app.use(raw({ type: ['message/rfc822', 'text/plain'], limit: BODY_LIMIT }));
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
