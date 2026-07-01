import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';
import { S3StorageService } from './s3-storage.service';
import { InMemoryStorageService } from './in-memory-storage.service';

/**
 * Provides a single `StorageService`. `STORAGE_DRIVER=memory` selects the
 * in-memory fake (tests / no-MinIO dev); anything else uses S3/MinIO.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: StorageService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const driver = config.get<string>('STORAGE_DRIVER', 's3');
        return driver === 'memory'
          ? new InMemoryStorageService()
          : new S3StorageService(config);
      },
    },
  ],
  exports: [StorageService],
})
export class StorageModule {}
