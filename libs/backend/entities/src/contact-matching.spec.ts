import {
  editDistance,
  exactContactMatch,
  heuristicallyDecisive,
  nameAffinity,
  nameKeys,
  normalize,
  rankCandidates,
  scoreCandidate,
  type ContactEvidence,
} from './contact-matching';

function evidence(overrides: Partial<ContactEvidence>): ContactEvidence {
  return {
    voiceProfileId: 'contact-1',
    contactName: 'Detlef Müller',
    coPresenceCount: 0,
    sharedNeighborCount: 0,
    sharedNeighborNames: [],
    coMentionCount: 0,
    ...overrides,
  };
}

describe('normalize', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalize('  Angela   Merkel ')).toBe('angela merkel');
    expect(normalize('ACME')).toBe('acme');
  });
});

describe('nameKeys', () => {
  it('folds diacritics and German transliteration', () => {
    expect(nameKeys('Müller')).toEqual(expect.arrayContaining(['müller', 'muller', 'mueller']));
    expect(nameKeys('Groß')).toEqual(expect.arrayContaining(['groß', 'gross']));
  });
});

describe('editDistance', () => {
  it('computes small distances and exits early past the budget', () => {
    expect(editDistance('mueller', 'müller'.normalize('NFC'), 2)).toBeLessThanOrEqual(2);
    expect(editDistance('anna', 'anna')).toBe(0);
    expect(editDistance('anna', 'annette', 2)).toBeGreaterThan(2);
  });
});

describe('nameAffinity', () => {
  it('is 1 for exact names modulo case, diacritics and transliteration', () => {
    expect(nameAffinity(['Detlef Mueller'], 'Detlef Müller')).toBe(1);
    expect(nameAffinity(['angela merkel'], 'Angela Merkel')).toBe(1);
  });

  it('scores a token subset ("Detlef" ⊂ "Detlef Müller")', () => {
    expect(nameAffinity(['Detlef'], 'Detlef Müller')).toBeCloseTo(0.75);
    expect(nameAffinity(['Detlef Müller'], 'Detlef')).toBeCloseTo(0.75);
  });

  it('matches misspelled tokens fuzzily but never short ones', () => {
    expect(nameAffinity(['Detlef Muler'], 'Detlef Müller')).toBeGreaterThanOrEqual(0.75);
    // "Jan" vs "Jana" must NOT match — short tokens are different people.
    expect(nameAffinity(['Jan'], 'Jana')).toBe(0);
  });

  it('uses aliases and picks the best form', () => {
    expect(nameAffinity(['Detti', 'Detlef Müller'], 'Detlef Müller')).toBe(1);
  });

  it('is 0 for unrelated names', () => {
    expect(nameAffinity(['Zoe Roth'], 'Detlef Müller')).toBe(0);
  });
});

describe('scoreCandidate', () => {
  it('combines name, co-presence and graph evidence with reasons', () => {
    const scored = scoreCandidate(
      ['Detlef'],
      evidence({ coPresenceCount: 2, sharedNeighborCount: 1, sharedNeighborNames: ['ACME'] }),
    );
    expect(scored.confidence).toBeGreaterThan(0.7);
    expect(scored.reasons).toEqual(
      expect.arrayContaining([
        'name closely matches',
        expect.stringContaining('speaks in 2 recordings'),
        expect.stringContaining('ACME'),
      ]),
    );
  });

  it('penalizes co-mentions — people named together are usually different', () => {
    const clean = scoreCandidate(['Detlef'], evidence({}));
    const coMentioned = scoreCandidate(['Detlef'], evidence({ coMentionCount: 2 }));
    expect(coMentioned.confidence).toBeLessThan(clean.confidence);
    expect(coMentioned.reasons.join(' ')).toContain('different people');
  });

  it('gives unnamed contacts no name affinity', () => {
    const scored = scoreCandidate(['Detlef'], evidence({ contactName: null }));
    expect(scored.confidence).toBe(0);
  });
});

describe('rankCandidates / heuristicallyDecisive', () => {
  it('ranks best-first and drops noise below the floor', () => {
    const ranked = rankCandidates(
      ['Detlef'],
      [
        evidence({ voiceProfileId: 'strong', coPresenceCount: 3 }),
        evidence({ voiceProfileId: 'weak', contactName: 'Zoe Roth' }),
      ],
    );
    expect(ranked.map((c) => c.voiceProfileId)).toEqual(['strong']);
  });

  it('is decisive only with a confident, clearly-leading top candidate', () => {
    const strong = scoreCandidate(
      ['Detlef'],
      evidence({ coPresenceCount: 3, sharedNeighborCount: 1 }),
    );
    const alsoStrong = scoreCandidate(
      ['Detlef'],
      evidence({
        voiceProfileId: 'contact-2',
        contactName: 'Detlef Schmidt',
        coPresenceCount: 3,
        sharedNeighborCount: 1,
      }),
    );
    expect(heuristicallyDecisive([strong])).toBe(true);
    // Two near-equal Detlefs: not decisive — that ambiguity is the LLM's call.
    expect(heuristicallyDecisive([strong, alsoStrong])).toBe(false);
    expect(heuristicallyDecisive([])).toBe(false);
  });
});

describe('exactContactMatch', () => {
  const contacts = [
    { id: 'mueller', name: 'Detlef Müller' },
    { id: 'nameless', name: null },
  ];

  it('matches exact names modulo folding, via canonical or alias', () => {
    expect(exactContactMatch(['Detlef Mueller'], contacts)).toBe('mueller');
    expect(exactContactMatch(['Detti', 'detlef müller'], contacts)).toBe('mueller');
  });

  it('never matches partial or unrelated names', () => {
    expect(exactContactMatch(['Detlef'], contacts)).toBeNull();
    expect(exactContactMatch(['Zoe'], contacts)).toBeNull();
  });
});
