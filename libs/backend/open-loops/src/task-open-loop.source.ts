import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { OpenLoopDto, OpenLoopState, TaskDto, TaskStatus } from '@plaudern/contracts';
import { TaskCitationEntity } from '@plaudern/persistence';
import { TasksRegistryService } from '@plaudern/tasks';
import type { OpenLoopSource } from './open-loop-source';

/**
 * Adapts the per-user task list (JJ-35) into the ledger. The authoritative
 * open-task set, citation counts and age all come from `TasksRegistryService`
 * (so the ledger inherits its ghost-hiding and latest-extraction accounting);
 * this adapter only additionally resolves each task's most-recent source
 * recording for the provenance deep-link, which the `TaskDto` doesn't carry.
 *
 * State durability is inherited: `updateStatus` writes the `tasks` row, and task
 * dedupe only ever matches OPEN rows — a completed/dismissed task is never
 * resurrected or wiped by a re-run, so the user's `done`/`dropped` survives.
 */
@Injectable()
export class TaskOpenLoopSource implements OpenLoopSource {
  readonly kind = 'task' as const;

  constructor(
    private readonly registry: TasksRegistryService,
    @InjectRepository(TaskCitationEntity)
    private readonly citations: Repository<TaskCitationEntity>,
  ) {}

  async list(userId: string, includeResolved: boolean): Promise<OpenLoopDto[]> {
    const tasks = await this.registry.list(userId, includeResolved ? undefined : 'open');
    if (tasks.length === 0) return [];
    const latest = await this.latestCitationByTask(tasks.map((t) => t.id));
    return tasks.map((task) => this.toDto(task, latest.get(task.id) ?? null));
  }

  async updateState(userId: string, id: string, state: OpenLoopState): Promise<OpenLoopDto> {
    const task = await this.registry.updateStatus(userId, id, toTaskStatus(state));
    const latest = await this.latestCitationByTask([task.id]);
    return this.toDto(task, latest.get(task.id) ?? null);
  }

  /**
   * Most-recent citation per task, for the provenance deep-link (its inbox item
   * plus the segment start, so the ledger row jumps to the cited moment). Uses
   * raw createdAt (not the latest-succeeded-extraction filter the registry
   * applies to counts): a newer extraction always appends newer citation rows,
   * so the max-createdAt citation is the freshest mention — an acceptable, cheap
   * approximation for a link target.
   */
  private async latestCitationByTask(
    taskIds: string[],
  ): Promise<Map<string, { inboxItemId: string; startSeconds: number | null }>> {
    const map = new Map<string, { inboxItemId: string; startSeconds: number | null }>();
    if (taskIds.length === 0) return map;
    const rows = await this.citations.find({ where: { taskId: In(taskIds) } });
    const newest = new Map<string, Date>();
    for (const row of rows) {
      const seen = newest.get(row.taskId);
      if (!seen || row.createdAt > seen) {
        newest.set(row.taskId, row.createdAt);
        map.set(row.taskId, { inboxItemId: row.inboxItemId, startSeconds: row.startSeconds });
      }
    }
    return map;
  }

  private toDto(
    task: TaskDto,
    latest: { inboxItemId: string; startSeconds: number | null } | null,
  ): OpenLoopDto {
    return {
      id: task.id,
      kind: 'task',
      state: fromTaskStatus(task.status),
      title: task.title,
      direction: null,
      counterpartyName: null,
      dueDate: task.dueDate,
      overdue: isOverdue(task.dueDate),
      inboxItemId: latest?.inboxItemId ?? null,
      sourceTimestamp: latest?.startSeconds ?? null,
      citationCount: task.citationCount,
      firstSeenAt: task.firstSeenAt,
      lastSeenAt: task.lastSeenAt,
      score: 0,
      completionHint: null,
    };
  }
}

function toTaskStatus(state: OpenLoopState): TaskStatus {
  return state === 'done' ? 'completed' : state === 'dropped' ? 'dismissed' : 'open';
}

function fromTaskStatus(status: TaskStatus): OpenLoopState {
  return status === 'completed' ? 'done' : status === 'dismissed' ? 'dropped' : 'open';
}

function isOverdue(dueDate: string | null): boolean {
  return dueDate !== null && Date.parse(dueDate) < Date.now();
}
