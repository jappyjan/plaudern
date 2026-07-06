import {
  NUDGE_LEAD_DAYS,
  NUDGE_STALE_DAYS,
  classifyNudge,
  draftNudgeText,
  isResolvedByLaterItems,
  subjectKeywords,
} from './nudges.resolution';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-06T12:00:00.000Z');

describe('classifyNudge', () => {
  it('flags an overdue due date', () => {
    const r = classifyNudge({ dueDate: new Date(NOW - DAY_MS).toISOString(), occurredAt: new Date(NOW - 5 * DAY_MS).toISOString(), now: NOW });
    expect(r).toEqual({ eligible: true, reason: 'overdue' });
  });

  it('flags a due date within the lead window', () => {
    const r = classifyNudge({ dueDate: new Date(NOW + (NUDGE_LEAD_DAYS - 1) * DAY_MS).toISOString(), occurredAt: new Date(NOW - DAY_MS).toISOString(), now: NOW });
    expect(r).toEqual({ eligible: true, reason: 'due_soon' });
  });

  it('does not flag a due date beyond the lead window', () => {
    const r = classifyNudge({ dueDate: new Date(NOW + (NUDGE_LEAD_DAYS + 3) * DAY_MS).toISOString(), occurredAt: new Date(NOW - DAY_MS).toISOString(), now: NOW });
    expect(r.eligible).toBe(false);
  });

  it('flags a due-date-less promise once it is stale by age', () => {
    const r = classifyNudge({ dueDate: null, occurredAt: new Date(NOW - (NUDGE_STALE_DAYS + 1) * DAY_MS).toISOString(), now: NOW });
    expect(r).toEqual({ eligible: true, reason: 'stale' });
  });

  it('does not flag a recent due-date-less promise', () => {
    const r = classifyNudge({ dueDate: null, occurredAt: new Date(NOW - 2 * DAY_MS).toISOString(), now: NOW });
    expect(r.eligible).toBe(false);
  });
});

describe('subjectKeywords', () => {
  it('keeps distinctive words and drops filler', () => {
    expect(subjectKeywords('send the draft to the team')).toEqual(['draft', 'team']);
  });
});

describe('isResolvedByLaterItems', () => {
  const base = {
    description: 'send the signed draft',
    counterpartyName: 'Anna',
    occurredAt: new Date(NOW - 5 * DAY_MS).toISOString(),
  };

  it('detects resolution when a later item names the counterparty + subject', () => {
    expect(
      isResolvedByLaterItems({
        ...base,
        laterTexts: [
          { occurredAt: new Date(NOW - DAY_MS).toISOString(), text: 'i finally gave anna the signed draft this morning' },
        ],
      }),
    ).toBe(true);
  });

  it('does not resolve from an EARLIER item', () => {
    expect(
      isResolvedByLaterItems({
        ...base,
        laterTexts: [
          { occurredAt: new Date(NOW - 10 * DAY_MS).toISOString(), text: 'i gave anna the signed draft' },
        ],
      }),
    ).toBe(false);
  });

  it('does not resolve when later items are unrelated', () => {
    expect(
      isResolvedByLaterItems({
        ...base,
        laterTexts: [
          { occurredAt: new Date(NOW - DAY_MS).toISOString(), text: 'talked to bob about the garden fence' },
        ],
      }),
    ).toBe(false);
  });

  it('never suppresses when the description has no distinctive words', () => {
    expect(
      isResolvedByLaterItems({
        description: 'do it',
        counterpartyName: 'Anna',
        occurredAt: base.occurredAt,
        laterTexts: [{ occurredAt: new Date(NOW - DAY_MS).toISOString(), text: 'did it with anna' }],
      }),
    ).toBe(false);
  });

  it('resolves without a counterparty when subject overlap is strong', () => {
    expect(
      isResolvedByLaterItems({
        description: 'renew the apartment insurance policy',
        counterpartyName: null,
        occurredAt: base.occurredAt,
        laterTexts: [
          { occurredAt: new Date(NOW - DAY_MS).toISOString(), text: 'renewed the apartment insurance policy online' },
        ],
      }),
    ).toBe(true);
  });
});

describe('draftNudgeText', () => {
  it('drafts an outgoing follow-up for owed_to_me', () => {
    expect(draftNudgeText('owed_to_me', 'Tom', "the landlord's answer")).toContain('Tom');
  });

  it('drafts a self-facing note for owed_by_me', () => {
    expect(draftNudgeText('owed_by_me', 'Anna', 'send the draft')).toContain('Anna');
  });
});
