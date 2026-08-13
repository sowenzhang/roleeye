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

Repository skeleton only. Phase 0 (bootstrap) has not been implemented yet.

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

## Getting started (once Phase 0 lands)

```bash
cp .env.example .env
cp config/criteria.example.yaml config/criteria.yaml
cp config/sources.example.yaml config/sources.yaml
cp profile/career-profile.example.md profile/career-profile.md
cp profile/accomplishments.example.yaml profile/accomplishments.yaml
cp profile/master-resume.example.md profile/master-resume.md

npm install
npm run build
roleeye doctor
roleeye scan
```

## Rules that must not be broken

- The local SQLite database is the source of truth; the VPS is a replica.
- Deterministic code does acquisition, persistence, dedupe, and analytics. The LLM only reasons.
- Nothing is ever deleted from job history.
- No application is ever submitted automatically.
- No resume claim may exist without a matching approved fact ID.
