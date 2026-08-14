import type { ApplicationStatus, EvaluationDecision } from '../core/types.js';
import { ExitCode, UsageError, type ExitCodeValue } from '../util/errors.js';
import { syncSearchIndex } from '../search/indexer.js';
import { search, type SearchFilters } from '../search/query.js';
import { DOCUMENT_TYPES } from '../search/indexer.js';
import { singleLine, truncate } from '../normalize/text.js';
import { flagBool, flagList, flagNumber, flagString } from './args.js';
import { printJson, printLine, type Command, type CommandContext } from './command.js';

const DECISIONS: readonly EvaluationDecision[] = ['APPLY', 'MAYBE', 'SKIP'];

const STATUSES: readonly ApplicationStatus[] = [
  'APPLIED',
  'RECRUITER_SCREEN',
  'INTERVIEWING',
  'FINAL',
  'OFFER',
  'REJECTED',
  'WITHDRAWN',
  'CLOSED',
];

/**
 * Search over everything recorded: postings, verdicts, notes, answers, outcomes.
 *
 * `list` still exists and still does what it did — it filters jobs. This
 * searches *documents*, which is a different question: "where did I read
 * that?" rather than "which roles match?".
 */
export const searchCommand: Command = {
  name: 'search',
  summary: 'Search postings, evaluations, notes, answers, and outcomes',
  usage:
    'roleeye search [query] [--type <document-type>] [--company <name>] [--decision APPLY|MAYBE|SKIP] ' +
    '[--status <status>] [--applied|--not-applied] [--source <name|type>] [--country <code>] ' +
    '[--min-salary <n>] [--since <iso-date>] [--until <iso-date>] [--include-closed] [--limit <n>] [--reindex] [--json]',

  run(context: CommandContext): ExitCodeValue {
    const { db } = context.openDb();

    if (flagBool(context.args, 'reindex')) {
      const stats = syncSearchIndex(db, { rebuild: true });
      if (context.json) {
        printJson(context, stats);
      } else {
        printLine(context, `Rebuilt the index: ${stats.documents} document(s).`);
        for (const entry of stats.byType) {
          printLine(context, `  ${entry.documentType.padEnd(20)} ${String(entry.count).padStart(6)}`);
        }
      }
      return ExitCode.Ok;
    }

    const filters = parseFilters(context);
    const result = search(db, filters);

    if (context.json) {
      printJson(context, { query: filters.query, match: result.matchExpression, hits: result.hits });
      return result.hits.length > 0 ? ExitCode.Ok : ExitCode.NotFound;
    }

    if (result.hits.length === 0) {
      printLine(context, 'Nothing matched.');
      printLine(context);
      printLine(context, `  ${result.indexed} document(s) are indexed.`);
      if (filters.query) {
        printLine(context, '  Every word must appear. Drop one, or search a phrase you are sure of.');
      }
      return ExitCode.NotFound;
    }

    printLine(context, `${result.hits.length} result(s)`);

    for (const hit of result.hits) {
      printLine(context);
      printLine(context, `${hit.company ? `${hit.company} — ` : ''}${truncate(hit.title, 70)}`);

      const marks = [
        hit.documentType,
        hit.createdAt.slice(0, 10),
        hit.decision ? `${hit.decision}${hit.score !== undefined ? ` ${Math.round(hit.score)}` : ''}` : undefined,
        hit.status,
        hit.jobId,
      ].filter(Boolean);

      printLine(context, `  ${marks.join('  ')}`);
      // Posting-derived text on its way to a terminal. Collapsing whitespace is
      // not enough: `\s` does not match ESC, so a description containing
      // `\x1b[1A` would move the cursor and overwrite the line above it — a
      // posting rewriting the result above its own.
      if (hit.excerpt) printLine(context, `  ${truncate(singleLine(hit.excerpt), 150)}`);
    }

    return ExitCode.Ok;
  },
};

function parseFilters(context: CommandContext): SearchFilters {
  const query = context.args.positionals.join(' ').trim();

  const decision = flagString(context.args, 'decision')?.toUpperCase();
  if (decision && !DECISIONS.includes(decision as EvaluationDecision)) {
    throw new UsageError(`unknown decision "${decision}". One of: ${DECISIONS.join(', ')}`);
  }

  const status = flagString(context.args, 'status')?.toUpperCase().replace(/-/g, '_');
  if (status && !STATUSES.includes(status as ApplicationStatus)) {
    throw new UsageError(`unknown status "${status}". One of: ${STATUSES.join(', ').toLowerCase()}`);
  }

  const types = flagList(context.args, 'type') ?? (flagString(context.args, 'type') ? [flagString(context.args, 'type')!] : undefined);
  for (const type of types ?? []) {
    if (!DOCUMENT_TYPES.includes(type as (typeof DOCUMENT_TYPES)[number])) {
      throw new UsageError(`unknown document type "${type}". One of: ${DOCUMENT_TYPES.join(', ')}`);
    }
  }

  const since = flagString(context.args, 'since');
  const until = flagString(context.args, 'until');

  return {
    query: query.length > 0 ? query : undefined,
    documentTypes: types as SearchFilters['documentTypes'],
    company: flagString(context.args, 'company'),
    title: flagString(context.args, 'title'),
    decision: decision as EvaluationDecision | undefined,
    status: status as ApplicationStatus | undefined,
    applied: flagBool(context.args, 'applied') ? true : flagBool(context.args, 'not-applied') ? false : undefined,
    source: flagString(context.args, 'source'),
    country: flagString(context.args, 'country'),
    minSalary: flagNumber(context.args, 'min-salary'),
    since: since ? isoDate(since, 'since') : undefined,
    until: until ? isoDate(until, 'until') : undefined,
    includeClosed: flagBool(context.args, 'include-closed'),
    limit: flagNumber(context.args, 'limit') ?? 25,
  };
}

/** A date that cannot be parsed is a usage error, never a silent full scan. */
function isoDate(value: string, flag: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new UsageError(`--${flag} is not a date: "${value}"`);
  return parsed.toISOString();
}
