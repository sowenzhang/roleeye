import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { loadConfig, resolveSources } from '../../src/config/load.js';
import { sourcesSchema } from '../../src/config/schema.js';
import { catalogKey, selectCatalog, type CatalogEntry } from '../../src/discovery/catalog.js';

/**
 * Watching a *kind* of company rather than a list of them.
 *
 * The list was a snapshot of the catalog on the day someone pressed save: a
 * company added later matched everything they had asked for and was never
 * watched. Resolving a rule at load is what makes "companies like this" mean
 * what it says.
 */

const ENTRIES: CatalogEntry[] = [
  { company: 'Alpha', type: 'greenhouse', token: 'alpha', category: 'ai', size: 'startup', ownership: 'private' },
  { company: 'Beta', type: 'ashby', token: 'beta', category: 'ai', size: 'large', ownership: 'public' },
  { company: 'Gamma', type: 'lever', token: 'gamma', category: 'fintech', size: 'startup', ownership: 'private' },
  { company: 'Delta', type: 'greenhouse', token: 'delta', category: 'fintech', size: 'large', ownership: 'private' },
];

const rule = (over: Partial<Parameters<typeof selectCatalog>[0]> = {}) => ({
  size: [],
  ownership: [],
  sectors: [],
  include: [],
  exclude: [],
  ...over,
});

const names = (entries: CatalogEntry[]) => entries.map((entry) => entry.company).sort();

describe('company rule', () => {
  it('watches nothing until something is chosen', () => {
    // Watching fifty boards because the user has not decided yet is not a
    // helpful default; it is a very slow first scan nobody asked for.
    assert.deepEqual(selectCatalog(rule(), ENTRIES), []);
  });

  it('treats facets in one row as OR and across rows as AND', () => {
    assert.deepEqual(names(selectCatalog(rule({ size: ['startup'] }), ENTRIES)), ['Alpha', 'Gamma']);
    assert.deepEqual(names(selectCatalog(rule({ size: ['startup', 'large'] }), ENTRIES)), [
      'Alpha', 'Beta', 'Delta', 'Gamma',
    ]);
    assert.deepEqual(
      names(selectCatalog(rule({ size: ['startup'], sectors: ['fintech'] }), ENTRIES)),
      ['Gamma'],
      'a startup AND a fintech, not either',
    );
  });

  it('lets an explicit choice overrule the rule in both directions', () => {
    const withExtra = selectCatalog(rule({ size: ['startup'], include: ['ashby:beta'] }), ENTRIES);
    assert.deepEqual(names(withExtra), ['Alpha', 'Beta', 'Gamma']);

    const without = selectCatalog(rule({ size: ['startup'], exclude: ['greenhouse:alpha'] }), ENTRIES);
    assert.deepEqual(names(without), ['Gamma']);
  });

  it('never re-adds a company the user removed', () => {
    // Exclusion is the user overruling themselves. Silently restoring a company
    // they took out would be the worst outcome of a rule-based system.
    const both = selectCatalog(
      rule({ size: ['startup'], include: ['greenhouse:alpha'], exclude: ['greenhouse:alpha'] }),
      ENTRIES,
    );

    assert.deepEqual(names(both), ['Gamma'], 'exclude wins over include');
  });

  it('names entries the same way the config file does', () => {
    assert.equal(catalogKey({ type: 'greenhouse', token: 'Alpha' }), 'greenhouse:alpha');
  });
});

describe('resolving sources from a rule', () => {
  const workspaces: string[] = [];

  after(() => {
    for (const dir of workspaces) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may still hold a handle.
      }
    }
  });

  function workspace(sourcesYaml: string): string {
    const root = mkdtempSync(path.join(tmpdir(), 'roleeye-rule-'));
    mkdirSync(path.join(root, 'config'), { recursive: true });
    writeFileSync(path.join(root, 'config', 'sources.yaml'), sourcesYaml);
    writeFileSync(path.join(root, 'config', 'criteria.yaml'), 'version: 1\n');
    workspaces.push(root);
    return root;
  }

  it('turns a rule into the boards a scan will read', () => {
    const root = workspace(`version: 1
sources: []
discovery:
  companies:
    size: [large]
    sectors: [security]
`);

    const config = loadConfig({ root });
    const companies = config.sources.sources.map((source) => source.company);

    assert.ok(companies.length > 0, 'a rule with no names still produces sources');
    assert.ok(companies.includes('Okta'), 'the large security company is watched');
    assert.ok(!companies.includes('Linear'), 'a small product company is not');
    assert.ok(
      config.sources.sources.every((source) => source.enabled),
      'every resolved board is live',
    );
  });

  it('keeps boards written down by name alongside the rule', () => {
    const root = workspace(`version: 1
sources:
  - name: acme
    type: greenhouse
    company: Acme
    board: acme
discovery:
  companies:
    size: [large]
    sectors: [security]
`);

    const companies = loadConfig({ root }).sources.sources.map((source) => source.company);

    assert.ok(companies.includes('Acme'), 'a board added by URL survives');
    assert.ok(companies.includes('Okta'), 'and the rule still applies');
  });

  it('does not watch the same board twice when a name and the rule agree', () => {
    const declared = sourcesSchema.parse({
      version: 1,
      sources: [{ name: 'okta', type: 'greenhouse', company: 'Okta', board: 'okta', enabled: true }],
      discovery: { companies: { size: ['large'], sectors: ['security'] } },
    });

    const resolved = resolveSources(declared);
    const okta = resolved.filter((source) => source.company.toLowerCase() === 'okta');

    assert.equal(okta.length, 1, 'a named board wins, because it may carry overrides the catalog cannot know');
  });

  it('honours an exclusion even against a board written down by name', () => {
    const declared = sourcesSchema.parse({
      version: 1,
      sources: [{ name: 'okta', type: 'greenhouse', company: 'Okta', board: 'okta', enabled: true }],
      discovery: { companies: { size: ['large'], exclude: ['greenhouse:okta'] } },
    });

    assert.equal(
      resolveSources(declared).some((source) => source.company === 'Okta'),
      false,
      'removing a company removes it however it got there',
    );
  });

  it('leaves an unconfigured install watching nothing', () => {
    const root = workspace('version: 1\nsources: []\n');
    assert.deepEqual(loadConfig({ root }).sources.sources, []);
  });
});
