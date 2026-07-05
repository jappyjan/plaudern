import { z } from 'zod';
import { sourceTypeSchema } from './source-type';
import { registryEntitySchema } from './entities';
import { personalFactSchema } from './facts';
import { commitmentSchema } from './commitments';
import { questionSchema } from './questions';
import { entityRelationEdgeSchema, graphEntitySchema } from './relations';

/**
 * Contracts for the person dossier (JJ-24): a single read-side aggregation of
 * EVERYTHING the platform knows about one registry `person` entity — the page
 * you glance at before you meet someone, so it IS your memory of them.
 *
 * It unions the per-person slices of the existing read models — personal facts
 * (JJ-31, active + a superseded history timeline), commitments in both
 * directions (JJ-36), open questions (JJ-34), the knowledge-graph neighborhood
 * (JJ-22/JJ-32) and the recent recordings that mention them — with every
 * element CITED back to the source inbox item(s) so nothing is aspirational
 * (VISION §4/§6, mirroring chat/JJ-37). Purely derived: no new tables, no
 * migration; the endpoint just fans out over the existing services.
 */

/**
 * A source-item citation for one dossier element. Deep-links to the inbox item
 * and, when a transcript segment located the claim, to the audio timestamp —
 * exactly the shape the chat citations use (`/items/:id?t=startSeconds`).
 */
export const dossierCitationSchema = z.object({
  inboxItemId: z.string().uuid(),
  /** AI/summary title of the source recording; null when none was derived. */
  title: z.string().nullable(),
  sourceType: sourceTypeSchema,
  occurredAt: z.string().datetime(),
  /** Transcript segment start (seconds) for the audio deep link; null otherwise. */
  startSeconds: z.number().nullable(),
  /** The sentence the element was drawn from in this recording; null if uncaptured. */
  quote: z.string().nullable(),
});
export type DossierCitationDto = z.infer<typeof dossierCitationSchema>;

/**
 * A personal fact enriched with the source recordings that state it. A fact can
 * be cited by several recordings (its `citationCount`); `citations` carries them
 * (capped) so the timeline can deep-link each supporting moment.
 */
export const dossierFactSchema = personalFactSchema.extend({
  citations: z.array(dossierCitationSchema),
});
export type DossierFactDto = z.infer<typeof dossierFactSchema>;

/** A commitment with its single source recording resolved to a citation. */
export const dossierCommitmentSchema = commitmentSchema.extend({
  citation: dossierCitationSchema.nullable(),
});
export type DossierCommitmentDto = z.infer<typeof dossierCommitmentSchema>;

/** An open question with its single source recording resolved to a citation. */
export const dossierQuestionSchema = questionSchema.extend({
  citation: dossierCitationSchema.nullable(),
});
export type DossierQuestionDto = z.infer<typeof dossierQuestionSchema>;

/** A recent recording that mentions this person, newest first. */
export const dossierRecentItemSchema = z.object({
  inboxItemId: z.string().uuid(),
  title: z.string().nullable(),
  sourceType: sourceTypeSchema,
  occurredAt: z.string().datetime(),
  /** The surface form this person was mentioned as in that recording. */
  surfaceForm: z.string(),
});
export type DossierRecentItemDto = z.infer<typeof dossierRecentItemSchema>;

/**
 * How many rows exist in each section BEFORE the dossier's per-section caps, so
 * the page can surface a "view all N" affordance rather than dumping everything.
 */
export const dossierCountsSchema = z.object({
  activeFacts: z.number().int().nonnegative(),
  supersededFacts: z.number().int().nonnegative(),
  owedByMe: z.number().int().nonnegative(),
  owedToMe: z.number().int().nonnegative(),
  openQuestions: z.number().int().nonnegative(),
  relations: z.number().int().nonnegative(),
  /** Distinct recordings mentioning this person (== entity.mentionCount). */
  mentions: z.number().int().nonnegative(),
});
export type DossierCountsDto = z.infer<typeof dossierCountsSchema>;

/**
 * GET /v1/entities/:id/dossier — the whole person dossier in one payload.
 *
 * Entity resolution caveat (JJ-70 is repointing merge in parallel): a
 * commitment/question `counterpartyEntityId` or a relation endpoint may dangle
 * after an entity merge. The aggregation tolerates this — a dangling relation
 * endpoint is simply absent from `neighbors` (rendered "unknown"), and rows are
 * matched to THIS entity by id, so a stale reference elsewhere never crashes the
 * page. Counterparties fall back to their stored `counterpartyName`.
 */
export const entityDossierSchema = z.object({
  /** Core identity of the person (name, aliases, contact link, mention count). */
  entity: registryEntitySchema,
  facts: z.object({
    /** Active (not-superseded) facts — the current picture. */
    active: z.array(dossierFactSchema),
    /** Superseded facts, newest-superseded first — the history timeline. */
    superseded: z.array(dossierFactSchema),
  }),
  commitments: z.object({
    /** What I owe them. */
    owedByMe: z.array(dossierCommitmentSchema),
    /** What they owe me. */
    owedToMe: z.array(dossierCommitmentSchema),
  }),
  /** Open loops involving them, in either direction. */
  openQuestions: z.array(dossierQuestionSchema),
  /** Knowledge-graph edges touching this person (capped, newest first). */
  relations: z.array(entityRelationEdgeSchema),
  /** The connected entities the edges point at, for rendering names/links. */
  neighbors: z.array(graphEntitySchema),
  /** Recent recordings mentioning them (capped, newest first). */
  recentItems: z.array(dossierRecentItemSchema),
  counts: dossierCountsSchema,
});
export type EntityDossierDto = z.infer<typeof entityDossierSchema>;

/** Per-section caps the dossier endpoint applies (top-N, newest first). */
export const DOSSIER_RECENT_ITEMS_CAP = 8;
export const DOSSIER_RELATIONS_CAP = 24;
export const DOSSIER_FACT_CITATIONS_CAP = 5;
