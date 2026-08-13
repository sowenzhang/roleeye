import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CATALOG, CATEGORY_LABELS, catalogEntryToSource } from '../../src/portal/catalog.js';
import {
  compileSelection,
  inferSelection,
  ROLE_FAMILIES,
  SENIORITY_OPTIONS,
  type PresetSelection,
} from '../../src/portal/presets.js';
import { criteriaSchema, sourcesSchema } from '../../src/config/schema.js';
import { evaluateScope, resolveScope } from '../../src/discovery/scope.js';
import { scopeSchema } from '../../src/config/schema.js';

function selection(over: Partial<PresetSelection> = {}): PresetSelection {
  return {
    families: [],
    seniority: [],
    locations: [],
    metros: [],
    remoteOnly: false,
    postedWithinDays: undefined,
    salaryFloor: 0,
    refuseSystems: [],
    rejectRelocation: true,
    screeningEnabled: true,
    captureMode: 'scoped',
    extraTitles: [],
    extraExcludes: [],
    ...over,
  };
}

describe('company catalog', () => {
  it('has unique entries with a known category', () => {
    const keys = new Set<string>();

    for (const entry of CATALOG) {
      const key = `${entry.type}:${entry.token.toLowerCase()}`;
      assert.ok(!keys.has(key), `duplicate catalog entry: ${key}`);
      keys.add(key);

      assert.ok(entry.company.trim().length > 0);
      assert.ok(entry.token.trim().length > 0);
      assert.ok(CATEGORY_LABELS[entry.category], `unknown category on ${entry.company}`);
    }

    assert.ok(CATALOG.length >= 40, 'the catalog should be worth browsing');
  });

  it('covers every provider we can actually read', () => {
    const types = new Set(CATALOG.map((entry) => entry.type));
    assert.deepEqual([...types].sort(), ['ashby', 'greenhouse', 'lever']);
  });

  it('produces sources the loader accepts', () => {
    const parsed = sourcesSchema.safeParse({ sources: CATALOG.map(catalogEntryToSource) });

    assert.equal(parsed.success, true, 'every catalog entry must compile to a valid source');
    if (!parsed.success) return;

    const names = parsed.data.sources.map((source) => source.name);
    assert.equal(new Set(names).size, names.length, 'source names must stay unique');
  });

  it('puts the token in the field its provider expects', () => {
    const lever = CATALOG.find((entry) => entry.type === 'lever');
    const greenhouse = CATALOG.find((entry) => entry.type === 'greenhouse');
    assert.ok(lever && greenhouse);

    assert.ok('site' in catalogEntryToSource(lever));
    assert.ok('board' in catalogEntryToSource(greenhouse));
  });
});

describe('preset compilation', () => {
  it('turns role families into title matching', () => {
    const compiled = compileSelection(selection({ families: ['software', 'ai'] }));
    const titles = (compiled.scope['titles'] as { include: string[]; exclude: string[] }).include;

    assert.ok(titles.includes('software engineer'));
    assert.ok(titles.includes('ml engineer'));
  });

  it('carries family exclusions so lookalike roles are dropped', () => {
    const compiled = compileSelection(selection({ families: ['software'] }));
    const scope = resolveScope(scopeSchema.parse(compiled.scope));

    assert.equal(evaluateScope({ title: 'Staff Software Engineer' }, scope).inScope, true);
    assert.equal(
      evaluateScope({ title: 'Sales Engineer' }, scope).inScope,
      false,
      'a sales engineer is not a software engineer',
    );
  });

  it('expresses seniority as exclusions so unlabelled titles survive', () => {
    const compiled = compileSelection(selection({ families: ['software'], seniority: ['staff', 'principal'] }));
    const scope = resolveScope(scopeSchema.parse(compiled.scope));

    assert.equal(evaluateScope({ title: 'Staff Software Engineer' }, scope).inScope, true);
    assert.equal(evaluateScope({ title: 'Principal Engineer' }, scope).inScope, true);
    assert.equal(evaluateScope({ title: 'Junior Software Engineer' }, scope).inScope, false);
    assert.equal(
      evaluateScope({ title: 'Software Engineer' }, scope).inScope,
      true,
      'a title stating no level must not be silently dropped',
    );
  });

  it('keeps everything when nothing is picked', () => {
    const compiled = compileSelection(selection());
    const scope = resolveScope(scopeSchema.parse(compiled.scope));

    assert.equal(evaluateScope({ title: 'Anything At All' }, scope).inScope, true);
  });

  it('compiles to criteria the loader accepts', () => {
    const compiled = compileSelection(
      selection({
        families: ['software'],
        locations: ['us'],
        salaryFloor: 200_000,
        refuseSystems: ['workday'],
        postedWithinDays: 60,
      }),
    );

    const criteria = criteriaSchema.safeParse({
      hard_filters: compiled.hardFilters,
      preferences: compiled.preferences,
    });

    assert.equal(criteria.success, true);
    if (!criteria.success) return;

    assert.equal(criteria.data.hard_filters.minimum_base_salary?.amount, 200_000);
    assert.deepEqual(criteria.data.hard_filters.countries, ['US']);
    assert.deepEqual(criteria.data.preferences.application_system.deny, ['workday']);

    const sources = sourcesSchema.safeParse({ discovery: { capture_mode: 'scoped', scope: compiled.scope } });
    assert.equal(sources.success, true);
  });

  it('omits the salary filter at the Any step', () => {
    const compiled = compileSelection(selection({ salaryFloor: 0 }));
    assert.equal(compiled.hardFilters['minimum_base_salary'], undefined);
  });

  it('merges free-text extras with the picked families', () => {
    const compiled = compileSelection(
      selection({ families: ['software'], extraTitles: ['rewards'], extraExcludes: ['contract'] }),
    );
    const titles = compiled.scope['titles'] as { include: string[]; exclude: string[] };

    assert.ok(titles.include.includes('rewards'));
    assert.ok(titles.exclude.includes('contract'));
  });
});

describe('reading a saved selection back', () => {
  it('round-trips the picked options', () => {
    const original = selection({
      families: ['software', 'infra'],
      seniority: ['staff', 'principal'],
      locations: ['us'],
      metros: ['seattle'],
      salaryFloor: 200_000,
      refuseSystems: ['workday'],
      postedWithinDays: 60,
    });

    const compiled = compileSelection(original);
    const inferred = inferSelection(compiled.scope, {
      hard_filters: compiled.hardFilters,
      preferences: compiled.preferences,
    });

    assert.deepEqual(inferred.families?.sort(), ['infra', 'software']);
    assert.deepEqual(inferred.seniority?.sort(), ['principal', 'staff']);
    assert.deepEqual(inferred.locations, ['us']);
    assert.deepEqual(inferred.metros, ['seattle']);
    assert.equal(inferred.salaryFloor, 200_000);
    assert.deepEqual(inferred.refuseSystems, ['workday']);
    assert.equal(inferred.postedWithinDays, 60);
  });

  it('recovers custom terms as extras rather than losing them', () => {
    const compiled = compileSelection(selection({ families: ['software'], extraTitles: ['loyalty'] }));
    const inferred = inferSelection(compiled.scope, { hard_filters: compiled.hardFilters });

    assert.deepEqual(inferred.extraTitles, ['loyalty']);
  });

  it('reads a hand-written config without presets', () => {
    const inferred = inferSelection(
      { titles: { include: ['rewards platform'] }, locations: { countries: [] } },
      { hard_filters: {} },
    );

    assert.deepEqual(inferred.families, []);
    assert.deepEqual(inferred.extraTitles, ['rewards platform']);
  });
});

describe('preset taxonomy', () => {
  it('uses ids and levels the scope evaluator understands', () => {
    const ids = new Set<string>();

    for (const family of ROLE_FAMILIES) {
      assert.ok(!ids.has(family.id), `duplicate family id ${family.id}`);
      ids.add(family.id);
      assert.ok(family.titles.length > 0);
      assert.ok(family.label.length > 0);
    }

    for (const option of SENIORITY_OPTIONS) {
      assert.ok(option.levels.length > 0, `${option.id} must map to levels`);
    }
  });
});
