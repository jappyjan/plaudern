import { mapWhisperSegments, normalizeWhisperLanguage } from './whisper.provider';

describe('mapWhisperSegments', () => {
  it('maps {start,end,text} and trims whitespace', () => {
    const segments = mapWhisperSegments([
      { start: 0, end: 1.2, text: '  Hello there.  ' },
      { start: 1.2, end: 2.5, text: 'How are you?' },
    ]);
    expect(segments).toEqual([
      { start: 0, end: 1.2, text: 'Hello there.' },
      { start: 1.2, end: 2.5, text: 'How are you?' },
    ]);
  });

  it('drops whitespace-only segments', () => {
    const segments = mapWhisperSegments([
      { start: 0, end: 1, text: '   ' },
      { start: 1, end: 2, text: 'kept' },
    ]);
    expect(segments).toEqual([{ start: 1, end: 2, text: 'kept' }]);
  });

  it('returns undefined for empty, undefined, or all-blank input', () => {
    expect(mapWhisperSegments(undefined)).toBeUndefined();
    expect(mapWhisperSegments([])).toBeUndefined();
    expect(mapWhisperSegments([{ start: 0, end: 1, text: '   ' }])).toBeUndefined();
  });
});

describe('normalizeWhisperLanguage', () => {
  it('maps full language names to 2-letter codes, case-insensitively', () => {
    expect(normalizeWhisperLanguage('english')).toBe('en');
    expect(normalizeWhisperLanguage('English')).toBe('en');
    expect(normalizeWhisperLanguage('GERMAN')).toBe('de');
  });

  it('passes through 2-letter codes and unmapped names unchanged', () => {
    expect(normalizeWhisperLanguage('en')).toBe('en');
    expect(normalizeWhisperLanguage('klingon')).toBe('klingon');
  });

  it('returns undefined when no language is given', () => {
    expect(normalizeWhisperLanguage(undefined)).toBeUndefined();
  });
});
