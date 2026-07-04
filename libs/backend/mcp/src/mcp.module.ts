import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { McpTokenEntity } from '@plaudern/persistence';
import { InboxModule } from '@plaudern/inbox';
import { EmbeddingModule } from '@plaudern/embeddings';
import { IngestionModule } from '@plaudern/ingestion';
import { McpTokenService } from './mcp-token.service';
import { McpTokenController } from './mcp-token.controller';
import { McpToolsService } from './mcp.tools';
import { McpController } from './mcp.controller';

/**
 * Exposes the user's memory over MCP (JJ-14): the `/api/mcp` Streamable HTTP
 * endpoint plus the settings routes to mint/revoke the per-user token. Tool
 * logic lives in McpToolsService, backed by the existing inbox, embeddings
 * (semantic search) and ingestion (text capture) modules — no new capability
 * beyond wiring what the platform already does to the MCP surface.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([McpTokenEntity]),
    InboxModule,
    EmbeddingModule,
    IngestionModule,
  ],
  providers: [McpTokenService, McpToolsService],
  controllers: [McpTokenController, McpController],
  exports: [McpTokenService, McpToolsService],
})
export class McpModule {}
