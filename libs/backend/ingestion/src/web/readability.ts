/**
 * Dependency-free readable-text extraction for web clips (plan §2 /
 * VISION §2 `sources/web`). Deliberately not a full readability engine: the
 * goal is a plain-text snapshot good enough as link-rot insurance and as
 * input for later extraction kinds, using only string processing so the
 * backend gains no HTML-parser dependency (house rule: plain `fetch`, no new
 * npm packages for outbound web access).
 */

/** Result of extracting readable content from an HTML document. */
export interface ReadableContent {
  title: string | null;
  text: string;
}

const BLOCK_TAGS =
  'p|div|section|article|main|header|footer|aside|nav|ul|ol|li|table|tr|th|td|blockquote|pre|form|figure|figcaption|h[1-6]|br|hr|dl|dt|dd';

/** Named entities worth decoding without a full entity table. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  deg: '°',
  sect: '§',
  middot: '·',
  bull: '•',
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  Auml: 'Ä',
  Ouml: 'Ö',
  Uuml: 'Ü',
  szlig: 'ß',
};

export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name] ?? match);
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Strip a tag *and its content* (scripts, styles, chrome regions, ...). */
function dropElement(html: string, tag: string): string {
  return html.replace(
    new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'),
    ' ',
  );
}

/** First match of `<tag ...>...</tag>`, or null. */
function firstElementContent(html: string, tag: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i').exec(html);
  return match ? match[1] : null;
}

export function extractTitle(html: string): string | null {
  const og = /<meta\b[^>]*property=["']og:title["'][^>]*>/i.exec(html)?.[0];
  if (og) {
    const content = /content=["']([^"']*)["']/i.exec(og)?.[1];
    if (content?.trim()) return collapseWhitespace(decodeHtmlEntities(content));
  }
  const title = firstElementContent(html, 'title');
  if (title?.trim()) return collapseWhitespace(decodeHtmlEntities(stripTags(title)));
  const h1 = firstElementContent(html, 'h1');
  if (h1?.trim()) return collapseWhitespace(decodeHtmlEntities(stripTags(h1)));
  return null;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Reduce an HTML document to readable plain text. Prefers the semantic main
 * region (`<article>`/`<main>`) when present, drops scripts/styles and page
 * chrome (`nav`/`header`/`footer`/`aside`), converts block boundaries to
 * newlines and decodes common entities.
 */
export function extractReadableText(html: string): string {
  let body = firstElementContent(html, 'body') ?? html;
  for (const tag of ['script', 'style', 'noscript', 'template', 'svg', 'iframe']) {
    body = dropElement(body, tag);
  }
  // Prefer the semantic main content once the noise is gone.
  const mainRegion =
    firstElementContent(body, 'article') ?? firstElementContent(body, 'main');
  let region = mainRegion ?? body;
  if (!mainRegion) {
    for (const tag of ['nav', 'header', 'footer', 'aside']) {
      region = dropElement(region, tag);
    }
  }
  const withBreaks = region
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Source whitespace (including intra-paragraph line wraps) is not
    // structure — only block-tag boundaries become line breaks.
    .replace(/\s+/g, ' ')
    .replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n');
  const text = decodeHtmlEntities(stripTags(withBreaks));
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

/** Full readable extraction: title + text. */
export function extractReadableContent(html: string): ReadableContent {
  return { title: extractTitle(html), text: extractReadableText(html) };
}
