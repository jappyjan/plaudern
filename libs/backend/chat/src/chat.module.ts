import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatConversationEntity, ChatMessageEntity } from '@plaudern/persistence';
import { SearchModule } from '@plaudern/search';
import { VerificationModule } from '@plaudern/citations';
import { CHAT_COMPLETION_PROVIDER } from './chat.provider';
import { OpenAiChatCompletionProvider } from './providers/openai.provider';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';

/**
 * Memory chat (JJ-37): conversational RAG over the whole memory. Retrieval is
 * the hybrid SearchService reused in-process (never over HTTP); generation is
 * an OpenAI-compatible chat provider (DeepSeek by default, CHAT_* env falling
 * back to the SUMMARIZATION_* tier); citations are enforced structurally in
 * ChatService. Ships disabled until a key is configured.
 */
@Module({
  imports: [
    ConfigModule,
    SearchModule,
    VerificationModule,
    TypeOrmModule.forFeature([ChatConversationEntity, ChatMessageEntity]),
  ],
  providers: [
    OpenAiChatCompletionProvider,
    // Only one provider for now (any OpenAI-compatible /chat/completions
    // endpoint); the token keeps the seam for future providers and test fakes.
    {
      provide: CHAT_COMPLETION_PROVIDER,
      inject: [OpenAiChatCompletionProvider],
      useFactory: (openai: OpenAiChatCompletionProvider) => openai,
    },
    ChatService,
  ],
  controllers: [ChatController],
  exports: [ChatService],
})
export class ChatModule {}
