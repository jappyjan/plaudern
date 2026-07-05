import type { ExtractedFact } from '@plaudern/contracts';
import type { ExtractionFixture } from '../harness';

/**
 * Golden set for personal-fact extraction. Exercises `parseFactsResponse`:
 * subject/attribute/value capture, the `exclusive` coercion (only a literal
 * `true` supersedes), code-fence tolerance and dropping of unnamed/attribute-
 * less junk.
 */
export const factFixtures: ExtractionFixture<ExtractedFact>[] = [
  {
    name: 'birthday + allergy, both attributed',
    response: `{"facts":[
      {"person":"Anna","attribute":"birthday","value":"March 3rd","exclusive":true,"quote":"Anna's birthday is March 3rd"},
      {"person":"Tom","attribute":"allergy","value":"peanuts","exclusive":false,"quote":null}
    ]}`,
    expected: [
      { person: 'Anna', attribute: 'birthday', value: 'March 3rd', exclusive: true, quote: "Anna's birthday is March 3rd" },
      { person: 'Tom', attribute: 'allergy', value: 'peanuts', exclusive: false, quote: null },
    ],
  },
  {
    name: 'code-fenced reply, drops the attribute-less junk entry',
    response: '```json\n{"facts":[' +
      '{"person":"Mia","attribute":"job","value":"teacher","exclusive":true,"quote":null},' +
      '{"person":"","attribute":"","value":"nonsense"}' +
      ']}\n```',
    expected: [{ person: 'Mia', attribute: 'job', value: 'teacher', exclusive: true, quote: null }],
  },
  {
    name: 'empty transcript yields no facts',
    response: '{"facts":[]}',
    expected: [],
  },
];
