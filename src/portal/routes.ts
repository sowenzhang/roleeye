import { resolveSources, type AppConfig } from '../config/load.js';
import type { Repositories } from '../db/repositories/index.js';
import { sourcesSchema, type SourceConfig } from '../config/schema.js';
import { evaluateScope, scopeFromConfig } from '../discovery/scope.js';
import { boardUrl } from '../discovery/greenhouse.js';
import { postingsUrl } from '../discovery/lever.js';
import { jobBoardUrl } from '../discovery/ashby.js';
import { createHttpClient } from '../discovery/http.js';
import { parseBoardEntry } from '../cli/setup.js';
import {
  CATALOG,
  CATEGORY_LABELS,
  catalogEntryToSource,
  catalogKey,
  OWNERSHIP_LABELS,
  selectCatalog,
  SIZE_LABELS,
} from '../discovery/catalog.js';
import { estimateCost, MODEL_OPTIONS, type ModelOption } from './models.js';
import {
  APPLICATION_SYSTEMS,
  compileSelection,
  inferSelection,
  LOCATION_OPTIONS,
  METRO_OPTIONS,
  ROLE_FAMILIES,
  SALARY_STEPS,
  SENIORITY_OPTIONS,
} from './presets.js';
import type { Logger } from '../util/logger.js';
import type { ConfigService } from './config-service.js';
import type { RouteHandler, RouteResult } from './server.js';

/**
 * Portal routes.
 *
 * Every one of these delegates to the same modules the CLI uses. The web layer
 * holds no rules of its own, so the portal and the terminal can never disagree
 * about what your configuration means.
 */

export interface RouteDependencies {
  config: ConfigService;
  logger: Logger;
  loadConfig: () => AppConfig;
  openDb: () => { repos: Repositories };
}

function ok(json: unknown): RouteResult {
  return { status: 200, json };
}

function badRequest(json: unknown): RouteResult {
  return { status: 400, json };
}

const EMPTY_RULE = { size: [], ownership: [], sectors: [], include: [], exclude: [] } as const;

/**
 * Merges one level into each scope group instead of replacing it.
 *
 * The page owns titles, levels and locations. It has never heard of
 * `departments`, `teams`, `titles.patterns` or `locations.exclude`, and a
 * wholesale replacement quietly deleted every one of them the first time
 * somebody pressed Save after hand-editing the file.
 */
function mergeScope(existing: unknown, compiled: Record<string, unknown>): Record<string, unknown> {
  const current = (existing ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...current };

  for (const [group, value] of Object.entries(compiled)) {
    const previous = current[group];
    merged[group] =
      isPlainObject(previous) && isPlainObject(value) ? { ...previous, ...value } : value;
  }

  return merged;
}

/** Same rule, for the preference groups the setup page actually asks about. */
function mergePreferences(existing: unknown, compiled: Record<string, unknown>): Record<string, unknown> {
  return mergeScope(existing, compiled);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sourceKey(source: SourceConfig): string {
  const token = 'board' in source ? source.board : 'site' in source ? source.site : source.url;
  return `${source.type}:${token}`.toLowerCase();
}

/**
 * Whether this entry is exactly what the catalog would have produced.
 *
 * The rule can only express "watch this board with its defaults". A source the
 * user disabled, renamed, relabelled, or scoped carries information a rule
 * cannot hold, so converting it would silently re-enable it or lose its name —
 * and a source name is what `--only` selects and what run history is filed
 * under.
 */
function isCanonicalCatalogSource(source: SourceConfig): boolean {
  const entry = CATALOG.find((candidate) => catalogKey(candidate) === sourceKey(source));
  if (!entry) return false;

  const canonical = catalogEntryToSource(entry) as Record<string, unknown>;
  const actual = source as unknown as Record<string, unknown>;

  // Compared field by field so a key added to either shape later cannot make
  // this quietly start or stop matching.
  return (
    actual['name'] === canonical['name'] &&
    actual['company'] === canonical['company'] &&
    actual['enabled'] === true &&
    actual['scope'] === undefined &&
    actual['capture_mode'] === undefined
  );
}

/** Bounded, de-duplicated strings: these become selectors, not free text. */
function stringList(value: unknown, max = 200): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const clean = entry.trim().slice(0, 120);
    if (clean.length > 0) seen.add(clean);
    if (seen.size >= max) break;
  }

  return [...seen];
}

/**
 * Refuses to merge into a file that does not currently load.
 *
 * An unreadable file is shown in the portal as defaults so the page still
 * opens. Merging a partial edit into those defaults and saving would replace
 * every setting the user had written by hand with a default value, silently and
 * irreversibly. Editing one panel must never be able to do that.
 */
function blockedByInvalidConfig(deps: RouteDependencies): RouteResult | undefined {
  const criteria = deps.config.readCriteria();
  const sources = deps.config.readSources();
  const broken = [
    ...(criteria.valid ? [] : [{ file: 'criteria.yaml', path: criteria.path, problems: criteria.problems }]),
    ...(sources.valid ? [] : [{ file: 'sources.yaml', path: sources.path, problems: sources.problems }]),
  ];

  if (broken.length === 0) return undefined;

  return badRequest({
    saved: false,
    reason:
      `${broken.map((entry) => entry.file).join(' and ')} cannot be read, so saving would overwrite ` +
      'settings that are not shown here. Fix or delete the file first.',
    invalid: broken,
    problems: broken.flatMap((entry) => entry.problems),
  });
}

/**
 * Confirms a board exists before it is saved.
 *
 * Asking someone to know their target company's Greenhouse token is asking them
 * to learn our implementation details. Paste a careers URL instead and let the
 * adapter say whether it works and how many roles are there.
 */
async function checkBoard(entry: string, deps: RouteDependencies): Promise<RouteResult> {
  const parsed = parseBoardEntry(entry);
  if (!parsed) {
    return badRequest({
      ok: false,
      reason:
        'That does not look like a Greenhouse, Lever, or Ashby board. Paste the careers URL, for example https://boards.greenhouse.io/airtable.',
    });
  }

  const appConfig = deps.loadConfig();
  const http = createHttpClient({
    userAgent: appConfig.sources.defaults.user_agent,
    timeoutMs: 15_000,
    delayMs: 0,
    logger: deps.logger,
  });

  const url =
    parsed.type === 'greenhouse'
      ? boardUrl(parsed.token)
      : parsed.type === 'lever'
        ? postingsUrl(parsed.token)
        : jobBoardUrl(parsed.token);

  try {
    const payload = await http.getJson<unknown>(url);
    const count = Array.isArray(payload)
      ? payload.length
      : Array.isArray((payload as { jobs?: unknown[] }).jobs)
        ? ((payload as { jobs: unknown[] }).jobs.length ?? 0)
        : 0;

    return ok({ ok: true, type: parsed.type, token: parsed.token, openRoles: count });
  } catch (error) {
    return ok({
      ok: false,
      type: parsed.type,
      token: parsed.token,
      reason: `Could not reach that board: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * Asks a local Ollama which models are actually installed.
 *
 * Offering a model the user has not pulled is offering a broken choice, and the
 * failure would only surface much later during a real evaluation.
 */
async function detectLocalModels(): Promise<RouteResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);

  try {
    // Fixed loopback address: nothing here is user-controlled, so no SSRF surface.
    const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: controller.signal });
    if (!response.ok) return ok({ running: false, models: [] });

    const payload = (await response.json()) as { models?: Array<{ name?: unknown; size?: unknown }> };
    const models = (payload.models ?? [])
      .map((model) => (typeof model.name === 'string' ? model.name : ''))
      .filter((name) => name.length > 0);

    return ok({ running: true, models });
  } catch {
    return ok({ running: false, models: [] });
  } finally {
    clearTimeout(timer);
  }
}

export function createRoutes(deps: RouteDependencies): Record<string, RouteHandler> {
  return {
    'GET /api/config': () => {
      const criteria = deps.config.readCriteria();
      const sources = deps.config.readSources();
      const rule = sources.value.discovery?.companies ?? EMPTY_RULE;

      // A config written before rules existed names its boards outright. Only
      // an entry identical to what the catalog would generate can become a
      // rule `include`: anything the user has touched — renamed, disabled,
      // relabelled, or given its own scope — has to stay a named board, or
      // saving would quietly hand it back its defaults.
      const plain: string[] = [];
      const custom: SourceConfig[] = [];

      for (const source of sources.value.sources) {
        if (isCanonicalCatalogSource(source)) plain.push(sourceKey(source));
        else custom.push(source);
      }

      const include = [...new Set([...rule.include.map((key) => key.toLowerCase()), ...plain])];
      const effective = { ...rule, include };

      return ok({
        criteria: criteria.value,
        sources: sources.value,
        selection: inferSelection(
          (sources.value.discovery?.scope ?? {}) as Record<string, unknown>,
          criteria.value as unknown as Record<string, unknown>,
        ),
        companies: {
          ...effective,
          // What the rule resolves to, so the page never re-implements this.
          matched: selectCatalog(effective).map(catalogKey),
          // Returned whole and written back whole, so a save can never drop a
          // setting the page was not shown.
          custom,
        },
        captureMode: sources.value.discovery?.capture_mode ?? 'scoped',
        exists: { criteria: criteria.exists, sources: sources.exists },
        invalid: [
          ...(criteria.valid ? [] : [{ file: 'criteria.yaml', problems: criteria.problems }]),
          ...(sources.valid ? [] : [{ file: 'sources.yaml', problems: sources.problems }]),
        ],
        locations: deps.config.locations(),
      });
    },

    'GET /api/catalog': () => {
      const sources = deps.config.readSources();
      const rule = sources.value.discovery?.companies ?? EMPTY_RULE;
      const matched = new Set(selectCatalog(rule).map(catalogKey));

      return ok({
        categories: CATEGORY_LABELS,
        sizes: SIZE_LABELS,
        ownership: OWNERSHIP_LABELS,
        /** What the catalog can and cannot reach, so the page can explain gaps. */
        coverage: {
          total: CATALOG.length,
          providers: ['Greenhouse', 'Lever', 'Ashby'],
        },
        entries: CATALOG.map((entry) => ({
          ...entry,
          key: catalogKey(entry),
          added: matched.has(catalogKey(entry)),
        })),
      });
    },

    'GET /api/presets': () =>
      ok({
        families: ROLE_FAMILIES,
        seniority: SENIORITY_OPTIONS,
        locations: LOCATION_OPTIONS,
        metros: METRO_OPTIONS,
        salarySteps: SALARY_STEPS,
        applicationSystems: APPLICATION_SYSTEMS,
      }),

    /** Saves picked options by compiling them into scope and criteria. */
    'PUT /api/preferences': ({ body }) => {
      const blocked = blockedByInvalidConfig(deps);
      if (blocked) return blocked;

      const selection = body as Parameters<typeof compileSelection>[0];
      const compiled = compileSelection(selection);

      const sources = deps.config.readSources().value as Record<string, any>;
      const criteria = deps.config.readCriteria().value as Record<string, any>;

      sources['discovery'] = {
        ...sources['discovery'],
        capture_mode: selection.captureMode ?? 'scoped',
        // Merged one level down, not replaced. The page owns titles, levels and
        // locations; it knows nothing about departments, teams, or per-source
        // caps, and replacing the whole object deleted them on every save.
        scope: mergeScope(sources['discovery']?.scope, compiled.scope),
        companies: {
          size: stringList(selection.companySize),
          ownership: stringList(selection.companyOwnership),
          sectors: stringList(selection.companySectors),
          include: stringList(selection.companyInclude),
          exclude: stringList(selection.companyExclude),
        },
      };

      criteria['hard_filters'] = { ...criteria['hard_filters'], ...compiled.hardFilters };
      criteria['preferences'] = mergePreferences(criteria['preferences'], compiled.preferences);
      criteria['screening'] = { ...criteria['screening'], enabled: selection.screeningEnabled !== false };

      if (Array.isArray(selection.customBoards)) {
        // Written back exactly as they were read. These entries may carry
        // per-source scope or capture overrides that no rule can express, so
        // the portal passes them through rather than rebuilding them.
        sources['sources'] = selection.customBoards;
      }

      const savedSources = deps.config.saveSources(sources);
      if (!savedSources.ok) return badRequest({ saved: false, problems: savedSources.problems });

      const savedCriteria = deps.config.saveCriteria(criteria);
      if (!savedCriteria.ok) return badRequest({ saved: false, problems: savedCriteria.problems });

      return ok({ saved: true, sources: savedSources.path, criteria: savedCriteria.path });
    },

    /**
     * What model runs the reasoning, and what that costs.
     *
     * Key presence is reported, never the key itself: knowing whether the
     * variable is set is what the user needs; the value is not ours to show.
     */
    'GET /api/reasoning': () => {
      const criteria = deps.config.readCriteria().value as Record<string, any>;
      const reasoning = criteria['reasoning'] ?? {};
      const budget = criteria['budget'] ?? {};
      const passes = reasoning.passes ?? 2;

      return ok({
        current: reasoning,
        budget,
        models: MODEL_OPTIONS.map((option: ModelOption) => ({
          ...option,
          keyPresent: option.apiKeyEnv === undefined || (process.env[option.apiKeyEnv] ?? '').length > 0,
          estimate: estimateCost(option, passes),
        })),
      });
    },

    'POST /api/reasoning/detect': () => detectLocalModels(),

    /** Writes only the reasoning and budget keys, leaving the rest of criteria alone. */
    'PUT /api/reasoning': ({ body }) => {
      const blocked = blockedByInvalidConfig(deps);
      if (blocked) return blocked;

      const payload = (body ?? {}) as { reasoning?: unknown; budget?: unknown };
      const criteria = deps.config.readCriteria().value as Record<string, any>;

      if (payload.reasoning !== undefined) {
        criteria['reasoning'] = { ...criteria['reasoning'], ...(payload.reasoning as Record<string, unknown>) };
      }
      if (payload.budget !== undefined) {
        criteria['budget'] = { ...criteria['budget'], ...(payload.budget as Record<string, unknown>) };
      }

      const result = deps.config.saveCriteria(criteria);
      return result.ok
        ? ok({ saved: true, path: result.path, reasoning: (result.value as Record<string, any>)['reasoning'] })
        : badRequest({ saved: false, problems: result.problems });
    },

    'PUT /api/config/criteria': ({ body }) => {
      const result = deps.config.saveCriteria(body);
      return result.ok ? ok({ saved: true, path: result.path }) : badRequest({ saved: false, problems: result.problems });
    },

    'PUT /api/config/sources': ({ body }) => {
      const result = deps.config.saveSources(body);
      return result.ok ? ok({ saved: true, path: result.path }) : badRequest({ saved: false, problems: result.problems });
    },

    'POST /api/board-check': async ({ body }) => {
      const entry = typeof (body as { entry?: unknown })?.entry === 'string' ? (body as { entry: string }).entry : '';
      if (entry.trim().length === 0) return badRequest({ ok: false, reason: 'Enter a careers URL or board token.' });
      return checkBoard(entry.trim(), deps);
    },

    'GET /api/status': () => {
      const sources = deps.config.readSources();
      // Counted from what a scan would actually read, not from the names in the
      // file: with a rule, that file may list nothing at all.
      const resolved = resolveSources(sources.value);
      const enabled = resolved.filter((source) => source.enabled);

      try {
        const { repos } = deps.openDb();
        const jobs = repos.jobs.count();
        const postings = repos.postings.count();
        const companies = repos.companies.count();

        return ok({
          configured: sources.exists,
          sources: { total: resolved.length, enabled: enabled.length },
          jobs,
          postings,
          companies,
        });
      } catch {
        return ok({
          configured: sources.exists,
          sources: { total: resolved.length, enabled: enabled.length },
          jobs: 0,
          postings: 0,
          companies: 0,
        });
      }
    },

    /** Read-only preview, identical to `roleeye scope test`. */
    'POST /api/scope-preview': ({ body }) => {
      const candidate = (body as { sources?: unknown })?.sources;

      // Preview the unsaved edits when they are valid, otherwise what is on disk.
      const parsed = candidate === undefined ? undefined : sourcesSchema.safeParse(candidate);
      if (parsed && !parsed.success) {
        return badRequest({
          error: 'those source settings are not valid yet',
          problems: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || '(root)',
            message: issue.message,
          })),
        });
      }

      const sources = parsed?.success ? parsed.data : deps.config.readSources().value;
      const scope = scopeFromConfig(sources);

      const { repos } = deps.openDb();
      const jobs = repos.jobs.list({ limit: 400, includeClosed: true, inScope: undefined });

      const kept: Array<{ company: string; title: string }> = [];
      const dropped: Array<{ company: string; title: string; reason: string }> = [];

      for (const job of jobs) {
        const verdict = evaluateScope(
          {
            title: job.title,
            level: job.level,
            department: job.department,
            team: job.team,
            locationText: job.locationText,
            country: job.country,
            workArrangement: job.workArrangement,
            postedAt: job.postedAt ?? job.firstSeenAt,
          },
          scope,
        );

        if (verdict.inScope) kept.push({ company: job.companyName, title: job.title });
        else dropped.push({ company: job.companyName, title: job.title, reason: verdict.reason ?? 'out of scope' });
      }

      return ok({
        evaluated: jobs.length,
        kept: kept.length,
        dropped: dropped.length,
        keptSample: kept.slice(0, 25),
        droppedSample: dropped.slice(0, 25),
      });
    },
  };
}
