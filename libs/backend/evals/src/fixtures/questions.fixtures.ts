import type { ExtractedQuestion } from '@plaudern/contracts';
import type { ExtractionFixture } from '../harness';

/**
 * Golden set for question extraction. Exercises `parseQuestionsResponse`:
 * direction (asked_by_me vs asked_of_me), counterparty, the `answered` flag,
 * code-fence tolerance and dropping of empty-question junk.
 */
export const questionFixtures: ExtractionFixture<ExtractedQuestion>[] = [
  {
    name: 'one asked of me (open), one asked by me (answered)',
    response: `{"questions":[
      {"direction":"asked_of_me","counterparty":"Anna","question":"When is the deadline?","answered":false,"sourceQuote":"Anna asked when the deadline is"},
      {"direction":"asked_by_me","counterparty":"Tom","question":"Did you send the invoice?","answered":true,"sourceQuote":null}
    ]}`,
    expected: [
      { direction: 'asked_of_me', counterparty: 'Anna', question: 'When is the deadline?', answered: false, sourceQuote: 'Anna asked when the deadline is', sourceTimestamp: null },
      { direction: 'asked_by_me', counterparty: 'Tom', question: 'Did you send the invoice?', answered: true, sourceQuote: null, sourceTimestamp: null },
    ],
  },
  {
    name: 'code-fenced reply, drops the empty-question entry',
    response: '```json\n{"questions":[' +
      '{"direction":"asked_by_me","counterparty":"","question":"Where did we park?","answered":false,"sourceQuote":null},' +
      '{"direction":"asked_of_me","counterparty":"x","question":""}' +
      ']}\n```',
    expected: [
      { direction: 'asked_by_me', counterparty: '', question: 'Where did we park?', answered: false, sourceQuote: null, sourceTimestamp: null },
    ],
  },
  {
    name: 'no questions',
    response: '{"questions":[]}',
    expected: [],
  },
];
