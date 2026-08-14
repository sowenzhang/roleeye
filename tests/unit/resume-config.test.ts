import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { archetypesSchema, duplicateArchetypeIds } from '../../src/config/archetype-schema.js';

/**
 * The shipped example has to satisfy the schema the CLI enforces.
 *
 * `roleeye init` copies it, so an example that fails validation is a broken
 * first run for every new user — and it is exactly the file nobody re-reads
 * after editing the schema.
 */

describe('archetype configuration', () => {
  const example = parseYaml(
    readFileSync(path.join(process.cwd(), 'config', 'archetypes.example.yaml'), 'utf8'),
  ) as unknown;

  it('validates the shipped example', () => {
    const result = archetypesSchema.safeParse(example);
    assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  });

  it('defaults to no archetypes rather than failing', () => {
    const config = archetypesSchema.parse({});

    assert.deepEqual(config.archetypes, []);
    assert.equal(config.classification.min_score, 0.35);
    assert.equal(config.classification.model_tiebreak, false);
  });

  it('rejects an id that could not be a directory name', () => {
    for (const id of ['../escape', 'Has Spaces', 'UPPER', '']) {
      const result = archetypesSchema.safeParse({ archetypes: [{ id, label: 'Something' }] });
      assert.equal(result.success, false, `"${id}" must be rejected`);
    }
  });

  it('rejects an unknown key instead of ignoring it', () => {
    // The lesson from `min_base_salary`: a mistyped key that is silently
    // dropped leaves the user believing a setting is active when it is not.
    const result = archetypesSchema.safeParse({
      archetypes: [{ id: 'ai', label: 'AI', skils: ['pytorch'] }],
    });

    assert.equal(result.success, false);
  });

  it('lowercases matching terms so configuration is not case-sensitive', () => {
    const config = archetypesSchema.parse({
      archetypes: [{ id: 'ai', label: 'AI', titles: ['ML Engineer'], skills: ['PyTorch'] }],
    });

    assert.deepEqual(config.archetypes[0]?.titles, ['ml engineer']);
    assert.deepEqual(config.archetypes[0]?.skills, ['pytorch']);
  });

  it('refuses duplicate ids, which would make an artifact path ambiguous', () => {
    const result = archetypesSchema.safeParse({
      archetypes: [
        { id: 'ai', label: 'AI one' },
        { id: 'ai', label: 'AI two' },
      ],
    });

    assert.equal(result.success, false);
    assert.match(JSON.stringify(result.error?.issues), /duplicate archetype id/);
    assert.deepEqual(duplicateArchetypeIds({ archetypes: [{ id: 'ai' }, { id: 'ai' }] }), ['ai']);
  });
});
