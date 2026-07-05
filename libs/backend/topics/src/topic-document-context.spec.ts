import { sanitizeMarkers, usedMarkers } from './topic-document-context';

describe('citation marker handling (memory-chat identifier guard)', () => {
  describe('sanitizeMarkers', () => {
    it('keeps in-range citation markers untouched', () => {
      expect(sanitizeMarkers('Foundation poured [1]. Roof done [2].', 2)).toBe(
        'Foundation poured [1]. Roof done [2].',
      );
    });

    it('strips a true out-of-range citation marker', () => {
      expect(sanitizeMarkers('A claim [1] and a bogus one [9].', 2)).toBe(
        'A claim [1] and a bogus one .',
      );
    });

    it('does NOT mangle identifier-adjacent brackets like array[99]', () => {
      // `array[99]` is code/array indexing, not a citation — even though 99 is
      // out of range it must be left completely intact.
      const prose = 'The loop reads array[99] each pass, per the notes [1].';
      expect(sanitizeMarkers(prose, 2)).toBe(prose);
    });

    it('leaves an identifier-adjacent in-range bracket (arr[1]) untouched', () => {
      const prose = 'Access arr[1] directly.';
      expect(sanitizeMarkers(prose, 3)).toBe(prose);
    });

    it('handles a chained run, stripping only the out-of-range member', () => {
      expect(sanitizeMarkers('Both agreed [1][9].', 2)).toBe('Both agreed [1].');
    });
  });

  describe('usedMarkers', () => {
    it('collects only in-range markers at citation positions', () => {
      const used = usedMarkers('Done [1] and later [2][9]. Also array[99] and arr[2].', 2);
      // [1] and [2] are citations; [9] is out of range; array[99]/arr[2] are
      // identifier-adjacent (not citations) so contribute nothing.
      expect([...used].sort()).toEqual([1, 2]);
    });

    it('ignores an out-of-range-only body', () => {
      expect(usedMarkers('Bogus [9] only.', 2).size).toBe(0);
    });
  });
});
