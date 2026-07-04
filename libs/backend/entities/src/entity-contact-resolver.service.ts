import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { EntityContactSuggestionDto } from '@plaudern/contracts';
import {
  EntityMentionEntity,
  EntityRegistryEntity,
  ExtractedPayloadEntity,
  SpeakerOccurrenceEntity,
  VoiceProfileEntity,
} from '@plaudern/persistence';
import {
  LLM_ACCEPT_CONFIDENCE,
  SUGGESTION_FLOOR,
  exactContactMatch,
  heuristicallyDecisive,
  rankCandidates,
  scoreCandidate,
  type ContactEvidence,
} from './contact-matching';
import {
  CONTACT_RESOLUTION_PROVIDER,
  type ContactResolutionProvider,
} from './contact-resolution.provider';
import { EntitiesRegistryService } from './entities-registry.service';
import { EntityGraphService } from './entity-graph.service';

/** LLM shortlist: anything with a whiff of evidence, capped to keep prompts small. */
const LLM_SHORTLIST_FLOOR = 0.05;
const LLM_SHORTLIST_MAX = 5;
const MENTION_EXAMPLES_MAX = 5;

/**
 * Intelligent entity↔contact identity resolution. For every unlinked person
 * entity it gathers evidence against the whole contact book — fuzzy name
 * affinity, whose voice is in the recordings that mention the person, and the
 * knowledge graph (shared neighbors as identity evidence, co-mentions as
 * counter-evidence) — scores it (contact-matching.ts), and either links
 * decisively, asks the LLM provider to settle ambiguous cases, or leaves the
 * ranked suggestions for the user. Explicitly unlinked (`suppressed`) entities
 * are never touched.
 */
@Injectable()
export class EntityContactResolverService {
  private readonly logger = new Logger(EntityContactResolverService.name);

  constructor(
    @InjectRepository(EntityRegistryEntity)
    private readonly entities: Repository<EntityRegistryEntity>,
    @InjectRepository(EntityMentionEntity)
    private readonly mentions: Repository<EntityMentionEntity>,
    @InjectRepository(ExtractedPayloadEntity)
    private readonly extractions: Repository<ExtractedPayloadEntity>,
    @InjectRepository(SpeakerOccurrenceEntity)
    private readonly occurrences: Repository<SpeakerOccurrenceEntity>,
    @InjectRepository(VoiceProfileEntity)
    private readonly profiles: Repository<VoiceProfileEntity>,
    private readonly registry: EntitiesRegistryService,
    private readonly graph: EntityGraphService,
    @Inject(CONTACT_RESOLUTION_PROVIDER)
    private readonly provider: ContactResolutionProvider,
  ) {}

  /**
   * Ranked contact suggestions for one entity, with the evidence spelled out.
   * Heuristics only — fast enough for the link dialog; the LLM weighs in
   * during auto-linking, where latency is invisible.
   */
  async suggest(userId: string, entityId: string): Promise<EntityContactSuggestionDto[]> {
    const entity = await this.entities.findOne({ where: { id: entityId, userId } });
    if (!entity) throw new NotFoundException('entity not found');
    if (entity.type !== 'person') return [];
    const contacts = await this.profiles.find({ where: { userId } });
    if (contacts.length === 0) return [];
    const evidence = await this.gatherEvidence(userId, entity, contacts);
    return rankCandidates(entityNames(entity), evidence).map((candidate) => ({
      voiceProfileId: candidate.voiceProfileId,
      name: candidate.contactName,
      confidence: round(candidate.confidence),
      reasons: candidate.reasons,
    }));
  }

  /** Resolve every unlinked person entity of the user. Returns links made. */
  async autoLinkAll(userId: string): Promise<number> {
    const rows = await this.entities.find({ where: { userId, type: 'person' } });
    return this.autoLink(userId, rows);
  }

  /**
   * Resolve just the person entities mentioned by one item's latest entities
   * extraction — the per-recording pass the pipeline runs after extraction, so
   * new mentions link up (or get suggestions) without any user action.
   */
  async autoLinkForItem(userId: string, inboxItemId: string): Promise<number> {
    const rows = await this.registry.entitiesForItem(userId, inboxItemId);
    return this.autoLink(userId, rows.filter((row) => row.type === 'person'));
  }

  private async autoLink(userId: string, rows: EntityRegistryEntity[]): Promise<number> {
    const unlinked = rows.filter(
      (row) =>
        row.type === 'person' && !row.voiceProfileId && row.voiceProfileLinkOrigin !== 'suppressed',
    );
    if (unlinked.length === 0) return 0;
    const contacts = await this.profiles.find({ where: { userId } });
    if (contacts.length === 0) return 0;

    let linked = 0;
    for (const entity of unlinked) {
      try {
        const match = await this.resolveOne(userId, entity, contacts);
        if (!match) continue;
        entity.voiceProfileId = match.voiceProfileId;
        entity.voiceProfileLinkOrigin = 'auto';
        await this.entities.save(entity);
        linked += 1;
        this.logger.log(
          `linked entity "${entity.canonicalName}" to contact ${match.voiceProfileId} (${match.via}: ${match.reason})`,
        );
      } catch (err) {
        // Resolution is enrichment, never a pipeline failure: log and move on.
        this.logger.warn(
          `contact resolution failed for entity ${entity.id}: ${(err as Error).message}`,
        );
      }
    }
    return linked;
  }

  /** One entity against the contact book: decisive heuristics, then the LLM. */
  private async resolveOne(
    userId: string,
    entity: EntityRegistryEntity,
    contacts: VoiceProfileEntity[],
  ): Promise<{ voiceProfileId: string; via: 'heuristic' | 'llm'; reason: string } | null> {
    const names = entityNames(entity);
    // Exact (folded) full-name equality is decisive on its own — same fast
    // path ingest takes, so a sweep after renaming a contact behaves alike.
    const exact = exactContactMatch(names, contacts);
    if (exact) return { voiceProfileId: exact, via: 'heuristic', reason: 'exact name match' };

    const evidence = await this.gatherEvidence(userId, entity, contacts);
    const scored = evidence
      .map((e) => scoreCandidate(names, e))
      .sort((a, b) => b.confidence - a.confidence);

    const ranked = scored.filter((c) => c.confidence >= SUGGESTION_FLOOR);
    if (heuristicallyDecisive(ranked)) {
      return {
        voiceProfileId: ranked[0].voiceProfileId,
        via: 'heuristic',
        reason: ranked[0].reasons.join('; ') || `confidence ${round(ranked[0].confidence)}`,
      };
    }

    if (!this.provider.enabled) return null;
    // Anything with a whiff of evidence goes to the model — it can bridge what
    // lexical matching can't (nicknames, diminutives), but it may only choose
    // among candidates we can substantiate.
    const shortlist = scored
      .filter((c) => c.confidence >= LLM_SHORTLIST_FLOOR)
      .slice(0, LLM_SHORTLIST_MAX);
    if (shortlist.length === 0) return null;

    const mentionExamples = await this.mentionExamples(entity.id);
    const result = await this.provider.resolve({
      entity: {
        id: entity.id,
        name: entity.canonicalName,
        aliases: entity.aliases ?? [],
        mentionExamples,
      },
      candidates: shortlist.map((candidate) => ({
        voiceProfileId: candidate.voiceProfileId,
        name: candidate.contactName,
        evidence: candidate.reasons,
        heuristicConfidence: round(candidate.confidence),
      })),
    });
    const { decision } = result;
    if (!decision.voiceProfileId || decision.confidence < LLM_ACCEPT_CONFIDENCE) return null;
    return {
      voiceProfileId: decision.voiceProfileId,
      via: 'llm',
      reason: decision.reason || `model confidence ${round(decision.confidence)}`,
    };
  }

  /**
   * Build the evidence dossier of one entity against every contact:
   * co-presence (whose voice is in the recordings mentioning the entity),
   * shared graph neighbors via each contact's already-linked entities, and
   * co-mentions with those entities as counter-evidence.
   */
  private async gatherEvidence(
    userId: string,
    entity: EntityRegistryEntity,
    contacts: VoiceProfileEntity[],
  ): Promise<ContactEvidence[]> {
    const itemIds = await this.mentionItemIds(entity.id);
    const speakersByItem = await this.speakersByItem([...itemIds]);
    const coPresence = new Map<string, number>();
    for (const speakers of speakersByItem.values()) {
      for (const profileId of speakers) {
        coPresence.set(profileId, (coPresence.get(profileId) ?? 0) + 1);
      }
    }

    // The contacts' own footprints in the graph: their linked person entities.
    const linkedEntities = await this.entities.find({
      where: { userId, type: 'person', voiceProfileId: In(contacts.map((c) => c.id)) },
    });
    const linkedByContact = new Map<string, EntityRegistryEntity[]>();
    for (const row of linkedEntities) {
      if (!row.voiceProfileId || row.id === entity.id) continue;
      const list = linkedByContact.get(row.voiceProfileId) ?? [];
      list.push(row);
      linkedByContact.set(row.voiceProfileId, list);
    }

    // One hop around the entity, shared with each candidate's one hop.
    const entityEdges = await this.graph.edgesFor(userId, entity.id);
    const entityNeighbors = neighborIds(entityEdges, entity.id);

    const evidence: ContactEvidence[] = [];
    for (const contact of contacts) {
      const sharedNeighborIds = new Set<string>();
      let coMentionCount = 0;
      for (const linked of linkedByContact.get(contact.id) ?? []) {
        const linkedEdges = await this.graph.edgesFor(userId, linked.id);
        for (const id of neighborIds(linkedEdges, linked.id)) {
          if (id !== entity.id && entityNeighbors.has(id)) sharedNeighborIds.add(id);
        }
        // A direct edge between the two means they appeared in the same
        // recording — evidence they are different people.
        coMentionCount += entityEdges
          .filter(
            (edge) => edge.sourceEntityId === linked.id || edge.targetEntityId === linked.id,
          )
          .reduce((sum, edge) => sum + edge.evidenceCount, 0);
      }
      const sharedNeighborNames =
        sharedNeighborIds.size > 0
          ? (
              await this.entities.find({
                where: { id: In([...sharedNeighborIds].slice(0, 3)), userId },
              })
            ).map((row) => row.canonicalName)
          : [];
      evidence.push({
        voiceProfileId: contact.id,
        contactName: contact.name,
        coPresenceCount: coPresence.get(contact.id) ?? 0,
        sharedNeighborCount: sharedNeighborIds.size,
        sharedNeighborNames,
        coMentionCount,
      });
    }
    return evidence;
  }

  /** Items whose LATEST succeeded entities extraction mentions the entity. */
  private async mentionItemIds(entityId: string): Promise<Set<string>> {
    const rows = await this.mentions.find({ where: { entityId } });
    if (rows.length === 0) return new Set();
    const latest = await this.latestExtractionIds(
      [...new Set(rows.map((r) => r.inboxItemId))],
      'entities',
    );
    return new Set(rows.filter((r) => latest.has(r.extractionId)).map((r) => r.inboxItemId));
  }

  /** Speakers per item, restricted to each item's latest succeeded diarization. */
  private async speakersByItem(itemIds: string[]): Promise<Map<string, Set<string>>> {
    const result = new Map<string, Set<string>>();
    if (itemIds.length === 0) return result;
    const rows = await this.occurrences.find({ where: { inboxItemId: In(itemIds) } });
    if (rows.length === 0) return result;
    const latest = await this.latestExtractionIds(itemIds, 'diarization');
    for (const row of rows) {
      if (!latest.has(row.extractionId)) continue;
      const set = result.get(row.inboxItemId) ?? new Set<string>();
      set.add(row.voiceProfileId);
      result.set(row.inboxItemId, set);
    }
    return result;
  }

  /** Ids of each item's latest succeeded extraction of the given kind. */
  private async latestExtractionIds(
    itemIds: string[],
    kind: 'entities' | 'diarization',
  ): Promise<Set<string>> {
    const rows = await this.extractions.find({
      where: { inboxItemId: In(itemIds), kind, status: 'succeeded' },
    });
    const latestByItem = new Map<string, ExtractedPayloadEntity>();
    for (const row of rows) {
      const current = latestByItem.get(row.inboxItemId);
      if (!current || row.createdAt > current.createdAt) latestByItem.set(row.inboxItemId, row);
    }
    return new Set([...latestByItem.values()].map((r) => r.id));
  }

  /** A few "surface form (date)" samples for the LLM's context. */
  private async mentionExamples(entityId: string): Promise<string[]> {
    const rows = await this.mentions.find({
      where: { entityId },
      order: { createdAt: 'DESC' },
      take: MENTION_EXAMPLES_MAX,
    });
    return rows.map(
      (row) => `"${row.surfaceForm}" (${row.createdAt.toISOString().slice(0, 10)})`,
    );
  }
}

/** All name forms of an entity, canonical first. */
function entityNames(entity: EntityRegistryEntity): string[] {
  return [entity.canonicalName, ...(entity.aliases ?? [])];
}

function neighborIds(
  edges: { sourceEntityId: string; targetEntityId: string }[],
  selfId: string,
): Set<string> {
  const ids = new Set<string>();
  for (const edge of edges) {
    ids.add(edge.sourceEntityId === selfId ? edge.targetEntityId : edge.sourceEntityId);
  }
  ids.delete(selfId);
  return ids;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
