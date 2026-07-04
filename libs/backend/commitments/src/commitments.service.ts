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
  CommitmentDto,
  CommitmentListQuery,
  CommitmentListResponse,
  CommitmentStatus,
  ExtractedCommitment,
  ExtractionStatus,
  ItemCommitmentsResponse,
} from '@plaudern/contracts';
import {
  CommitmentEntity,
  EntityRegistryEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
} from '@plaudern/persistence';
import {
  COMMITMENT_EXTRACTION_PROVIDER,
  type CommitmentExtractionProvider,
} from './commitments.provider';
import { COMMITMENTS_QUEUE, type CommitmentsQueue } from './commitments.job';
import { resolveDueDate } from './date-resolver';

const ACTIVE_STATUSES: ExtractionStatus[] = ['queued', 'processing'];

/**
 * Version of the commitments extractor (kind@version), recorded on every
 * appended row. Bump when the output meaningfully improves (better model or
 * prompt) so backfill runs can catch older items up.
 */
export const COMMITMENTS_EXTRACTOR_VERSION = 1;

/**
 * Owns the commitment-extraction pipeline step (JJ-36). WHEN it runs is decided
 * by the extraction DAG (`CommitmentsExtractor` + the generic pipeline in
 * @plaudern/extraction). This service owns HOW: enqueueing + manual retry,
 * persisting the resolved commitments (dedupe/upsert, relative-date resolution,
 * counterparty→registry linking), and the read models (an item's commitments,
 * the user's list, status updates).
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
    @InjectRepository(EntityRegistryEntity)
    private readonly entities: Repository<EntityRegistryEntity>,
    @InjectRepository(InboxItemEntity)
    private readonly items: Repository<InboxItemEntity>,
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
    return this.enqueueCommitments(inboxItemId);
  }

  /** Append a fresh `queued` commitments row and hand the job to the queue. */
  async enqueueCommitments(inboxItemId: string): Promise<string> {
    const extraction = await this.inbox.addExtraction(
      inboxItemId,
      'commitments',
      this.provider.id,
      COMMITMENTS_EXTRACTOR_VERSION,
    );
    await this.queue.enqueue({ extractionId: extraction.id, inboxItemId });
    return extraction.id;
  }

  /**
   * Resolve + persist a batch of extracted commitments for an item. Relative
   * due phrases are resolved to absolute instants against `occurredAt`;
   * counterparties are linked to the per-user registry `person` entities when a
   * confident name match exists. Deduped + upserted on
   * (inboxItemId, direction, normalizedDescription): a re-run updates the
   * existing row (repointing provenance to the new extraction) but PRESERVES the
   * user's status, so backfills never duplicate or reset progress. Returns the
   * number of commitment rows the extraction touched.
   */
  async persist(
    userId: string,
    inboxItemId: string,
    extractionId: string,
    occurredAt: string | undefined,
    extracted: ExtractedCommitment[],
  ): Promise<number> {
    // Collapse duplicates within the batch first (same direction + normalized
    // description), keeping the first occurrence.
    const byKey = new Map<string, ExtractedCommitment>();
    for (const raw of extracted) {
      const description = raw.description.trim();
      if (!description) continue;
      const key = `${raw.direction}:${normalize(description)}`;
      if (!byKey.has(key)) byKey.set(key, { ...raw, description });
    }
    if (byKey.size === 0) return 0;

    const personByName = await this.personEntities(userId);
    let count = 0;
    for (const raw of byKey.values()) {
      const normalizedDescription = normalize(raw.description);
      const counterpartyName = raw.counterparty.trim();
      const counterpartyEntityId = counterpartyName
        ? personByName.get(normalize(counterpartyName)) ?? null
        : null;
      const dueIso = resolveDueDate(raw.duePhrase, occurredAt ?? null);

      const existing = await this.commitments.findOne({
        where: { inboxItemId, direction: raw.direction, normalizedDescription },
      });
      if (existing) {
        existing.extractionId = extractionId;
        existing.description = raw.description;
        existing.counterpartyName = counterpartyName;
        existing.counterpartyEntityId = counterpartyEntityId;
        existing.dueDate = dueIso;
        existing.sourceTimestamp = raw.sourceTimestamp ?? null;
        existing.sourceQuote = raw.sourceQuote ?? null;
        // status is deliberately left untouched — it is the user's to advance.
        await this.commitments.save(existing);
      } else {
        await this.commitments.save(
          this.commitments.create({
            userId,
            inboxItemId,
            extractionId,
            direction: raw.direction,
            counterpartyName,
            counterpartyEntityId,
            description: raw.description,
            normalizedDescription,
            dueDate: dueIso,
            status: 'open',
            sourceTimestamp: raw.sourceTimestamp ?? null,
            sourceQuote: raw.sourceQuote ?? null,
          }),
        );
      }
      count += 1;
    }
    return count;
  }

  // ---- Read models ----

  /** An item's commitments tab: latest extraction's status + the item's commitments. */
  async getItemCommitments(userId: string, inboxItemId: string): Promise<ItemCommitmentsResponse> {
    const item = await this.inbox.getItem(userId, inboxItemId);
    const latest = latestOfKind(item.extractions ?? [], 'commitments');
    const occurredAt = iso(item.occurredAt)!;
    const rows = await this.commitments.find({ where: { userId, inboxItemId } });
    return {
      status: latest?.status ?? null,
      commitments: rows
        .map((row) => toCommitmentDto(row, occurredAt))
        .sort(byDueThenCreated),
      model: latest?.provider ?? null,
      error: latest?.error ?? null,
      createdAt: latest ? iso(latest.createdAt) : null,
      completedAt: latest?.completedAt ?? null,
    };
  }

  /** The user's commitments, optionally filtered by direction and/or status. */
  async list(userId: string, filters: CommitmentListQuery): Promise<CommitmentListResponse> {
    const rows = await this.commitments.find({
      where: {
        userId,
        ...(filters.direction ? { direction: filters.direction } : {}),
        ...(filters.status ? { status: filters.status } : {}),
      },
    });
    const occurredById = await this.occurredByItem(rows.map((r) => r.inboxItemId));
    const commitments = rows
      .map((row) => toCommitmentDto(row, occurredById.get(row.inboxItemId) ?? row.createdAt.toISOString()))
      .sort(byDueThenCreated);
    return { commitments };
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

  /** Named `person` registry entities keyed by normalized name, for linking. */
  private async personEntities(userId: string): Promise<Map<string, string>> {
    const rows = await this.entities.find({ where: { userId, type: 'person' } });
    const map = new Map<string, string>();
    for (const row of rows) {
      // First writer wins so linking is stable when two rows normalize alike.
      if (!map.has(row.normalizedName)) map.set(row.normalizedName, row.id);
    }
    return map;
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

/** Normalization key: lowercased, whitespace-collapsed. Dedupe + name matching. */
export function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
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
