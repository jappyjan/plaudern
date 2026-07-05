import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { InboxService } from '@plaudern/inbox';
import type {
  DecisionDto,
  DecisionListQuery,
  DecisionListResponse,
  DecisionStatus,
  ExtractionStatus,
  ItemDecisionsResponse,
} from '@plaudern/contracts';
import {
  DecisionEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
} from '@plaudern/persistence';
import {
  DECISION_EXTRACTION_PROVIDER,
  type DecisionExtractionProvider,
} from './decisions.provider';
import { DECISIONS_QUEUE, type DecisionsQueue } from './decisions.job';

const ACTIVE_STATUSES: ExtractionStatus[] = ['queued', 'processing'];

/**
 * Version of the decisions extractor (kind@version), recorded on every appended
 * row. Bump when the output meaningfully improves (better model or prompt) so
 * backfill runs can catch older items up.
 */
export const DECISIONS_EXTRACTOR_VERSION = 1;

/**
 * Owns the decision-extraction pipeline step (JJ-33). WHEN it runs is decided
 * by the extraction DAG (`DecisionsExtractor` + the generic pipeline in
 * @plaudern/extraction). This service owns enqueueing + manual retry and the
 * read models (an item's decisions, the user's log, status updates).
 *
 * Persisting an extraction's output lives in DecisionsPersistenceService —
 * deliberately NOT here, so the processor (reached via the queue this service
 * injects) never needs an edge back to this service; that cycle would deadlock
 * Nest's module compile.
 */
@Injectable()
export class DecisionsService {
  constructor(
    private readonly inbox: InboxService,
    @Inject(DECISION_EXTRACTION_PROVIDER)
    private readonly provider: DecisionExtractionProvider,
    @Inject(DECISIONS_QUEUE)
    private readonly queue: DecisionsQueue,
    @InjectRepository(DecisionEntity)
    private readonly decisions: Repository<DecisionEntity>,
    @InjectRepository(InboxItemEntity)
    private readonly items: Repository<InboxItemEntity>,
  ) {}

  /**
   * Whether decision extraction is configured (DECISIONS_API_KEY present, or
   * DECISIONS_ENABLED=true for keyless local endpoints like Ollama).
   */
  get enabled(): boolean {
    return this.provider.enabled;
  }

  // ---- Pipeline ----

  /**
   * Manually (re)run decision extraction for an item — e.g. after a failure or
   * a provider/model change. Appends a fresh extraction (older ones stay in
   * history); persisted decisions are upserted so a user status survives.
   */
  async retry(userId: string, inboxItemId: string): Promise<string> {
    if (!this.provider.enabled) {
      throw new BadRequestException(
        'decision extraction is not configured (set DECISIONS_API_KEY, or DECISIONS_ENABLED=true for keyless local endpoints such as Ollama)',
      );
    }
    const item = await this.inbox.getItem(userId, inboxItemId);
    const extractions = item.extractions ?? [];
    const transcription = latestOfKind(extractions, 'transcription');
    if (transcription?.status !== 'succeeded') {
      throw new BadRequestException('item has no completed transcription to extract decisions from');
    }
    const decisions = latestOfKind(extractions, 'decisions');
    if (decisions && ACTIVE_STATUSES.includes(decisions.status)) {
      throw new ConflictException('decision extraction is already running');
    }
    return this.enqueueDecisions(inboxItemId);
  }

  /** Append a fresh `queued` decisions row and hand the job to the queue. */
  async enqueueDecisions(inboxItemId: string): Promise<string> {
    const extraction = await this.inbox.addExtraction(
      inboxItemId,
      'decisions',
      this.provider.id,
      DECISIONS_EXTRACTOR_VERSION,
    );
    await this.queue.enqueue({ extractionId: extraction.id, inboxItemId });
    return extraction.id;
  }

  // ---- Read models ----

  /** An item's decisions tab: latest extraction's status + the item's decisions. */
  async getItemDecisions(userId: string, inboxItemId: string): Promise<ItemDecisionsResponse> {
    const item = await this.inbox.getItem(userId, inboxItemId);
    const latest = latestOfKind(item.extractions ?? [], 'decisions');
    const occurredAt = iso(item.occurredAt)!;
    const rows = await this.decisions.find({ where: { userId, inboxItemId } });
    return {
      status: latest?.status ?? null,
      decisions: rows.map((row) => toDecisionDto(row, occurredAt)).sort(byCreated),
      model: latest?.provider ?? null,
      error: latest?.error ?? null,
      createdAt: latest ? iso(latest.createdAt) : null,
      completedAt: latest?.completedAt ?? null,
    };
  }

  /** The user's decision log, optionally filtered by status and/or participant. */
  async list(userId: string, filters: DecisionListQuery): Promise<DecisionListResponse> {
    const rows = await this.decisions.find({
      where: {
        userId,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.participantEntityId
          ? { participantEntityId: filters.participantEntityId }
          : {}),
      },
    });
    const occurredById = await this.occurredByItem(rows.map((r) => r.inboxItemId));
    const decisions = rows
      .map((row) => toDecisionDto(row, occurredById.get(row.inboxItemId) ?? row.createdAt.toISOString()))
      .sort(byCreated);
    return { decisions };
  }

  /** Advance a decision's lifecycle status (active → revisited / superseded). */
  async updateStatus(userId: string, id: string, status: DecisionStatus): Promise<DecisionDto> {
    const row = await this.decisions.findOne({ where: { id, userId } });
    if (!row) throw new NotFoundException('decision not found');
    row.status = status;
    const saved = await this.decisions.save(row);
    const occurredById = await this.occurredByItem([saved.inboxItemId]);
    return toDecisionDto(
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

function toDecisionDto(row: DecisionEntity, occurredAt: string): DecisionDto {
  return {
    id: row.id,
    inboxItemId: row.inboxItemId,
    decision: row.decision,
    context: row.context,
    participants: row.participants,
    participantEntityId: row.participantEntityId,
    status: row.status,
    confidence: row.confidence,
    sourceTimestamp: row.sourceTimestamp,
    occurredAt,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

/** Newest first, by creation time. */
function byCreated(a: DecisionDto, b: DecisionDto): number {
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
