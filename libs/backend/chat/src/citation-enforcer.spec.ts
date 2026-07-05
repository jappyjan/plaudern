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
