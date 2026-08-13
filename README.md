# RoleEye

A local-first AI career agent that keeps an eye on the job market, while keeping the human in the loop.

```text
Scout → Evaluate → Human Review → Apply → Outcome
  ↑                                      │
  └──────────── Career Memory ───────────┘
```

RoleEye discovers roles from public ATS sources, evaluates fit with an Advocate / Skeptic / Judge
pipeline, tailors resume artifacts from an approved fact store, tracks the full application
lifecycle, and builds searchable career memory. It never auto-applies.

See [`agent.md`](./agent.md) for behavioral rules and [`architecture.md`](./architecture.md) for
the technical design and implementation phases.

## Status

**Phases 0, 1, 2, 2.5, and 3a are implemented.**

RoleEye currently runs a complete deterministic loop with no model and no spend:
discover roles, keep permanent history, filter them against your rules, screen
them for scams, and run itself on a schedule.

- `roleeye init --interactive` — answer a few questions, get working config
- `roleeye doctor` — validate config, database, migrations, adapters
- `roleeye scan` — fetch Greenhouse, Lever, Ashby, and career pages
- `roleeye add <url>` — capture a single posting the sources do not reach
- `roleeye scope test` — preview which roles the scope keeps and drops
- `roleeye screen` — apply hard filters and authenticity checks
- `roleeye verify <job-id>` — explain one role, signal by signal
- `roleeye list` / `roleeye show` — query the local record
- `roleeye schedule install` — run it daily via Task Scheduler or cron
- `roleeye backup` — snapshot the authoritative database

Not implemented yet: LLM evaluation, resume tailoring, application tracking,
search, analytics, and the local portal. Those commands exit with a usage error
naming the phase that will deliver them. See [`docs/progress.md`](./docs/progress.md).

## Layout

```text
config/       human-edited YAML preferences (only *.example.yaml committed)
profile/      career profile + approved accomplishment fact store
src/cli/      roleeye command implementations
src/config/   config + env loading and validation
src/core/     shared domain types
src/db/       SQLite access, migrations, repositories
src/discovery/  source adapters (greenhouse, lever, ashby, career pages)
src/normalize/  posting normalization, dedupe, repost detection
src/evaluate/   hard filters, scoring, advocate/skeptic/judge
src/reasoning/  LLM provider interface + implementations
src/resume/     fact store, matching, tailoring, claim validation
src/applications/ application state machine and history
src/notifications/ notifier interface + adapters
src/search/     structured, fulltext, semantic, planner
src/analytics/  funnel and segment metrics
src/export/     private/public sanitized export
src/sync/       VPS sync
data/         local SQLite database (gitignored, authoritative)
artifacts/    generated per-job artifacts (gitignored)
export/       generated export packages (gitignored)
tests/        unit, integration, and fixture tests
scripts/      developer/maintenance scripts
docs/         working notes and decisions
```

## Getting started

Requires Node.js 22+.

```bash
npm install
npm run build

node dist/index.js init --interactive   # a few questions, then you are configured
node dist/index.js scan                 # fetch the boards you listed
node dist/index.js screen               # filter them against your rules
node dist/index.js verify <job-id>      # see exactly why a role passed or failed
node dist/index.js schedule install --at 07:30
```

Everything above is deterministic. No model is called, nothing is sent anywhere,
and nothing is spent.

`roleeye init` without `--interactive` copies the committed example files instead.

During development, run the CLI straight from TypeScript:

```bash
npm run roleeye -- scan --dry-run
```

`roleeye init` never overwrites an existing file unless you pass `--force`.

## Commands

| Command | Description |
|---|---|
| `roleeye init` | Set up config and the database; `--interactive` asks a few questions |
| `roleeye doctor` | Validate config, paths, database, migrations, and adapters |
| `roleeye scan` | Fetch all enabled sources; `--source <name\|type>`, `--dry-run` |
| `roleeye add <url>` | Capture one posting from a URL; `--company`, `--dry-run` |
| `roleeye scope test` | Preview what the scope filter keeps and drops, with reasons |
| `roleeye screen` | Apply hard filters and authenticity checks; `--force` re-decides |
| `roleeye verify <job-id>` | Explain one role's screening decision, signal by signal |
| `roleeye list` | Filter stored jobs by company, title, department, source, country, date |
| `roleeye show` | Show one job with its sources, history, reposts, and snapshots |
| `roleeye schedule` | `install`, `status`, or `remove` the daily run; `--print` shows the command |
| `roleeye backup` | Snapshot the database; also runs automatically before migrations |

Every command supports `--json` for scripting and returns meaningful exit codes:
`0` ok, `1` error, `2` usage, `3` config, `4` not found, `5` completed with warnings.

## Screening

Hard filters are your rules, applied deterministically: country, relocation,
salary floor (normalized across pay periods), and application systems you refuse
to use. A rejection always names the rule and the value that failed it.

Missing data is never silently decided. Most postings state no salary, so the
default is to flag rather than reject; `hard_filters.on_unknown` lets you demand
a stated salary instead.

Authenticity screening reports four independent dimensions, because a posting can
be several things at once:

| Dimension | Values |
|---|---|
| `freshness` | current, stale, unknown |
| `hiringIntent` | specific, evergreen, unknown |
| `fraudRisk` | low, medium, high |
| `provenance` | verified, unverified, suspicious |

Scam markers are detected on first sight. Longevity and reposting signals stay
`unknown` until a posting has been observed long enough to justify an opinion —
they are deliberately silent rather than confidently wrong.

## Sources and scope

Supported source types: `greenhouse`, `lever`, `ashby`, and `career-page`
(schema.org `JobPosting` data, with an optional Playwright fallback for
JavaScript-rendered pages).

A board routinely holds 50-400 postings, nearly all irrelevant to one person, so
capture is scoped by configuration rather than exhaustive:

| Capture mode | Stores | Description body | Evaluates |
|---|---|---|---|
| `scoped` (default) | in-scope postings only | yes | in-scope roles |
| `full` | every posting | yes | in-scope roles |
| `history` | every posting | metadata only | nothing |

Scope filters on department, title (terms and regex), seniority level, country,
metro, remote-only, and posting age, with per-source overrides. Preview any
change with `roleeye scope test` before scanning — it only reads.

Scope changes never delete history: a role that leaves scope stops being
evaluated, it does not stop existing.

## Development

```bash
npm test          # unit + integration tests (node:test, no network access)
npm run typecheck # strict TypeScript across src and tests
npm run build     # emit dist/
```

Provider tests run entirely from committed fixtures in `tests/fixtures/`.

## Rules that must not be broken

- The local SQLite database is the source of truth; the VPS is a replica.
- Deterministic code does acquisition, persistence, dedupe, and analytics. The LLM only reasons.
- Nothing is ever deleted from job history.
- No application is ever submitted automatically.
- No resume claim may exist without a matching approved fact ID.
- Capture is scoped by user configuration, not exhaustive.
- Job postings are untrusted third-party input at every boundary.
- Model spend is budgeted, accounted for, and never silently escalated.

## Design notes

- [`docs/progress.md`](./docs/progress.md) — phase status and decision log
- [`docs/security-review-phase1.md`](./docs/security-review-phase1.md) — threat model, findings, and fixes
- [`docs/spend-analysis.md`](./docs/spend-analysis.md) — measured token costs and the pipeline that controls them
