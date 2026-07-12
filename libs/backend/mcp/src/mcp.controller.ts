import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Req,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { Public } from '@plaudern/auth';
import { McpTokenService } from './mcp-token.service';
import { McpToolsService } from './mcp.tools';
import { buildMcpServer } from './mcp.server';

/**
 * The MCP (Model Context Protocol) endpoint. Mounted at `/api/mcp`, it speaks
 * the Streamable HTTP transport so Claude or any MCP-capable agent can use the
 * user's memory as a tool.
 *
 * Auth is enforced here at the API layer with a per-user Bearer token (minted
 * under settings/mcp): the token resolves to a user id and every tool call is
 * scoped to that user, so an MCP client inherits exactly the owner's
 * permissions and nothing more. The route is `@Public()` only so the session
 * guard steps aside — this controller does its own token check and rejects any
 * request without a valid token.
 *
 * Each request is handled statelessly: a fresh transport + server bound to the
 * authenticated user, torn down when the response closes. No session state is
 * retained between calls, which keeps auth simple (every request re-presents
 * its token) and horizontally scalable.
 */
@Public()
@Controller({ path: 'mcp', version: VERSION_NEUTRAL })
export class McpController {
  constructor(
    private readonly tokens: McpTokenService,
    private readonly tools: McpToolsService,
  ) {}

  @Post()
  async post(@Req() req: Request, @Res() res: Response, @Body() body: unknown): Promise<void> {
    await this.handle(req, res, body);
  }

  @Get()
  async get(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.handle(req, res, undefined);
  }

  @Delete()
  async delete(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.handle(req, res, undefined);
  }

  private async handle(req: Request, res: Response, body: unknown): Promise<void> {
    const actor = await this.authenticate(req);
    if (!actor) {
      res
        .status(401)
        .set('WWW-Authenticate', 'Bearer realm="plaudern-mcp"')
        .json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'missing or invalid MCP token' },
          id: null,
        });
      return;
    }

    // Stateless: one transport + server per request, bound to this actor.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = buildMcpServer(actor, this.tools);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /** Resolve the `Authorization: Bearer <token>` header to the acting actor, or null. */
  private async authenticate(
    req: Request,
  ): Promise<{ userId: string; tokenPrefix: string } | null> {
    const header = req.headers.authorization;
    if (!header) return null;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) return null;
    return this.tokens.resolveActor(match[1].trim());
  }
}
