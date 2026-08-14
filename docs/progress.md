# Implementation Progress

Phases are defined in `architecture.md` §33. Build one at a time. Do not skip ahead.

| Phase | Scope | Status |
|---|---|---|
| — | Repository skeleton | done |
| 0 | TypeScript project, CLI skeleton, config loader, SQLite + migrations, logging, tests, README | done |
| 1 | Source adapter interface, Greenhouse adapter, normalize, dedupe, snapshots, source runs, `scan` + `show` | done |
| — | Pre-Phase-2 security review and hardening | done |
| 2 | Lever, Ashby, career pages, discovery scope config, capture modes, `add`, `scope test` | done |
| 2.5 | Cross-model review; source/job separation (migration 003), closure lifecycle, bug fixes | done |
| 3a | Criteria engine, hard filters, authenticity screening, backup, scheduling, interactive init | done |
| 3c | Configuration portal (`roleeye ui`) | done |
| 3b | Requirement extraction, reasoning provider, evaluation, cache, spend accounting, `evaluate` + `recommend` | done |
| 3.5 | Notifier (terminal, desktop, webhook), daily digest, `digest` | done |
| 4 | Fact store, `.docx`/`.pdf` import as draft facts, **archetype** resumes, claim validation, resume diff, `.docx` output | not started |
| 5 | Application tracking, state history, notes, recommendation overrides, application question bank | not started |
| 6 | SQL search, FTS5, funnel + segment analytics, `stats` | not started |
| 6.5 | Review portal: queue, application timeline, analytics | not started |
| 7 | Career memory / local RAG | speculative |
| 8 | Learning loop | speculative |
| 9 | Desktop application shell (Tauri over the portal, CLI as sidecar) | planned (see `docs/vision.md`) |
| 10a | Agent CLI as a reasoner (Copilot CLI, all tools denied) | done |
| 10b | Tool-using agent / application assistant | gated on the controls in `docs/vision.md` §6.3 |
| — | VPS sync and private job site | deferred, not planned |

## Decisions log

| Date | Decision | Rationale |
|---|---|---|
| 2026-08-12 | Repository skeleton follows the layout in `agent.md` and `architecture.md` §7 verbatim, plus `src/core`, `src/util`, `export/`, `scripts/`, `docs/`. | The extra directories are mechanical (shared types, helpers, generated export target, notes) and do not change any architectural boundary. |
| 2026-08-12 | `better-sqlite3` for persistence. | Synchronous API keeps the ingestion pipeline simple and transactional; `node:sqlite` is still experimental on Node 22. |
| 2026-08-12 | Hand-written CLI router instead of a framework. | architecture.md §4 allows "a small explicit command router"; avoids a dependency for five commands. |
| 2026-08-12 | Migrations are TypeScript modules holding SQL strings. | Keeps `tsc` the only build step — no asset-copy stage — while the SQL stays reviewable in version control. |
| 2026-08-12 | Job IDs are derived from the identity key (`job_<sha256[0:16]>`) rather than random. | Re-ingesting the same posting into a fresh database yields the same ID, so artifact paths and exports stay stable. |
| 2026-08-12 | Evaluation/application/artifact/note tables ship in migration 001 even though phases 3-5 populate them. | The domain model in architecture.md §8 is fixed; creating the tables now avoids a schema churn migration later. |
| 2026-08-12 | Added `roleeye list` (not in the documented command set). | `show` needs a job ID and phase 6 owns real search; this is plain SQL filtering, not a substitute for it. |
| 2026-08-13 | Capture is scoped by user configuration rather than capturing every posting (§36). | A board holds 50-400 roles, nearly all irrelevant to one person. Scope is the largest lever on both noise and cost, and it belongs to the user, not to code. |
| 2026-08-13 | Added a job authenticity agent for ghost and fraudulent postings (§37). | Deterministic signals from our own longitudinal history — repost cadence, posting longevity — detect evergreen listings that no snapshot-free tool can see. |
| 2026-08-13 | Token budget is an architectural constraint with accounting and hard limits (§38). | Measured data showed the naive pipeline costs roughly $68 per full pass and repeats it every scan. Filtering and caching cut this about 100x. |
| 2026-08-13 | Local portal added as Phase 3.5, strictly as a client over existing modules. | YAML is a good storage format and a poor input format, but business logic must not migrate into a web layer. |
| 2026-08-13 | `.docx`/`.pdf` resume import produces draft facts requiring explicit approval. | Removes the blank-page problem without weakening the rule that every generated claim traces to an approved fact. |
| 2026-08-13 | Security review conducted before Phase 2 rather than after. | Phase 2 accepts arbitrary career-page URLs and Phase 3 puts posting text into prompts; both amplify weaknesses that are inert today. |
| 2026-08-13 | Lockfile `resolved` URLs normalized to `registry.npmjs.org`, with `.npmrc` pinning the public registry. | The lockfile had been generated behind a corporate mirror; publishing it would delegate dependency hosting for every contributor and CI job. |
| 2026-08-13 | A per-source scope group replaces the global group entirely rather than merging field by field. | Partial merging makes configuration hard to predict: a user who sets source-specific titles expects exactly those titles. |
| 2026-08-13 | The career-page adapter reads only schema.org `JobPosting` data and refuses to guess from arbitrary markup. | Heuristic scraping produces silently wrong records, and a wrong record is worse than a missing one. The error names the linked ATS when it finds one. |
| 2026-08-13 | Playwright stays an optional, dynamically imported peer rather than a dependency. | It is a large install most users never need, and architecture.md ranks browser automation last among discovery methods. |
| 2026-08-13 | Salary parsing now requires explicit monetary evidence and plausibility bounds. | Real postings caused "$12.7B valuation" and "founded in 2015… 13 countries" to be stored as pay. Compensation feeds a Phase 3 hard filter, so a wrong number is worse than no number. |
| 2026-08-13 | **Reversed**: the domain model is *not* fixed, and pre-creating Phase 3-5 tables was a mistake. | `jobs` conflated a logical role with one source posting, and `evaluations` had no link to the content it judged. Both had to be corrected before evaluation is built on them. |
| 2026-08-13 | Migration 003 separates `jobs` (logical role) from `source_postings` (one row per advertising source). | The same role on two ATS providers merged by fingerprint, then alternated `source_job_id` every scan and reported a repost forever. Repost cadence is the primary ghost-job signal, so that noise had to go before Phase 3 depends on it. |
| 2026-08-13 | Clustering uses a location-independent key requiring an identical body under the same company. | Recognises one role advertised on several providers or in several locations, while never merging on title similarity. An absent body never clusters. |
| 2026-08-13 | Evaluations reference a snapshot, a content hash, and profile/criteria hashes. | Without them a verdict cannot be attributed to the body that produced it, cannot be marked stale after an edit, and the documented cache key cannot be implemented. |
| 2026-08-13 | Postings close only after a source run succeeds, and a role closes only when every posting closes. | `closed_at` was previously never set at all. A failed fetch must never retire live roles (architecture.md §30). |
| 2026-08-13 | The per-scan cap defers unseen roles instead of truncating the fetch. | Truncating stopped refreshing known roles — which would eventually close live jobs — and could hide the same role forever if it sat past the cap in the provider's ordering. |
| 2026-08-13 | Boilerplate is removed by truncating at terminal headings, not by matching sections. | Measured on 29 live postings: 36% fewer characters, ~490 tokens saved each. A per-section matcher saved 19 tokens of 1,077, because real postings (Ramp) end with a benefits heading followed by *unlabeled* country bullet lists that no heading pattern matches. |
| 2026-08-13 | Nested configuration objects are `.strict()`. | A mistyped key such as `min_base_salary` was silently dropped, leaving the user believing a hard filter was active when it was not. Found by writing a test that used the wrong field name. |
| 2026-08-13 | The portal reports an unreadable config file instead of quietly showing defaults. | It falls back to defaults so the page still opens; without a warning, pressing save would replace the user's real settings with those defaults. Malformed YAML also returned an opaque 500. |
| 2026-08-13 | The page's embedded script is executed in tests against a DOM shim, not merely parsed. | The script is a string inside a `.ts` file, so the compiler never sees it. The first run of this harness immediately caught a `ReferenceError` that typechecking and `node --check` both passed. |
| 2026-08-13 | Resumes are tailored per role archetype (3-6), not per posting. | 100 postings produced 100 documents the user would never read, under their own name, at 100x the cost. Regeneration is triggered by an archetype changing, not by a posting arriving. |
| 2026-08-13 | Application answers are classified recalled / composed / never-invented. | "Generate answers automatically" collides with the existing prohibition on inventing legal, demographic and compensation answers. Recall is retrieval of the user's own stated answer; it is not generation. |
| 2026-08-13 | Agent mode (delegating to an installed `--yolo` agent) is sequenced last and gated. | It is the feature most likely to make the product usable by non-engineers and the one most likely to harm them: postings are attacker-controlled text, and an approval-bypassed agent running as the user turns prompt injection into code execution with that user's privileges. |
| 2026-08-13 | Posting-derived facts (company, title, location, team) moved *inside* the prompt fence, and field values are newline-stripped. | A cross-model review found they were interpolated outside it. Reproduced: a job title containing newlines escaped the facts block and appeared as a free-standing `SYSTEM:` instruction before the fence began. The poster controls the title. |
| 2026-08-13 | Model-extracted requirements are fenced too when passed to the assessment pass. | They are a model's reading of attacker text, so an injected instruction can be carried forward into a "structured" field. Structured is not trusted. |
| 2026-08-13 | Fence markers are neutralised case-insensitively. | Exact-string replacement let `untrusted_job_posting>>>` through untouched, and models match instructions case-insensitively. |
| 2026-08-13 | Boilerplate truncation requires heading *shape*, not a line prefix. | The prefix rule discarded everything after "Benefits of this microservice architecture include…", losing a work-authorisation requirement that feeds a hard filter. Heading shape keeps the full 36% saving while retaining decision input. |
| 2026-08-13 | The evaluation cache key includes provider name and pass count. | A two-pass verdict was being served to a user who had since asked for the adversarial third pass, and one model name means different things on different providers. |
| 2026-08-13 | Portal routes refuse to merge into a config file that does not load. | The portal shows defaults for an unreadable file; merging one panel's edit into those defaults and saving would silently replace every hand-written setting. A UI warning was not sufficient. |
| 2026-08-13 | **Corrected**: `docs/vision.md` claimed a posting-to-archetype classifier already exists in `src/portal/presets.ts`. It does not. | `presets.ts` compiles UI selections into scope configuration. The classifier is unbuilt work in Phase 4, and recording it as existing would have hidden real scope. |
| 2026-08-13 | **Reversed**: agent mode ships now as a reasoner, instead of last. | It was sequenced last because `--yolo` was assumed necessary. It is not: an approval bypass is only needed by an agent that *acts*. Invoked with `--deny-tool=all --disable-builtin-mcps --no-custom-instructions`, the agent has the blast radius of an API call. The dangerous version (tool use, browser automation) stays gated as Phase 10b. |
| 2026-08-13 | The user brings their own paid coding agent; Copilot CLI is supported first. | Removes the API key, which was the real barrier for anyone who is not already an engineer with a model subscription. Ollama and direct API keys remain supported but are no longer the onboarding story. |
| 2026-08-13 | `--no-custom-instructions` is part of the hardened flag set, not an optimisation. | An agent otherwise loads instruction files from the working directory and user profile, which would silently join a prompt that also contains an untrusted job posting. |
| 2026-08-13 | The agent CLI provider reports `requestCount` and leaves `estimatedCostUsd` undefined. | It bills against a subscription quota, not per token. Measured 30.2k input tokens for a 90-character prompt, because the agent carries a large fixed system prompt. Inventing a dollar figure would make spend accounting confidently wrong. |
| 2026-08-13 | The schema shape is now sent to every provider, not just named. | Found by running the real prompt against the real agent: it returned `company` / `responsibilities` / `required_qualifications` where the schema wanted `primary_mission` / `seniority` / `required_skills`. The OpenAI path had the same gap — `json_object` mode guarantees valid JSON, not correct fields — and 327 passing tests missed it because the scripted provider returns pre-shaped data. |
| 2026-08-13 | String length limits are included in the schema hint. | The second live run produced correct field names and over-long values. A limit the model is never told about is a limit it cannot respect. |
| 2026-08-13 | Tauri will load the existing portal over `127.0.0.1` with the CLI as a sidecar. | A conventional Tauri app would add a Rust toolchain and a frontend bundler, breaking the rule that `tsc` is the only build step. Loading a URL keeps one UI implementation and no bundler. |
| 2026-08-13 | Evaluation is capped at 5 roles per run by default, with no maximum and a warning past 20. | Measured 7 minutes per role through an agent CLI, so an uncapped pass over the eligible set is a multi-hour job. A small run that finishes is worth more than a large one the user cancels. The warning states the estimated hours rather than refusing. |
| 2026-08-13 | The cap keeps the highest-priority roles, ranked deterministically. | A cap that keeps whatever the database returned first is a cap that throws away the best role. Priority reuses the screening verdict already computed — freshness, hiring intent, fraud risk, provenance, stated pay, body length, age — so it is free and cannot be swayed by a posting's persuasive writing. It ranks likelihood of repaying a call, never fit. |

## Phase 3.5 notes

Windows toasts need no native dependency, but they do need three things that
were only discoverable by trying them:

1. **Windows PowerShell 5.1, not PowerShell 7.** WinRT types cannot be loaded in
   pwsh, so the script runs under `System32\WindowsPowerShell\v1.0`.
2. **Both WinRT types loaded explicitly** — the notification manager *and*
   `Windows.Data.Xml.Dom.XmlDocument`. Loading only the first fails at the point
   the document is constructed.
3. **A registered AppUserModelID.** PowerShell's own is used, because a toast
   from an unregistered app id is silently dropped.

### Toast content travels in an environment variable

Company names and job titles are chosen by whoever posted the job. Embedding
them in the PowerShell script text means a title containing a quote can end a
string literal. The XML is passed in `ROLEEYE_TOAST_XML` instead, which
PowerShell treats as data, and the text is XML-escaped with control characters
stripped so the document still loads.

### The acceptance criterion was tested literally

"A scheduled scan can notify without a terminal attached" was verified by
registering a real scheduled task, triggering it, and confirming `Last Result: 0`
with the toast delivered — not by reasoning that it should work.

### Thresholds default to APPLY only

A notifier that fires on everything gets muted, and a muted notifier is worse
than none because it still looks like it is working. `notify.min_decision`
defaults to `APPLY`; the digest command says which setting to lower when it
finds nothing.

## Phase 3b notes

The reasoning boundary has one primitive, `generate<T>()`, returning an envelope
(data, usage, finish reason, model, request id, latency, attempts). It is
deliberately *not* shaped around the product — there is no `assessJob()` method —
so a provider cannot quietly acquire product logic, and the whole pipeline can be
replayed against a scripted provider.

Scoring is computed in code from the model's per-category scores multiplied by
the user's weights. The model supplies judgement on bounded questions; it never
supplies the number. Scores are therefore reproducible, and re-weighting does not
require re-running a model.

### Cost is measured, not estimated

`evaluate --dry-run` prints the exact prompts, the token counts and the price
before anything is sent. Against live data, one Ramp posting is 1,077 tokens and
588 after stripping. The portal shows price per 100 roles per model *before* the
user picks one, because a model choice is a spending decision.

### The model picker exists so "local" is a real option

Selecting Ollama is one click, and `POST /api/reasoning/detect` asks a local
Ollama which models are actually installed — offering a model the user has not
pulled is offering a broken choice that would only fail much later, mid-run.
Choosing a local model means nothing leaves the machine, and the UI says so on
the card rather than in documentation.

### What live testing changed

- `stripBoilerplate` was rewritten from section matching to truncation (see the
  decisions log). Section matching saved 19 tokens of 1,077.
- The dry run claimed "Data leaves this machine: yes" when no provider was
  configured and nothing would be sent at all.
- Nested config objects were not strict, so a mistyped hard-filter key was
  silently ignored.
- A malformed `criteria.yaml` crashed the portal route with an opaque 500.

## Phase 3c notes

The portal was pulled forward from 6.5 after user feedback: hand-writing YAML was
blocking real use. The earlier "defer the portal" argument was about managing
*state*, which is still true — so the portal was split. Configuration editing
ships now; the review queue, application timeline, and analytics stay at 6.5
where the state they display will exist.

- `roleeye ui` binds `127.0.0.1` only, mints a token at start, and refuses
  cross-origin writes. Verified in a real browser: a cross-origin `PUT` gets 403.
- The web layer holds no rules. It reads and writes the same YAML through the
  same zod schemas the CLI loader uses, so the two cannot disagree.
- An invalid save returns per-field problems and writes nothing.
- The portal opens even when a config file on disk is broken, which is exactly
  when someone needs it.
- Board lookup checks a pasted careers URL against the live adapter through the
  URL guard, so nobody has to know what an ATS board token is.
- No bundler and no framework: `node:http` plus one embedded page module, so
  `tsc` remains the only build step and the whole UI is auditable in one file.
- All third-party text is inserted as text nodes; `innerHTML` is never assigned
  anywhere on the page, and a test asserts that.

### Configuration by picking, not typing

The first version still asked for comma-separated lists in six text boxes, which
means asking the user to guess our matching rules. Replaced with:

- **51 preloaded company boards**, every token verified live against its
  provider before shipping. 16 of the first 50 guesses were wrong, which is
  exactly why an unverified catalog would have shipped broken. Re-check any time
  with `npm run catalog:check`.
- **Role families** — "Software engineering" expands into the title terms and
  the lookalike exclusions ("sales engineer" is not a software engineer).
- **Seniority, locations, metros, salary, recency, and refused application
  systems** as chips and scales.
- Free text survives only in an Advanced panel, so nothing is lost — only typing.

Seniority compiles to level *exclusions* rather than inclusions: an inclusion
list silently drops every posting whose title states no level, which is a large
share of real postings.

Verified end to end in a browser from a clean install: five companies picked by
clicking, no typing at all → `doctor` passed → `scan` fetched 1,715 postings and
stored the 123 in scope → `screen` marked 113 eligible → reopening the portal
showed every selection restored. Mobile collapses to a single column at 390px
with no horizontal scroll.

## Phase 3a notes

A third model (Claude Opus 4.6) reviewed the forward plan before this phase. Its
findings changed the sequencing:

- Phase 3 was split. 3a is entirely deterministic — no model, no spend — so hard
  filters could be used immediately without waiting for evaluation to be good.
- The portal moved from 3.5 to 6.5. Its own justification was that "the CLI
  proves the workflow", and the workflow is not proven until applications are
  tracked.
- VPS sync and the private job site were demoted out of the plan entirely. The
  goal is an agent anyone can run and schedule on their own machine.
- Feedback capture moves earlier: application overrides are recorded from Phase 5
  so the learning loop has data long before it is built.
- Resume fact approval will be per experience block, not per fact. Approving 60
  atomic facts is a form nobody fills in honestly.

Built in 3a:

- criteria engine with a content-derived hash, so editing a threshold correctly
  invalidates cached decisions without a hand-maintained version field
- deterministic hard filters with explicit `pass` / `reject` / `unknown`, and a
  configurable policy for missing data. Most postings state no salary, so
  rejecting all of them by default would be useless; the default flags instead
- authenticity screening across four independent dimensions
- `roleeye screen`, `roleeye verify`, `roleeye backup`, `roleeye schedule`,
  and `roleeye init --interactive`
- migration 004: `job_screenings`, `llm_calls`, and a content-only key

### The fraud patterns had to be rewritten after live testing

The first version blocked a legitimate Shield AI avionics role. It matched
"**wire** harnesses ... **equipment** procurement" — ordinary job duties. A
confident false accusation is far more damaging than a missed scam, because the
user stops trusting every verdict the tool produces.

Every payment pattern now requires the applicant to be the party paying, and the
messaging-app and free-email patterns require an instruction to make contact
that way. Validated across 273 real postings from two companies: zero signals
fired. The avionics text and four similar phrasings are pinned as regression
tests.

### Other decisions

- Backups use `VACUUM INTO`, which is synchronous, so a migration cannot begin
  before the snapshot exists. A failed backup aborts the migration.
- The content-only key exists because `fingerprint` and `cluster_key` both
  include the company, so neither could ever answer "is this same description
  being advertised by unrelated companies?"
- Scheduling builds its command as data and supports `--print`, because a tool
  that edits your crontab should show you the line first.

## Phase 2.5 notes

Two models reviewed the codebase independently before Phase 3 (design critique by
GPT-5.6 Sol, implementation review of the Phase 2 diff by Gemini 3.1 Pro). Every
claim was reproduced before being acted on. Eight confirmed bugs:

1. `history` capture overwrote a stored body with an empty string — a direct
   violation of the preserve-history rule.
2. Switching a source from `history` to `full` never backfilled the body, because
   the stored hash already described content the database did not hold.
3. An out-of-scope role stopped being refreshed entirely, so `in_scope` went
   stale and `last_seen_at` froze.
4. `max_new_per_source_per_scan` truncated the raw fetch (both reviewers).
5. `gh_jid` was stripped as a tracking parameter, breaking embedded Greenhouse
   capture — it identifies the posting, not a campaign.
6. Greenhouse departments were declared in the payload type but never mapped, so
   department scope filters silently did nothing for that provider.
7. `closed_at` was never written anywhere: roles never closed, `--include-closed`
   was meaningless, and the ghost-job longevity signal had no data.
8. Salary still misparsed `"raised a $5M seed round. Salary is competitive."`,
   and dropped valid JPY/INR salaries as implausible.

Also corrected: ATS URL matchers used substring host checks; the browser fallback
guarded only the top-level URL while Chromium fetched subresources unrestricted,
and `docs/progress.md` had claimed otherwise.

A sobering note: 171 tests passed while all of this was present. The suite largely
confirmed the behaviour that was written rather than attacking it. The new tests
in `tests/integration/dedupe.test.ts` are written the other way round.

Migration 003 was verified against a populated database built by the previous
release: 49 jobs, 31 snapshots, and 49 events migrated with zero orphans and zero
foreign key violations, and the following scan was correctly idempotent.

## Phase 2 notes

- Adapters: Greenhouse, Lever, Ashby, and a generic career page. Lever and Ashby
  provide structured salary ranges, which are preferred over parsing prose.
- Capture modes (`scoped`, `full`, `history`) and scope filters are configured in
  `config/sources.yaml`, previewable with `roleeye scope test`.
- `roleeye add <url>` uses ATS single-posting endpoints where they exist and falls
  back to page JSON-LD. It bypasses the scope filter deliberately: the user asked
  for that specific role.
- Every outbound request, including the browser fallback, passes the Phase 1 URL
  guard.
- Verified live across all three ATS providers: 588 postings fetched, scope
  dropped 327, `history` mode stored 18 rows with zero bodies, and a second scan
  reported 276 unchanged with no duplicates.
- Salary audit over 276 live postings: 275 parsed, all plausible (annual
  76k-440k, five genuinely hourly technician roles).

## Phase 1 notes

- Identity hierarchy: source job ID → canonical apply URL → company/title/location/content
  fingerprint. Titles alone never merge two jobs.
- Reposts are recorded as events; `first_seen_at` is never rewritten.
- A changed description writes a new snapshot and keeps the previous one.
- A failing source marks only its own `source_run` as failed; other sources still persist,
  and no job is marked closed because of a failed run.
- Verified end to end against a live public Greenhouse board: 16 jobs ingested, second scan
  reported 16 unchanged and created no duplicates.

## Pre-Phase-2 hardening notes

Full report: `docs/security-review-phase1.md`. Spend analysis: `docs/spend-analysis.md`.

- Postings are now treated as untrusted input at a single boundary: control
  characters stripped, escaped markup unable to re-materialize, descriptions capped.
- All outbound requests pass a URL guard (HTTPS only; private, loopback, and
  link-local ranges blocked; every redirect hop re-validated). Applied to every
  Phase 2 adapter, to `roleeye add <url>`, and — since Phase 2.5 — to every
  subresource the browser fallback requests.
- Log redaction covers URL-borne credentials and query-string secrets.
- Lockfile provenance corrected; `npm audit` reports 0 vulnerabilities.
- Measured corpus: median description 1,532 tokens, ~44% boilerplate
  (`scripts/measure-corpus.ts` reproduces it).

## Open items carried into Phase 2

- The lockfile was normalized textually because this machine cannot reach
  `registry.npmjs.org` (TLS interception). Confirm with a clean `npm ci` on a
  machine or CI runner with public registry access.
- `scripts/measure-corpus.ts` performs live network calls. It is a developer
  tool, never invoked by the product or the test suite.

## Before starting each phase

1. Summarize the phase.
2. List files to create/change.
3. List new dependencies.
4. Implement the smallest complete vertical slice.
5. Add and run tests.
6. Update this file and the README.
