import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  createAiProviderRequestSchema,
  updateAiProviderRequestSchema,
  type AiProviderDto,
  type AiProviderListDto,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { AiProviderService } from './ai-provider.service';

/**
 * CRUD for the signed-in user's AI provider connections (credentials). Mounted
 * under /settings like every other settings route; the API key is write-only.
 */
@Controller({ path: 'settings/ai/providers', version: '1' })
export class AiProviderController {
  constructor(private readonly providers: AiProviderService) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser): Promise<AiProviderListDto> {
    return { providers: await this.providers.list(user.id) };
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<AiProviderDto> {
    const parsed = createAiProviderRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid provider');
    }
    return this.providers.create(user.id, parsed.data);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AiProviderDto> {
    const parsed = updateAiProviderRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid provider');
    }
    return this.providers.update(user.id, id, parsed.data);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    await this.providers.remove(user.id, id);
  }
}
