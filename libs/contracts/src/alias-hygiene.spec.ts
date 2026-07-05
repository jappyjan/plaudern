import { isMeaningfulAlias, sanitizeAliases, normalizeAliasTerm } from './alias-hygiene';

describe('alias-hygiene', () => {
  describe('isMeaningfulAlias', () => {
    it('rejects German function words', () => {
      for (const term of ['Sie', 'ihr', 'Ihre', 'Ihrer', 'Ihrem', 'Ihnen', 'der', 'die', 'das']) {
        expect(isMeaningfulAlias(term)).toBe(false);
      }
    });

    it('rejects English function words', () => {
      for (const term of ['I', 'you', 'she', 'they', 'the', 'my', 'their']) {
        expect(isMeaningfulAlias(term)).toBe(false);
      }
    });

    it('rejects generic role nouns and article-prefixed phrases', () => {
      for (const term of ['Patient', 'der Patient', 'Arzt', 'der Arzt', 'the doctor', 'Herr', 'Frau']) {
        expect(isMeaningfulAlias(term)).toBe(false);
      }
    });

    it('rejects empty / punctuation-only / digit-only terms', () => {
      for (const term of ['', '   ', '...', '—', '123', '  , ']) {
        expect(isMeaningfulAlias(term)).toBe(false);
      }
    });

    it('keeps real names', () => {
      for (const term of ['Jan', 'Jan Jaap', 'Angela Merkel', 'Dr. Bertram', 'Ibuprofen']) {
        expect(isMeaningfulAlias(term)).toBe(true);
      }
    });
  });

  describe('sanitizeAliases', () => {
    it('drops function words and generic nouns, keeps real names', () => {
      const input = ['Patient', 'Sie', 'Ihnen', 'Ihre', 'Ihrer', 'Ihrem', 'Jan', 'Jan Jaap'];
      expect(sanitizeAliases('Patient', input)).toEqual(['Jan', 'Jan Jaap']);
    });

    it('drops aliases equal to the canonical name (case-insensitively)', () => {
      expect(sanitizeAliases('Jan Jaap', ['jan jaap', 'Jan'])).toEqual(['Jan']);
    });

    it('dedupes case-insensitively, keeping first-seen casing', () => {
      expect(sanitizeAliases('Patient', ['Jan', 'jan', 'JAN'])).toEqual(['Jan']);
    });

    it('trims surviving aliases and preserves order', () => {
      expect(sanitizeAliases('Patient', ['  Jan  ', 'Sie', 'Jaap'])).toEqual(['Jan', 'Jaap']);
    });

    it('returns an empty array when everything is junk', () => {
      expect(sanitizeAliases('Patient', ['Patient', 'Sie', 'der', '...'])).toEqual([]);
    });
  });

  describe('normalizeAliasTerm', () => {
    it('lowercases and collapses whitespace', () => {
      expect(normalizeAliasTerm('  Jan   Jaap ')).toBe('jan jaap');
    });
  });
});
