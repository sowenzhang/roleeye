import type { ScopeConfig, ScopeOverride, SourcesConfig } from '../config/schema.js';
import { extractLevel } from '../normalize/title.js';
import { daysBetween, type IsoTimestamp } from '../util/time.js';

/**
 * Deterministic scope filtering.
 *
 * This is the largest lever in the system: it decides how much of a board
 * becomes noise the user must read and how much becomes model spend. It runs
 * before hard filters and long before any model call, and it is pure so it can
 * be previewed with `roleeye scope test`.
 */

export interface EffectiveScope {
  departments: { include: string[]; exclude: string[] };
  titles: { include: string[]; exclude: string[]; patterns: string[] };
  levels: { include: string[]; exclude: string[] };
  locations: { countries: string[]; metros: string[]; remoteOnly: boolean; exclude: string[] };
  postedWithinDays: number | undefined;
  maxNewPerSourcePerScan: number | undefined;
}

export const emptyScope: EffectiveScope = {
  departments: { include: [], exclude: [] },
  titles: { include: [], exclude: [], patterns: [] },
  levels: { include: [], exclude: [] },
  locations: { countries: [], metros: [], remoteOnly: false, exclude: [] },
  postedWithinDays: undefined,
  maxNewPerSourcePerScan: undefined,
};

/**
 * Merges the global scope with a per-source override.
 *
 * A group present in the override replaces that group entirely. Partial merging
 * within a group would make configuration hard to reason about: a user setting
 * source-specific titles expects exactly those titles.
 */
export function resolveScope(global: ScopeConfig, override?: ScopeOverride | undefined): EffectiveScope {
  const source = override ?? {};

  const departments = source.departments ?? global.departments;
  const titles = source.titles ?? global.titles;
  const levels = source.levels ?? global.levels;
  const locations = source.locations ?? global.locations;

  return {
    departments: {
      include: departments?.include ?? [],
      exclude: departments?.exclude ?? [],
    },
    titles: {
      include: titles?.include ?? [],
      exclude: titles?.exclude ?? [],
      patterns: titles?.patterns ?? [],
    },
    levels: {
      include: levels?.include ?? [],
      exclude: levels?.exclude ?? [],
    },
    locations: {
      countries: locations?.countries ?? [],
      metros: locations?.metros ?? [],
      remoteOnly: locations?.remote_only ?? false,
      exclude: locations?.exclude ?? [],
    },
    postedWithinDays: source.posted_within_days ?? global.posted_within_days,
    maxNewPerSourcePerScan: source.max_new_per_source_per_scan ?? global.max_new_per_source_per_scan,
  };
}

/** Folds the superseded `discovery_filters` block into the scope. */
export function scopeFromConfig(sources: SourcesConfig, override?: ScopeOverride | undefined): EffectiveScope {
  const scope = resolveScope(sources.discovery.scope, override);
  const legacy = sources.discovery_filters;

  if (legacy.title_include.length > 0 && scope.titles.include.length === 0) {
    scope.titles.include = [...legacy.title_include];
  }
  if (legacy.title_exclude.length > 0) {
    scope.titles.exclude = [...new Set([...scope.titles.exclude, ...legacy.title_exclude])];
  }

  return scope;
}

export interface ScopeCandidate {
  title: string;
  level?: string | undefined;
  department?: string | undefined;
  team?: string | undefined;
  locationText?: string | undefined;
  country?: string | undefined;
  workArrangement?: string | undefined;
  postedAt?: IsoTimestamp | undefined;
}

export interface ScopeVerdict {
  inScope: boolean;
  /** Human-readable explanation. `scope test` shows these verbatim. */
  reason: string | undefined;
}

const IN_SCOPE: ScopeVerdict = { inScope: true, reason: undefined };

function drop(reason: string): ScopeVerdict {
  return { inScope: false, reason };
}

function lower(value: string | undefined): string {
  return (value ?? '').toLowerCase();
}

function matchesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle.toLowerCase()));
}

/** Compiled once per evaluation batch; an invalid pattern must not abort a scan. */
function matchesPattern(haystack: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, 'i').test(haystack);
    } catch {
      return false;
    }
  });
}

/**
 * Decides whether a posting is in scope.
 *
 * Exclusions are evaluated before inclusions so a user can broadly include a
 * family of titles and still carve out the parts they never want.
 */
export function evaluateScope(candidate: ScopeCandidate, scope: EffectiveScope, now?: IsoTimestamp): ScopeVerdict {
  const title = lower(candidate.title);
  const department = `${lower(candidate.department)} ${lower(candidate.team)}`.trim();
  const location = lower(candidate.locationText);
  const level = candidate.level ?? extractLevel(candidate.title);

  if (scope.titles.exclude.length > 0 && matchesAny(title, scope.titles.exclude)) {
    return drop('title matched an excluded term');
  }

  if (scope.departments.exclude.length > 0 && department.length > 0 && matchesAny(department, scope.departments.exclude)) {
    return drop('department matched an excluded term');
  }

  if (scope.levels.exclude.length > 0 && level && scope.levels.exclude.includes(level)) {
    return drop(`level "${level}" is excluded`);
  }

  if (scope.locations.exclude.length > 0 && location.length > 0 && matchesAny(location, scope.locations.exclude)) {
    return drop('location matched an excluded term');
  }

  const wantsTitle = scope.titles.include.length > 0 || scope.titles.patterns.length > 0;
  if (wantsTitle) {
    const included = matchesAny(title, scope.titles.include) || matchesPattern(title, scope.titles.patterns);
    if (!included) return drop('title did not match any included term or pattern');
  }

  if (scope.departments.include.length > 0) {
    // A source that does not report a department cannot be filtered on one.
    if (department.length > 0 && !matchesAny(department, scope.departments.include)) {
      return drop('department did not match any included term');
    }
  }

  if (scope.levels.include.length > 0) {
    if (!level) return drop('no seniority level could be determined');
    if (!scope.levels.include.includes(level)) return drop(`level "${level}" is not in the included levels`);
  }

  const remote = candidate.workArrangement === 'remote';
  if (scope.locations.remoteOnly && !remote) {
    return drop('role is not remote');
  }

  if (scope.locations.countries.length > 0 && !remote) {
    const country = candidate.country;
    if (!country) return drop('no country could be determined');
    if (!scope.locations.countries.map((entry) => entry.toUpperCase()).includes(country.toUpperCase())) {
      return drop(`country "${country}" is not in the included countries`);
    }
  }

  if (scope.locations.metros.length > 0 && !remote) {
    if (location.length === 0) return drop('no location was reported');
    if (!matchesAny(location, scope.locations.metros)) return drop('location is not in an included metro');
  }

  if (scope.postedWithinDays !== undefined && candidate.postedAt) {
    const age = daysBetween(candidate.postedAt, now ?? new Date().toISOString());
    if (age > scope.postedWithinDays) {
      return drop(`posted ${Math.round(age)} days ago (limit ${scope.postedWithinDays})`);
    }
  }

  return IN_SCOPE;
}

export function isScopeEmpty(scope: EffectiveScope): boolean {
  return (
    scope.departments.include.length === 0 &&
    scope.departments.exclude.length === 0 &&
    scope.titles.include.length === 0 &&
    scope.titles.exclude.length === 0 &&
    scope.titles.patterns.length === 0 &&
    scope.levels.include.length === 0 &&
    scope.levels.exclude.length === 0 &&
    scope.locations.countries.length === 0 &&
    scope.locations.metros.length === 0 &&
    scope.locations.exclude.length === 0 &&
    !scope.locations.remoteOnly &&
    scope.postedWithinDays === undefined
  );
}
