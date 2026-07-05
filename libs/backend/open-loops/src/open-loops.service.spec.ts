import { BadRequestException } from '@nestjs/common';
import type { OpenLoopDto, OpenLoopKind, OpenLoopState } from '@plaudern/contracts';
import { OpenLoopsService } from './open-loops.service';
import { rankOpenLoops, scoreOpenLoop, type OpenLoopSource } from './open-loop-source';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-05T00:00:00.000Z');

function loop(partial: Partial<OpenLoopDto> & { id: string; kind: OpenLoopKind }): OpenLoopDto {
  return {
    state: 'open',
    title: partial.id,
    direction: null,
    counterpartyName: null,
    dueDate: null,
    overdue: false,
    inboxItemId: null,
    citationCount: 1,
    firstSeenAt: new Date(NOW).toISOString(),
    lastSeenAt: new Date(NOW).toISOString(),
    score: 0,
    completionHint: null,
    ...partial,
  };
}

/** A stub source that records the args it was listed with. */
class FakeSource implements OpenLoopSource {
  listCalls: Array<{ userId: string; includeResolved: boolean }> = [];
  updated: Array<{ id: string; state: OpenLoopState }> = [];
  constructor(
    readonly kind: OpenLoopKind,
    private readonly rows: OpenLoopDto[],
  ) {}
  async list(userId: string, includeResolved: boolean): Promise<OpenLoopDto[]> {
    this.listCalls.push({ userId, includeResolved });
    return this.rows;
  }
  async updateState(_userId: string, id: string, state: OpenLoopState): Promise<OpenLoopDto> {
    this.updated.push({ id, state });
    return loop({ id, kind: this.kind, state });
  }
}

describe('scoreOpenLoop', () => {
  it('ranks an older loop above a newer one', () => {
    const old = loop({ id: 'a', kind: 'task', firstSeenAt: new Date(NOW - 30 * DAY).toISOString() });
    const fresh = loop({ id: 'b', kind: 'task', firstSeenAt: new Date(NOW - 1 * DAY).toISOString() });
    expect(scoreOpenLoop(old, NOW)).toBeGreaterThan(scoreOpenLoop(fresh, NOW));
  });

  it('floats an overdue loop above a merely old one', () => {
    const oldOpen = loop({ id: 'a', kind: 'task', firstSeenAt: new Date(NOW - 20 * DAY).toISOString() });
    const overdue = loop({
      id: 'b',
      kind: 'commitment',
      firstSeenAt: new Date(NOW - 2 * DAY).toISOString(),
      dueDate: new Date(NOW - 1 * DAY).toISOString(),
      overdue: true,
    });
    expect(scoreOpenLoop(overdue, NOW)).toBeGreaterThan(scoreOpenLoop(oldOpen, NOW));
  });

  it('weights loops raised across more recordings higher', () => {
    const once = loop({ id: 'a', kind: 'task', citationCount: 1 });
    const many = loop({ id: 'b', kind: 'task', citationCount: 5 });
    expect(scoreOpenLoop(many, NOW)).toBeGreaterThan(scoreOpenLoop(once, NOW));
  });
});

describe('rankOpenLoops', () => {
  it('sorts by score desc and sets the score field', () => {
    const rows = [
      loop({ id: 'fresh', kind: 'task', firstSeenAt: new Date(NOW - 1 * DAY).toISOString() }),
      loop({ id: 'old', kind: 'task', firstSeenAt: new Date(NOW - 40 * DAY).toISOString() }),
    ];
    const ranked = rankOpenLoops(rows, NOW);
    expect(ranked.map((r) => r.id)).toEqual(['old', 'fresh']);
    expect(ranked[0].score).toBeGreaterThan(0);
  });
});

describe('OpenLoopsService', () => {
  it('merges and ranks every source by default', async () => {
    const tasks = new FakeSource('task', [
      loop({ id: 't', kind: 'task', firstSeenAt: new Date(NOW - 5 * DAY).toISOString() }),
    ]);
    const commitments = new FakeSource('commitment', [
      loop({ id: 'c', kind: 'commitment', firstSeenAt: new Date(NOW - 50 * DAY).toISOString() }),
    ]);
    const svc = new OpenLoopsService([tasks, commitments]);
    const result = await svc.list('u1', { includeResolved: false });
    expect(result.map((r) => r.id)).toEqual(['c', 't']);
    expect(tasks.listCalls).toEqual([{ userId: 'u1', includeResolved: false }]);
    expect(commitments.listCalls).toEqual([{ userId: 'u1', includeResolved: false }]);
  });

  it('queries only the matching source when kind is filtered', async () => {
    const tasks = new FakeSource('task', [loop({ id: 't', kind: 'task' })]);
    const commitments = new FakeSource('commitment', [loop({ id: 'c', kind: 'commitment' })]);
    const svc = new OpenLoopsService([tasks, commitments]);
    const result = await svc.list('u1', { kind: 'task', includeResolved: false });
    expect(result.map((r) => r.id)).toEqual(['t']);
    expect(commitments.listCalls).toHaveLength(0);
  });

  it('narrows to the directional kinds and filters by direction', async () => {
    const commitments = new FakeSource('commitment', [
      loop({ id: 'mine', kind: 'commitment', direction: 'owed_by_me' }),
      loop({ id: 'theirs', kind: 'commitment', direction: 'owed_to_me' }),
    ]);
    const questions = new FakeSource('question', [
      loop({ id: 'answer-i-owe', kind: 'question', direction: 'owed_by_me' }),
      loop({ id: 'answer-owed-me', kind: 'question', direction: 'owed_to_me' }),
    ]);
    const tasks = new FakeSource('task', [loop({ id: 't', kind: 'task' })]);
    const svc = new OpenLoopsService([tasks, commitments, questions]);
    const result = await svc.list('u1', { direction: 'owed_by_me', includeResolved: false });
    expect(result.map((r) => r.id).sort()).toEqual(['answer-i-owe', 'mine']);
    expect(tasks.listCalls).toHaveLength(0);
  });

  it('passes includeResolved through to sources', async () => {
    const tasks = new FakeSource('task', []);
    const svc = new OpenLoopsService([tasks]);
    await svc.list('u1', { includeResolved: true });
    expect(tasks.listCalls).toEqual([{ userId: 'u1', includeResolved: true }]);
  });

  it('routes a state mutation to the owning source', async () => {
    const tasks = new FakeSource('task', []);
    const commitments = new FakeSource('commitment', []);
    const svc = new OpenLoopsService([tasks, commitments]);
    const updated = await svc.updateState('u1', 'commitment', 'c1', 'done');
    expect(updated).toMatchObject({ id: 'c1', kind: 'commitment', state: 'done' });
    expect(commitments.updated).toEqual([{ id: 'c1', state: 'done' }]);
    expect(tasks.updated).toHaveLength(0);
  });

  it('rejects an unknown kind on mutation', async () => {
    const svc = new OpenLoopsService([new FakeSource('task', [])]);
    await expect(svc.updateState('u1', 'commitment', 'x', 'done')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
