import { buildLabelPrompt, parseLabelResponse } from './openai.labeler';

describe('parseLabelResponse', () => {
  it('parses a plain JSON object', () => {
    expect(parseLabelResponse('{"label":"Hausbau","description":"Building a house"}')).toEqual({
      label: 'Hausbau',
      description: 'Building a house',
    });
  });

  it('tolerates code-fence wrapping and trims whitespace', () => {
    const content = '```json\n{ "label": "  Kitchen Reno  ", "description": "" }\n```';
    expect(parseLabelResponse(content)).toEqual({ label: 'Kitchen Reno', description: null });
  });

  it('returns an empty label when nothing usable is present', () => {
    expect(parseLabelResponse('not json at all')).toEqual({ label: '', description: null });
  });

  it('recovers a JSON object embedded in prose', () => {
    expect(parseLabelResponse('Here you go: {"label":"Taxes"} — done')).toEqual({
      label: 'Taxes',
      description: null,
    });
  });
});

describe('buildLabelPrompt', () => {
  it('includes the language and numbers each sample', () => {
    const prompt = buildLabelPrompt({ samples: ['first note', 'second note'], language: 'de' });
    expect(prompt).toContain('Notes language: de.');
    expect(prompt).toContain('Note 1:');
    expect(prompt).toContain('Note 2:');
    expect(prompt).toContain('first note');
  });
});
