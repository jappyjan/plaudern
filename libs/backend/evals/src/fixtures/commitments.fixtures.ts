import type { ExtractedCommitment } from '@plaudern/contracts';
import type { ExtractionFixture } from '../harness';

/**
 * Golden set for commitment extraction. Exercises `parseCommitmentsResponse`:
 * direction attribution (owed_by_me vs owed_to_me), counterparty capture,
 * code-fence tolerance and dropping of description-less junk.
 */
export const commitmentFixtures: ExtractionFixture<ExtractedCommitment>[] = [
  {
    name: 'one owed by me, one owed to me, both attributed',
    response: `{"commitments":[
      {"direction":"owed_by_me","counterparty":"Anna","description":"send the draft","duePhrase":"by Friday","sourceQuote":"I'll send you the draft by Friday"},
      {"direction":"owed_to_me","counterparty":"Tom","description":"check with the landlord","duePhrase":null,"sourceQuote":"Tom said he'd check with the landlord"}
    ]}`,
    expected: [
      { direction: 'owed_by_me', counterparty: 'Anna', description: 'send the draft', duePhrase: 'by Friday', sourceQuote: "I'll send you the draft by Friday", sourceTimestamp: null },
      { direction: 'owed_to_me', counterparty: 'Tom', description: 'check with the landlord', duePhrase: null, sourceQuote: "Tom said he'd check with the landlord", sourceTimestamp: null },
    ],
  },
  {
    name: 'code-fenced reply, drops the description-less junk entry',
    response: '```json\n{"commitments":[' +
      '{"direction":"owed_by_me","counterparty":"","description":"call the plumber","duePhrase":"tomorrow","sourceQuote":null},' +
      '{"direction":"owed_by_me","counterparty":"x"}' +
      ']}\n```',
    expected: [
      { direction: 'owed_by_me', counterparty: '', description: 'call the plumber', duePhrase: 'tomorrow', sourceQuote: null, sourceTimestamp: null },
    ],
  },
  {
    name: 'no commitments',
    response: '{"commitments":[]}',
    expected: [],
  },
];

/**
 * Golden set for the due-date RESOLVER (`resolveDueDate`) — "did it find the
 * right due date?". Relative phrases are anchored on a fixed recording time so
 * every expectation is a concrete UTC instant. Anchor: Wednesday 2026-07-01,
 * and resolved due dates land at 17:00 UTC.
 */
export const DUE_DATE_ANCHOR = '2026-07-01T09:00:00.000Z';

export interface DueDateCase {
  phrase: string | null;
  expected: string | null;
}

export const dueDateCases: DueDateCase[] = [
  { phrase: 'tomorrow', expected: '2026-07-02T17:00:00.000Z' },
  { phrase: 'morgen', expected: '2026-07-02T17:00:00.000Z' },
  { phrase: 'in 3 days', expected: '2026-07-04T17:00:00.000Z' },
  { phrase: 'next week', expected: '2026-07-08T17:00:00.000Z' },
  { phrase: 'by Friday', expected: '2026-07-03T17:00:00.000Z' },
  { phrase: 'bis Freitag', expected: '2026-07-03T17:00:00.000Z' },
  { phrase: 'next Monday', expected: '2026-07-13T17:00:00.000Z' },
  { phrase: 'end of week', expected: '2026-07-03T17:00:00.000Z' },
  { phrase: 'Ende des Monats', expected: '2026-07-31T17:00:00.000Z' },
  { phrase: '2026-08-15', expected: '2026-08-15T17:00:00.000Z' },
  { phrase: 'sometime soon', expected: null },
  { phrase: null, expected: null },
];
