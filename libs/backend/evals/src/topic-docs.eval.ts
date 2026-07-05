import { buildUserPrompt, parseDocumentResponse } from '../../topics/src/providers/openai.document';
import { docParseCases, promptInput } from './fixtures/topic-docs.fixtures';

/**
 * Topic documents have no structured rows to score — their quality lives in the
 * PROMPT and the response parsing (JJ-1 guidance 2). So this eval pins both: the
 * markdown extraction from recorded replies, and the load-bearing structure of
 * the constructed prompt (numbered [n] source markers, the running document,
 * the topic name), so prompt/schema drift is caught.
 */
describe('topic-documents quality (JJ-1)', () => {
  describe('parseDocumentResponse markdown extraction', () => {
    let correct = 0;
    for (const c of docParseCases) {
      it(`extracts markdown from "${c.name}"`, () => {
        expect(parseDocumentResponse(c.response)).toBe(c.expected);
        correct++;
      });
    }
    afterAll(() => {
      const accuracy = correct / docParseCases.length;
      console.log(`topic-docs · markdown extraction accuracy: ${(accuracy * 100).toFixed(1)}%`);
      expect(accuracy).toBeGreaterThanOrEqual(0.9);
    });
  });

  describe('buildUserPrompt structure', () => {
    const prompt = buildUserPrompt(promptInput);

    it('anchors the prompt on the topic name and description', () => {
      expect(prompt).toContain('Topic: Kitchen renovation');
      expect(prompt).toContain('Topic description: Planning and contractor coordination');
    });

    it('hands the model the running document to update', () => {
      expect(prompt).toContain('Current document (update it');
      expect(prompt).toContain('Initial scoping done [1].');
    });

    it('numbers every source with its [n] citation marker, oldest first', () => {
      expect(prompt).toContain('Source items (2), oldest first');
      expect(prompt).toContain('[1] Kickoff call');
      expect(prompt).toContain('[2] Contractor visit');
      // ordering: source 1 must appear before source 2.
      expect(prompt.indexOf('[1] Kickoff call')).toBeLessThan(prompt.indexOf('[2] Contractor visit'));
      expect(prompt).toContain('We agreed to get three quotes before deciding.');
    });
  });
});
