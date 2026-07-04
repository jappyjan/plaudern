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
  createTopicRequestSchema,
  updateTopicRequestSchema,
  type ItemTopicsResponse,
  type TopicDto,
  type TopicItemsResponse,
  type TopicListResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { TopicsService } from './topics.service';

/**
 * The editable topic/project taxonomy (CRUD) plus "list items by topic". No
 * global ZodError filter exists, so requests are validated with `.safeParse`
 * and surfaced as 400s rather than 500s (mirrors the summarization settings
 * controller).
 */
@Controller({ path: 'topics', version: '1' })
export class TopicsController {
  constructor(private readonly topics: TopicsService) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser): Promise<TopicListResponse> {
    return { topics: await this.topics.listTopics(user.id) };
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown): Promise<TopicDto> {
    const parsed = createTopicRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid topic');
    }
    return this.topics.createTopic(user.id, parsed.data);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<TopicDto> {
    const parsed = updateTopicRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid topic');
    }
    return this.topics.updateTopic(user.id, id, parsed.data);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    await this.topics.deleteTopic(user.id, id);
  }

  @Get(':id/items')
  items(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<TopicItemsResponse> {
    return this.topics.listItemsByTopic(user.id, id);
  }
}

/**
 * An item's topics read model + manual reclassification. Mounted on /inbox/:id
 * for symmetry with the summary and transcript routes; lives in this module so
 * the inbox lib stays free of any topics dependency.
 */
@Controller({ path: 'inbox', version: '1' })
export class ItemTopicsController {
  constructor(private readonly topics: TopicsService) {}

  @Get(':id/topics')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ItemTopicsResponse> {
    return this.topics.getItemTopics(user.id, id);
  }

  @Post(':id/topics/retry')
  async retry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ItemTopicsResponse> {
    await this.topics.retry(user.id, id);
    return this.topics.getItemTopics(user.id, id);
  }
}
