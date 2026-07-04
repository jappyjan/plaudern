import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type {
  EntityConnectResponse,
  EntityNeighborhoodResponse,
  EntityRelationEdgeDto,
  ExtractedRelation,
  GraphEntityDto,
  RelationType,
} from '@plaudern/contracts';
import {
  EntityRegistryEntity,
  EntityRelationEntity,
  ExtractedPayloadEntity,
} from '@plaudern/persistence';
import { normalize } from './contact-matching';
import { isUniqueViolation } from './entities-registry.service';

/**
 * Relation types whose direction carries no meaning; their endpoints are
 * canonicalized (smaller entity id first) so A↔B and B↔A dedupe to one edge.
 */
const SYMMETRIC_RELATION_TYPES: ReadonlySet<RelationType> = new Set([
  'related_to',
  'discussed_with',
]);

/** Confidence recorded on implicit same-recording co-occurrence edges. */
export const COOCCURRENCE_CONFIDENCE = 0.2;

/**
 * Safety budget for connect()'s BFS: co-occurrence edges are O(N²) per
 * recording, so a hub entity can fan out enormously. Once the traversal has
 * visited this many nodes (or loaded MAX_GRAPH_EVIDENCE_ROWS rows) it stops
 * expanding and reports `truncated: true` instead of unbounded queries.
 */
export const MAX_GRAPH_VISITED_NODES = 500;
export const MAX_GRAPH_EVIDENCE_ROWS = 5_000;

/** Ceiling on a single SQL IN() list, well below Postgres's bind-param limit. */
export const GRAPH_IN_CHUNK_SIZE = 500;

interface EvidenceCandidate {
  sourceEntityId: string;
  targetEntityId: string;
  relationType: RelationType;
  label: string | null;
  confidence: number | null;
  origin: 'llm' | 'cooccurrence';
}

/**
 * Owns the knowledge-graph edges (JJ-22): validating and persisting the
 * relations the LLM extracted (plus weak implicit co-occurrence edges) as
 * `entity_relations` evidence rows, and serving the graph read models —
 * neighborhood, connecting subgraph, per-entity edges. Like the mention read
 * model, evidence is restricted to each item's LATEST succeeded `relations`
 * extraction so append-only reprocessing supersedes old edges, and every
 * query is scoped to the owning user at every step.
 */
@Injectable()
export class EntityGraphService {
  constructor(
    @InjectRepository(EntityRelationEntity)
    private readonly relations: Repository<EntityRelationEntity>,
    @InjectRepository(EntityRegistryEntity)
    private readonly entities: Repository<EntityRegistryEntity>,
    @InjectRepository(ExtractedPayloadEntity)
    private readonly extractions: Repository<ExtractedPayloadEntity>,
  ) {}

  /**
   * Validate + persist one extraction's relations. Both endpoints of every
   * LLM relation must resolve (by canonical name or alias, normalized) to an
   * entity actually extracted from THIS item — anything else is dropped,
   * never written. Entity pairs the model related in no way at all get a weak
   * implicit `related_to` co-occurrence edge. Returns the number of evidence
   * rows this extraction stands for; idempotent per extraction.
   */
  async ingest(
    userId: string,
    inboxItemId: string,
    extractionId: string,
    extracted: ExtractedRelation[],
    itemEntities: EntityRegistryEntity[],
  ): Promise<number> {
    // Resolution map restricted to this item's entities (canonical + aliases).
    const byName = new Map<string, EntityRegistryEntity>();
    for (const entity of itemEntities) {
      for (const form of [entity.canonicalName, ...(entity.aliases ?? [])]) {
        const key = normalize(form);
        // First writer wins so resolution is stable when two entities share a form.
        if (key && !byName.has(key)) byName.set(key, entity);
      }
    }

    const candidates = new Map<string, EvidenceCandidate>();
    for (const raw of extracted) {
      const source = byName.get(normalize(raw.source));
      const target = byName.get(normalize(raw.target));
      if (!source || !target || source.id === target.id) continue; // strict: drop unresolved/self edges
      const [a, b] =
        SYMMETRIC_RELATION_TYPES.has(raw.type) && target.id < source.id
          ? [target, source]
          : [source, target];
      const key = `${a.id}:${b.id}:${raw.type}`;
      if (candidates.has(key)) continue;
      candidates.set(key, {
        sourceEntityId: a.id,
        targetEntityId: b.id,
        relationType: raw.type,
        label: raw.label?.trim() || null,
        confidence: raw.confidence ?? null,
        origin: 'llm',
      });
    }

    // Weak implicit co-occurrence: entities mentioned in the same recording
    // are related even when the model stated nothing explicit about the pair.
    const related = new Set<string>();
    for (const candidate of candidates.values()) {
      related.add(pairKey(candidate.sourceEntityId, candidate.targetEntityId));
    }
    const sorted = itemEntities.slice().sort((a, b) => a.id.localeCompare(b.id));
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        if (related.has(pairKey(sorted[i].id, sorted[j].id))) continue;
        candidates.set(`${sorted[i].id}:${sorted[j].id}:related_to`, {
          sourceEntityId: sorted[i].id,
          targetEntityId: sorted[j].id,
          relationType: 'related_to',
          label: null,
          confidence: COOCCURRENCE_CONFIDENCE,
          origin: 'cooccurrence',
        });
      }
    }

    for (const candidate of candidates.values()) {
      await this.upsertEvidence(userId, inboxItemId, extractionId, candidate);
    }
    return candidates.size;
  }

  /** Aggregated edges touching one entity, optionally filtered by type. */
  async edgesFor(
    userId: string,
    entityId: string,
    relationType?: RelationType,
  ): Promise<EntityRelationEdgeDto[]> {
    const filter = relationType ? { relationType } : {};
    const rows = await this.relations.find({
      where: [
        { userId, sourceEntityId: entityId, ...filter },
        { userId, targetEntityId: entityId, ...filter },
      ],
    });
    return this.toEdges(await this.currentRows(rows));
  }

  /** One hop around an entity: its edges plus the entities they connect to. */
  async neighborhood(
    userId: string,
    entityId: string,
    relationType?: RelationType,
  ): Promise<EntityNeighborhoodResponse> {
    const root = await this.entities.findOne({ where: { id: entityId, userId } });
    if (!root) throw new NotFoundException('entity not found');
    const relations = await this.edgesFor(userId, entityId, relationType);
    const neighborIds = [
      ...new Set(relations.flatMap((edge) => [edge.sourceEntityId, edge.targetEntityId])),
    ].filter((id) => id !== entityId);
    const neighbors =
      neighborIds.length > 0
        ? await this.entities.find({ where: { id: In(neighborIds), userId } })
        : [];
    return {
      entity: toGraphEntity(root),
      relations,
      neighbors: neighbors
        .map(toGraphEntity)
        .sort((a, b) => a.canonicalName.localeCompare(b.canonicalName)),
    };
  }

  /**
   * The subgraph connecting 2–3 entities: bounded multi-source BFS (≤ maxDepth
   * hops, each expansion user-scoped and chunked), then the shortest path from
   * the first entity to each of the others, unioned. `connected` is false when
   * some requested entity is unreachable within maxDepth — the paths that do
   * exist are still returned. The traversal carries a hard safety budget
   * (MAX_GRAPH_VISITED_NODES / MAX_GRAPH_EVIDENCE_ROWS); hitting it stops the
   * expansion and sets `truncated: true`.
   */
  async connect(
    userId: string,
    ids: string[],
    maxDepth: number,
    includeCooccurrence = true,
  ): Promise<EntityConnectResponse> {
    const seedIds = [...new Set(ids)];
    const seeds = await this.entities.find({ where: { id: In(seedIds), userId } });
    if (seeds.length !== seedIds.length) throw new NotFoundException('entity not found');

    // Bounded BFS from all seeds at once; collecting every edge it crosses is
    // enough, because any ≤maxDepth-hop path between two seeds lies within
    // ⌈maxDepth/2⌉ hops of one of them.
    const visited = new Set(seedIds);
    let frontier = seedIds;
    const evidence: EntityRelationEntity[] = [];
    const seenRowIds = new Set<string>();
    let truncated = false;
    for (let depth = 0; depth < maxDepth && frontier.length > 0 && !truncated; depth += 1) {
      const remaining = MAX_GRAPH_EVIDENCE_ROWS - evidence.length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const { rows, overflowed } = await this.evidenceTouching(
        userId,
        frontier,
        includeCooccurrence,
        remaining,
      );
      if (overflowed) truncated = true;
      const next = new Set<string>();
      for (const row of rows) {
        if (seenRowIds.has(row.id)) continue;
        if (evidence.length >= MAX_GRAPH_EVIDENCE_ROWS) {
          truncated = true;
          break;
        }
        seenRowIds.add(row.id);
        evidence.push(row);
        for (const id of [row.sourceEntityId, row.targetEntityId]) {
          if (visited.has(id)) continue;
          if (visited.size >= MAX_GRAPH_VISITED_NODES) {
            truncated = true;
            continue;
          }
          visited.add(id);
          next.add(id);
        }
      }
      frontier = [...next];
    }

    const edges = this.toEdges(evidence);
    const adjacency = new Map<string, Set<string>>();
    for (const edge of edges) {
      link(adjacency, edge.sourceEntityId, edge.targetEntityId);
      link(adjacency, edge.targetEntityId, edge.sourceEntityId);
    }

    const nodeIds = new Set(seedIds);
    let connected = true;
    const [first, ...rest] = seedIds;
    for (const other of rest) {
      const path = shortestPath(adjacency, first, other, maxDepth);
      if (!path) {
        connected = false;
        continue;
      }
      for (const id of path) nodeIds.add(id);
    }

    const relations = edges.filter(
      (edge) => nodeIds.has(edge.sourceEntityId) && nodeIds.has(edge.targetEntityId),
    );
    const nodes = await this.entities.find({ where: { id: In([...nodeIds]), userId } });
    return {
      entities: nodes
        .map(toGraphEntity)
        .sort((a, b) => a.canonicalName.localeCompare(b.canonicalName)),
      relations,
      connected,
      truncated,
    };
  }

  /** One evidence row per (extraction, source, target, type); idempotent on re-runs. */
  private async upsertEvidence(
    userId: string,
    inboxItemId: string,
    extractionId: string,
    candidate: EvidenceCandidate,
  ): Promise<void> {
    const existing = await this.relations.findOne({
      where: {
        extractionId,
        sourceEntityId: candidate.sourceEntityId,
        targetEntityId: candidate.targetEntityId,
        relationType: candidate.relationType,
      },
    });
    if (existing) return;
    try {
      await this.relations.save(
        this.relations.create({ userId, inboxItemId, extractionId, ...candidate }),
      );
    } catch (err) {
      // Lost a race on the evidence unique index — the row already exists.
      if (!isUniqueViolation(err)) throw err;
    }
  }

  /**
   * One BFS expansion: the CURRENT evidence rows touching the given entities,
   * user-scoped, with the co-occurrence filter and a hard row limit pushed
   * into the SQL, and the IN() lists chunked so a wide frontier can never
   * exceed the driver's bind-parameter limit. Rows are deduped by id across
   * chunks (a row matches both the source and the target chunk when both of
   * its endpoints are in the frontier). `overflowed` reports that more raw
   * rows existed than the limit allowed to load.
   */
  private async evidenceTouching(
    userId: string,
    entityIds: string[],
    includeCooccurrence: boolean,
    limit: number,
  ): Promise<{ rows: EntityRelationEntity[]; overflowed: boolean }> {
    // Only two origins exist, so "no co-occurrence" is exactly "llm only".
    const originFilter = includeCooccurrence ? {} : { origin: 'llm' as const };
    const byId = new Map<string, EntityRelationEntity>();
    let overflowed = false;
    for (let i = 0; i < entityIds.length && !overflowed; i += GRAPH_IN_CHUNK_SIZE) {
      const chunk = entityIds.slice(i, i + GRAPH_IN_CHUNK_SIZE);
      // Ask for one row more than the remaining budget so hitting the limit is
      // distinguishable from exactly exhausting it.
      const rows = await this.relations.find({
        where: [
          { userId, sourceEntityId: In(chunk), ...originFilter },
          { userId, targetEntityId: In(chunk), ...originFilter },
        ],
        take: limit - byId.size + 1,
      });
      for (const row of rows) byId.set(row.id, row);
      if (byId.size > limit) overflowed = true;
    }
    const bounded = [...byId.values()].slice(0, limit);
    return { rows: await this.currentRows(bounded), overflowed };
  }

  /**
   * Evidence rows restricted to each inbox item's latest succeeded `relations`
   * extraction — so reprocessing supersedes old edges, mirroring mentions.
   */
  private async currentRows(rows: EntityRelationEntity[]): Promise<EntityRelationEntity[]> {
    if (rows.length === 0) return [];
    const itemIds = [...new Set(rows.map((r) => r.inboxItemId))];
    const extractionRows = await this.extractions.find({
      where: { inboxItemId: In(itemIds), kind: 'relations', status: 'succeeded' },
    });
    const latestByItem = new Map<string, ExtractedPayloadEntity>();
    for (const row of extractionRows) {
      const current = latestByItem.get(row.inboxItemId);
      if (!current || row.createdAt > current.createdAt) latestByItem.set(row.inboxItemId, row);
    }
    const latestExtractionIds = new Set([...latestByItem.values()].map((r) => r.id));
    return rows.filter((row) => latestExtractionIds.has(row.extractionId));
  }

  /** Collapse evidence rows into unique aggregated edges, newest first. */
  private toEdges(rows: EntityRelationEntity[]): EntityRelationEdgeDto[] {
    const grouped = new Map<string, EntityRelationEntity[]>();
    for (const row of rows) {
      const key = `${row.sourceEntityId}:${row.targetEntityId}:${row.relationType}`;
      const list = grouped.get(key) ?? [];
      list.push(row);
      grouped.set(key, list);
    }
    return [...grouped.values()]
      .map((group) => {
        const newestFirst = group
          .slice()
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const confidences = group
          .map((r) => r.confidence)
          .filter((c): c is number => c !== null);
        return {
          sourceEntityId: group[0].sourceEntityId,
          targetEntityId: group[0].targetEntityId,
          relationType: group[0].relationType,
          label: newestFirst.find((r) => r.label !== null)?.label ?? null,
          confidence: confidences.length > 0 ? Math.max(...confidences) : null,
          origin: group.some((r) => r.origin === 'llm')
            ? ('llm' as const)
            : ('cooccurrence' as const),
          evidenceCount: new Set(group.map((r) => r.inboxItemId)).size,
          firstSeenAt: newestFirst[newestFirst.length - 1].createdAt.toISOString(),
          lastSeenAt: newestFirst[0].createdAt.toISOString(),
        };
      })
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }
}

function toGraphEntity(row: EntityRegistryEntity): GraphEntityDto {
  return { id: row.id, type: row.type, canonicalName: row.canonicalName };
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function link(adjacency: Map<string, Set<string>>, from: string, to: string): void {
  const set = adjacency.get(from) ?? new Set<string>();
  set.add(to);
  adjacency.set(from, set);
}

/** Plain BFS shortest path (inclusive of endpoints), bounded by maxDepth hops. */
function shortestPath(
  adjacency: Map<string, Set<string>>,
  from: string,
  to: string,
  maxDepth: number,
): string[] | null {
  if (from === to) return [from];
  const parent = new Map<string, string>([[from, from]]);
  let frontier = [from];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const neighbor of adjacency.get(node) ?? []) {
        if (parent.has(neighbor)) continue;
        parent.set(neighbor, node);
        if (neighbor === to) {
          const path = [to];
          let cursor = to;
          while (cursor !== from) {
            cursor = parent.get(cursor) as string;
            path.push(cursor);
          }
          return path.reverse();
        }
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return null;
}
