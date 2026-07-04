import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { EmbeddingChunkSource } from '@plaudern/contracts';
import { ExtractedPayloadEntity } from './extracted-payload.entity';

/**
 * Serialize a vector as a JSON array of floats. This string is:
 *  - stored verbatim in the sqlite unit-test path (a TEXT column, no pgvector),
 *  - a valid pgvector literal on Postgres (`[1,2,3]`), so the same value is
 *    accepted by the real `vector(N)` column the migration provisions.
 * pgvector prints vectors in the same bracketed form, so reads round-trip
 * through `JSON.parse`.
 */
const vectorTransformer = {
  to: (value: number[] | null): string | null => (value === null ? null : JSON.stringify(value)),
  from: (value: string | number[] | null): number[] | null => {
    if (value === null) return null;
    return Array.isArray(value) ? value : (JSON.parse(value) as number[]);
  },
};

/**
 * One chunked embedding of a recording's transcript or summary — the retrieval
 * unit behind semantic search/memory. Append-only children of an `embedding`
 * extraction (regenerating embeddings inserts a fresh extraction + chunks, it
 * never mutates existing rows), preserving the immutability guarantee.
 *
 * The `embedding` column is declared `text` here so the entity works on the
 * sqlite test database (which has no pgvector). On Postgres the migration
 * redeclares it as `vector(N)` with an HNSW cosine index; TypeORM reads/writes
 * it as the JSON-array text that pgvector accepts and emits, so nearest-
 * neighbour search runs natively while the ORM stays driver-agnostic.
 */
@Entity({ name: 'embedding_chunks' })
@Index(['inboxItemId'])
@Index(['extractionId'])
@Index(['userId'])
export class EmbeddingChunkEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => ExtractedPayloadEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'extractionId' })
  extraction!: ExtractedPayloadEntity;

  @Column({ type: 'uuid' })
  extractionId!: string;

  /** Denormalized owning item, so chunks are cheap to scope, list and purge. */
  @Column({ type: 'uuid' })
  inboxItemId!: string;

  /** Denormalized owner for per-user retrieval scoping. */
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar' })
  source!: EmbeddingChunkSource;

  @Column({ type: 'int' })
  chunkIndex!: number;

  @Column({ type: 'text' })
  text!: string;

  /** Segment start (seconds) for transcript chunks; null for summary chunks. */
  @Column({ type: 'float', nullable: true })
  startSeconds!: number | null;

  /** Segment end (seconds) for transcript chunks; null for summary chunks. */
  @Column({ type: 'float', nullable: true })
  endSeconds!: number | null;

  @Column({ type: 'varchar' })
  model!: string;

  @Column({ type: 'int' })
  dimensions!: number;

  @Column({ type: 'text', transformer: vectorTransformer })
  embedding!: number[];

  @CreateDateColumn()
  createdAt!: Date;
}
