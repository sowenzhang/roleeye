/** Seniority signals, ordered most specific first so "senior staff" wins over "senior". */
const LEVEL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(chief technology officer|cto)\b/i, 'executive'],
  [/\b(vp|vice president)\b/i, 'vp'],
  [/\bsenior director\b/i, 'senior-director'],
  [/\bdirector\b/i, 'director'],
  [/\bsenior (engineering )?manager\b/i, 'senior-manager'],
  [/\b(engineering manager|people manager)\b/i, 'manager'],
  [/\bdistinguished\b/i, 'distinguished'],
  [/\bfellow\b/i, 'fellow'],
  [/\bprincipal\b/i, 'principal'],
  [/\bsenior staff\b/i, 'senior-staff'],
  [/\bstaff\b/i, 'staff'],
  [/\b(lead|tech lead|technical lead)\b/i, 'lead'],
  [/\b(sr\.?|senior)\b/i, 'senior'],
  [/\b(jr\.?|junior|associate|entry[- ]level)\b/i, 'junior'],
  [/\bintern(ship)?\b/i, 'intern'],
  [/\b(iv|4)\b/i, 'iv'],
  [/\biii\b/i, 'iii'],
  [/\bii\b/i, 'ii'],
];

/** Decorations that vary between postings of the same role. */
const NOISE_PATTERNS: readonly RegExp[] = [
  /\(remote[^)]*\)/gi,
  /\(hybrid[^)]*\)/gi,
  /\(on-?site[^)]*\)/gi,
  /\(contract[^)]*\)/gi,
  /\(us[^)]*\)/gi,
  /\b(remote|hybrid|on-?site)\b/gi,
  /\bm\/f\/d\b/gi,
  /\ball genders?\b/gi,
];

export function normalizeTitle(title: string): string {
  let value = title.toLowerCase().replace(/[–—]/g, '-');

  for (const pattern of NOISE_PATTERNS) {
    value = value.replace(pattern, ' ');
  }

  return value
    .replace(/[^a-z0-9+#/\s-]/g, ' ')
    .replace(/\s*-\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractLevel(title: string): string | undefined {
  for (const [pattern, level] of LEVEL_PATTERNS) {
    if (pattern.test(title)) return level;
  }
  return undefined;
}

const MANAGEMENT_LEVELS = new Set(['executive', 'vp', 'senior-director', 'director', 'senior-manager', 'manager']);

export function isManagementTitle(title: string): boolean {
  const level = extractLevel(title);
  return level !== undefined && MANAGEMENT_LEVELS.has(level);
}
