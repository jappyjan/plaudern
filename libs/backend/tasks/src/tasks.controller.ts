import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  taskListQuerySchema,
  updateTaskStatusRequestSchema,
  type ItemTasksResponse,
  type TaskDto,
  type TaskListResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { InboxService, SelfProfileService } from '@plaudern/inbox';
import { TasksRegistryService } from './tasks-registry.service';
import { TasksService } from './tasks.service';

/**
 * The per-user task list read model + status mutation (JJ-35). No global
 * ZodError filter exists, so queries/bodies are validated with `.safeParse` and
 * surfaced as 400s rather than 500s (mirrors the topics controller).
 *
 * NB: there is deliberately no global tasks *page* endpoint beyond list/update
 * here — the full tasks surface is JJ-29 and out of scope.
 */
@Controller({ path: 'tasks', version: '1' })
export class TasksController {
  constructor(
    private readonly registry: TasksRegistryService,
    private readonly selfProfile: SelfProfileService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: unknown,
  ): Promise<TaskListResponse> {
    const parsed = taskListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid query');
    }
    // Tasks are the owner's; without a designated owner, prompt to set one.
    if (!(await this.selfProfile.hasOwner(user.id))) {
      return { tasks: [], needsOwner: true };
    }
    return { tasks: await this.registry.list(user.id, parsed.data.status), needsOwner: false };
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<TaskDto> {
    const parsed = updateTaskStatusRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid task update');
    }
    return this.registry.updateStatus(user.id, id, parsed.data.status);
  }
}

/**
 * An item's tasks read model + manual re-extraction. Mounted on /inbox/:id for
 * symmetry with the topics/entities routes; lives in this module so the inbox
 * lib stays free of any tasks dependency.
 */
@Controller({ path: 'inbox', version: '1' })
export class InboxTasksController {
  constructor(
    private readonly registry: TasksRegistryService,
    private readonly tasks: TasksService,
    private readonly inbox: InboxService,
  ) {}

  @Get(':id/tasks')
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ItemTasksResponse> {
    const item = await this.inbox.getItem(user.id, id);
    return this.registry.getItemTasks(item);
  }

  @Post(':id/tasks/retry')
  async retry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ItemTasksResponse> {
    await this.tasks.retry(user.id, id);
    const item = await this.inbox.getItem(user.id, id);
    return this.registry.getItemTasks(item);
  }
}
