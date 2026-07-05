import { countUncitedClaims, enforceCitations } from './citation-enforcer';

describe('enforceCitations', () => {
  const valid = new Set([1, 2, 3]);

  it('keeps valid markers and reports them in order of first appearance', () => {
    const result = enforceCitations('The dose is 20mg [2]. Taken daily [1][2].', valid);
    expect(result.usedMarkers).toEqual([2, 1]);
    expect(result.content).toBe('The dose is 20mg [1]. Taken daily [2][1].');
    expect(result.uncitedClaimCount).toBe(0);
  });

  it('strips markers referencing sources that were never provided', () => {
    const result = enforceCitations('The rent is 900 euros [7].', valid);
    expect(result.usedMarkers).toEqual([]);
    expect(result.content).toBe('The rent is 900 euros.');
  });

  it('renumbers surviving markers densely after stripping invalid ones', () => {
    const result = enforceCitations('A fact [3]. Another fact [9]. More detail [3][1].', valid);
    expect(result.usedMarkers).toEqual([3, 1]);
    expect(result.content).toBe('A fact [1]. Another fact. More detail [1][2].');
    // "Another fact." lost its only marker but is too short to count as a claim.
    expect(result.uncitedClaimCount).toBe(0);
  });

  it('counts substantive sentences left without any citation', () => {
    const result = enforceCitations(
      'The landlord agreed to fix the heating before winter [1]. ' +
        'He also promised to lower the rent by fifty euros a month.',
      valid,
    );
    expect(result.usedMarkers).toEqual([1]);
    expect(result.uncitedClaimCount).toBe(1);
  });

  it('flags short uncited clauses (JJ-68): "Anna is pregnant. …" is low confidence', () => {
    // Previously this served at HIGH: three declarative clauses under 30 chars
    // slipped past the sentence-length heuristic. Clause-level coverage counts
    // each as an uncited claim, so the caller downgrades to low confidence.
    const result = enforceCitations(
      'Anna is pregnant. He quit his job. She moved to Berlin. Yes [1].',
      valid,
    );
    expect(result.usedMarkers).toEqual([1]);
    expect(result.uncitedClaimCount).toBe(3);
  });

  it('returns empty markers for an entirely uncited answer', () => {
    const result = enforceCitations(
      'The doctor said to take the medication twice a day with food.',
      valid,
    );
    expect(result.usedMarkers).toEqual([]);
    expect(result.uncitedClaimCount).toBe(1);
  });

  it('tidies double spaces and space-before-punctuation left by stripping', () => {
    const result = enforceCitations('It was Tuesday [8] , according to notes [1].', valid);
    expect(result.content).toBe('It was Tuesday, according to notes [1].');
  });

  it('leaves identifier-adjacent brackets untouched even when the index is a valid marker', () => {
    // `data[3]` is array indexing, not a citation — no chip, no renumbering.
    const result = enforceCitations('The value lives in data[3] per the config [1].', valid);
    expect(result.content).toBe('The value lives in data[3] per the config [1].');
    expect(result.usedMarkers).toEqual([1]);
  });

  it('never strips identifier-adjacent brackets whose index is out of range', () => {
    // `foo[15]` with only 3 sources must NOT be corrupted to `foo`; the real
    // citation [2] is still renumbered densely (it is the only one → [1]).
    const result = enforceCitations('Call foo[15] to read it, as captured [2].', valid);
    expect(result.content).toBe('Call foo[15] to read it, as captured [1].');
    expect(result.usedMarkers).toEqual([2]);
  });

  it('still treats punctuation/start-of-string-adjacent markers as citations', () => {
    const result = enforceCitations('[2] Karsten said so. [3]', valid);
    expect(result.usedMarkers).toEqual([2, 3]);
    expect(result.content).toBe('[1] Karsten said so. [2]');
  });

  it('leaves chained array indexing untouched while keeping citation chains', () => {
    const result = enforceCitations('Use arr[1][2] here; the doctor confirmed it [1][2].', valid);
    expect(result.content).toBe('Use arr[1][2] here; the doctor confirmed it [1][2].');
    expect(result.usedMarkers).toEqual([1, 2]);
  });
});

describe('countUncitedClaims', () => {
  it('does not count questions, short fragments, or hedged non-answers', () => {
    expect(countUncitedClaims('Do you want me to look for the exact date in the archive?')).toBe(0);
    expect(countUncitedClaims('In short:')).toBe(0);
    expect(
      countUncitedClaims("I couldn't find any mention of the WiFi password in your recordings."),
    ).toBe(0);
  });

  it('counts long declarative sentences without markers', () => {
    expect(
      countUncitedClaims('Karsten said he would send the contract draft next Friday afternoon.'),
    ).toBe(1);
  });
});
