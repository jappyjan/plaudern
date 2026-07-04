import { highlightSnippet, tokenize } from './keyword-search.service';

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumerics and drops 1-char tokens', () => {
    expect(tokenize('The Wi-Fi password!')).toEqual(['the', 'wi', 'fi', 'password']);
  });

  it('folds diacritics so umlaut queries match folded text', () => {
    expect(tokenize('Über Hausbau')).toEqual(['uber', 'hausbau']);
  });

  it('returns nothing for punctuation-only input', () => {
    expect(tokenize('  ,.!  ')).toEqual([]);
  });
});

describe('highlightSnippet', () => {
  it('wraps matched terms in <mark> preserving original casing/diacritics', () => {
    const snippet = highlightSnippet('We discussed the Hausbau budget in detail', ['hausbau']);
    expect(snippet).toContain('<mark>Hausbau</mark>');
  });

  it('matches accented source text with a folded query term', () => {
    const snippet = highlightSnippet('Wir sprachen über den Vertrag', ['uber']);
    expect(snippet).toContain('<mark>über</mark>');
  });

  it('adds an ellipsis prefix when the window starts mid-text', () => {
    const long = `${'x '.repeat(100)}needle tail`;
    const snippet = highlightSnippet(long, ['needle']);
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet).toContain('<mark>needle</mark>');
  });

  it('highlights multiple distinct terms', () => {
    const snippet = highlightSnippet('alpha then beta then gamma', ['alpha', 'gamma']);
    expect(snippet).toContain('<mark>alpha</mark>');
    expect(snippet).toContain('<mark>gamma</mark>');
  });
});
