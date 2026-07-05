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
  ExtractionStatus,
  ItemQuestionsResponse,
  QuestionDto,
  QuestionListQuery,
  QuestionListResponse,
  QuestionStatus,
} from '@plaudern/contracts';
import {
  ExtractedPayloadEntity,
  InboxItemEntity,
  QuestionEntity,
} from '@plaudern/persistence';
import {
  QUESTION_EXTRACTION_PROVIDER,
  type QuestionExtractionProvider,
} from './questions.provider';
import { QUESTIONS_QUEUE, type QuestionsQueue } from './questions.job';

const ACTIVE_STATUSES: ExtractionStatus[] = ['queued', 'processing'];

/**
 * Version of the questions extractor (kind@version), recorded on every appended
 * row. Bump when the output meaningfully improves (better model or prompt) so
 * backfill runs can catch older items up.
 */
export const QUESTIONS_EXTRACTOR_VERSION = 1;

/**
 * Owns the question-extraction pipeline step (JJ-34). WHEN it runs is decided
 * by the extraction DAG (`QuestionsExtractor` + the generic pipeline in
 * @plaudern/extraction). This service owns enqueueing + manual retry and the
 * read models (an item's questions, the user's list, status updates).
 *
 * Persisting an extraction's output lives in QuestionsPersistenceService —
 * deliberately NOT here, so the processor (reached via the queue this service
 * injects) never needs an edge back to this service; that cycle would deadlock
 * Nest's module compile.
 */
@Injectable()
export class QuestionsService {
  constructor(
    private readonly inbox: InboxService,
    @Inject(QUESTION_EXTRACTION_PROVIDER)
    private readonly provider: QuestionExtractionProvider,
    @Inject(QUESTIONS_QUEUE)
    private readonly queue: QuestionsQueue,
    @InjectRepository(QuestionEntity)
    private readonly questions: Repository<QuestionEntity>,
    @InjectRepository(InboxItemEntity)
    private readonly items: Repository<InboxItemEntity>,
  ) {}

  /**
   * Whether question extraction is configured (QUESTIONS_API_KEY present, or
   * QUESTIONS_ENABLED=true for keyless local endpoints like Ollama).
   */
  get enabled(): boolean {
    return this.provider.enabled;
  }

  // ---- Pipeline ----

  /**
   * Manually (re)run question extraction for an item — e.g. after a failure or
   * a provider/model change. Appends a fresh extraction (older ones stay in
   * history); persisted questions are upserted so a user `dropped` survives.
   */
  async retry(userId: string, inboxItemId: string): Promise<string> {
    if (!this.provider.enabled) {
      throw new BadRequestException(
        'question extraction is not configured (set QUESTIONS_API_KEY, or QUESTIONS_ENABLED=true for keyless local endpoints such as Ollama)',
      );
    }
    const item = await this.inbox.getItem(userId, inboxItemId);
    const extractions = item.extractions ?? [];
    const transcription = latestOfKind(extractions, 'transcription');
    if (transcription?.status !== 'succeeded') {
      throw new BadRequestException('item has no completed transcription to extract questions from');
    }
    const questions = latestOfKind(extractions, 'questions');
    if (questions && ACTIVE_STATUSES.includes(questions.status)) {
      throw new ConflictException('question extraction is already running');
    }
    return this.enqueueQuestions(inboxItemId);
  }

  /** Append a fresh `queued` questions row and hand the job to the queue. */
  async enqueueQuestions(inboxItemId: string): Promise<string> {
    const extraction = await this.inbox.addExtraction(
      inboxItemId,
      'questions',
      this.provider.id,
      QUESTIONS_EXTRACTOR_VERSION,
    );
    await this.queue.enqueue({ extractionId: extraction.id, inboxItemId });
    return extraction.id;
  }

  // ---- Read models ----

  /** An item's questions tab: latest extraction's status + the item's questions. */
  async getItemQuestions(userId: string, inboxItemId: string): Promise<ItemQuestionsResponse> {
    const item = await this.inbox.getItem(userId, inboxItemId);
    const latest = latestOfKind(item.extractions ?? [], 'questions');
    const occurredAt = iso(item.occurredAt)!;
    const rows = await this.questions.find({ where: { userId, inboxItemId } });
    return {
      status: latest?.status ?? null,
      questions: rows.map((row) => toQuestionDto(row, occurredAt)).sort(byCreated),
      model: latest?.provider ?? null,
      error: latest?.error ?? null,
      createdAt: latest ? iso(latest.createdAt) : null,
      completedAt: latest?.completedAt ?? null,
    };
  }

  /** The user's questions, optionally filtered by direction and/or status. */
  async list(userId: string, filters: QuestionListQuery): Promise<QuestionListResponse> {
    const rows = await this.questions.find({
      where: {
        userId,
        ...(filters.direction ? { direction: filters.direction } : {}),
        ...(filters.status ? { status: filters.status } : {}),
      },
    });
    const occurredById = await this.occurredByItem(rows.map((r) => r.inboxItemId));
    const questions = rows
      .map((row) => toQuestionDto(row, occurredById.get(row.inboxItemId) ?? row.createdAt.toISOString()))
      .sort(byCreated);
    return { questions };
  }

  /** Advance a question's lifecycle status (open → answered / dropped). */
  async updateStatus(userId: string, id: string, status: QuestionStatus): Promise<QuestionDto> {
    const row = await this.questions.findOne({ where: { id, userId } });
    if (!row) throw new NotFoundException('question not found');
    row.status = status;
    const saved = await this.questions.save(row);
    const occurredById = await this.occurredByItem([saved.inboxItemId]);
    return toQuestionDto(
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

function toQuestionDto(row: QuestionEntity, occurredAt: string): QuestionDto {
  return {
    id: row.id,
    inboxItemId: row.inboxItemId,
    direction: row.direction,
    counterpartyName: row.counterpartyName,
    counterpartyEntityId: row.counterpartyEntityId,
    question: row.question,
    status: row.status,
    sourceTimestamp: row.sourceTimestamp,
    occurredAt,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

/** Newest first, by creation time. */
function byCreated(a: QuestionDto, b: QuestionDto): number {
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
