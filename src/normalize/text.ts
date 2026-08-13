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

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

const BLOCK_TAGS = 'p|div|section|article|header|footer|h[1-6]|ul|ol|table|tr|blockquote|pre';

/**
 * Minimal HTML-to-text conversion. Job descriptions arrive as HTML from every
 * ATS; we keep paragraph and list structure because the evaluator and the
 * full-text index both read this text.
 */
export function htmlToText(html: string): string {
  let text = html;

  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<li\b[^>]*>/gi, '\n• ');
  text = text.replace(new RegExp(`</(${BLOCK_TAGS})>`, 'gi'), '\n\n');
  text = text.replace(new RegExp(`<(${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeHtmlEntities(text);

  return normalizeWhitespace(text);
}

/** Collapses runs of spaces/newlines without destroying paragraph breaks. */
export function normalizeWhitespace(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
