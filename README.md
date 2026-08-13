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

**Phase 0 (bootstrap) and Phase 1 (discovery + history) are implemented.**

Working today:

- `roleeye init` — create local config/profile files from the committed examples
- `roleeye doctor` — validate config, database, migrations, adapters
- `roleeye scan` — fetch configured sources, normalize, dedupe, persist history
- `roleeye list` — structured SQL listing of stored jobs
- `roleeye show` — full local record for one job, with event and snapshot history

Not implemented yet: evaluation, resume tailoring, application tracking, search,
analytics, export, and sync. Those commands exit with a usage error naming the
phase that will deliver them. See [`docs/progress.md`](./docs/progress.md).

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

node dist/index.js init      # creates config/*.yaml, profile/*, .env, and the database
# edit config/sources.yaml and add a real Greenhouse board
node dist/index.js doctor
node dist/index.js scan
node dist/index.js list --title engineer
node dist/index.js show <job-id>
```

During development, run the CLI straight from TypeScript:

```bash
npm run roleeye -- scan --dry-run
```

`roleeye init` never overwrites an existing file unless you pass `--force`.

## Commands

| Command | Description |
|---|---|
| `roleeye init` | Copy example config/profile files and create the database |
| `roleeye doctor` | Validate config, paths, database, migrations, and adapters |
| `roleeye scan` | Fetch all enabled sources; `--source <name\|type>`, `--dry-run` |
| `roleeye list` | Filter stored jobs by company, title, source, country, date |
| `roleeye show` | Show one job with its history, reposts, and snapshots |

Every command supports `--json` for scripting and returns meaningful exit codes:
`0` ok, `1` error, `2` usage, `3` config, `4` not found, `5` completed with warnings.

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
