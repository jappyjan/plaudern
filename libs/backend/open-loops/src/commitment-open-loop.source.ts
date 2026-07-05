import { Injectable } from '@nestjs/common';
import type {
  CommitmentDto,
  CommitmentStatus,
  OpenLoopDto,
  OpenLoopState,
} from '@plaudern/contracts';
import { CommitmentsService } from '@plaudern/commitments';
import type { OpenLoopSource } from './open-loop-source';

/**
 * Adapts commitments in both directions (JJ-36) into the ledger. Age is anchored
 * to the recording's `occurredAt` (when the promise was actually made), not the
 * row's insert time, so an old promise surfaced by a late re-extraction still
 * reads as old.
 *
 * State durability is inherited: `updateStatus` writes the `commitments` row, and
 * the persistence layer reaps only OPEN stale rows on re-run while preserving
 * fulfilled/dismissed — so the user's `done`/`dropped` survives re-extraction.
 */
@Injectable()
export class CommitmentOpenLoopSource implements OpenLoopSource {
  readonly kind = 'commitment' as const;

  constructor(private readonly commitments: CommitmentsService) {}

  async list(userId: string, includeResolved: boolean): Promise<OpenLoopDto[]> {
    const { commitments } = await this.commitments.list(
      userId,
      includeResolved ? {} : { status: 'open' },
    );
    return commitments.map((c) => toDto(c));
  }

  async updateState(userId: string, id: string, state: OpenLoopState): Promise<OpenLoopDto> {
    const updated = await this.commitments.updateStatus(userId, id, toCommitmentStatus(state));
    return toDto(updated);
  }
}

function toDto(c: CommitmentDto): OpenLoopDto {
  return {
    id: c.id,
    kind: 'commitment',
    state: fromCommitmentStatus(c.status),
    title: c.description,
    direction: c.direction,
    counterpartyName: c.counterpartyName || null,
    dueDate: c.dueDate,
    overdue: c.dueDate !== null && Date.parse(c.dueDate) < Date.now(),
    inboxItemId: c.inboxItemId,
    // A commitment is per-recording (no cross-item dedupe), so it is raised once.
    citationCount: 1,
    firstSeenAt: c.occurredAt,
    lastSeenAt: c.occurredAt,
    score: 0,
    completionHint: null,
  };
}

function toCommitmentStatus(state: OpenLoopState): CommitmentStatus {
  return state === 'done' ? 'fulfilled' : state === 'dropped' ? 'dismissed' : 'open';
}

function fromCommitmentStatus(status: CommitmentStatus): OpenLoopState {
  return status === 'fulfilled' ? 'done' : status === 'dismissed' ? 'dropped' : 'open';
}
