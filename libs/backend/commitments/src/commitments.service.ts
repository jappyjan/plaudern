import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { InboxService, SelfProfileService } from '@plaudern/inbox';
import type {
  CommitmentDto,
  CommitmentListQuery,
  CommitmentListResponse,
  CommitmentStatus,
  ExtractionStatus,
  ItemCommitmentsResponse,
} from '@plaudern/contracts';
import {
  CommitmentEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
} from '@plaudern/persistence';
import {
  COMMITMENT_EXTRACTION_PROVIDER,
  type CommitmentExtractionProvider,
} from './commitments.provider';
import { COMMITMENTS_QUEUE, type CommitmentsQueue } from './commitments.job';

const ACTIVE_STATUSES: ExtractionStatus[] = ['queued', 'processing'];

/**
 * Version of the commitments extractor (kind@version), recorded on every
 * appended row. Bump when the output meaningfully improves (better model or
 * prompt) so backfill runs can catch older items up.
 */
export const COMMITMENTS_EXTRACTOR_VERSION = 2;

/**
 * Owns the commitment-extraction pipeline step (JJ-36). WHEN it runs is decided
 * by the extraction DAG (`CommitmentsExtractor` + the generic pipeline in
 * @plaudern/extraction). This service owns enqueueing + manual retry and the
 * read models (an item's commitments, the user's list, status updates).
 *
 * Persisting an extraction's output lives in CommitmentsPersistenceService —
 * deliberately NOT here, so the processor (reached via the queue this service
 * injects) never needs an edge back to this service; that cycle would deadlock
 * Nest's module compile.
 */
@Injectable()
export class CommitmentsService {
  constructor(
    private readonly inbox: InboxService,
    @Inject(COMMITMENT_EXTRACTION_PROVIDER)
    private readonly provider: CommitmentExtractionProvider,
    @Inject(COMMITMENTS_QUEUE)
    private readonly queue: CommitmentsQueue,
    @InjectRepository(CommitmentEntity)
    private readonly commitments: Repository<CommitmentEntity>,
    @InjectRepository(InboxItemEntity)
    private readonly items: Repository<InboxItemEntity>,
    private readonly selfProfile: SelfProfileService,
  ) {}

  /**
   * Whether commitment extraction is configured (COMMITMENTS_API_KEY present,
   * or COMMITMENTS_ENABLED=true for keyless local endpoints like Ollama).
   */
  get enabled(): boolean {
    return this.provider.enabled;
  }

  // ---- Pipeline ----

  /**
   * Manually (re)run commitment extraction for an item — e.g. after a failure
   * or a provider/model change. Appends a fresh extraction (older ones stay in
   * history); persisted commitments are upserted so the user's statuses survive.
   */
  async retry(userId: string, inboxItemId: string): Promise<string> {
    if (!this.provider.enabled) {
      throw new BadRequestException(
        'commitment extraction is not configured (set COMMITMENTS_API_KEY, or COMMITMENTS_ENABLED=true for keyless local endpoints such as Ollama)',
      );
    }
    if (!(await this.selfProfile.hasOwner(userId))) {
      throw new BadRequestException(
        'set which contact is you ("This is me") before extracting commitments',
      );
    }
    const item = await this.inbox.getItem(userId, inboxItemId);
    const extractions = item.extractions ?? [];
    const transcription = latestOfKind(extractions, 'transcription');
    if (transcription?.status !== 'succeeded') {
      throw new BadRequestException('item has no completed transcription to extract commitments from');
    }
    const commitments = latestOfKind(extractions, 'commitments');
    if (commitments && ACTIVE_STATUSES.includes(commitments.status)) {
      throw new ConflictException('commitment extraction is already running');
    }
    return (await this.enqueueCommitments(inboxItemId, userId)) as string;
  }

  /**
   * Append a fresh `queued` commitments row and hand the job to the queue.
   * No-op (returns null) when the user has not designated an account owner —
   * direction is meaningless without one, so we never extract or guess.
   */
  async enqueueCommitments(inboxItemId: string, userId: string): Promise<string | null> {
    if (!(await this.selfProfile.hasOwner(userId))) return null;
    const extraction = await this.inbox.addExtraction(
      inboxItemId,
      'commitments',
      this.provider.id,
      COMMITMENTS_EXTRACTOR_VERSION,
    );
    await this.queue.enqueue({ extractionId: extraction.id, inboxItemId });
    return extraction.id;
  }

  // ---- Read models ----

  /** An item's commitments tab: latest extraction's status + the item's commitments. */
  async getItemCommitments(userId: string, inboxItemId: string): Promise<ItemCommitmentsResponse> {
    const item = await this.inbox.getItem(userId, inboxItemId);
    // Without an account owner, direction can't be trusted — surface the prompt
    // to set one instead of showing (possibly mis-attributed) commitments.
    if (!(await this.selfProfile.hasOwner(userId))) {
      return {
        status: null,
        commitments: [],
        model: null,
        error: null,
        createdAt: null,
        completedAt: null,
        needsOwner: true,
      };
    }
    const latest = latestOfKind(item.extractions ?? [], 'commitments');
    const occurredAt = iso(item.occurredAt)!;
    // Hide commitments the dedupe collapsed into a task (duplicatesTaskId set) —
    // the task carries the same intention, so we show it once, not twice.
    const rows = await this.commitments.find({
      where: { userId, inboxItemId, duplicatesTaskId: IsNull() },
    });
    return {
      status: latest?.status ?? null,
      commitments: rows
        .map((row) => toCommitmentDto(row, occurredAt))
        .sort(byDueThenCreated),
      model: latest?.provider ?? null,
      error: latest?.error ?? null,
      createdAt: latest ? iso(latest.createdAt) : null,
      completedAt: latest?.completedAt ?? null,
      needsOwner: false,
    };
  }

  /** The user's commitments, optionally filtered by direction and/or status. */
  async list(userId: string, filters: CommitmentListQuery): Promise<CommitmentListResponse> {
    if (!(await this.selfProfile.hasOwner(userId))) {
      return { commitments: [], needsOwner: true };
    }
    const rows = await this.commitments.find({
      where: {
        userId,
        // Exclude commitments the dedupe merged into a task, so the open-loops
        // ledger raises the intention once (as the task) instead of twice.
        duplicatesTaskId: IsNull(),
        ...(filters.direction ? { direction: filters.direction } : {}),
        ...(filters.status ? { status: filters.status } : {}),
      },
    });
    const occurredById = await this.occurredByItem(rows.map((r) => r.inboxItemId));
    const commitments = rows
      .map((row) => toCommitmentDto(row, occurredById.get(row.inboxItemId) ?? row.createdAt.toISOString()))
      .sort(byDueThenCreated);
    return { commitments, needsOwner: false };
  }

  /** Advance a commitment's lifecycle status (open → fulfilled / dismissed). */
  async updateStatus(userId: string, id: string, status: CommitmentStatus): Promise<CommitmentDto> {
    const row = await this.commitments.findOne({ where: { id, userId } });
    if (!row) throw new NotFoundException('commitment not found');
    row.status = status;
    const saved = await this.commitments.save(row);
    const occurredById = await this.occurredByItem([saved.inboxItemId]);
    return toCommitmentDto(
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

function toCommitmentDto(row: CommitmentEntity, occurredAt: string): CommitmentDto {
  return {
    id: row.id,
    inboxItemId: row.inboxItemId,
    direction: row.direction,
    counterpartyName: row.counterpartyName,
    counterpartyEntityId: row.counterpartyEntityId,
    description: row.description,
    dueDate: row.dueDate,
    status: row.status,
    sourceTimestamp: row.sourceTimestamp,
    occurredAt,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

/** Due date ascending (nulls last), then newest first. */
function byDueThenCreated(a: CommitmentDto, b: CommitmentDto): number {
  if (a.dueDate && b.dueDate) return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0;
  if (a.dueDate) return -1;
  if (b.dueDate) return 1;
  return a.createdAt < b.createdAt ? 1 : -1;
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
