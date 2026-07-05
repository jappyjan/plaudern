import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One durable personal fact about a person in the user's life (JJ-31) — "her
 * birthday is in March", "he's allergic to nuts", "starts school in August", a
 * gift idea someone mentioned. Produced by the `facts` extractor and
 * deduplicated across every recording that states it into ONE row carrying many
 * `personal_fact_citations`, exactly like a task carries citations.
 *
 * APPEND-ONLY with SUPERSESSION, applied only among EXCLUSIVE facts. An
 * attribute is `exclusive` when it holds one current value per person (birthday,
 * employer, current city): within a (subject, attribute) group the newest
 * citation-live exclusive fact is active and every other exclusive fact points
 * at it via `supersededByFactId` + `supersededAt` — WITHOUT being deleted, so
 * the timeline ("school in August → moved to September") survives for the
 * person dossier (JJ-24). ACCUMULATIVE facts (the default: allergies, gift
 * ideas, hobbies, children) coexist and are never superseded — only exact
 * duplicates collapse via the dedupe unique index. Recency is decided by
 * `lastOccurredAt` (the newest supporting recording's `occurredAt`), so the
 * chronologically-latest statement wins regardless of processing order.
 *
 * User-scoped and MUTABLE (citations accrete, supersession flips), so it lives
 * OUTSIDE the immutable inbox aggregate — like a task or a registry entity.
 * Deduped on (userId, subjectKey, normalizedAttribute, normalizedValue) so
 * re-runs, backfills and repeated mentions upsert onto the same row rather than
 * duplicating.
 */
@Entity({ name: 'personal_facts' })
@Index(['userId'])
@Index(['personEntityId'])
@Index(['userId', 'subjectKey'])
@Index(['userId', 'subjectKey', 'normalizedAttribute', 'normalizedValue'], { unique: true })
export class PersonalFactEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  /**
   * Linked registry `person` entity id when the subject's name confidently
   * matches a known entity; null otherwise. A loose reference (no FK) so the
   * facts module stays decoupled from the entity registry — mirroring how a
   * commitment carries a bare counterparty entity id. Repointed on entity merge
   * (JJ-63) so facts follow the survivor.
   */
  @Column({ type: 'uuid', nullable: true })
  personEntityId!: string | null;

  /** The subject's display name as spoken; empty string when unknown. */
  @Column({ type: 'varchar', default: '' })
  personName!: string;

  /**
   * Stable per-subject grouping/dedupe axis, always non-null: `e:<entityId>`
   * when linked to a registry person, else `n:<normalizedName>`. Keeping it a
   * single concrete column lets the unique index dedupe BOTH linked and unlinked
   * facts (a nullable personEntityId would make NULL rows distinct and defeat
   * dedupe). Recomputed to the survivor on entity merge.
   */
  @Column({ type: 'varchar' })
  subjectKey!: string;

  /** Short key naming what the fact is about ("birthday", "allergy"). */
  @Column({ type: 'varchar' })
  attribute!: string;

  /** Lowercased/whitespace-collapsed attribute — the supersession + dedupe axis. */
  @Column({ type: 'varchar' })
  normalizedAttribute!: string;

  /** The fact itself. */
  @Column({ type: 'text' })
  value!: string;

  /** Lowercased/whitespace-collapsed value — the dedupe key (same value = same fact). */
  @Column({ type: 'varchar' })
  normalizedValue!: string;

  /**
   * Whether the attribute holds ONE current value per person (birthday, current
   * city, employer) — only exclusive facts participate in supersession.
   * Accumulative facts (false, the default) coexist: allergies, gift ideas,
   * hobbies, children. LLM-classified; defaulting to accumulate means a
   * mislabel degrades to "extra visible facts", never to hidden data.
   */
  @Column({ type: 'boolean', default: false })
  exclusive!: boolean;

  /**
   * The exclusive fact that superseded this one (the group's active exclusive
   * fact), or null while this fact is active (or accumulative). Never triggers
   * a delete — superseded rows are retained as history.
   */
  @Column({ type: 'uuid', nullable: true })
  supersededByFactId!: string | null;

  /** When this fact was superseded (ISO 8601 UTC string), or null when active. */
  @Column({ type: 'varchar', nullable: true })
  supersededAt!: string | null;

  /**
   * The newest supporting recording's `occurredAt` (ISO 8601 UTC string), or
   * null when unknown. Drives supersession ordering: within a (subject,
   * attribute) group the fact with the latest `lastOccurredAt` is the active one.
   */
  @Column({ type: 'varchar', nullable: true })
  lastOccurredAt!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
