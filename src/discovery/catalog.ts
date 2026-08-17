import type { SourceType } from '../core/types.js';

/**
 * A curated catalog of company boards.
 *
 * Every token here was verified against the live provider API and returned open
 * roles. Shipping a guessed token is worse than shipping none: the user adds a
 * company, the scan finds nothing, and they conclude the tool is broken.
 *
 * Re-verify with `npm run catalog:check` before adding entries.
 */

export type CatalogCategory =
  | 'ai'
  | 'devtools'
  | 'infra'
  | 'data'
  | 'fintech'
  | 'security'
  | 'consumer'
  | 'product'
  | 'health'
  | 'hr'
  | 'defense';

/**
 * Roughly how big the company is, and whether it is listed.
 *
 * Deliberately coarse, and deliberately *not* funding stage. "Series B" is the
 * thing people ask for and the worst thing to store: rounds are announced
 * constantly, so the label would be wrong within months and wrong silently.
 * Headcount band and public/private move slowly enough that a three-way bucket
 * stays true, and both are what the question underneath "what stage?" is
 * usually about — how much structure, and how much process.
 *
 * These are approximations. The UI says so.
 */
export type CompanySize = 'startup' | 'midsize' | 'large';
export type Ownership = 'private' | 'public';

export interface CatalogEntry {
  company: string;
  type: Extract<SourceType, 'greenhouse' | 'lever' | 'ashby'>;
  token: string;
  category: CatalogCategory;
  size: CompanySize;
  ownership: Ownership;
}

export const CATEGORY_LABELS: Record<CatalogCategory, string> = {
  ai: 'AI research and tooling',
  devtools: 'Developer tools',
  infra: 'Infrastructure',
  data: 'Data platforms',
  fintech: 'Fintech',
  security: 'Security',
  consumer: 'Consumer',
  product: 'Product and productivity',
  health: 'Health',
  hr: 'HR and payroll',
  defense: 'Defense',
};

export const SIZE_LABELS: Record<CompanySize, { label: string; detail: string }> = {
  startup: { label: 'Startup', detail: 'under ~500 people' },
  midsize: { label: 'Mid-size', detail: '~500 to 5,000' },
  large: { label: 'Large', detail: 'over ~5,000' },
};

export const OWNERSHIP_LABELS: Record<Ownership, { label: string; detail: string }> = {
  private: { label: 'Private', detail: 'equity is illiquid' },
  public: { label: 'Public', detail: 'listed, RSUs are liquid' },
};

export const CATALOG: readonly CatalogEntry[] = [
  // AI
  { company: 'OpenAI', type: 'ashby', token: 'openai', category: 'ai', size: 'midsize', ownership: 'private' },
  { company: 'Anthropic', type: 'greenhouse', token: 'anthropic', category: 'ai', size: 'midsize', ownership: 'private' },
  { company: 'Cursor', type: 'ashby', token: 'cursor', category: 'ai', size: 'startup', ownership: 'private' },
  { company: 'ElevenLabs', type: 'ashby', token: 'elevenlabs', category: 'ai', size: 'startup', ownership: 'private' },
  { company: 'LangChain', type: 'ashby', token: 'langchain', category: 'ai', size: 'startup', ownership: 'private' },

  // Developer tools
  { company: 'GitLab', type: 'greenhouse', token: 'gitlab', category: 'devtools', size: 'midsize', ownership: 'public' },
  { company: 'Replit', type: 'ashby', token: 'replit', category: 'devtools', size: 'startup', ownership: 'private' },
  { company: 'Supabase', type: 'ashby', token: 'supabase', category: 'devtools', size: 'startup', ownership: 'private' },
  { company: 'PostHog', type: 'ashby', token: 'posthog', category: 'devtools', size: 'startup', ownership: 'private' },
  { company: 'Browserbase', type: 'ashby', token: 'browserbase', category: 'devtools', size: 'startup', ownership: 'private' },
  { company: 'Warp', type: 'ashby', token: 'warp', category: 'devtools', size: 'startup', ownership: 'private' },
  { company: 'Netlify', type: 'greenhouse', token: 'netlify', category: 'devtools', size: 'startup', ownership: 'private' },

  // Infrastructure
  { company: 'Cloudflare', type: 'greenhouse', token: 'cloudflare', category: 'infra', size: 'midsize', ownership: 'public' },
  { company: 'Datadog', type: 'greenhouse', token: 'datadog', category: 'infra', size: 'large', ownership: 'public' },
  { company: 'Twilio', type: 'greenhouse', token: 'twilio', category: 'infra', size: 'large', ownership: 'public' },
  { company: 'Elastic', type: 'greenhouse', token: 'elastic', category: 'infra', size: 'midsize', ownership: 'public' },
  { company: 'Render', type: 'ashby', token: 'render', category: 'infra', size: 'startup', ownership: 'private' },
  { company: 'Railway', type: 'ashby', token: 'railway', category: 'infra', size: 'startup', ownership: 'private' },

  // Data
  { company: 'Databricks', type: 'greenhouse', token: 'databricks', category: 'data', size: 'large', ownership: 'private' },
  { company: 'MongoDB', type: 'greenhouse', token: 'mongodb', category: 'data', size: 'large', ownership: 'public' },
  { company: 'ClickHouse', type: 'ashby', token: 'clickhouse', category: 'data', size: 'startup', ownership: 'private' },
  { company: 'Palantir', type: 'lever', token: 'palantir', category: 'data', size: 'midsize', ownership: 'public' },
  { company: 'Neon', type: 'ashby', token: 'neon', category: 'data', size: 'startup', ownership: 'private' },

  // Fintech
  { company: 'Stripe', type: 'greenhouse', token: 'stripe', category: 'fintech', size: 'large', ownership: 'private' },
  { company: 'Ramp', type: 'ashby', token: 'Ramp', category: 'fintech', size: 'midsize', ownership: 'private' },
  { company: 'Brex', type: 'greenhouse', token: 'brex', category: 'fintech', size: 'midsize', ownership: 'private' },
  { company: 'Coinbase', type: 'greenhouse', token: 'coinbase', category: 'fintech', size: 'midsize', ownership: 'public' },
  { company: 'Robinhood', type: 'greenhouse', token: 'robinhood', category: 'fintech', size: 'midsize', ownership: 'public' },
  { company: 'Affirm', type: 'greenhouse', token: 'affirm', category: 'fintech', size: 'midsize', ownership: 'public' },
  { company: 'Chime', type: 'greenhouse', token: 'chime', category: 'fintech', size: 'midsize', ownership: 'public' },
  { company: 'Carta', type: 'greenhouse', token: 'carta', category: 'fintech', size: 'midsize', ownership: 'private' },
  { company: 'Tala', type: 'lever', token: 'tala', category: 'fintech', size: 'midsize', ownership: 'private' },

  // Security
  { company: 'Okta', type: 'greenhouse', token: 'okta', category: 'security', size: 'large', ownership: 'public' },

  // Consumer
  { company: 'Discord', type: 'greenhouse', token: 'discord', category: 'consumer', size: 'midsize', ownership: 'private' },
  { company: 'Reddit', type: 'greenhouse', token: 'reddit', category: 'consumer', size: 'midsize', ownership: 'public' },
  { company: 'Pinterest', type: 'greenhouse', token: 'pinterest', category: 'consumer', size: 'midsize', ownership: 'public' },
  { company: 'Spotify', type: 'lever', token: 'spotify', category: 'consumer', size: 'large', ownership: 'public' },
  { company: 'Lyft', type: 'greenhouse', token: 'lyft', category: 'consumer', size: 'midsize', ownership: 'public' },
  { company: 'Instacart', type: 'greenhouse', token: 'instacart', category: 'consumer', size: 'midsize', ownership: 'public' },
  { company: 'Duolingo', type: 'greenhouse', token: 'duolingo', category: 'consumer', size: 'midsize', ownership: 'public' },
  { company: 'Match Group', type: 'lever', token: 'matchgroup', category: 'consumer', size: 'midsize', ownership: 'public' },
  { company: 'Gopuff', type: 'lever', token: 'gopuff', category: 'consumer', size: 'midsize', ownership: 'private' },

  // Product and productivity
  { company: 'Figma', type: 'greenhouse', token: 'figma', category: 'product', size: 'midsize', ownership: 'public' },
  { company: 'Notion', type: 'ashby', token: 'Notion', category: 'product', size: 'midsize', ownership: 'private' },
  { company: 'Linear', type: 'ashby', token: 'linear', category: 'product', size: 'startup', ownership: 'private' },
  { company: 'Airtable', type: 'greenhouse', token: 'airtable', category: 'product', size: 'midsize', ownership: 'private' },
  { company: 'Asana', type: 'greenhouse', token: 'asana', category: 'product', size: 'midsize', ownership: 'public' },
  { company: 'Dropbox', type: 'greenhouse', token: 'dropbox', category: 'product', size: 'midsize', ownership: 'public' },
  { company: 'Samsara', type: 'greenhouse', token: 'samsara', category: 'product', size: 'midsize', ownership: 'public' },

  // HR and payroll
  { company: 'Gusto', type: 'greenhouse', token: 'gusto', category: 'hr', size: 'midsize', ownership: 'private' },

  // Defense
  { company: 'Shield AI', type: 'lever', token: 'shieldai', category: 'defense', size: 'midsize', ownership: 'private' },
];

export function catalogEntryToSource(entry: CatalogEntry): Record<string, unknown> {
  return {
    name: `${entry.company}-${entry.type}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
    type: entry.type,
    enabled: true,
    company: entry.company,
    ...(entry.type === 'lever' ? { site: entry.token } : { board: entry.token }),
  };
}

/** How an entry is named in `include` and `exclude`, and in the portal. */
export function catalogKey(entry: { type: string; token: string }): string {
  return `${entry.type}:${entry.token}`.toLowerCase();
}

export interface CompanyRule {
  size: readonly string[];
  ownership: readonly string[];
  sectors: readonly string[];
  include: readonly string[];
  exclude: readonly string[];
}

/**
 * The catalog entries a rule selects.
 *
 * Facets within a row are OR and rows are AND, which is what ticking two boxes
 * in one group and one in another means to everybody. An empty row means "any",
 * not "none" — otherwise a fresh rule would match nothing and the tool would
 * look broken before it was ever configured.
 *
 * A rule with no facets at all matches nothing rather than everything. Watching
 * fifty boards because someone has not chosen yet is not a helpful default; it
 * is a very slow first scan they did not ask for.
 */
export function selectCatalog(rule: CompanyRule, catalog: readonly CatalogEntry[] = CATALOG): CatalogEntry[] {
  const excluded = new Set(rule.exclude.map((key) => key.toLowerCase()));
  const included = new Set(rule.include.map((key) => key.toLowerCase()));
  const hasFacets = rule.size.length > 0 || rule.ownership.length > 0 || rule.sectors.length > 0;

  return catalog.filter((entry) => {
    const key = catalogKey(entry);
    // Exclusion is absolute: it is the user overruling their own rule, and
    // silently re-adding a company they removed would be the worst outcome.
    if (excluded.has(key)) return false;
    if (included.has(key)) return true;
    if (!hasFacets) return false;

    if (rule.size.length > 0 && !rule.size.includes(entry.size)) return false;
    if (rule.ownership.length > 0 && !rule.ownership.includes(entry.ownership)) return false;
    if (rule.sectors.length > 0 && !rule.sectors.includes(entry.category)) return false;

    return true;
  });
}
