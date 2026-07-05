/**
 * Golden set for topic classification. Exercises `parseClassificationResponse`:
 * assignments outside the provided taxonomy are discarded, duplicate ids are
 * deduped to the highest confidence, and confidence is clamped into [0, 1].
 */
export interface TopicFixture {
  name: string;
  response: string;
  /** The taxonomy ids offered to the model — ids outside this set are dropped. */
  validTopicIds: string[];
  /** Topic ids the code should assign, with expected (post-clamp) confidence. */
  expected: Array<{ topicId: string; confidence: number }>;
}

export const topicFixtures: TopicFixture[] = [
  {
    name: 'keeps valid ids, drops the off-taxonomy id, dedupes to max confidence',
    response:
      '{"assignments":[{"id":"t1","confidence":0.9},{"id":"t9","confidence":0.8},{"id":"t2","confidence":0.4},{"id":"t1","confidence":0.5}]}',
    validTopicIds: ['t1', 't2', 't3'],
    expected: [
      { topicId: 't1', confidence: 0.9 },
      { topicId: 't2', confidence: 0.4 },
    ],
  },
  {
    name: 'code-fenced reply, clamps out-of-range confidence into [0,1]',
    response: '```json\n{"assignments":[{"id":"t3","confidence":1.7}]}\n```',
    validTopicIds: ['t1', 't2', 't3'],
    expected: [{ topicId: 't3', confidence: 1 }],
  },
  {
    name: 'nothing fits the taxonomy',
    response: '{"assignments":[]}',
    validTopicIds: ['t1', 't2'],
    expected: [],
  },
];
