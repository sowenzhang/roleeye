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

**Phases 0 through 6.5 are implemented.**

RoleEye runs a complete deterministic loop with no model and no spend: discover
roles, keep permanent history, filter them against your rules, screen them for
scams, and run itself on a schedule. Add a model and it also evaluates fit,
explains its reasoning, tailors one resume per kind of role you pursue, and
accounts for every token. It then tracks what you actually did about it, and
answers questions about the record it kept. Drive it from a browser or a
terminal — both call the same code.

- `roleeye ui` — local portal: setup, run, review queue, applications, reports
- `roleeye init --interactive` — the same setup as a terminal interview
- `roleeye doctor` — validate config, database, migrations, adapters
- `roleeye run` — the daily pass: scan, then screen, then evaluate
- `roleeye scan` — fetch Greenhouse, Lever, Ashby, and career pages
- `roleeye add <url>` — capture a single posting the sources do not reach
- `roleeye scope test` — preview which roles the scope keeps and drops
- `roleeye screen` — apply hard filters and authenticity checks
- `roleeye verify <job-id>` — explain one role, signal by signal
- `roleeye evaluate` — score fit with a model; `--dry-run` shows cost first
- `roleeye recommend` — the shortlist, with reasons and concerns
- `roleeye digest --send` — tell you about it: terminal, Windows toast, or webhook
- `roleeye resume import <file>` — read your `.docx`/`.pdf` resume into draft facts
- `roleeye resume generate <archetype>` — one tailored resume per kind of role
- `roleeye apply record <job-id>` — track what you applied to, and what came of it
- `roleeye apply questions <job-id>` — what the form asks beyond your resume
- `roleeye search "<words>"` — everything recorded: postings, verdicts, notes, answers
- `roleeye ask "<question>"` — answered from records, with the command that proves it
- `roleeye stats` — the funnel, segments, and `--cost` for spend by model and day
- `roleeye list` / `roleeye show` — query the local record
- `roleeye schedule install` — run it daily via Task Scheduler or cron
- `roleeye backup` — snapshot the authoritative database

Evaluation is optional and off by default. You can drive it three ways:

| Engine | What it needs | Notes |
|---|---|---|
| **Agent CLI** (`copilot`) | an agent you already pay for | No API key. Invoked with every tool denied, so it can only read and answer. ~90s per role. |
| **Local model** (Ollama) | a pulled model | Nothing leaves this machine. |
| **API key** (OpenAI-compatible) | `OPENAI_API_KEY` | Fastest, priced per token. |

Not implemented yet: career memory (Phase 7) and the learning loop (Phase 8).
See [`docs/progress.md`](./docs/progress.md) for status and
[`docs/vision.md`](./docs/vision.md) for where this is going.

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
src/notify/     notifier interface + adapters (terminal, desktop, webhook)
src/search/     structured, fulltext, semantic, planner
src/analytics/  funnel and segment metrics
src/export/     private/public sanitized export
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

npm run ui                                # the portal: setup, review, applications, reports
node dist/index.js scan                   # real jobs from real boards
node dist/index.js screen                 # filters + scam screening
node dist/index.js verify <job-id>        # why it passed or failed
node dist/index.js schedule install --at 07:30
```

`npm run dev` on its own prints the command list, because it passes no command
through. Use `npm run ui`, or `npm run roleeye -- <command>` for anything else.
Note that npm keeps some flags for itself (`--save` among them), so pass those
to the built CLI directly: `node dist/index.js apply questions <id> --save`.

The portal ships with **51 company boards**, each verified live against its
provider. Pick companies, role families, seniority, locations, a salary floor,
and which application systems you refuse — all by clicking. Free text is
confined to an Advanced panel for people who want it.

It has four views:

| View | What it is for |
|---|---|
| **Setup** | What to watch, and which model reasons about it |
| **Review** | The queue: each role with its reasoning, its concerns, and its authenticity signals. Record that you applied, or that you passed |
| **Applications** | Every application, its append-only status history, and a search over everything ever seen |
| **Reports** | The funnel, one segment of it, and what the model has cost |

Nothing in the portal decides anything: each route calls the same function the
CLI calls. And nothing in it can submit an application — the button reads
*Record that I applied*, because that is all it does. Links are opened only if
they are `https`, since the employer wrote them.

Prefer a terminal? `node dist/index.js init --interactive` asks the same
questions. Both write the same YAML, validated the same way.

Everything above is deterministic. No model is called, nothing is sent anywhere,
and nothing is spent.

During development, run the CLI straight from TypeScript:

```bash
npm run roleeye -- scan --dry-run
```

`roleeye init` never overwrites an existing file unless you pass `--force`.

## Commands

| Command | Description |
|---|---|
| `roleeye ui` | Local portal: setup, run, review queue, applications, reports; `--port`, `--no-open` |
| `roleeye init` | Set up config and the database; `--interactive` asks a few questions |
| `roleeye doctor` | Validate config, paths, database, migrations, and adapters |
| `roleeye run` | The daily pass: scan, screen, then evaluate; `--only <stage,...>`, `--limit`, `--force` |
| `roleeye scan` | Fetch all enabled sources; `--source <name\|type>`, `--dry-run` |
| `roleeye add <url>` | Capture one posting from a URL; `--company`, `--dry-run` |
| `roleeye scope test` | Preview what the scope filter keeps and drops, with reasons |
| `roleeye screen` | Apply hard filters and authenticity checks; `--force` re-decides |
| `roleeye verify <job-id>` | Explain one role's screening decision, signal by signal |
| `roleeye evaluate` | Score fit with a model; `--dry-run` prints the prompts and the cost without sending |
| `roleeye recommend` | The shortlist with reasons, concerns, and what to verify |
| `roleeye digest` | Summarise what deserves attention; `--send` delivers it, `--test` proves the channels work |
| `roleeye resume` | Fact store, role archetypes, and tailored resumes — see below |
| `roleeye apply` | Track applications, their history, and reusable answers — see below |
| `roleeye search` | Search postings, evaluations, notes, answers and outcomes; `--reindex` rebuilds |
| `roleeye ask` | Answer a question from your records, and name the command that reproduces it |
| `roleeye stats` | The funnel and its segments; `--cost` shows spend by model and day |
| `roleeye list` | Filter stored jobs by company, title, department, source, country, date |
| `roleeye show` | Show one job with its sources, history, reposts, and snapshots |
| `roleeye schedule` | `install`, `status`, or `remove` the daily run; `--print` shows the command |
| `roleeye backup` | Snapshot the database; also runs automatically before migrations |

Every command supports `--json` for scripting and returns meaningful exit codes:
`0` ok, `1` error, `2` usage, `3` config, `4` not found, `5` completed with warnings.

## Resumes

Resumes are tailored per **role archetype** — a kind of role you pursue, like
"AI platform engineering" — not per posting. A hundred discovered roles produce
a hundred documents nobody reads, at a hundred times the cost.

```bash
roleeye resume import ~/jane-doe.docx        # -> draft facts, unusable yet
roleeye resume facts                          # review what it found
roleeye resume approve --experience acme-corp-staff-software-engineer
roleeye resume archetypes --seed "software,ai"
roleeye resume generate ai                    # one call, one reviewed resume
roleeye resume classify                       # assign stored roles; zero model calls
roleeye resume delta <job-id>                 # on APPLY only: headline, order, note
```

The rules this enforces:

| Rule | What it means |
|---|---|
| Nothing is used until a human approves it | Import always produces drafts, including your own `accomplishments.yaml` |
| Approval is bound to the words | Editing an approved statement returns it to draft |
| Every claim traces to approved facts | A bullet cites fact IDs; `resume-provenance.md` shows them |
| Nothing is invented | Numbers and named technologies must appear in the cited facts, or the claim is dropped before it reaches a document |
| Classification is free | Assigning roles to archetypes makes no model calls, and an ambiguous posting is left unassigned rather than guessed |

## Applications

Nothing is ever submitted for you. What is recorded is what you did.

```bash
roleeye apply record <job-id> --referral "Dana"   # with the resume that went with it
roleeye apply status <job-id> interviewing --note "call booked"
roleeye apply skip <job-id> --reason "commute"     # passing is feedback too
roleeye apply questions <job-id> --save            # what the form asks beyond the resume
roleeye apply answer "Notice period?" --value "Four weeks"
roleeye apply list
```

Status history is append-only, and both directions of disagreement are kept:
applying to a role that scored badly, and passing on one that scored well. The
second is the half most tools throw away, and it is the half that says the
scoring is wrong.

**Form inspection** reads a posting's application form and reports only what
your resume does not already answer, matching each remaining question against
the bank so you write it once. Greenhouse publishes its question set; Lever and
Ashby do not, and RoleEye says so rather than guessing from a rendered page.

Two rules the bank does not bend:

| Rule | What it means |
|---|---|
| A protected question is reported, never inferred | Work authorisation, compensation, criminal history: with no stored answer it is flagged unanswered, never filled from a similar-looking previous one |
| Self-identification is yours alone | EEO/demographic questions are shown so you know they are there, and are never stored or reused |

## Search and analytics

```bash
roleeye search "kubernetes operators" --decision APPLY --not-applied
roleeye search --type job-evaluation --company Ramp --since 2026-07-01
roleeye ask "What AI roles did I see in July but skip?"
roleeye stats --funnel --segment level
```

The index is **derived**. Every document is built from a record and carries the
hash it came from, so `--reindex` is always safe and an unchanged corpus costs
no writes. Five kinds of document are indexed: `job-description`,
`job-evaluation`, `application-answer`, `interview-note` and `outcome-summary` —
the reasoning is searchable, not only the verdict.

Your words are words. FTS5's query language is unreachable from input, so
`senior "staff" engineer (remote)` searches for those words instead of raising a
syntax error.

`stats` computes the funnel from records every time and stores no metric:

```text
discovered → in scope → screened → eligible → evaluated → recommended
          → applied → recruiter screen → interviewing → final → offer
```

Stages past *applied* are read from the status history, so an application that
reached a final round and was then rejected still counts as having had one. A
rate with no denominator is reported as unknown rather than as 0%. Segment it by
`company`, `source`, `country`, `level`, `department`, `arrangement`,
`archetype`, `decision`, `salary_band` or `month`.

`--since` is inclusive and `--until` is exclusive, so `--since 2026-07-01
--until 2026-08-01` is July and consecutive windows never both claim the same
record.

`ask` is deterministic and calls no model. It classifies the question
(`STRUCTURED`, `KEYWORD`, `ANALYTICS`, `HYBRID`, `SEMANTIC`), answers from
records, and prints the command that reproduces the answer. Questions about
resemblance are refused rather than guessed at from keyword overlap — that needs
embeddings, which are Phase 7.

Reading `.pdf` resumes needs `pdfjs-dist`, an optional 33 MB install
(`npm install pdfjs-dist`). `.docx` needs nothing extra.

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

Every push and pull request runs all three on Ubuntu and Windows
(`.github/workflows/ci.yml`). The suite is hermetic — DNS, the platform, and the
reasoning provider are injected — so CI needs no secrets and calls no model.

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
