import type { TopicDocumentInput } from '@plaudern/topics';

/**
 * Golden set for the topic-document generator. Its value is almost entirely in
 * the PROMPT and the response parsing (there is no structured row to score), so
 * per JJ-1 guidance we (a) pin `parseDocumentResponse` markdown extraction and
 * (b) assert the constructed prompt keeps its load-bearing structure — numbered
 * `[n]` source markers, the running document to update, the topic name — so
 * prompt/schema drift is caught.
 */
export interface DocParseCase {
  name: string;
  response: string;
  expected: string;
}

export const docParseCases: DocParseCase[] = [
  {
    name: 'plain JSON object',
    response: '{"markdown":"## Overview\\nAnna owes a draft [1]."}',
    expected: '## Overview\nAnna owes a draft [1].',
  },
  {
    name: 'code-fenced JSON',
    response: '```json\n{"markdown":"## Timeline\\n- Kickoff [1]\\n- Review [2]"}\n```',
    expected: '## Timeline\n- Kickoff [1]\n- Review [2]',
  },
];

/** Input used to snapshot the constructed prompt structure. */
export const promptInput: TopicDocumentInput = {
  topicName: 'Kitchen renovation',
  topicDescription: 'Planning and contractor coordination',
  previousMarkdown: '## Overview\nInitial scoping done [1].',
  sources: [
    {
      marker: 1,
      inboxItemId: '00000000-0000-0000-0000-000000000001',
      title: 'Kickoff call',
      occurredAt: '2026-06-01T10:00:00.000Z',
      text: 'We agreed to get three quotes before deciding.',
      language: 'en',
    },
    {
      marker: 2,
      inboxItemId: '00000000-0000-0000-0000-000000000002',
      title: 'Contractor visit',
      occurredAt: '2026-06-10T10:00:00.000Z',
      text: 'The contractor measured the space and quoted 12k.',
      language: 'en',
    },
  ],
};
