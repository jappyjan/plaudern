import { Controller, Delete, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import type { McpTokenCreatedDto, McpTokenStatusDto } from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { McpTokenService } from './mcp-token.service';

/**
 * Settings endpoints to mint, rotate and revoke the signed-in user's MCP token.
 * Session-authenticated like every other settings route — only the token owner,
 * in a browser session, can manage it. The plaintext is returned by
 * mint/rotate exactly once and never again.
 */
@Controller({ path: 'settings/mcp', version: '1' })
export class McpTokenController {
  constructor(private readonly tokens: McpTokenService) {}

  @Get()
  async get(@CurrentUser() user: AuthenticatedUser): Promise<McpTokenStatusDto> {
    return this.tokens.toStatusDto(await this.tokens.getEntity(user.id));
  }

  /** Mints the token on first call, rotates it (invalidating the old one) after. */
  @Post('token')
  async mint(@CurrentUser() user: AuthenticatedUser): Promise<McpTokenCreatedDto> {
    return this.tokens.mint(user.id);
  }

  @Delete('token')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.tokens.revoke(user.id);
  }
}
