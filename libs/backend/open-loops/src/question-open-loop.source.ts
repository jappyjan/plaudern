import { Injectable } from '@nestjs/common';
import type {
  CommitmentDirection,
  OpenLoopDto,
  OpenLoopState,
  QuestionDirection,
  QuestionDto,
  QuestionStatus,
} from '@plaudern/contracts';
import { QuestionsService } from '@plaudern/questions';
import type { OpenLoopSource } from './open-loop-source';

/**
 * Adapts open questions in both directions (JJ-34) into the ledger. Age is
 * anchored to the recording's `occurredAt` (when the question was actually
 * asked), matching the commitment source.
 *
 * Direction is NORMALIZED into the ledger's obligation semantic so the
 * "I owe / owed to me" filter spans both directional kinds:
 *   - asked_of_me  → I owe the counterparty an answer   → owed_by_me
 *   - asked_by_me  → the counterparty owes me an answer → owed_to_me
 *
 * State durability is inherited: `updateStatus` writes the `questions` row, and
 * the questions pipeline treats `answered` as durable once set (a re-run may
 * promote open → answered but never demotes or reaps it) and `dropped` as
 * user-owned — so the user's `done`/`dropped` survives re-extraction.
 */
@Injectable()
export class QuestionOpenLoopSource implements OpenLoopSource {
  readonly kind = 'question' as const;

  constructor(private readonly questions: QuestionsService) {}

  async list(userId: string, includeResolved: boolean): Promise<OpenLoopDto[]> {
    const { questions } = await this.questions.list(
      userId,
      includeResolved ? {} : { status: 'open' },
    );
    return questions.map((q) => toDto(q));
  }

  async updateState(userId: string, id: string, state: OpenLoopState): Promise<OpenLoopDto> {
    const updated = await this.questions.updateStatus(userId, id, toQuestionStatus(state));
    return toDto(updated);
  }
}

function toDto(q: QuestionDto): OpenLoopDto {
  return {
    id: q.id,
    kind: 'question',
    state: fromQuestionStatus(q.status),
    title: q.question,
    direction: toLedgerDirection(q.direction),
    counterpartyName: q.counterpartyName || null,
    // Questions carry no due date; urgency comes from age alone.
    dueDate: null,
    overdue: false,
    inboxItemId: q.inboxItemId,
    sourceTimestamp: q.sourceTimestamp,
    // A question is per-recording (no cross-item dedupe), so it is raised once.
    citationCount: 1,
    firstSeenAt: q.occurredAt,
    lastSeenAt: q.occurredAt,
    score: 0,
    completionHint: null,
  };
}

/** Normalize a question's direction into the ledger's who-owes-whom semantic. */
function toLedgerDirection(direction: QuestionDirection): CommitmentDirection {
  return direction === 'asked_of_me' ? 'owed_by_me' : 'owed_to_me';
}

function toQuestionStatus(state: OpenLoopState): QuestionStatus {
  return state === 'done' ? 'answered' : state === 'dropped' ? 'dropped' : 'open';
}

function fromQuestionStatus(status: QuestionStatus): OpenLoopState {
  return status === 'answered' ? 'done' : status === 'dropped' ? 'dropped' : 'open';
}
