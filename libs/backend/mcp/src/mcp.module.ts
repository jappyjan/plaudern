import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { McpTokenEntity } from '@plaudern/persistence';
import { InboxModule } from '@plaudern/inbox';
import { SearchModule } from '@plaudern/search';
import { IngestionModule } from '@plaudern/ingestion';
import { EntitiesModule } from '@plaudern/entities';
import { FactsModule } from '@plaudern/facts';
import { TasksModule } from '@plaudern/tasks';
import { CommitmentsModule } from '@plaudern/commitments';
import { QuestionsModule } from '@plaudern/questions';
import { DecisionsModule } from '@plaudern/decisions';
import { RemindersModule } from '@plaudern/reminders';
import { TopicsModule } from '@plaudern/topics';
import { JournalModule } from '@plaudern/journal';
import { CalendarModule } from '@plaudern/calendar';
import { SentinelModule } from '@plaudern/sensitivity';
import { McpTokenService } from './mcp-token.service';
import { McpTokenController } from './mcp-token.controller';
import { McpToolsService } from './mcp.tools';
import { McpController } from './mcp.controller';

/**
 * Exposes the user's memory over MCP (JJ-14): the `/api/mcp` Streamable HTTP
 * endpoint plus the settings routes to mint/revoke the per-user token. Tool
 * logic lives in McpToolsService, backed by the existing inbox, search (hybrid
 * FTS + pgvector memory search) and ingestion (text capture) modules.
 *
 * JJ-78 extends the surface to the whole knowledge graph the extraction pipeline
 * derives — entities, dossiers, relations, facts, tasks, commitments, questions,
 * decisions, reminders, topics, journal and calendar — by wrapping each domain's
 * existing per-user read service. Every knowledge-graph tool routes item-derived
 * content through the JJ-21 sensitivity gate (SentinelModule) so sensitive/secret
 * or not-yet-classified items never leak over this external surface.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([McpTokenEntity]),
    InboxModule,
    SearchModule,
    IngestionModule,
    EntitiesModule,
    FactsModule,
    TasksModule,
    CommitmentsModule,
    QuestionsModule,
    DecisionsModule,
    RemindersModule,
    TopicsModule,
    JournalModule,
    CalendarModule,
    SentinelModule,
  ],
  providers: [McpTokenService, McpToolsService],
  controllers: [McpTokenController, McpController],
  exports: [McpTokenService, McpToolsService],
})
export class McpModule {}
