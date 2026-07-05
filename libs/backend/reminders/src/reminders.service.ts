import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import { InboxService } from '@plaudern/inbox';
import type {
  ExtractionStatus,
  ItemRemindersResponse,
  ReminderDto,
  ReminderListQuery,
  ReminderListResponse,
  ReminderStatus,
} from '@plaudern/contracts';
import {
  ExtractedPayloadEntity,
  InboxItemEntity,
  ReminderEntity,
} from '@plaudern/persistence';
import {
  REMINDER_EXTRACTION_PROVIDER,
  type ReminderExtractionProvider,
} from './reminders.provider';
import { REMINDERS_QUEUE, type RemindersQueue } from './reminders.job';

const ACTIVE_STATUSES: ExtractionStatus[] = ['queued', 'processing'];

/**
 * Version of the reminders extractor (kind@version), recorded on every appended
 * row. Bump when the output meaningfully improves (better model or prompt) so
 * backfill runs can catch older items up.
 */
export const REMINDERS_EXTRACTOR_VERSION = 1;

/**
 * Owns the reminder-extraction pipeline step (JJ-25). WHEN it runs is decided
 * by the extraction DAG (`RemindersExtractor` + the generic pipeline). This
 * service owns enqueueing + manual retry and the read models (an item's
 * reminders, the user's calendar-visible list, status updates).
 *
 * Persisting an extraction's output lives in RemindersPersistenceService —
 * deliberately NOT here, so the processor (reached via the queue this service
 * injects) never needs an edge back to this service; that cycle would deadlock
 * Nest's module compile.
 */
@Injectable()
export class RemindersService {
  constructor(
    private readonly inbox: InboxService,
    @Inject(REMINDER_EXTRACTION_PROVIDER)
    private readonly provider: ReminderExtractionProvider,
    @Inject(REMINDERS_QUEUE)
    private readonly queue: RemindersQueue,
    @InjectRepository(ReminderEntity)
    private readonly reminders: Repository<ReminderEntity>,
    @InjectRepository(InboxItemEntity)
    private readonly items: Repository<InboxItemEntity>,
  ) {}

  /**
   * Whether reminder extraction is configured (REMINDERS_API_KEY present, or
   * REMINDERS_ENABLED=true for keyless local endpoints like Ollama).
   */
  get enabled(): boolean {
    return this.provider.enabled;
  }

  // ---- Pipeline ----

  /**
   * Manually (re)run reminder extraction for an item — e.g. after a failure or
   * a provider/model change. Appends a fresh extraction (older ones stay in
   * history); persisted reminders are upserted so a user status survives.
   */
  async retry(userId: string, inboxItemId: string): Promise<string> {
    if (!this.provider.enabled) {
      throw new BadRequestException(
        'reminder extraction is not configured (set REMINDERS_API_KEY, or REMINDERS_ENABLED=true for keyless local endpoints such as Ollama)',
      );
    }
    const item = await this.inbox.getItem(userId, inboxItemId);
    const extractions = item.extractions ?? [];
    const transcription = latestOfKind(extractions, 'transcription');
    if (transcription?.status !== 'succeeded') {
      throw new BadRequestException('item has no completed transcription to extract reminders from');
    }
    const reminders = latestOfKind(extractions, 'reminders');
    if (reminders && ACTIVE_STATUSES.includes(reminders.status)) {
      throw new ConflictException('reminder extraction is already running');
    }
    return this.enqueueReminders(inboxItemId);
  }

  /** Append a fresh `queued` reminders row and hand the job to the queue. */
  async enqueueReminders(inboxItemId: string): Promise<string> {
    const extraction = await this.inbox.addExtraction(
      inboxItemId,
      'reminders',
      this.provider.id,
      REMINDERS_EXTRACTOR_VERSION,
    );
    await this.queue.enqueue({ extractionId: extraction.id, inboxItemId });
    return extraction.id;
  }

  // ---- Read models ----

  /** An item's reminders tab: latest extraction's status + the item's reminders. */
  async getItemReminders(userId: string, inboxItemId: string): Promise<ItemRemindersResponse> {
    const item = await this.inbox.getItem(userId, inboxItemId);
    const latest = latestOfKind(item.extractions ?? [], 'reminders');
    const occurredAt = iso(item.occurredAt)!;
    const rows = await this.reminders.find({ where: { userId, inboxItemId } });
    return {
      status: latest?.status ?? null,
      reminders: rows.map((row) => toReminderDto(row, occurredAt)).sort(byDueAt),
      model: latest?.provider ?? null,
      error: latest?.error ?? null,
      createdAt: latest ? iso(latest.createdAt) : null,
      completedAt: latest?.completedAt ?? null,
    };
  }

  /**
   * The user's reminders, optionally filtered by status and/or a due window —
   * the calendar fetches just the visible range, an "upcoming" view requests
   * everything still `active`. Sorted by due date ascending (soonest first).
   */
  async list(userId: string, filters: ReminderListQuery): Promise<ReminderListResponse> {
    const rows = await this.reminders.find({
      where: {
        userId,
        ...(filters.status ? { status: filters.status } : {}),
        ...dueRange(filters.from, filters.to),
      },
    });
    const occurredById = await this.occurredByItem(rows.map((r) => r.inboxItemId));
    const reminders = rows
      .map((row) =>
        toReminderDto(row, occurredById.get(row.inboxItemId) ?? row.createdAt.toISOString()),
      )
      .sort(byDueAt);
    return { reminders };
  }

  /** Advance a reminder's lifecycle status (active → done / dismissed, or reopen). */
  async updateStatus(userId: string, id: string, status: ReminderStatus): Promise<ReminderDto> {
    const row = await this.reminders.findOne({ where: { id, userId } });
    if (!row) throw new NotFoundException('reminder not found');
    row.status = status;
    const saved = await this.reminders.save(row);
    const occurredById = await this.occurredByItem([saved.inboxItemId]);
    return toReminderDto(
      saved,
      occurredById.get(saved.inboxItemId) ?? saved.createdAt.toISOString(),
    );
  }

  /** occurredAt (ISO) per inbox item id, for building DTOs in list/update. */
  private async occurredByItem(itemIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const unique = [...new Set(itemIds)].filter(Boolean);
    if (unique.length === 0) return map;
    const rows = await this.items.find({
      select: { id: true, occurredAt: true },
      where: { id: In(unique) },
    });
    for (const row of rows) map.set(row.id, iso(row.occurredAt)!);
    return map;
  }
}

/** TypeORM where-fragment for an optional [from, to] due window on `dueAt`. */
function dueRange(from?: string, to?: string) {
  if (from && to) return { dueAt: Between(from, to) };
  if (from) return { dueAt: MoreThanOrEqual(from) };
  if (to) return { dueAt: LessThanOrEqual(to) };
  return {};
}

function toReminderDto(row: ReminderEntity, occurredAt: string): ReminderDto {
  return {
    id: row.id,
    inboxItemId: row.inboxItemId,
    title: row.title,
    dueAt: row.dueAt,
    status: row.status,
    confidence: row.confidence,
    sourceTimestamp: row.sourceTimestamp,
    sourceQuote: row.sourceQuote,
    occurredAt,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

/** Soonest due first; ties broken by creation time (newest first). */
function byDueAt(a: ReminderDto, b: ReminderDto): number {
  if (a.dueAt !== b.dueAt) return a.dueAt < b.dueAt ? -1 : 1;
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function latestOfKind(
  extractions: ExtractedPayloadEntity[],
  kind: ExtractedPayloadEntity['kind'],
): ExtractedPayloadEntity | undefined {
  return extractions
    .filter((e) => e.kind === kind)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}
