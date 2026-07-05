import type { ExtractedDecision } from '@plaudern/contracts';
import type { ExtractionFixture } from '../harness';

/**
 * Golden set for decision extraction. Exercises `parseDecisionsResponse`:
 * the decision statement, participant attribution, optional context/confidence,
 * code-fence tolerance and dropping of empty-decision junk.
 */
export const decisionFixtures: ExtractionFixture<ExtractedDecision>[] = [
  {
    name: 'vendor choice with participants, launch postponed without',
    response: `{"decisions":[
      {"decision":"Go with vendor B","context":"cheaper and faster","participants":"Anna, Tom","confidence":0.9,"sourceQuote":"We decided to go with vendor B"},
      {"decision":"Postpone the launch","context":null,"participants":"","confidence":null,"sourceQuote":null}
    ]}`,
    expected: [
      { decision: 'Go with vendor B', context: 'cheaper and faster', participants: 'Anna, Tom', confidence: 0.9, sourceQuote: 'We decided to go with vendor B', sourceTimestamp: null },
      { decision: 'Postpone the launch', context: null, participants: '', confidence: null, sourceQuote: null, sourceTimestamp: null },
    ],
  },
  {
    name: 'code-fenced reply, drops the empty-decision entry',
    response: '```json\n{"decisions":[' +
      '{"decision":"Adopt the new logo","context":null,"participants":"Design team","confidence":null,"sourceQuote":null},' +
      '{"decision":"","participants":"x"}' +
      ']}\n```',
    expected: [
      { decision: 'Adopt the new logo', context: null, participants: 'Design team', confidence: null, sourceQuote: null, sourceTimestamp: null },
    ],
  },
  {
    name: 'no decisions',
    response: '{"decisions":[]}',
    expected: [],
  },
];
