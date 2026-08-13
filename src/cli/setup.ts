import { stringify } from 'yaml';
import { parseAmount, parseList, type Prompter } from './prompt.js';

/**
 * Turns a short interview into working configuration.
 *
 * The alternative is a user hand-writing YAML from documentation before seeing
 * a single job, which is where most self-hosted tools lose people.
 */

export interface SetupAnswers {
  titles: string[];
  excludeTitles: string[];
  countries: string[];
  remoteOnly: boolean;
  minimumSalary: number | undefined;
  denyWorkday: boolean;
  boards: Array<{ type: 'greenhouse' | 'lever' | 'ashby'; token: string; company: string }>;
}

const BOARD_HINTS = `Add company boards. Paste a careers URL or "<type>:<token>", for example:
    greenhouse:airtable        (boards.greenhouse.io/airtable)
    lever:shieldai             (jobs.lever.co/shieldai)
    ashby:Ramp                 (jobs.ashbyhq.com/Ramp)`;

/** Recognises a board from a pasted URL or an explicit type:token pair. */
export function parseBoardEntry(entry: string): SetupAnswers['boards'][number] | undefined {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return undefined;

  const explicit = /^(greenhouse|lever|ashby)\s*:\s*(.+)$/i.exec(trimmed);
  if (explicit?.[1] && explicit[2]) {
    const token = explicit[2].trim();
    return { type: explicit[1].toLowerCase() as SetupAnswers['boards'][number]['type'], token, company: token };
  }

  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    const host = url.hostname.toLowerCase();
    const first = url.pathname.split('/').filter(Boolean)[0];
    if (!first) return undefined;

    if (host.endsWith('greenhouse.io')) return { type: 'greenhouse', token: first, company: first };
    if (host.endsWith('lever.co')) return { type: 'lever', token: first, company: first };
    if (host.endsWith('ashbyhq.com')) return { type: 'ashby', token: first, company: first };
  } catch {
    return undefined;
  }

  return undefined;
}

export async function interview(prompter: Prompter): Promise<SetupAnswers> {
  const titles = parseList(
    await prompter.ask('Job titles you want (comma separated)', 'engineer, architect'),
  );
  const excludeTitles = parseList(
    await prompter.ask('Titles to always exclude', 'intern, manager, director'),
  );
  const countries = parseList(await prompter.ask('Countries to include (ISO codes)', 'US'));
  const remoteOnly = await prompter.confirm('Remote roles only?', false);
  const minimumSalary = parseAmount(await prompter.ask('Minimum base salary, blank to skip', ''));
  const denyWorkday = await prompter.confirm('Skip roles that only apply through Workday?', false);

  const boards: SetupAnswers['boards'] = [];
  for (let index = 0; index < 5; index += 1) {
    const answer = await prompter.ask(index === 0 ? `${BOARD_HINTS}\n  Board` : '  Another board, blank to finish', '');
    if (answer.trim().length === 0) break;

    const board = parseBoardEntry(answer);
    if (board) boards.push(board);
  }

  return { titles, excludeTitles, countries, remoteOnly, minimumSalary, denyWorkday, boards };
}

/** Renders answers into the same shape the schemas validate. */
export function buildSourcesYaml(answers: SetupAnswers): string {
  const document = {
    version: 1,
    defaults: {
      request_delay_ms: 1500,
      timeout_ms: 20_000,
      max_pages: 5,
      user_agent: 'roleeye/0.1 (+local career agent)',
    },
    discovery: {
      capture_mode: 'scoped',
      scope: {
        titles: { include: answers.titles, exclude: answers.excludeTitles },
        locations: { countries: answers.countries, remote_only: answers.remoteOnly },
        max_new_per_source_per_scan: 50,
      },
    },
    sources: answers.boards.map((board) => ({
      name: `${board.company}-${board.type}`.toLowerCase(),
      type: board.type,
      enabled: true,
      company: board.company,
      ...(board.type === 'lever' ? { site: board.token } : { board: board.token }),
    })),
    dedupe: { repost_gap_days: 21 },
  };

  return stringify(document, { lineWidth: 100 });
}

export function buildCriteriaYaml(answers: SetupAnswers): string {
  const document: Record<string, unknown> = {
    version: 1,
    profile_name: 'default',
    decision_thresholds: { apply: 78, maybe: 62 },
    weights: {
      career_direction: 20,
      hands_on: 15,
      product_customer: 15,
      ai_relevance: 15,
      technical_domain: 15,
      location: 10,
      compensation: 10,
    },
    hard_filters: {
      countries: answers.countries,
      require_us_payroll: false,
      relocation: { reject_if_required: true },
      ...(answers.minimumSalary ? { minimum_base_salary: { amount: answers.minimumSalary, currency: 'USD' } } : {}),
      on_unknown: { salary: 'flag', country: 'flag' },
    },
    screening: {
      enabled: true,
      observation_window_days: 21,
      stale_after_days: 60,
    },
    preferences: {
      work_arrangement: { preferred: answers.remoteOnly ? ['remote'] : ['remote', 'hybrid'] },
      application_system: { deny: answers.denyWorkday ? ['workday'] : [] },
      direction: { positive: [], negative: [] },
    },
  };

  return stringify(document, { lineWidth: 100 });
}
