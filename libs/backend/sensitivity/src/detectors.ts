import {
  CATEGORY_TIER,
  maxTier,
  type SensitivityCategory,
  type SensitivityDetection,
  type SensitivitySpan,
  type SensitivityTier,
} from '@plaudern/contracts';

/**
 * Deterministic sensitivity detectors (JJ-21) — pure, dependency-free, and
 * keyless: they ALWAYS run (no LLM required). Each detector scans text and
 * emits `[start, end)` spans tagged with a category; the categories fold into
 * a tier via CATEGORY_TIER. The optional LLM classifier layers on top for
 * nuanced cases (health details, other people's secrets) the regexes can't
 * catch.
 *
 * Precision over recall: every detector validates its match (IBAN mod-97, card
 * Luhn) so ordinary numbers in a transcript don't get masked. Detectors never
 * throw — a bad match is simply dropped.
 */
export interface DeterministicResult {
  tier: SensitivityTier;
  spans: SensitivitySpan[];
  detections: SensitivityDetection[];
}

/** Run every deterministic detector and fold the results into one classification. */
export function detectDeterministic(text: string): DeterministicResult {
  const spans: SensitivitySpan[] = [
    ...detectCreditCards(text),
    ...detectIbans(text),
    ...detectCredentials(text),
    ...detectNationalIds(text),
  ];
  return foldSpans(spans);
}

/** Fold a raw span list into a deduped, ordered classification (tier + counts). */
export function foldSpans(spans: SensitivitySpan[]): DeterministicResult {
  const deduped = dedupeSpans(spans);
  let tier: SensitivityTier = 'normal';
  const counts = new Map<SensitivityCategory, number>();
  for (const span of deduped) {
    tier = maxTier(tier, CATEGORY_TIER[span.category]);
    counts.set(span.category, (counts.get(span.category) ?? 0) + 1);
  }
  const detections: SensitivityDetection[] = [...counts.entries()].map(([category, count]) => ({
    category,
    count,
  }));
  return { tier, spans: deduped, detections };
}

/**
 * Credit/debit card numbers: 13–19 digit runs (optionally space/dash grouped)
 * that pass the Luhn checksum. Matched with digit-group boundaries so a longer
 * number isn't clipped.
 */
export function detectCreditCards(text: string): SensitivitySpan[] {
  const re = /\b(?:\d[ -]?){12,18}\d\b/g;
  const spans: SensitivitySpan[] = [];
  for (const match of text.matchAll(re)) {
    const raw = match[0];
    const digits = raw.replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    if (!luhnValid(digits)) continue;
    const start = match.index ?? 0;
    spans.push({ start, end: start + raw.length, category: 'credit_card' });
  }
  return spans;
}

/**
 * IBANs: country code + 2 check digits + up to 30 alphanumerics, validated with
 * the ISO 13616 mod-97 checksum (== 1). The checksum makes false positives on
 * arbitrary uppercase tokens vanishingly rare.
 */
export function detectIbans(text: string): SensitivitySpan[] {
  const re = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{1,4}){2,8}\b/g;
  const spans: SensitivitySpan[] = [];
  for (const match of text.matchAll(re)) {
    const raw = match[0];
    const compact = raw.replace(/\s/g, '');
    if (compact.length < 15 || compact.length > 34) continue;
    if (!ibanValid(compact)) continue;
    const start = match.index ?? 0;
    spans.push({ start, end: start + raw.length, category: 'iban' });
  }
  return spans;
}

/**
 * Credentials: an explicit secret keyword followed by its value
 * (`password: hunter2`, `api_key = sk-...`), inline bearer tokens, PEM private
 * key blocks, and AWS access-key ids. The value (not just the keyword) is the
 * masked span.
 */
export function detectCredentials(text: string): SensitivitySpan[] {
  const spans: SensitivitySpan[] = [];

  // keyword: value  /  keyword = value  (value is the sensitive part)
  const kv =
    /\b(?:passwords?|passwd|pwd|api[_\s-]?keys?|secret|token|passphrase|credentials?)\b\s*(?:is|are|:|=)\s*(\S{3,})/gi;
  for (const match of text.matchAll(kv)) {
    const value = match[1];
    // Precision guard (JJ-86): the kv-regex fires on casual speech too
    // ("the password is fridge" → the whole item was held as `secret`). A bare
    // natural-language word after a credential keyword is far more likely chatter
    // than an actual secret, so drop it — while a real secret (mixed classes,
    // symbols, long, or high-entropy) still holds. Erring safe: only the
    // clearly-casual shape is dropped; anything ambiguous keeps masking.
    if (isCasualCredentialValue(value)) continue;
    const valueStart = (match.index ?? 0) + match[0].lastIndexOf(value);
    spans.push({ start: valueStart, end: valueStart + value.length, category: 'credential' });
  }

  // Bearer <token>
  const bearer = /\bBearer\s+([A-Za-z0-9._~+/-]{10,})=*/g;
  for (const match of text.matchAll(bearer)) {
    const start = match.index ?? 0;
    spans.push({ start, end: start + match[0].length, category: 'credential' });
  }

  // PEM private key block
  const pem = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
  for (const match of text.matchAll(pem)) {
    const start = match.index ?? 0;
    spans.push({ start, end: start + match[0].length, category: 'credential' });
  }

  // AWS access key id
  const aws = /\bAKIA[0-9A-Z]{16}\b/g;
  for (const match of text.matchAll(aws)) {
    const start = match.index ?? 0;
    spans.push({ start, end: start + match[0].length, category: 'credential' });
  }

  return spans;
}

/**
 * A small, bounded set of very common casual words that frequently appear right
 * after a credential keyword in ordinary speech ("the secret is safe", "my
 * password is fine"). Membership is a fast, unambiguous "this is chatter" signal;
 * the word-shape heuristic below catches the long tail (e.g. "fridge").
 */
const CASUAL_CREDENTIAL_STOP_WORDS = new Set([
  'safe',
  'fine',
  'okay',
  'good',
  'ready',
  'done',
  'gone',
  'mine',
  'yours',
  'ours',
  'theirs',
  'here',
  'there',
  'simple',
  'secret',
  'strong',
  'weak',
  'important',
  'wrong',
  'right',
  'correct',
  'changed',
  'updated',
  'saved',
  'the',
  'that',
  'this',
  'out',
  'set',
  'still',
]);

/**
 * Whether a credential-keyword VALUE looks like casual natural-language chatter
 * rather than an actual secret (JJ-86 precision guard). Returns true ONLY for a
 * value we are confident is a bare word; every real-secret shape and every
 * ambiguous case returns false (keep masking — err safe).
 *
 * A genuine secret almost always mixes character classes (letters + digits),
 * carries a symbol, mixes case, or is long/high-entropy. So we treat a value as
 * casual only when it is a single short word of ONE letter case with a natural,
 * pronounceable shape — a low-entropy word-shape check: it has a vowel and no
 * long consonant run (random tokens like "qwvbk" fail this and stay masked).
 */
export function isCasualCredentialValue(value: string): boolean {
  // Strip surrounding quotes and trailing sentence punctuation ("fridge." ").
  const v = value.replace(/^["'`]+/, '').replace(/["'`.,;:!?)]+$/, '');
  // Must be a bare, single-case alphabetic word of modest length. Anything with
  // a digit, symbol, mixed case, or length ≥ 12 is secret-shaped → keep masking.
  const lower = /^[a-z]{3,11}$/.test(v);
  const upper = /^[A-Z]{3,11}$/.test(v);
  if (!lower && !upper) return false;
  const word = v.toLowerCase();
  if (CASUAL_CREDENTIAL_STOP_WORDS.has(word)) return true;
  // Word-shape / low-entropy check: real words have a vowel and no long
  // consonant cluster; opaque tokens (e.g. "hunter" has none, but "xk7"/"qwvbk"
  // do) stay masked. Uppercase-only tokens read as acronyms/keys, not chatter,
  // so we only relax the pure-lowercase natural-word case here.
  if (!lower) return false;
  if (!/[aeiou]/.test(word)) return false; // no vowel → token-like, keep masking
  if (/[^aeiou]{4,}/.test(word)) return false; // 4+ consonant run → token-like
  return true;
}

/** National IDs: US SSN (nnn-nn-nnnn). Kept narrow to avoid false positives. */
export function detectNationalIds(text: string): SensitivitySpan[] {
  const re = /\b\d{3}-\d{2}-\d{4}\b/g;
  const spans: SensitivitySpan[] = [];
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0;
    spans.push({ start, end: start + match[0].length, category: 'national_id' });
  }
  return spans;
}

// ---- checksums -------------------------------------------------------------

/** Luhn (mod-10) checksum used by payment cards. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** ISO 13616 IBAN mod-97 checksum (valid iff the remainder is 1). */
export function ibanValid(iban: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;
  // Move the first four chars to the end, then map letters A→10 … Z→35.
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch >= 'A' && ch <= 'Z' ? (ch.charCodeAt(0) - 55).toString() : ch;
    for (const digit of code) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder === 1;
}

// ---- span hygiene ----------------------------------------------------------

/**
 * Drop exact duplicates and spans fully contained inside another, keeping the
 * higher-tier category on overlap so masking stays conservative.
 */
export function dedupeSpans(spans: SensitivitySpan[]): SensitivitySpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: SensitivitySpan[] = [];
  for (const span of sorted) {
    if (span.end <= span.start) continue;
    const overlap = kept.find((k) => span.start < k.end && k.start < span.end);
    if (!overlap) {
      kept.push(span);
      continue;
    }
    // On overlap, widen the kept span and upgrade its category if the new one
    // is more sensitive.
    overlap.start = Math.min(overlap.start, span.start);
    overlap.end = Math.max(overlap.end, span.end);
    if (CATEGORY_TIER[span.category] !== CATEGORY_TIER[overlap.category]) {
      overlap.category = maxTier(CATEGORY_TIER[span.category], CATEGORY_TIER[overlap.category]) ===
        CATEGORY_TIER[span.category]
        ? span.category
        : overlap.category;
    }
  }
  return kept.sort((a, b) => a.start - b.start);
}
