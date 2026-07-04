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
import {
  topicClassificationPayloadSchema,
  type CreateTopicRequest,
  type ExtractionStatus,
  type ItemTopicsResponse,
  type TopicAssignmentDto,
  type TopicDto,
  type TopicItemsResponse,
  type UpdateTopicRequest,
} from '@plaudern/contracts';
import {
  ExtractedPayloadEntity,
  InboxItemEntity,
  ItemTopicEntity,
  TopicEntity,
} from '@plaudern/persistence';
import {
  TOPIC_CLASSIFICATION_PROVIDER,
  type TopicClassificationProvider,
} from './topics.provider';
import { TOPICS_QUEUE, type TopicsQueue } from './topics.job';
import { buildTopicContent } from './topic-context';

const ACTIVE_STATUSES: ExtractionStatus[] = ['queued', 'processing'];

/**
 * Version of the topics extractor (kind@version), recorded on every appended
 * row. Bump when the output meaningfully improves (better model or prompt) so
 * backfill runs can catch older items up.
 */
export const TOPICS_EXTRACTOR_VERSION = 1;

/**
 * Owns topic/project classification (JJ-18). WHEN a classification runs is
 * decided by the extraction DAG (`TopicsExtractor` + the generic pipeline in
 * `@plaudern/extraction`); this service owns HOW: the editable taxonomy (CRUD),
 * enqueueing + manual retry, and the read models (an item's topics, a topic's
 * items).
 */
@Injectable()
export class TopicsService {
  constructor(
    private readonly inbox: InboxService,
    @InjectRepository(TopicEntity)
    private readonly topics: Repository<TopicEntity>,
    @InjectRepository(ItemTopicEntity)
    private readonly assignments: Repository<ItemTopicEntity>,
    @InjectRepository(InboxItemEntity)
    private readonly items: Repository<InboxItemEntity>,
    @Inject(TOPIC_CLASSIFICATION_PROVIDER)
    private readonly provider: TopicClassificationProvider,
    @Inject(TOPICS_QUEUE)
    private readonly queue: TopicsQueue,
  ) {}

  /** Whether classification is configured (TOPICS_API_KEY or TOPICS_ENABLED). */
  get enabled(): boolean {
    return this.provider.enabled;
  }

  // ---- Taxonomy CRUD ----

  /** Every taxonomy entry for a user (archived included), newest first. */
  async listTopics(userId: string): Promise<TopicDto[]> {
    const rows = await this.topics.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    return rows.map(toTopicDto);
  }

  async createTopic(userId: string, req: CreateTopicRequest): Promise<TopicDto> {
    const row = this.topics.create({
      userId,
      name: req.name,
      description: req.description ?? null,
      archived: false,
    });
    return toTopicDto(await this.topics.save(row));
  }

  async updateTopic(userId: string, id: string, req: UpdateTopicRequest): Promise<TopicDto> {
    const row = await this.topics.findOne({ where: { id, userId } });
    if (!row) throw new NotFoundException('topic not found');
    if (req.name !== undefined) row.name = req.name;
    if (req.description !== undefined) row.description = req.description;
    if (req.archived !== undefined) row.archived = req.archived;
    return toTopicDto(await this.topics.save(row));
  }

  /**
   * Delete a taxonomy entry and prune its assignments. The immutable
   * classification history stays in `extracted_payloads` (each `topics` row's
   * JSON `content`); only the queryable `item_topics` projection is pruned.
   */
  async deleteTopic(userId: string, id: string): Promise<void> {
    const row = await this.topics.findOne({ where: { id, userId } });
    if (!row) throw new NotFoundException('topic not found');
    await this.topics.manager.transaction(async (em) => {
      await em.getRepository(ItemTopicEntity).delete({ userId, topicId: id });
      await em.getRepository(TopicEntity).delete({ id, userId });
    });
  }

  /** The user's active (non-archived) taxonomy — the candidates a run tags against. */
  async getActiveTopics(userId: string): Promise<TopicEntity[]> {
    return this.topics.find({ where: { userId, archived: false } });
  }

  // ---- Read models ----

  /** An item's topics tab: latest classification's status + assignments. */
  async getItemTopics(userId: string, inboxItemId: string): Promise<ItemTopicsResponse> {
    const item = await this.inbox.getItem(userId, inboxItemId);
    const topics = latestOfKind(item.extractions ?? [], 'topics');
    if (!topics) {
      return {
        status: null,
        assignments: [],
        model: null,
        error: null,
        createdAt: null,
        completedAt: null,
      };
    }
    const payload = parsePayload(topics.content);
    return {
      status: topics.status,
      // The immutable payload may reference topics deleted since the run;
      // filter to surviving taxonomy entries so this read model agrees with
      // listItemsByTopic (whose item_topics rows are pruned on delete).
      assignments: await this.survivingAssignments(userId, payload?.assignments ?? []),
      model: payload?.model ?? null,
      error: topics.error,
      createdAt: iso(topics.createdAt),
      completedAt: iso(topics.completedAt),
    };
  }

  /** Drop assignments whose topic no longer exists in the user's taxonomy. */
  private async survivingAssignments(
    userId: string,
    assignments: TopicAssignmentDto[],
  ): Promise<TopicAssignmentDto[]> {
    if (assignments.length === 0) return assignments;
    const rows = await this.topics.find({
      select: { id: true },
      where: { userId, id: In(assignments.map((a) => a.topicId)) },
    });
    const alive = new Set(rows.map((r) => r.id));
    return assignments.filter((a) => alive.has(a.topicId));
  }

  /**
   * Every item currently tagged with a topic, newest first. Reads the
   * latest-only `item_topics` projection, so each item appears at most once.
   */
  async listItemsByTopic(userId: string, topicId: string): Promise<TopicItemsResponse> {
    const topic = await this.topics.findOne({ where: { id: topicId, userId } });
    if (!topic) throw new NotFoundException('topic not found');

    const rows = await this.assignments.find({ where: { userId, topicId } });
    if (rows.length === 0) return { topicId, items: [] };

    const itemIds = rows.map((r) => r.inboxItemId);
    const items = await this.items.find({ where: { id: In(itemIds) } });
    const occurredById = new Map(items.map((i) => [i.id, i.occurredAt]));

    const result = rows
      .filter((r) => occurredById.has(r.inboxItemId))
      .map((r) => ({
        inboxItemId: r.inboxItemId,
        confidence: r.confidence,
        occurredAt: iso(occurredById.get(r.inboxItemId)!)!,
      }))
      .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));

    return { topicId, items: result };
  }

  // ---- Pipeline ----

  /**
   * Manually (re)classify an item — e.g. after a failure or a taxonomy change.
   * Appends a fresh topics row; older ones stay in history (append-only).
   */
  async retry(userId: string, inboxItemId: string): Promise<string> {
    if (!this.provider.enabled) {
      throw new BadRequestException(
        'topic classification is not configured (set TOPICS_API_KEY, or TOPICS_ENABLED=true for keyless local endpoints such as Ollama)',
      );
    }
    const item = await this.inbox.getItem(userId, inboxItemId);
    if (!buildTopicContent(item)) {
      throw new BadRequestException('item has no summary or transcription to classify');
    }
    const topics = latestOfKind(item.extractions ?? [], 'topics');
    if (topics && ACTIVE_STATUSES.includes(topics.status)) {
      throw new ConflictException('a classification is already running');
    }
    return this.enqueueTopics(inboxItemId);
  }

  /** Append a fresh `queued` topics row and hand the job to the queue. */
  async enqueueTopics(inboxItemId: string): Promise<string> {
    const extraction = await this.inbox.addExtraction(
      inboxItemId,
      'topics',
      this.provider.id,
      TOPICS_EXTRACTOR_VERSION,
    );
    await this.queue.enqueue({ extractionId: extraction.id, inboxItemId });
    return extraction.id;
  }
}

function toTopicDto(row: TopicEntity): TopicDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    archived: row.archived,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
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

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function parsePayload(content: string | null): { assignments: TopicAssignmentDto[]; model: string | null } | null {
  if (!content) return null;
  try {
    const parsed = topicClassificationPayloadSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
