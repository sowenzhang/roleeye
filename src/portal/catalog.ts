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

export interface CatalogEntry {
  company: string;
  type: Extract<SourceType, 'greenhouse' | 'lever' | 'ashby'>;
  token: string;
  category: CatalogCategory;
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

export const CATALOG: readonly CatalogEntry[] = [
  // AI
  { company: 'OpenAI', type: 'ashby', token: 'openai', category: 'ai' },
  { company: 'Anthropic', type: 'greenhouse', token: 'anthropic', category: 'ai' },
  { company: 'Cursor', type: 'ashby', token: 'cursor', category: 'ai' },
  { company: 'ElevenLabs', type: 'ashby', token: 'elevenlabs', category: 'ai' },
  { company: 'LangChain', type: 'ashby', token: 'langchain', category: 'ai' },

  // Developer tools
  { company: 'GitLab', type: 'greenhouse', token: 'gitlab', category: 'devtools' },
  { company: 'Replit', type: 'ashby', token: 'replit', category: 'devtools' },
  { company: 'Supabase', type: 'ashby', token: 'supabase', category: 'devtools' },
  { company: 'PostHog', type: 'ashby', token: 'posthog', category: 'devtools' },
  { company: 'Browserbase', type: 'ashby', token: 'browserbase', category: 'devtools' },
  { company: 'Warp', type: 'ashby', token: 'warp', category: 'devtools' },
  { company: 'Netlify', type: 'greenhouse', token: 'netlify', category: 'devtools' },

  // Infrastructure
  { company: 'Cloudflare', type: 'greenhouse', token: 'cloudflare', category: 'infra' },
  { company: 'Datadog', type: 'greenhouse', token: 'datadog', category: 'infra' },
  { company: 'Twilio', type: 'greenhouse', token: 'twilio', category: 'infra' },
  { company: 'Elastic', type: 'greenhouse', token: 'elastic', category: 'infra' },
  { company: 'Render', type: 'ashby', token: 'render', category: 'infra' },
  { company: 'Railway', type: 'ashby', token: 'railway', category: 'infra' },

  // Data
  { company: 'Databricks', type: 'greenhouse', token: 'databricks', category: 'data' },
  { company: 'MongoDB', type: 'greenhouse', token: 'mongodb', category: 'data' },
  { company: 'ClickHouse', type: 'ashby', token: 'clickhouse', category: 'data' },
  { company: 'Palantir', type: 'lever', token: 'palantir', category: 'data' },
  { company: 'Neon', type: 'ashby', token: 'neon', category: 'data' },

  // Fintech
  { company: 'Stripe', type: 'greenhouse', token: 'stripe', category: 'fintech' },
  { company: 'Ramp', type: 'ashby', token: 'Ramp', category: 'fintech' },
  { company: 'Brex', type: 'greenhouse', token: 'brex', category: 'fintech' },
  { company: 'Coinbase', type: 'greenhouse', token: 'coinbase', category: 'fintech' },
  { company: 'Robinhood', type: 'greenhouse', token: 'robinhood', category: 'fintech' },
  { company: 'Affirm', type: 'greenhouse', token: 'affirm', category: 'fintech' },
  { company: 'Chime', type: 'greenhouse', token: 'chime', category: 'fintech' },
  { company: 'Carta', type: 'greenhouse', token: 'carta', category: 'fintech' },
  { company: 'Tala', type: 'lever', token: 'tala', category: 'fintech' },

  // Security
  { company: 'Okta', type: 'greenhouse', token: 'okta', category: 'security' },

  // Consumer
  { company: 'Discord', type: 'greenhouse', token: 'discord', category: 'consumer' },
  { company: 'Reddit', type: 'greenhouse', token: 'reddit', category: 'consumer' },
  { company: 'Pinterest', type: 'greenhouse', token: 'pinterest', category: 'consumer' },
  { company: 'Spotify', type: 'lever', token: 'spotify', category: 'consumer' },
  { company: 'Lyft', type: 'greenhouse', token: 'lyft', category: 'consumer' },
  { company: 'Instacart', type: 'greenhouse', token: 'instacart', category: 'consumer' },
  { company: 'Duolingo', type: 'greenhouse', token: 'duolingo', category: 'consumer' },
  { company: 'Match Group', type: 'lever', token: 'matchgroup', category: 'consumer' },
  { company: 'Gopuff', type: 'lever', token: 'gopuff', category: 'consumer' },

  // Product and productivity
  { company: 'Figma', type: 'greenhouse', token: 'figma', category: 'product' },
  { company: 'Notion', type: 'ashby', token: 'Notion', category: 'product' },
  { company: 'Linear', type: 'ashby', token: 'linear', category: 'product' },
  { company: 'Airtable', type: 'greenhouse', token: 'airtable', category: 'product' },
  { company: 'Asana', type: 'greenhouse', token: 'asana', category: 'product' },
  { company: 'Dropbox', type: 'greenhouse', token: 'dropbox', category: 'product' },
  { company: 'Samsara', type: 'greenhouse', token: 'samsara', category: 'product' },

  // HR and payroll
  { company: 'Gusto', type: 'greenhouse', token: 'gusto', category: 'hr' },

  // Defense
  { company: 'Shield AI', type: 'lever', token: 'shieldai', category: 'defense' },
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
