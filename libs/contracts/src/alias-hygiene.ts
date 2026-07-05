/**
 * Alias hygiene: keep the "Also known as" list (an entity's `aliases`) free of
 * grammar the transcript happens to use rather than real names.
 *
 * The LLM extractor emits surface forms verbatim as `mentions`, and cheap models
 * routinely dump closed-class function words ("Sie", "ihr", "der") and generic
 * role nouns ("Patient", "der Arzt", "the doctor") as if they were aliases.
 * These accrete onto the registry row and surface as junk chips. This module is
 * the single, deterministic (model-agnostic) filter applied at every alias write
 * path, and by the one-shot migration that cleans rows already persisted.
 *
 * Pure and dependency-free so it can live in `@plaudern/contracts` and be shared
 * by the entities lib and the persistence migration without a dependency cycle.
 */

/** Normalization key for alias comparison: lowercased, whitespace-collapsed. */
export function normalizeAliasTerm(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Normalized terms that are never a personal alias. Two groups, German +
 * English: closed-class function words (pronouns, possessives, articles,
 * demonstratives) and generic role/relationship nouns (including the common
 * article-prefixed phrases the model emits). Extend as new junk shows up — a
 * whole-term match here drops the alias, so partial names ("Jan Jaap") are safe.
 */
export const NON_NAME_TERMS: ReadonlySet<string> = new Set<string>([
  // Personal pronouns (DE)
  'sie', 'er', 'es', 'ihn', 'ihm', 'ich', 'du', 'wir', 'mir', 'mich',
  'dir', 'dich', 'uns', 'euch', 'man',
  // Personal pronouns (EN)
  'i', 'he', 'she', 'they', 'it', 'me', 'you', 'we', 'us', 'him', 'her', 'them',
  // Possessives / articles / demonstratives (DE)
  'ihr', 'ihre', 'ihrer', 'ihrem', 'ihren', 'ihres', 'ihnen',
  'sein', 'seine', 'seiner', 'seinem', 'seinen', 'seines',
  'mein', 'meine', 'dein', 'deine', 'unser', 'unsere', 'euer', 'eure',
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer',
  'dieser', 'diese', 'dieses', 'diesem', 'diesen',
  // Possessives / articles / demonstratives (EN)
  'my', 'your', 'his', 'their', 'our', 'its',
  'the', 'a', 'an', 'this', 'that', 'these', 'those',
  // Generic role / relationship nouns (DE), incl. article-prefixed phrases
  'patient', 'der patient', 'patientin', 'die patientin',
  'arzt', 'der arzt', 'ärztin', 'die ärztin', 'doktor', 'der doktor',
  'herr', 'frau', 'mann', 'kunde', 'kundin', 'der kunde',
  'chef', 'chefin', 'kollege', 'kollegin', 'der kollege',
  'nachbar', 'nachbarin', 'der nachbar',
  'freund', 'freundin', 'der freund',
  // Generic role / relationship nouns (EN)
  'doctor', 'the doctor', 'the patient', 'customer', 'the customer',
  'boss', 'colleague', 'neighbor', 'neighbour', 'friend',
]);

/**
 * True when `term` is a plausible personal alias: non-empty, contains a letter
 * (not pure punctuation/digits), and is not a known non-name term.
 */
export function isMeaningfulAlias(term: string): boolean {
  const normalized = normalizeAliasTerm(term);
  if (!normalized) return false;
  if (!/\p{L}/u.test(normalized)) return false;
  return !NON_NAME_TERMS.has(normalized);
}

/**
 * Clean an entity's alias list: drop non-name terms, drop anything equal to the
 * canonical name (redundant with the header), and dedupe case-insensitively —
 * keeping the first-seen original casing and preserving order.
 */
export function sanitizeAliases(canonicalName: string, aliases: readonly string[]): string[] {
  const canonical = normalizeAliasTerm(canonicalName);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of aliases) {
    if (!isMeaningfulAlias(raw)) continue;
    const normalized = normalizeAliasTerm(raw);
    if (normalized === canonical) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(raw.trim());
  }
  return result;
}
