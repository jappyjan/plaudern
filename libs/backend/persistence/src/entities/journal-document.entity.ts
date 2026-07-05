import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ExtractionStatus, JournalCitation, JournalPeriodType } from '@plaudern/contracts';

/**
 * One generated version of a journal period (JJ-17) — a narrative diary entry
 * for a day, or a weekly/monthly/yearly review composed from the daily entries.
 * APPEND-ONLY: each regeneration inserts a fresh row with the next `version`,
 * so the entry's evolution stays visible as a history and a re-run never
 * clobbers the last good version. The CURRENT entry for a period is the
 * highest-`version` succeeded row; a queued/processing/failed newer row lets the
 * read model show "composing" (or a failed attempt) while the last good version
 * stays visible.
 *
 * A period is identified by (`userId`, `periodType`, `periodKey`) where
 * `periodKey` is `YYYY-MM-DD` for a day, `YYYY-Www` (ISO week) for a week,
 * `YYYY-MM` for a month, `YYYY` for a year — all computed in UTC, matching how
 * inbox `occurredAt` and calendar times are stored.
 *
 * `citations` is the STRUCTURAL source list the body's inline `[n]` markers
 * resolve against — inbox items and calendar events for a day, and the daily
 * entries themselves for a rollup — the same citation contract the memory chat
 * and living topic documents use, so every statement is traceable to a source.
 */
@Entity({ name: 'journal_documents' })
@Index(['userId'])
@Index(['userId', 'periodType'])
@Index(['userId', 'periodType', 'periodKey', 'status'])
// One row per (user, periodType, periodKey, version): makes version numbering
// consistent and lets a racing concurrent generation recover from the unique
// violation.
@Index(['userId', 'periodType', 'periodKey', 'version'], { unique: true })
export class JournalDocumentEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Owner — journal entries are strictly per-user. */
  @Column({ type: 'uuid' })
  userId!: string;

  /** Granularity: 'day' | 'week' | 'month' | 'year'. */
  @Column({ type: 'varchar' })
  periodType!: JournalPeriodType;

  /** The period this entry describes (e.g. '2026-06-14', '2026-W24', '2026-06', '2026'). */
  @Column({ type: 'varchar' })
  periodKey!: string;

  /** 1-based generation counter, monotonic per (user, periodType, periodKey). */
  @Column({ type: 'int' })
  version!: number;

  /** Generation lifecycle, reusing the extraction status vocabulary. */
  @Column({ type: 'varchar', default: 'queued' })
  status!: ExtractionStatus;

  /** The diary body (GitHub-flavored Markdown with `[n]` markers). */
  @Column({ type: 'text', nullable: true })
  markdown!: string | null;

  /** Structural source list the `[n]` markers resolve against. */
  @Column({ type: 'simple-json', nullable: true })
  citations!: JournalCitation[] | null;

  /** How many source signals this version was composed from. */
  @Column({ type: 'int', default: 0 })
  sourceItemCount!: number;

  /** Concrete model that produced the version, for provenance. */
  @Column({ type: 'varchar', nullable: true })
  model!: string | null;

  /** Failure reason when `status` is 'failed'; null otherwise. */
  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
