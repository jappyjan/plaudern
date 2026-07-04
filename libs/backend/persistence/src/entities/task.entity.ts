import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { TaskStatus } from '@plaudern/contracts';

/**
 * Serialize a vector as a JSON array of floats — the same trick the embedding
 * chunks use. The string is stored verbatim in the sqlite unit-test path (a
 * TEXT column, no pgvector) and is a valid pgvector literal on Postgres
 * (`[1,2,3]`), so the same value round-trips through the `vector(N)` column the
 * migration provisions. Nullable because tasks created while embeddings are not
 * configured carry no vector (they dedupe on normalized text instead).
 */
const nullableVectorTransformer = {
  to: (value: number[] | null): string | null =>
    value === null ? null : JSON.stringify(value),
  from: (value: string | number[] | null): number[] | null => {
    if (value === null) return null;
    return Array.isArray(value) ? value : (JSON.parse(value) as number[]);
  },
};

/**
 * A deduplicated task in a user's list (JJ-35) — a self-directed intention
 * ("book the dentist") pulled from recordings by the `tasks` extractor and
 * collapsed across every recording that mentions it. `task_citations` link this
 * row back to those recordings.
 *
 * Mutable by design (status resolves open → completed/dismissed, citations
 * accrete), so it lives OUTSIDE the immutable inbox aggregate — exactly like a
 * topic or a registry entity. Dedupe is SEMANTIC: the `embedding` vector is
 * compared against the user's other OPEN tasks via pgvector cosine distance;
 * `normalizedTitle` is the exact-match fallback when embeddings are not
 * configured.
 */
@Entity({ name: 'tasks' })
@Index(['userId'])
@Index(['userId', 'status'])
// At most one OPEN task per (user, normalized title) — the concurrency guard
// behind the exact-title dedupe (a losing concurrent writer re-reads the
// winner). Partial so a completed/dismissed task frees the title for a fresh
// task. Postgres and sqlite both support partial indexes, so the sqlite test
// DB (synchronize: true) enforces the same constraint the migration creates.
@Index(['userId', 'normalizedTitle'], { unique: true, where: `status = 'open'` })
export class TaskEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  /** Canonical imperative title, e.g. "Book the dentist". */
  @Column({ type: 'varchar' })
  title!: string;

  /** Lowercased, whitespace-collapsed title — the exact-match dedupe fallback. */
  @Column({ type: 'varchar' })
  normalizedTitle!: string;

  @Column({ type: 'varchar', default: 'open' })
  status!: TaskStatus;

  /** ISO date string the task is due, when the recording implied one; else null. */
  @Column({ type: 'varchar', nullable: true })
  dueDate!: string | null;

  /**
   * Dedupe embedding. Declared `text` here so the entity works on the sqlite
   * test database (which has no pgvector); the migration redeclares it as
   * `vector(N)` with an HNSW cosine index on Postgres. Null when embeddings
   * were not configured at extraction time.
   */
  @Column({ type: 'text', nullable: true, transformer: nullableVectorTransformer })
  embedding!: number[] | null;

  /** Provider model that produced `embedding`, for provenance; null when unset. */
  @Column({ type: 'varchar', nullable: true })
  embeddingModel!: string | null;

  /** Dimension of `embedding`, for the in-memory cosine guard; null when unset. */
  @Column({ type: 'int', nullable: true })
  embeddingDimensions!: number | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
