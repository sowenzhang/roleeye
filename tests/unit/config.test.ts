import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { criteriaSchema, sourcesSchema } from '../../src/config/schema.js';
import { parseDotEnv } from '../../src/config/paths.js';
import { redactString, redactValue, REDACTED } from '../../src/util/logger.js';

describe('criteria schema', () => {
  it('applies documented defaults', () => {
    const result = criteriaSchema.safeParse({});
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.decision_thresholds.apply, 78);
    assert.equal(result.data.weights.career_direction, 20);
  });

  it('rejects weights that do not total 100', () => {
    const result = criteriaSchema.safeParse({ weights: { career_direction: 50 } });
    assert.equal(result.success, false);
  });

  it('rejects a maybe threshold above the apply threshold', () => {
    const result = criteriaSchema.safeParse({ decision_thresholds: { apply: 60, maybe: 80 } });
    assert.equal(result.success, false);
  });

  it('keeps user preferences as data', () => {
    const result = criteriaSchema.safeParse({
      preferences: { application_system: { deny: ['workday'] } },
    });
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.deepEqual(result.data.preferences.application_system.deny, ['workday']);
  });
});

/**
 * The shipped examples are what `roleeye init` copies, so a broken one is a
 * broken first run for every new user.
 *
 * This exists because the examples drifted: the CLI told users to "set
 * reasoning.provider in config/criteria.yaml" while `criteria.example.yaml`
 * had no reasoning block at all — nor screening, budget, or notify. The file
 * still validated, because every one of those sections has a default, which is
 * exactly why nothing caught it.
 */
describe('shipped example configuration', () => {
  const read = (name: string): unknown =>
    parseYaml(readFileSync(path.join(process.cwd(), 'config', name), 'utf8'));

  it('validates criteria.example.yaml', () => {
    const result = criteriaSchema.safeParse(read('criteria.example.yaml'));
    assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  });

  it('validates sources.example.yaml', () => {
    const result = sourcesSchema.safeParse(read('sources.example.yaml'));
    assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  });

  it('shows every section the schema accepts', () => {
    // A section absent from the example is a section the user has to discover
    // from an error message, which is where this drift started.
    const example = read('criteria.example.yaml') as Record<string, unknown>;
    const accepted = Object.keys(criteriaSchema.parse({}));

    const missing = accepted.filter((key) => !(key in example));
    assert.deepEqual(missing, [], `criteria.example.yaml does not document: ${missing.join(', ')}`);
  });
});

describe('sources schema', () => {  it('validates per-type required fields', () => {
    const ok = sourcesSchema.safeParse({
      sources: [{ name: 'acme', type: 'greenhouse', company: 'Acme', board: 'acme' }],
    });
    assert.equal(ok.success, true);

    const missingBoard = sourcesSchema.safeParse({
      sources: [{ name: 'acme', type: 'greenhouse', company: 'Acme' }],
    });
    assert.equal(missingBoard.success, false);
  });

  it('rejects duplicate source names', () => {
    const result = sourcesSchema.safeParse({
      sources: [
        { name: 'dup', type: 'greenhouse', company: 'A', board: 'a' },
        { name: 'dup', type: 'lever', company: 'B', site: 'b' },
      ],
    });
    assert.equal(result.success, false);
  });

  it('defaults politeness settings', () => {
    const result = sourcesSchema.safeParse({});
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.ok(result.data.defaults.request_delay_ms > 0);
    assert.equal(result.data.dedupe.repost_gap_days, 21);
  });
});

describe('parseDotEnv', () => {
  it('parses keys, quotes, comments, and export prefixes', () => {
    const parsed = parseDotEnv(['# comment', 'A=1', 'export B="two"', "C='three'", 'BAD', 'D=has=equals'].join('\n'));
    assert.deepEqual(parsed, { A: '1', B: 'two', C: 'three', D: 'has=equals' });
  });
});

describe('log redaction', () => {
  it('redacts token-shaped strings', () => {
    assert.equal(redactString('token ghp_abcdefghijklmnopqrstuvwxyz0123'), `token ${REDACTED}`);
    assert.equal(redactString('Authorization: Bearer abcdef1234567890'), `Authorization: ${REDACTED}`);
  });

  it('redacts sensitive keys in objects', () => {
    const result = redactValue({ user: 'me', apiKey: 'super-secret', nested: { password: 'p' } }) as Record<
      string,
      unknown
    >;
    assert.equal(result['user'], 'me');
    assert.equal(result['apiKey'], REDACTED);
    assert.deepEqual(result['nested'], { password: REDACTED });
  });
});
