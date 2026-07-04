import { normalizeLanguage, wordsToSegments } from './elevenlabs.provider';

describe('wordsToSegments', () => {
  it('reconstructs text with spacing and starts a new segment per sentence', () => {
    const segments = wordsToSegments([
      { text: 'Hello', start: 0, end: 0.4, type: 'word' },
      { text: ' ', start: 0.4, end: 0.45, type: 'spacing' },
      { text: 'there.', start: 0.45, end: 0.9, type: 'word' },
      { text: ' ', start: 0.9, end: 0.95, type: 'spacing' },
      { text: 'How', start: 0.95, end: 1.2, type: 'word' },
      { text: ' ', start: 1.2, end: 1.25, type: 'spacing' },
      { text: 'are', start: 1.25, end: 1.4, type: 'word' },
      { text: ' ', start: 1.4, end: 1.45, type: 'spacing' },
      { text: 'you?', start: 1.45, end: 1.9, type: 'word' },
    ]);

    expect(segments).toEqual([
      { start: 0, end: 0.9, text: 'Hello there.' },
      { start: 0.95, end: 1.9, text: 'How are you?' },
    ]);
  });

  it('splits on a silence gap even without sentence punctuation', () => {
    const segments = wordsToSegments([
      { text: 'one', start: 0, end: 0.3, type: 'word' },
      { text: ' ', start: 0.3, end: 0.35, type: 'spacing' },
      { text: 'two', start: 0.35, end: 0.6, type: 'word' },
      // 2s of silence before the next word
      { text: 'three', start: 2.6, end: 2.9, type: 'word' },
    ]);

    expect(segments).toEqual([
      { start: 0, end: 0.6, text: 'one two' },
      { start: 2.6, end: 2.9, text: 'three' },
    ]);
  });

  it('splits when the speaker changes', () => {
    const segments = wordsToSegments([
      { text: 'hi', start: 0, end: 0.3, type: 'word', speaker_id: 'speaker_0' },
      { text: ' ', start: 0.3, end: 0.35, type: 'spacing', speaker_id: 'speaker_0' },
      { text: 'yo', start: 0.35, end: 0.6, type: 'word', speaker_id: 'speaker_1' },
    ]);

    expect(segments).toEqual([
      { start: 0, end: 0.3, text: 'hi' },
      { start: 0.35, end: 0.6, text: 'yo' },
    ]);
  });

  it('drops whitespace-only segments and returns nothing for empty input', () => {
    expect(wordsToSegments([])).toEqual([]);
    expect(wordsToSegments([{ text: '   ', start: 0, end: 0.1, type: 'spacing' }])).toEqual([]);
  });
});

describe('normalizeLanguage', () => {
  it('maps ISO 639-3 codes to the 2-letter form we store', () => {
    expect(normalizeLanguage('deu')).toBe('de');
    expect(normalizeLanguage('eng')).toBe('en');
    expect(normalizeLanguage('ENG')).toBe('en');
  });

  it('passes through 2-letter and unknown codes, and undefined', () => {
    expect(normalizeLanguage('de')).toBe('de');
    expect(normalizeLanguage('xyz')).toBe('xyz');
    expect(normalizeLanguage(undefined)).toBeUndefined();
  });
});
