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
  rsquo: '\u2019',
  lsquo: '\u2018',
  ldquo: '\u201C',
  rdquo: '\u201D',
  bull: '•',
  middot: '·',
  eacute: 'é',
  trade: '™',
  reg: '®',
  copy: '©',
};

export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

/**
 * Rejects control characters as well as out-of-range code points.
 *
 * A posting is third-party content that we later print to a terminal. Decoding
 * `&#27;` into a real ESC byte would let a posting emit ANSI sequences and
 * rewrite output the user has already seen — including the apply URL.
 */
function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return '';
  if (code >= 0x7f && code <= 0x9f) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\ufeff]/g;

/**
 * Removes control, bidirectional-override, and zero-width characters.
 *
 * Applied to every field that originates from a posting, because those fields
 * are printed to terminals, rendered in the portal, and sent to models.
 */
export function stripControlCharacters(input: string): string {
  return input.replace(CONTROL_CHARACTERS, '');
}

/**
 * One line, safe to print.
 *
 * Collapsing whitespace alone is not enough for text that reaches a terminal:
 * `\s` does not match ESC, so a posting containing `\x1b[1A` would move the
 * cursor up and overwrite the line above its own result.
 */
export function singleLine(input: string): string {
  return stripControlCharacters(input).replace(/\s+/g, ' ').trim();
}

const BLOCK_TAGS = 'p|div|section|article|header|footer|h[1-6]|ul|ol|table|tr|blockquote|pre';

/** Maximum stored description length. Bounds prompt size and storage growth. */
export const MAX_DESCRIPTION_LENGTH = 100_000;

function stripMarkupOnce(input: string): string {
  let text = input;

  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<\/?(script|style)\b[^>]*>/gi, '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<li\b[^>]*>/gi, '\n• ');
  text = text.replace(new RegExp(`</(${BLOCK_TAGS})>`, 'gi'), '\n\n');
  text = text.replace(new RegExp(`<(${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n');
  text = text.replace(/<[^>]{0,2000}>/g, '');

  return text;
}

/**
 * Minimal HTML-to-text conversion. Job descriptions arrive as HTML from every
 * ATS; we keep paragraph and list structure because the evaluator and the
 * full-text index both read this text.
 *
 * Stripping and decoding alternate until the text stops changing. Decoding
 * after a single strip pass would turn `&lt;img onerror=...&gt;` back into live
 * markup *after* the only sanitizing pass had run, storing attacker-controlled
 * HTML in a field that later reaches the portal, exports, and prompts.
 * Alternating also defeats double-escaped payloads.
 */
export function htmlToText(html: string): string {
  let text = html;

  for (let pass = 0; pass < 3; pass += 1) {
    const before = text;
    text = decodeHtmlEntities(stripMarkupOnce(text));
    if (text === before) break;
  }

  // Anything still angle-bracketed after the loop is inert leftovers, not markup.
  text = text.replace(/<[^>]{0,2000}>/g, '');

  return normalizeWhitespace(text);
}

/** Collapses runs of spaces/newlines without destroying paragraph breaks. */
export function normalizeWhitespace(input: string): string {
  return stripControlCharacters(input.replace(/\r\n?/g, '\n'))
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Single-line field cleanup for titles, locations, and company names. */
export function normalizeInlineText(input: string): string {
  return stripControlCharacters(input).replace(/\s+/g, ' ').trim();
}

/** Bounds a stored description; an unbounded body would bound nothing downstream. */
export function capDescription(input: string, max = MAX_DESCRIPTION_LENGTH): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}\n\n[truncated by roleeye at ${max} characters]`;
}

export function looksLikeHtml(input: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(input);
}

/**
 * Lowercase token stream used for fingerprints and matching.
 *
 * Internal punctuation is kept so "node.js" and "c++" survive, but leading and
 * trailing punctuation is trimmed: otherwise an edited trailing period would
 * change a job's content fingerprint.
 */
export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/^[.\-]+/, '').replace(/[.\-]+$/, ''))
    .filter((token) => token.length > 0);
}

export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1))}…`;
}
