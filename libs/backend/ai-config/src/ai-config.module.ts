import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiCapabilitySettingEntity, AiProviderEntity } from '@plaudern/persistence';
import { AiConfigService } from './ai-config.service';
import { AiProviderService } from './ai-provider.service';
import { AiCapabilityService } from './ai-capability.service';
import { AiProviderController } from './ai-provider.controller';
import { AiCapabilityController } from './ai-capability.controller';
import { AiConfigImportService } from './ai-config-import.service';
import { OpenAiChatClient } from './openai-chat.client';
import { OpenAiEmbeddingsClient } from './openai-embeddings.client';

/**
 * Per-user AI configuration: the `AiConfigService` resolver every provider now
 * calls instead of reading env, the shared OpenAI HTTP clients, the CRUD for
 * provider connections + capability assignments, and the one-time env→DB import.
 *
 * Global so any feature module can inject `AiConfigService` / the shared clients
 * without re-importing (mirrors how config was globally available before).
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([AiProviderEntity, AiCapabilitySettingEntity]),
  ],
  providers: [
    AiConfigService,
    AiProviderService,
    AiCapabilityService,
    AiConfigImportService,
    OpenAiChatClient,
    OpenAiEmbeddingsClient,
  ],
  controllers: [AiProviderController, AiCapabilityController],
  exports: [AiConfigService, OpenAiChatClient, OpenAiEmbeddingsClient],
})
export class AiConfigModule {}
