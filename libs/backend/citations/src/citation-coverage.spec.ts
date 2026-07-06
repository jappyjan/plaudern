import { analyzeCitationCoverage, splitClaims } from './citation-coverage';

describe('splitClaims', () => {
  it('splits on sentence terminators, semicolons/colons, and newlines', () => {
    expect(splitClaims('Anna is pregnant. He quit his job. Yes [1].')).toEqual([
      'Anna is pregnant.',
      'He quit his job.',
      'Yes [1].',
    ]);
    expect(splitClaims('First point; second point.')).toEqual(['First point;', 'second point.']);
    expect(splitClaims('Line one\nLine two')).toEqual(['Line one', 'Line two']);
  });

  it('does not split on abbreviations (JJ-79)', () => {
    // "z.B." (German "e.g.") must not sever the sentence right after it.
    expect(
      splitClaims('Er hat z.B. das Auto gekauft [1].'),
    ).toEqual(['Er hat z.B. das Auto gekauft [1].']);
    // A handful of the other listed abbreviations, spot-checked.
    expect(splitClaims('Das war teuer, d.h. über 10.000 Euro [1].')).toEqual([
      'Das war teuer, d.h. über 10.000 Euro [1].',
    ]);
    expect(splitClaims('Sie kaufte Obst, Brot usw. beim Markt [1].')).toEqual([
      'Sie kaufte Obst, Brot usw. beim Markt [1].',
    ]);
    expect(splitClaims('Dr. Meier war beim Termin dabei [1].')).toEqual([
      'Dr. Meier war beim Termin dabei [1].',
    ]);
  });

  it('still splits on a genuine sentence boundary right after an abbreviation-bearing clause', () => {
    expect(
      splitClaims('Er hat z.B. das Auto gekauft [1]. Das war teuer [2].'),
    ).toEqual(['Er hat z.B. das Auto gekauft [1].', 'Das war teuer [2].']);
  });

  it('still splits genuine sentence boundaries (no abbreviations involved)', () => {
    expect(splitClaims('Anna is pregnant. He quit his job.')).toEqual([
      'Anna is pregnant.',
      'He quit his job.',
    ]);
  });
});

describe('analyzeCitationCoverage — strict (memory chat contract)', () => {
  const strict = { strictUncited: true } as const;

  it('flags the short-uncited-clause answer JJ-68 describes as low confidence', () => {
    // "Anna is pregnant. He quit his job. She moved to Berlin. Yes [1]." served
    // at HIGH before: three short (<30 char) declarative clauses slipped past
    // the old sentence-length heuristic. Clause-level coverage catches them.
    const result = analyzeCitationCoverage(
      'Anna is pregnant. He quit his job. She moved to Berlin. Yes [1].',
      strict,
    );
    expect(result.totalClaims).toBe(3);
    expect(result.citedClaims).toBe(0);
    expect(result.uncitedClaims).toBe(3);
    expect(result.confidence).toBe('low');
  });

  it('keeps a fully-cited answer at high confidence', () => {
    const result = analyzeCitationCoverage('The dose is 20mg [1]. Taken daily [2].', strict);
    expect(result.uncitedClaims).toBe(0);
    expect(result.confidence).toBe('high');
  });

  it('does not count questions, hedged non-answers, or short connectives', () => {
    expect(
      analyzeCitationCoverage('Do you want me to look for the exact date?', strict).totalClaims,
    ).toBe(0);
    expect(
      analyzeCitationCoverage(
        "I couldn't find any mention of the WiFi password in your recordings.",
        strict,
      ).totalClaims,
    ).toBe(0);
    expect(analyzeCitationCoverage('In short: it happened [1].', strict).uncitedClaims).toBe(0);
  });

  it('keeps a cited German sentence using "z.B." at high confidence (JJ-79)', () => {
    // Before the abbreviation guard, "z.B." severed this into two claims and
    // the second ("das Auto gekauft [1].") lost the citation, downgrading to
    // low confidence even though the whole sentence IS cited.
    const result = analyzeCitationCoverage('Er hat z.B. das Auto gekauft [1].', strict);
    expect(result.totalClaims).toBe(1);
    expect(result.uncitedClaims).toBe(0);
    expect(result.confidence).toBe('high');
  });

  it('any single uncited substantive claim downgrades a strict answer', () => {
    const result = analyzeCitationCoverage(
      'The landlord agreed to fix the heating [1]. He also promised to lower the rent by fifty euros.',
      strict,
    );
    expect(result.uncitedClaims).toBe(1);
    expect(result.confidence).toBe('low');
  });
});

describe('analyzeCitationCoverage — ratio (journal / topic-docs)', () => {
  it('tolerates a minority of uncited claims but flags a majority', () => {
    // 3 of 4 cited → ratio 0.75 > 0.5 → high.
    const mostlyCited = analyzeCitationCoverage(
      'The team shipped the feature [1]. The launch went well [2]. Revenue rose sharply [3]. Everyone was relieved.',
    );
    expect(mostlyCited.confidence).toBe('high');

    // 1 of 4 cited → ratio 0.25 ≤ 0.5 → low.
    const mostlyUncited = analyzeCitationCoverage(
      'The team shipped the feature. The launch went well. Revenue rose sharply. Everyone was relieved [1].',
    );
    expect(mostlyUncited.confidence).toBe('low');
  });

  it('treats prose with no substantive claims as high confidence (ratio 1)', () => {
    const result = analyzeCitationCoverage('Yes. In short: no.');
    expect(result.totalClaims).toBe(0);
    expect(result.coverageRatio).toBe(1);
    expect(result.confidence).toBe('high');
  });

  it('leaves identifier-adjacent brackets out of citation detection', () => {
    // `data[3]` is array indexing, not a citation → the clause is uncited.
    const result = analyzeCitationCoverage('The value lives in data[3] according to the config.', {
      strictUncited: true,
    });
    expect(result.citedClaims).toBe(0);
    expect(result.uncitedClaims).toBe(1);
  });
});
