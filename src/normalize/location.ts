import type { WorkArrangement } from '../core/types.js';

const US_STATES = new Set([
  'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia','ks','ky','la','me','md',
  'ma','mi','mn','ms','mo','mt','ne','nv','nh','nj','nm','ny','nc','nd','oh','ok','or','pa','ri','sc',
  'sd','tn','tx','ut','vt','va','wa','wv','wi','wy','dc',
]);

const US_STATE_NAMES = [
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida',
  'georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine',
  'maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska',
  'nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota','ohio',
  'oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota','tennessee','texas',
  'utah','vermont','virginia','washington','west virginia','wisconsin','wyoming',
];

const COUNTRY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(united states|usa|u\.s\.a\.|u\.s\.|\bus\b)\b/i, 'US'],
  [/\b(united kingdom|uk|england|scotland|wales|london)\b/i, 'GB'],
  [/\b(canada|ontario|toronto|vancouver|montreal)\b/i, 'CA'],
  [/\b(germany|berlin|munich|deutschland)\b/i, 'DE'],
  [/\b(india|bangalore|bengaluru|hyderabad|pune)\b/i, 'IN'],
  [/\b(ireland|dublin)\b/i, 'IE'],
  [/\b(australia|sydney|melbourne)\b/i, 'AU'],
  [/\b(netherlands|amsterdam)\b/i, 'NL'],
  [/\b(france|paris)\b/i, 'FR'],
  [/\b(poland|warsaw|krakow)\b/i, 'PL'],
  [/\b(singapore)\b/i, 'SG'],
  [/\b(japan|tokyo)\b/i, 'JP'],
  [/\b(brazil|s(a|ã)o paulo)\b/i, 'BR'],
  [/\b(mexico|guadalajara)\b/i, 'MX'],
  [/\b(israel|tel aviv)\b/i, 'IL'],
];

export interface NormalizedLocation {
  text: string | undefined;
  country: string | undefined;
  workArrangement: WorkArrangement;
}

export function normalizeLocation(raw: string | undefined, description?: string | undefined): NormalizedLocation {
  const text = raw?.replace(/\s+/g, ' ').trim();
  const haystack = `${text ?? ''}`;

  return {
    text: text && text.length > 0 ? text : undefined,
    country: detectCountry(haystack) ?? detectCountry(description?.slice(0, 2000) ?? ''),
    workArrangement: detectWorkArrangement(haystack, description),
  };
}

export function detectCountry(text: string): string | undefined {
  if (!text) return undefined;
  const lower = text.toLowerCase();

  for (const [pattern, code] of COUNTRY_PATTERNS) {
    if (pattern.test(lower)) return code;
  }

  if (US_STATE_NAMES.some((state) => lower.includes(state))) return 'US';

  // "Seattle, WA" style suffixes.
  const stateMatch = /,\s*([a-z]{2})\b/.exec(lower);
  if (stateMatch?.[1] && US_STATES.has(stateMatch[1])) return 'US';

  return undefined;
}

export function detectWorkArrangement(
  locationText: string,
  description?: string | undefined,
): WorkArrangement {
  const location = locationText.toLowerCase();

  if (/\bhybrid\b/.test(location)) return 'hybrid';
  if (/\bremote\b/.test(location)) return 'remote';
  if (/\b(on-?site|in-?office|in-?person)\b/.test(location)) return 'onsite';

  if (description) {
    const head = description.slice(0, 4000).toLowerCase();
    if (/\bhybrid\b/.test(head)) return 'hybrid';
    if (/\b(fully remote|remote-first|100% remote|work from home)\b/.test(head)) return 'remote';
    if (/\b(on-?site|in-?office)\b/.test(head)) return 'onsite';
  }

  return 'unknown';
}

export function requiresRelocation(description: string | undefined): boolean {
  if (!description) return false;
  return /\brelocat(e|ion)\s+(is\s+)?(required|expected)\b/i.test(description);
}
