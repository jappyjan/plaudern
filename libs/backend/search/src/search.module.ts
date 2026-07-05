import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  EmbeddingChunkEntity,
  EntityMentionEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
  ItemSensitivityEntity,
  ItemTopicEntity,
} from '@plaudern/persistence';
import { EmbeddingModule } from '@plaudern/embeddings';
import { KeywordSearchService } from './keyword-search.service';
import { SearchService } from './search.service';
import { ItemSimilarController, SearchController } from './search.controller';

/**
 * Hybrid search (JJ-38): the keyword leg (FTS over transcript/summary payloads)
 * plus the semantic leg reused from EmbeddingModule (`EmbeddingSearchService`),
 * fused with Reciprocal Rank Fusion and constrained by structured filters over
 * entities, topics, source type and date range. Exports `SearchService` so the
 * MCP surface can share the exact same pipeline.
 */
@Module({
  imports: [
    EmbeddingModule,
    TypeOrmModule.forFeature([
      InboxItemEntity,
      ExtractedPayloadEntity,
      EntityMentionEntity,
      ItemTopicEntity,
      EmbeddingChunkEntity,
      ItemSensitivityEntity,
    ]),
  ],
  providers: [KeywordSearchService, SearchService],
  controllers: [SearchController, ItemSimilarController],
  exports: [SearchService],
})
export class SearchModule {}
