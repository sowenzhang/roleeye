import type { AppConfig } from '../config/load.js';
import type { Repositories } from '../db/repositories/index.js';
import { sourcesSchema, type SourceConfig } from '../config/schema.js';
import { evaluateScope, scopeFromConfig } from '../discovery/scope.js';
import { boardUrl } from '../discovery/greenhouse.js';
import { postingsUrl } from '../discovery/lever.js';
import { jobBoardUrl } from '../discovery/ashby.js';
import { createHttpClient } from '../discovery/http.js';
import { parseBoardEntry } from '../cli/setup.js';
import { CATALOG, CATEGORY_LABELS, catalogEntryToSource } from './catalog.js';
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

export function createRoutes(deps: RouteDependencies): Record<string, RouteHandler> {
  return {
    'GET /api/config': () => {
      const criteria = deps.config.readCriteria();
      const sources = deps.config.readSources();

      return ok({
        criteria: criteria.value,
        sources: sources.value,
        selection: inferSelection(
          (sources.value.discovery?.scope ?? {}) as Record<string, unknown>,
          criteria.value as unknown as Record<string, unknown>,
        ),
        captureMode: sources.value.discovery?.capture_mode ?? 'scoped',
        exists: { criteria: criteria.exists, sources: sources.exists },
        locations: deps.config.locations(),
      });
    },

    'GET /api/catalog': () => {
      const sources = deps.config.readSources();
      const existing = new Set(
        sources.value.sources.map((source: SourceConfig) => {
          const token = 'board' in source ? source.board : 'site' in source ? source.site : '';
          return `${source.type}:${token}`.toLowerCase();
        }),
      );

      return ok({
        categories: CATEGORY_LABELS,
        entries: CATALOG.map((entry) => ({
          ...entry,
          added: existing.has(`${entry.type}:${entry.token}`.toLowerCase()),
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
      const selection = body as Parameters<typeof compileSelection>[0];
      const compiled = compileSelection(selection);

      const sources = deps.config.readSources().value as Record<string, any>;
      const criteria = deps.config.readCriteria().value as Record<string, any>;

      sources['discovery'] = {
        capture_mode: selection.captureMode ?? 'scoped',
        scope: compiled.scope,
      };
      if (Array.isArray(selection.catalog)) {
        const chosen = CATALOG.filter((entry) =>
          (selection.catalog as string[]).includes(`${entry.type}:${entry.token}`),
        );
        sources['sources'] = chosen.map(catalogEntryToSource);
      }

      criteria['hard_filters'] = { ...criteria['hard_filters'], ...compiled.hardFilters };
      criteria['preferences'] = { ...criteria['preferences'], ...compiled.preferences };
      criteria['screening'] = { ...criteria['screening'], enabled: selection.screeningEnabled !== false };

      const savedSources = deps.config.saveSources(sources);
      if (!savedSources.ok) return badRequest({ saved: false, problems: savedSources.problems });

      const savedCriteria = deps.config.saveCriteria(criteria);
      if (!savedCriteria.ok) return badRequest({ saved: false, problems: savedCriteria.problems });

      return ok({ saved: true, sources: savedSources.path, criteria: savedCriteria.path });
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
      const enabled = sources.value.sources.filter((source: SourceConfig) => source.enabled);

      try {
        const { repos } = deps.openDb();
        const jobs = repos.jobs.count();
        const postings = repos.postings.count();
        const companies = repos.companies.count();

        return ok({
          configured: sources.exists,
          sources: { total: sources.value.sources.length, enabled: enabled.length },
          jobs,
          postings,
          companies,
        });
      } catch {
        return ok({
          configured: sources.exists,
          sources: { total: sources.value.sources.length, enabled: enabled.length },
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
