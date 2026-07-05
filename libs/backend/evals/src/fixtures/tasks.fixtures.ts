import type { ExtractedTask } from '@plaudern/contracts';
import type { ExtractionFixture } from '../harness';

/**
 * Golden set for task extraction. Exercises `parseTasksResponse`, in particular
 * `normalizeDate`: an ISO-shaped `dueDate` survives, a natural-language phrase
 * ("next month") is normalized to null rather than stored verbatim, and empty
 * titles are dropped.
 */
export const taskFixtures: ExtractionFixture<ExtractedTask>[] = [
  {
    name: 'ISO due date kept, natural-language due date nulled',
    response: `{"tasks":[
      {"title":"Book the flights","dueDate":"2026-08-01","quote":"I need to book the flights"},
      {"title":"Renew passport","dueDate":"next month","quote":null}
    ]}`,
    expected: [
      { title: 'Book the flights', dueDate: '2026-08-01', quote: 'I need to book the flights' },
      { title: 'Renew passport', dueDate: null, quote: null },
    ],
  },
  {
    name: 'code-fenced reply, drops the empty-title entry',
    response: '```json\n{"tasks":[' +
      '{"title":"Call the dentist","dueDate":null,"quote":null},' +
      '{"title":"","dueDate":"2026-01-01"}' +
      ']}\n```',
    expected: [{ title: 'Call the dentist', dueDate: null, quote: null }],
  },
  {
    name: 'no tasks',
    response: '{"tasks":[]}',
    expected: [],
  },
];
