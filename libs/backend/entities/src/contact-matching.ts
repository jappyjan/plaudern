/**
 * Pure evidence-scoring for entity↔contact identity resolution. No I/O — the
 * resolver service gathers the evidence (mentions, speakers, graph edges) and
 * this module turns it into ranked, *explained* candidates. The LLM provider
 * gets the same evidence as text, so heuristics and model always reason over
 * identical facts.
 *
 * Static name equality breaks on real data ("Detti" vs "Detlef Müller",
 * "Mueller" vs "Müller", two Annas). The signals here are the classic
 * entity-resolution ones instead:
 *  - name affinity: fuzzy, diacritic/transliteration-folded token matching;
 *  - co-presence: the contact's voice occurs in recordings that mention the
 *    entity — people are usually mentioned in conversations they're part of;
 *  - shared graph neighbors: both relate to the same third entities
 *    ("works at ACME", "married to Maria") — strong identity evidence;
 *  - co-mention penalty: the entity and the contact's own entity are mentioned
 *    in the same recording — one conversation rarely names the same person two
 *    ways, so they're likely *different* people.
 */

/** Normalization key: lowercased, whitespace-collapsed. Alias/case matching. */
export function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** All evidence gathered for one (entity, contact) pair. */
export interface ContactEvidence {
  voiceProfileId: string;
  /** Contact's display name; null profiles can't be matched by name. */
  contactName: string | null;
  /** Recordings mentioning the entity in which this contact speaks. */
  coPresenceCount: number;
  /** Distinct graph neighbors shared between the entity and the contact's linked entities. */
  sharedNeighborCount: number;
  /** Human-readable names of (up to a few) shared neighbors, for explanations. */
  sharedNeighborNames: string[];
  /** Recordings mentioning BOTH the entity and one of the contact's linked entities. */
  coMentionCount: number;
}

/** A scored candidate with the reasons that produced the score. */
export interface ScoredCandidate {
  voiceProfileId: string;
  contactName: string | null;
  confidence: number;
  reasons: string[];
}

/** Auto-link when the top candidate reaches this heuristic confidence… */
export const AUTO_LINK_CONFIDENCE = 0.6;
/** …and leads the runner-up by at least this margin. */
export const AUTO_LINK_MARGIN = 0.15;
/** Candidates below this score are not worth surfacing (or sending to the LLM). */
export const SUGGESTION_FLOOR = 0.3;
/** Accept an LLM match at or above this confidence. */
export const LLM_ACCEPT_CONFIDENCE = 0.7;

/**
 * Matching key variants for a name: normalized, diacritics stripped, and
 * German transliteration folded (ü→ue …), so "Müller", "Mueller" and "Muller"
 * all meet somewhere.
 */
export function nameKeys(name: string): string[] {
  const base = normalize(name);
  const stripped = base.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const transliterated = base
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');
  return [...new Set([base, stripped, transliterated])];
}

/** Damerau-lite edit distance with an early exit beyond `max`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      rowMin = Math.min(rowMin, curr[j]);
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/** Whether two name tokens are the same word modulo spelling/typos. */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  // Short tokens must match exactly — "jan" vs "jana" are different people.
  if (a.length < 4 || b.length < 4) return false;
  const budget = a.length >= 7 && b.length >= 7 ? 2 : 1;
  return editDistance(a, b, budget) <= budget;
}

/**
 * Name affinity in [0, 1] between an entity's name forms (canonical + aliases)
 * and a contact's name. 1.0 = same full name (modulo folding), 0.75 = one name
 * is a token-subset of the other ("Detlef" ⊂ "Detlef Müller"), otherwise a
 * scaled token overlap. Purely lexical — nicknames that share no substance
 * ("Detti" vs "Detlef Müller") score 0 here and are the LLM's job.
 */
export function nameAffinity(entityNames: string[], contactName: string): number {
  const contactKeys = nameKeys(contactName);
  const contactTokens = contactKeys.map((k) => k.split(' '));
  let best = 0;
  for (const entityName of entityNames) {
    for (const key of nameKeys(entityName)) {
      if (contactKeys.includes(key)) return 1;
      const tokens = key.split(' ');
      for (const other of contactTokens) {
        const [shorter, longer] = tokens.length <= other.length ? [tokens, other] : [other, tokens];
        const matched = shorter.filter((t) => longer.some((o) => tokensMatch(t, o))).length;
        if (matched === 0) continue;
        let score: number;
        if (matched === shorter.length) {
          // Full fuzzy equality (all tokens matched both ways) beats subset.
          score = shorter.length === longer.length ? 0.95 : 0.75;
        } else {
          score = 0.6 * (matched / longer.length);
        }
        best = Math.max(best, score);
      }
    }
  }
  return best;
}

/**
 * Best lexical affinity in [0, 1] between two entities' full name sets
 * (canonical + aliases each). Symmetric-ish: the max `nameAffinity` over every
 * name on the B side. Used to surface likely-duplicate entities (e.g. "Foo
 * GmbH" vs "Foo") regardless of type.
 */
export function bestNameAffinity(namesA: string[], namesB: string[]): number {
  let best = 0;
  for (const b of namesB) best = Math.max(best, nameAffinity(namesA, b));
  return best;
}

/** Below this affinity a fuzzy entity pairing is noise, not a duplicate hint. */
export const FUZZY_DUPLICATE_FLOOR = 0.6;

/** Saturating count → [0, 1): 1 observation ≈ 0.67, 3 ≈ 0.86, 9 ≈ 0.95. */
function saturate(count: number): number {
  return count <= 0 ? 0 : count / (count + 0.5);
}

/**
 * Combine one pair's evidence into a confidence + explanation. Name affinity
 * carries half the weight; the graph and the recordings supply the context
 * that names alone can't ("which Detlef?").
 */
export function scoreCandidate(
  entityNames: string[],
  evidence: ContactEvidence,
): ScoredCandidate {
  const reasons: string[] = [];
  const affinity = evidence.contactName ? nameAffinity(entityNames, evidence.contactName) : 0;
  if (affinity >= 1) reasons.push('name matches exactly');
  else if (affinity >= 0.75) reasons.push('name closely matches');
  else if (affinity > 0) reasons.push('name partially matches');

  const coPresence = 0.35 * saturate(evidence.coPresenceCount);
  if (evidence.coPresenceCount > 0) {
    reasons.push(
      `speaks in ${evidence.coPresenceCount} recording${evidence.coPresenceCount === 1 ? '' : 's'} mentioning this person`,
    );
  }

  const graph = 0.3 * saturate(evidence.sharedNeighborCount);
  if (evidence.sharedNeighborCount > 0) {
    const names = evidence.sharedNeighborNames.slice(0, 3).join(', ');
    reasons.push(
      `shares ${evidence.sharedNeighborCount} graph connection${evidence.sharedNeighborCount === 1 ? '' : 's'}${names ? ` (${names})` : ''}`,
    );
  }

  // Being mentioned alongside the contact's own entity in one recording is
  // evidence of being someone ELSE — a conversation rarely names one person
  // two different ways.
  const penalty = 0.4 * saturate(evidence.coMentionCount);
  if (evidence.coMentionCount > 0) {
    reasons.push(
      `mentioned together with this contact in ${evidence.coMentionCount} recording${evidence.coMentionCount === 1 ? '' : 's'} (suggests different people)`,
    );
  }

  const confidence = Math.max(0, Math.min(1, 0.5 * affinity + coPresence + graph - penalty));
  return {
    voiceProfileId: evidence.voiceProfileId,
    contactName: evidence.contactName,
    confidence,
    reasons,
  };
}

/**
 * Score all candidates for one entity, best first, dropping noise below the
 * suggestion floor.
 */
export function rankCandidates(
  entityNames: string[],
  evidence: ContactEvidence[],
): ScoredCandidate[] {
  return evidence
    .map((e) => scoreCandidate(entityNames, e))
    .filter((c) => c.confidence >= SUGGESTION_FLOOR)
    .sort((a, b) => b.confidence - a.confidence);
}

/**
 * Whether the heuristic ranking alone is decisive enough to auto-link its top
 * candidate (used when no LLM provider is configured, and as the fast path
 * before consulting one).
 */
export function heuristicallyDecisive(ranked: ScoredCandidate[]): boolean {
  if (ranked.length === 0) return false;
  if (ranked[0].confidence < AUTO_LINK_CONFIDENCE) return false;
  return ranked.length === 1 || ranked[0].confidence - ranked[1].confidence >= AUTO_LINK_MARGIN;
}

/** Exact (folded) full-name equality — the only match cheap enough for ingest. */
export function exactContactMatch(
  entityNames: string[],
  contacts: { id: string; name: string | null }[],
): string | null {
  const keys = new Set(entityNames.flatMap((n) => nameKeys(n)));
  // First writer wins so linking is stable when two profiles share a name.
  for (const contact of contacts) {
    if (!contact.name) continue;
    if (nameKeys(contact.name).some((k) => keys.has(k))) return contact.id;
  }
  return null;
}
