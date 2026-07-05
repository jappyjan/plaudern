import type { QuestionDto, QuestionListQuery, QuestionStatus } from '@plaudern/contracts';
import type { QuestionsService } from '@plaudern/questions';
import { QuestionOpenLoopSource } from './question-open-loop.source';

function question(partial: Partial<QuestionDto> & { id: string }): QuestionDto {
  return {
    inboxItemId: '7d1a2f30-0000-4000-8000-000000000001',
    direction: 'asked_by_me',
    counterpartyName: '',
    counterpartyEntityId: null,
    question: 'Did the landlord ever reply?',
    status: 'open',
    sourceTimestamp: null,
    occurredAt: '2026-06-01T12:00:00.000Z',
    createdAt: '2026-06-02T00:00:00.000Z',
    updatedAt: '2026-06-02T00:00:00.000Z',
    ...partial,
  };
}

/** Fake QuestionsService recording calls; only the two methods the source uses. */
class FakeQuestionsService {
  listCalls: Array<{ userId: string; filters: QuestionListQuery }> = [];
  updateCalls: Array<{ id: string; status: QuestionStatus }> = [];
  constructor(private readonly rows: QuestionDto[]) {}
  async list(userId: string, filters: QuestionListQuery) {
    this.listCalls.push({ userId, filters });
    return { questions: this.rows };
  }
  async updateStatus(_userId: string, id: string, status: QuestionStatus) {
    this.updateCalls.push({ id, status });
    return question({ id, status });
  }
}

function source(rows: QuestionDto[] = []): {
  src: QuestionOpenLoopSource;
  svc: FakeQuestionsService;
} {
  const svc = new FakeQuestionsService(rows);
  return { src: new QuestionOpenLoopSource(svc as unknown as QuestionsService), svc };
}

describe('QuestionOpenLoopSource', () => {
  it('maps an open question into a normalized ledger row', async () => {
    const { src } = source([
      question({
        id: 'q1',
        direction: 'asked_by_me',
        counterpartyName: 'Tom',
        question: 'When does the lease end?',
        occurredAt: '2026-05-20T09:00:00.000Z',
        inboxItemId: '7d1a2f30-0000-4000-8000-00000000abcd',
      }),
    ]);
    const [loop] = await src.list('u1', false);
    expect(loop).toEqual({
      id: 'q1',
      kind: 'question',
      state: 'open',
      title: 'When does the lease end?',
      direction: 'owed_to_me',
      counterpartyName: 'Tom',
      dueDate: null,
      overdue: false,
      inboxItemId: '7d1a2f30-0000-4000-8000-00000000abcd',
      citationCount: 1,
      firstSeenAt: '2026-05-20T09:00:00.000Z',
      lastSeenAt: '2026-05-20T09:00:00.000Z',
      score: 0,
      completionHint: null,
    });
  });

  it('normalizes directions into the who-owes-whom semantic', async () => {
    const { src } = source([
      question({ id: 'mine-to-answer', direction: 'asked_of_me' }),
      question({ id: 'their-answer-owed', direction: 'asked_by_me' }),
    ]);
    const loops = await src.list('u1', false);
    expect(loops.find((l) => l.id === 'mine-to-answer')?.direction).toBe('owed_by_me');
    expect(loops.find((l) => l.id === 'their-answer-owed')?.direction).toBe('owed_to_me');
  });

  it('maps statuses both ways (answered↔done, dropped↔dropped)', async () => {
    const { src } = source([
      question({ id: 'a', status: 'answered' }),
      question({ id: 'd', status: 'dropped' }),
    ]);
    const loops = await src.list('u1', true);
    expect(loops.find((l) => l.id === 'a')?.state).toBe('done');
    expect(loops.find((l) => l.id === 'd')?.state).toBe('dropped');
  });

  it('nulls an unknown (empty) counterparty', async () => {
    const { src } = source([question({ id: 'q', counterpartyName: '' })]);
    const [loop] = await src.list('u1', false);
    expect(loop.counterpartyName).toBeNull();
  });

  it('requests only open rows unless resolved rows are included', async () => {
    const { src, svc } = source([]);
    await src.list('u1', false);
    await src.list('u1', true);
    expect(svc.listCalls).toEqual([
      { userId: 'u1', filters: { status: 'open' } },
      { userId: 'u1', filters: {} },
    ]);
  });

  it('routes state mutations to QuestionsService with the source statuses', async () => {
    const { src, svc } = source();
    const done = await src.updateState('u1', 'q1', 'done');
    expect(done.state).toBe('done');
    await src.updateState('u1', 'q1', 'dropped');
    await src.updateState('u1', 'q1', 'open');
    expect(svc.updateCalls).toEqual([
      { id: 'q1', status: 'answered' },
      { id: 'q1', status: 'dropped' },
      { id: 'q1', status: 'open' },
    ]);
  });
});
