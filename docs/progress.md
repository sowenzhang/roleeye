# Implementation Progress

Phases are defined in `architecture.md` §33. Build one at a time. Do not skip ahead.

| Phase | Scope | Status |
|---|---|---|
| — | Repository skeleton | done |
| 0 | TypeScript project, CLI skeleton, config loader, SQLite + migrations, logging, tests, README | not started |
| 1 | Source adapter interface, Greenhouse adapter, normalize, dedupe, snapshots, source runs, `scan` + `show` | not started |
| 2 | Lever, Ashby, generic career pages, optional Playwright fallback | not started |
| 3 | Profile/criteria engine, hard filters, requirement extraction, Advocate/Skeptic/Judge, `evaluate` + `recommend` | not started |
| 4 | Fact store, fact matching, tailored resume, claim validation, resume diff, application answers | not started |
| 5 | Application entity, state history, notes, notifier, daily digest | not started |
| 6 | SQL search, FTS5, funnel + segment analytics, `stats`, basic `ask` | not started |
| 7 | Career memory / local RAG, embeddings, query planner, hybrid retrieval | not started |
| 8 | Private/public export, sanitization, manifest + checksums, secure sync, VPS importer | not started |
| 9 | Private job-site read-only API and dashboard | not started |
| 10 | Learning loop / outcome correlation | not started |

## Decisions log

| Date | Decision | Rationale |
|---|---|---|
| 2026-08-12 | Repository skeleton follows the layout in `agent.md` and `architecture.md` §7 verbatim, plus `src/core`, `src/util`, `export/`, `scripts/`, `docs/`. | The extra directories are mechanical (shared types, helpers, generated export target, notes) and do not change any architectural boundary. |

## Before starting each phase

1. Summarize the phase.
2. List files to create/change.
3. List new dependencies.
4. Implement the smallest complete vertical slice.
5. Add and run tests.
6. Update this file and the README.
