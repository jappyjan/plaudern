import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  DOSSIER_FACT_CITATIONS_CAP,
  DOSSIER_RECENT_ITEMS_CAP,
  DOSSIER_RELATIONS_CAP,
  summaryPayloadSchema,
  type DossierCitationDto,
  type DossierCommitmentDto,
  type DossierFactDto,
  type DossierQuestionDto,
  type DossierRecentItemDto,
  type EntityDossierDto,
  type PersonalFactDto,
} from '@plaudern/contracts';
import {
  ExtractedPayloadEntity,
  InboxItemEntity,
} from '@plaudern/persistence';
import { FactsRegistryService } from '@plaudern/facts';
import { CommitmentsService } from '@plaudern/commitments';
import { QuestionsService } from '@plaudern/questions';
import { EntitiesRegistryService } from './entities-registry.service';
import { EntityGraphService } from './entity-graph.service';

/**
 * Assembles the person dossier (JJ-24): one read-side aggregation of everything
 * the platform knows about a single registry `person` entity — its identity,
 * active + superseded personal facts (JJ-31), commitments both ways (JJ-36),
 * open questions (JJ-34), knowledge-graph neighborhood (JJ-22) and the recent
 * recordings that mention it — every element cited back to its source inbox
 * item(s).
 *
 * Purely a composition over the existing read models: it calls the facts /
 * commitments / questions / registry / graph services (no duplicated SQL) and
 * then resolves the referenced inbox items to lightweight citations in ONE
 * batched pass, so the whole page is a bounded number of queries rather than
 * N+1 per fact. Lists are capped (recent items, relations, per-fact citations)
 * with the pre-cap totals surfaced in `counts` for a "view all" affordance.
 *
 * Entity-resolution tolerance (JJ-70 repoints merges in parallel): rows are
 * matched to THIS entity by id, dangling relation endpoints simply drop out of
 * `neighbors`, and a missing source item yields no citation rather than a
 * crash — so a stale reference left by a merge never breaks the page.
 */
@Injectable()
export class DossierService {
  constructor(
    private readonly registry: EntitiesRegistryService,
    private readonly graph: EntityGraphService,
    private readonly facts: FactsRegistryService,
    private readonly commitments: CommitmentsService,
    private readonly questions: QuestionsService,
    @InjectRepository(InboxItemEntity)
    private readonly items: Repository<InboxItemEntity>,
    @InjectRepository(ExtractedPayloadEntity)
    private readonly extractions: Repository<ExtractedPayloadEntity>,
  ) {}

  /** The full dossier for one person entity (404s via registry.detail if unknown). */
  async build(userId: string, entityId: string): Promise<EntityDossierDto> {
    // Entity core + current mentions (throws NotFound when the id is unknown).
    const detail = await this.registry.detail(userId, entityId);

    // Fan out over the per-person read models in parallel. Each is a bounded
    // query set; none is per-fact, so this stays a constant number of queries.
    const [allFacts, commitmentsRes, questionsRes, neighborhood] = await Promise.all([
      this.facts.list(userId, { personEntityId: entityId, includeSuperseded: true }),
      this.commitments.list(userId, {}),
      this.questions.list(userId, {}),
      this.graph.neighborhood(userId, entityId),
    ]);

    const active = allFacts.filter((f) => f.active);
    const superseded = allFacts
      .filter((f) => !f.active)
      .sort((a, b) => (b.supersededAt ?? '').localeCompare(a.supersededAt ?? ''));

    // Commitments/questions are matched to this person by counterparty id — the
    // rows returned therefore reference an entity that exists (this one); a
    // dangling counterpartyEntityId elsewhere is simply never selected here.
    const owedByMe = commitmentsRes.commitments.filter(
      (c) => c.counterpartyEntityId === entityId && c.direction === 'owed_by_me',
    );
    const owedToMe = commitmentsRes.commitments.filter(
      (c) => c.counterpartyEntityId === entityId && c.direction === 'owed_to_me',
    );
    const openQuestions = questionsRes.questions.filter(
      (q) => q.counterpartyEntityId === entityId && q.status === 'open',
    );

    // Recent recordings mentioning this person, newest first, capped.
    const mentions = detail.mentions
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const recentMentions = mentions.slice(0, DOSSIER_RECENT_ITEMS_CAP);

    const relations = neighborhood.relations.slice(0, DOSSIER_RELATIONS_CAP);
    // Only keep neighbors still referenced by the (capped) relations — a
    // dangling endpoint the graph couldn't resolve is already absent here.
    const neighborIds = new Set(
      relations.flatMap((e) => [e.sourceEntityId, e.targetEntityId]).filter((id) => id !== entityId),
    );
    const neighbors = neighborhood.neighbors.filter((n) => neighborIds.has(n.id));

    // Resolve every referenced inbox item to citation metadata in one batch.
    const factCitationRefs = await this.facts.citationRefs(allFacts.map((f) => f.id));
    const referencedItemIds = new Set<string>();
    for (const refs of factCitationRefs.values()) {
      for (const ref of refs) referencedItemIds.add(ref.inboxItemId);
    }
    for (const c of [...owedByMe, ...owedToMe]) referencedItemIds.add(c.inboxItemId);
    for (const q of openQuestions) referencedItemIds.add(q.inboxItemId);
    for (const m of recentMentions) referencedItemIds.add(m.inboxItemId);
    const itemMeta = await this.itemMetadata(userId, [...referencedItemIds]);

    const toFact = (fact: PersonalFactDto): DossierFactDto => ({
      ...fact,
      citations: (factCitationRefs.get(fact.id) ?? [])
        .slice(0, DOSSIER_FACT_CITATIONS_CAP)
        .map((ref) => this.citation(itemMeta, ref.inboxItemId, ref.startSeconds, ref.quote))
        .filter((c): c is DossierCitationDto => c !== null),
    });

    const recentItems: DossierRecentItemDto[] = recentMentions
      .map((m) => {
        const meta = itemMeta.get(m.inboxItemId);
        if (!meta) return null;
        return {
          inboxItemId: m.inboxItemId,
          title: meta.title,
          sourceType: meta.sourceType,
          occurredAt: meta.occurredAt,
          surfaceForm: m.surfaceForm,
        } satisfies DossierRecentItemDto;
      })
      .filter((r): r is DossierRecentItemDto => r !== null)
      // "Recent" is about when the recording happened, not when the mention row
      // was written — order the displayed list by the recording's occurredAt.
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

    return {
      entity: {
        id: detail.id,
        type: detail.type,
        canonicalName: detail.canonicalName,
        aliases: detail.aliases,
        voiceProfileId: detail.voiceProfileId,
        voiceProfileLinkOrigin: detail.voiceProfileLinkOrigin,
        voiceProfileName: detail.voiceProfileName,
        mentionCount: detail.mentionCount,
        firstSeenAt: detail.firstSeenAt,
        lastSeenAt: detail.lastSeenAt,
        createdAt: detail.createdAt,
      },
      facts: {
        active: active.map(toFact),
        superseded: superseded.map(toFact),
      },
      commitments: {
        owedByMe: owedByMe.map((c): DossierCommitmentDto => ({
          ...c,
          citation: this.citation(itemMeta, c.inboxItemId, c.sourceTimestamp, null),
        })),
        owedToMe: owedToMe.map((c): DossierCommitmentDto => ({
          ...c,
          citation: this.citation(itemMeta, c.inboxItemId, c.sourceTimestamp, null),
        })),
      },
      openQuestions: openQuestions.map((q): DossierQuestionDto => ({
        ...q,
        citation: this.citation(itemMeta, q.inboxItemId, q.sourceTimestamp, null),
      })),
      relations,
      neighbors,
      recentItems,
      counts: {
        activeFacts: active.length,
        supersededFacts: superseded.length,
        owedByMe: owedByMe.length,
        owedToMe: owedToMe.length,
        openQuestions: openQuestions.length,
        relations: neighborhood.relations.length,
        mentions: detail.mentionCount,
      },
    };
  }

  /** Build one citation from resolved item metadata, or null when the item is gone. */
  private citation(
    itemMeta: Map<string, ItemMeta>,
    inboxItemId: string,
    startSeconds: number | null,
    quote: string | null,
  ): DossierCitationDto | null {
    const meta = itemMeta.get(inboxItemId);
    if (!meta) return null;
    return {
      inboxItemId,
      title: meta.title,
      sourceType: meta.sourceType,
      occurredAt: meta.occurredAt,
      startSeconds,
      quote,
    };
  }

  /**
   * Batched item metadata (title, sourceType, occurredAt) for a set of inbox
   * item ids — a user-scoped items query plus one summary-extraction query.
   * Title prefers an explicit metadata tag, then the latest succeeded summary's
   * title; items missing from the map (deleted/merged away) are skipped by
   * callers so a stale reference degrades to "no citation", never a crash.
   */
  private async itemMetadata(userId: string, itemIds: string[]): Promise<Map<string, ItemMeta>> {
    const result = new Map<string, ItemMeta>();
    const unique = [...new Set(itemIds)].filter(Boolean);
    if (unique.length === 0) return result;

    const items = await this.items.find({
      where: { id: In(unique), userId },
      select: { id: true, sourceType: true, occurredAt: true, metadata: true },
    });
    if (items.length === 0) return result;

    const titles = await this.summaryTitles(items.map((i) => i.id));
    for (const item of items) {
      result.set(item.id, {
        title: tagTitle(item.metadata) ?? titles.get(item.id) ?? null,
        sourceType: item.sourceType,
        occurredAt: item.occurredAt,
      });
    }
    return result;
  }

  /** AI summary title per item, from each item's latest succeeded summary extraction. */
  private async summaryTitles(itemIds: string[]): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    if (itemIds.length === 0) return titles;
    const rows = await this.extractions.find({
      where: { inboxItemId: In(itemIds), kind: 'summary', status: 'succeeded' },
    });
    const latestByItem = new Map<string, ExtractedPayloadEntity>();
    for (const row of rows) {
      const current = latestByItem.get(row.inboxItemId);
      if (!current || row.createdAt > current.createdAt) latestByItem.set(row.inboxItemId, row);
    }
    for (const [itemId, row] of latestByItem) {
      if (!row.content) continue;
      try {
        const parsed = summaryPayloadSchema.safeParse(JSON.parse(row.content));
        if (parsed.success && parsed.data.title) titles.set(itemId, parsed.data.title);
      } catch {
        // Non-JSON / malformed content — leave the item without a summary title.
      }
    }
    return titles;
  }
}

interface ItemMeta {
  title: string | null;
  sourceType: InboxItemEntity['sourceType'];
  occurredAt: string;
}

/** An explicit title tag on the item's ingest metadata, when present. */
function tagTitle(metadata: Record<string, unknown> | null): string | null {
  const tags = (metadata?.tags as Record<string, unknown> | undefined) ?? undefined;
  return typeof tags?.title === 'string' ? tags.title : null;
}
