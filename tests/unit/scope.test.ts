import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateScope, isScopeEmpty, resolveScope, scopeFromConfig, emptyScope } from '../../src/discovery/scope.js';
import { scopeSchema, sourcesSchema } from '../../src/config/schema.js';

function scope(overrides: Parameters<typeof resolveScope>[0]) {
  return resolveScope(scopeSchema.parse(overrides));
}

describe('scope resolution', () => {
  it('produces an empty scope from empty configuration', () => {
    assert.deepEqual(resolveScope(scopeSchema.parse({})), emptyScope);
    assert.equal(isScopeEmpty(emptyScope), true);
  });

  it('lets a per-source override replace a whole group', () => {
    const global = scopeSchema.parse({
      titles: { include: ['engineer'], exclude: ['intern'] },
      locations: { countries: ['US'] },
    });
    const resolved = resolveScope(global, { titles: { include: ['designer'] } });

    assert.deepEqual(resolved.titles.include, ['designer']);
    assert.deepEqual(resolved.titles.exclude, [], 'the override replaces the group, not just one field');
    assert.deepEqual(resolved.locations.countries, ['US'], 'untouched groups are inherited');
  });

  it('folds the superseded discovery_filters block into the scope', () => {
    const sources = sourcesSchema.parse({
      discovery_filters: { title_include: ['engineer'], title_exclude: ['intern'] },
    });
    const resolved = scopeFromConfig(sources);

    assert.deepEqual(resolved.titles.include, ['engineer']);
    assert.deepEqual(resolved.titles.exclude, ['intern']);
  });

  it('does not let the legacy block override an explicit scope', () => {
    const sources = sourcesSchema.parse({
      discovery: { scope: { titles: { include: ['architect'] } } },
      discovery_filters: { title_include: ['engineer'], title_exclude: ['sales'] },
    });
    const resolved = scopeFromConfig(sources);

    assert.deepEqual(resolved.titles.include, ['architect']);
    assert.deepEqual(resolved.titles.exclude, ['sales'], 'exclusions still merge; they only ever remove');
  });
});

describe('scope evaluation', () => {
  const base = { title: 'Staff Software Engineer', country: 'US', locationText: 'Seattle, WA' };

  it('keeps everything when no scope is configured', () => {
    assert.equal(evaluateScope(base, emptyScope).inScope, true);
    assert.equal(evaluateScope({ title: 'Sales Director' }, emptyScope).inScope, true);
  });

  it('applies exclusions before inclusions', () => {
    const s = scope({ titles: { include: ['engineer'], exclude: ['intern'] } });

    assert.equal(evaluateScope({ title: 'Software Engineer Intern' }, s).inScope, false);
    assert.equal(evaluateScope({ title: 'Staff Software Engineer' }, s).inScope, true);
    assert.equal(evaluateScope({ title: 'Product Manager' }, s).inScope, false);
  });

  it('supports title patterns', () => {
    const s = scope({ titles: { patterns: ['(staff|principal).*engineer'] } });

    assert.equal(evaluateScope({ title: 'Principal Software Engineer' }, s).inScope, true);
    assert.equal(evaluateScope({ title: 'Senior Software Engineer' }, s).inScope, false);
  });

  it('ignores an invalid pattern instead of aborting the scan', () => {
    const s = scope({ titles: { patterns: ['([unclosed'] } });
    assert.equal(evaluateScope({ title: 'Anything' }, s).inScope, false);
  });

  it('filters on seniority level', () => {
    const s = scope({ levels: { include: ['staff', 'principal'], exclude: ['director'] } });

    assert.equal(evaluateScope({ title: 'Principal Engineer' }, s).inScope, true);
    assert.equal(evaluateScope({ title: 'Director of Engineering' }, s).inScope, false);
    assert.equal(evaluateScope({ title: 'Senior Engineer' }, s).inScope, false);
    assert.equal(evaluateScope({ title: 'Software Engineer' }, s).inScope, false, 'no level means no match');
  });

  it('filters on department and team', () => {
    const s = scope({ departments: { include: ['engineering'], exclude: ['recruiting'] } });

    assert.equal(evaluateScope({ title: 'X', department: 'Engineering', team: 'Platform' }, s).inScope, true);
    assert.equal(evaluateScope({ title: 'X', department: 'Recruiting' }, s).inScope, false);
    assert.equal(evaluateScope({ title: 'X', department: 'Finance' }, s).inScope, false);
    assert.equal(
      evaluateScope({ title: 'X' }, s).inScope,
      true,
      'a source that reports no department cannot be filtered on one',
    );
  });

  it('filters on country but never drops a remote role for location', () => {
    const s = scope({ locations: { countries: ['US'] } });

    assert.equal(evaluateScope({ title: 'X', country: 'US' }, s).inScope, true);
    assert.equal(evaluateScope({ title: 'X', country: 'DE' }, s).inScope, false);
    assert.equal(evaluateScope({ title: 'X', country: 'DE', workArrangement: 'remote' }, s).inScope, true);
    assert.equal(evaluateScope({ title: 'X' }, s).inScope, false, 'unknown country cannot satisfy a country filter');
  });

  it('supports remote_only and metro filters', () => {
    const remoteOnly = scope({ locations: { remote_only: true } });
    assert.equal(evaluateScope({ title: 'X', workArrangement: 'remote' }, remoteOnly).inScope, true);
    assert.equal(evaluateScope({ title: 'X', workArrangement: 'hybrid' }, remoteOnly).inScope, false);

    const metros = scope({ locations: { metros: ['seattle'] } });
    assert.equal(evaluateScope({ title: 'X', locationText: 'Seattle, WA' }, metros).inScope, true);
    assert.equal(evaluateScope({ title: 'X', locationText: 'Austin, TX' }, metros).inScope, false);
  });

  it('filters on posting age', () => {
    const s = scope({ posted_within_days: 30 });
    const now = '2026-08-13T00:00:00.000Z';

    assert.equal(evaluateScope({ title: 'X', postedAt: '2026-08-01T00:00:00.000Z' }, s, now).inScope, true);
    assert.equal(evaluateScope({ title: 'X', postedAt: '2026-05-01T00:00:00.000Z' }, s, now).inScope, false);
    assert.equal(evaluateScope({ title: 'X' }, s, now).inScope, true, 'unknown post date is not a reason to drop');
  });

  it('explains why a posting was dropped', () => {
    const s = scope({ titles: { exclude: ['intern'] } });
    const verdict = evaluateScope({ title: 'Engineering Intern' }, s);

    assert.equal(verdict.inScope, false);
    assert.match(verdict.reason ?? '', /excluded term/);
  });

  it('reports no reason for an in-scope posting', () => {
    assert.equal(evaluateScope(base, emptyScope).reason, undefined);
  });
});
