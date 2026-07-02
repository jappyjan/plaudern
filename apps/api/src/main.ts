import 'reflect-metadata';
import { Logger, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI });
  app.enableCors();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  Logger.log(`plaudern-api listening on http://localhost:${port}/api`, 'Bootstrap');
}

bootstrap();
