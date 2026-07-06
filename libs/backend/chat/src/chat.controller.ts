import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import {
  chatAskRequestSchema,
  type ChatAskResponse,
  type ChatConversationDetailDto,
  type ChatConversationListResponse,
  type ChatStatusDto,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { ChatService } from './chat.service';

/**
 * Memory chat (JJ-37). POST /chat asks a question (optionally continuing a
 * conversation) and replies with the enforced, citation-backed answer — a
 * plain request/response with a loading state on the client, no streaming.
 * Bodies are validated with `.safeParse` and surfaced as 400s (no global
 * ZodError filter exists — mirrors the search/tasks controllers).
 */
@Controller({ path: 'chat', version: '1' })
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  /** Whether chat can run (a provider is assigned to the chat capability). */
  @Get('status')
  status(@CurrentUser() user: AuthenticatedUser): Promise<ChatStatusDto> {
    return this.chat.status(user.id);
  }

  @Post()
  ask(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown): Promise<ChatAskResponse> {
    const parsed = chatAskRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid chat request');
    }
    return this.chat.ask(user.id, parsed.data);
  }

  @Get('conversations')
  list(@CurrentUser() user: AuthenticatedUser): Promise<ChatConversationListResponse> {
    return this.chat.listConversations(user.id);
  }

  @Get('conversations/:id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ChatConversationDetailDto> {
    return this.chat.getConversation(user.id, id);
  }

  @Delete('conversations/:id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    await this.chat.deleteConversation(user.id, id);
  }
}
