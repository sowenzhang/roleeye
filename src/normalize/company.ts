const LEGAL_SUFFIXES = [
  'incorporated',
  'inc',
  'llc',
  'l.l.c',
  'ltd',
  'limited',
  'corporation',
  'corp',
  'co',
  'company',
  'gmbh',
  'plc',
  'sa',
  'nv',
  'ag',
  'pbc',
];

/**
 * Canonical company key. Deliberately conservative: it strips legal suffixes and
 * punctuation but never guesses that two differently-spelled companies are the
 * same organization.
 */
export function normalizeCompanyName(name: string): string {
  let value = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      const pattern = new RegExp(`(^|\\s)${suffix.replace(/\./g, '\\.')}\\.?$`);
      if (pattern.test(value)) {
        value = value.replace(pattern, '').trim();
        changed = true;
      }
    }
  }

  value = value.replace(/\./g, '').replace(/\s+/g, ' ').trim();
  return value.length > 0 ? value : name.toLowerCase().trim();
}

export function companySlug(name: string): string {
  const slug = normalizeCompanyName(name).replace(/\s+/g, '-').replace(/-+/g, '-');
  return slug.length > 0 ? slug : 'unknown-company';
}
