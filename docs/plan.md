# RoleEye Plan

The single work queue for the `building-roleeye` skill. One task is taken per
skill invocation, implemented by the worker agent, reviewed by the evaluator
agent, and closed here by the orchestrator.

## Contract

This file has a fixed shape so the skill can read and update it mechanically.

- Every task has an **id** (`P<phase>-<n>`), a **status**, **depends**, a **why**,
  and **acceptance** criteria written as checkable observables.
- `status` is one of `todo`, `in-progress`, `done`, `blocked`, `deferred`.
- Only the orchestrator edits this file. The worker agent must never touch it.
- A task closes as `done` only after an `ACCEPT` or `ACCEPT_WITH_FOLLOWUPS`
  verdict, and records `attempts` and the verdict.
- Review follow-ups are appended as new `todo` tasks tagged `(from <id> review)`,
  never folded silently into the task being closed.
- `blocked` means the 3-attempt cap was reached with an outstanding blocker. The
  reason line names the decision a human owes the loop.

Phase definitions live in `architecture.md` §33. Rationale and history live in
`docs/progress.md`. Product direction lives in `docs/vision.md`. This file holds
only what is left to do and what has been closed.

---

## Shipped

Closed before this plan file existed; status taken from the phase table in
`docs/progress.md` and verified against the code in `src/`. Detail is in that
file's phase notes, not repeated here.

| Phase | Scope | Status |
|---|---|---|
| — | Repository skeleton | done |
| 0 | TypeScript project, CLI skeleton, config loader, SQLite + migrations, logging, tests, README | done |
| 1 | Source adapter interface, Greenhouse adapter, normalize, dedupe, snapshots, source runs, `scan` + `show` | done |
| — | Pre-Phase-2 security review and hardening | done |
| 2 | Lever, Ashby, career pages, discovery scope config, capture modes, `add`, `scope test` | done |
| 2.5 | Cross-model review; source/job separation (migration 003), closure lifecycle | done |
| 3a | Criteria engine, hard filters, authenticity screening, backup, scheduling, interactive `init` | done |
| 3b | Requirement extraction, reasoning provider, evaluation, cache, spend accounting, `evaluate` + `recommend` | done |
| 3c | Configuration portal (`roleeye ui`) | done |
| 3.5 | Notifier (terminal, desktop, webhook), daily digest, `digest` | done |
| 4 | Fact store, `.docx`/`.pdf` import as draft facts, archetype resumes, claim validation, `.docx` output | done |
| 5 | Application tracking, state history, notes, overrides, question bank, form inspection and answering | done |
| 6 | SQL search, FTS5, funnel + segment analytics, `stats`, `search`, `ask` | done |
| 6.5 | Review portal: queue, application timeline, analytics | done |
| 6.6 | Run control: portal-driven runs, live progress, schedule management, prompt review | done |
| 10a | Agent CLI as a reasoner, all tools denied | done |

Also closed: the three deferred Phase 4 items (migration 006 employer-scoped
fact identity, manual-override supersession, batched archetype assignment), and
the Phase 5 form-answering work from `docs/vision.md` §8.

---

## Ready now

### P9-1 — Tauri shell over the existing portal
- status: todo
- depends: —
- why: `docs/vision.md` §3 and §10 put the desktop shell next. It is a shell
  around the CLI, not a rewrite: Tauri loads the existing portal over
  `127.0.0.1` and runs the Node CLI as a sidecar, so there is one UI
  implementation and the no-bundler constraint holds.
- acceptance:
  - [ ] a Tauri app opens the existing portal; no portal HTML or logic is
        duplicated into the shell
  - [ ] the CLI runs as a managed sidecar, started and stopped with the window
  - [ ] the portal still works unchanged via `roleeye ui` in a browser
  - [ ] the shell binds nothing beyond `127.0.0.1`
  - [ ] the decision on whether the sidecar bundles a Node runtime or requires an
        installed one is recorded in `docs/progress.md`, with the reason
  - [ ] `npm run build`, `npm run typecheck` and `npm test` pass unchanged

### P9-2 — First-run engine selection
- status: todo
- depends: P9-1
- why: the app must be usable by someone who has not chosen between an agent
  CLI, a local model and an API key. Today that choice is config a user has to
  know exists.
- acceptance:
  - [ ] first run offers agent CLI, local model, or API key, and explains the
        cost consequence of each before the choice, not after
  - [ ] the selection writes the same YAML through the same schema the CLI reads
  - [ ] the equivalent CLI command exists and produces an identical result
  - [ ] a user who picks a local model is told which models are actually
        installed, not offered ones they have not pulled

### P9-3 — Schedule management and native notifications in the shell
- status: todo
- depends: P9-1
- why: the unattended loop is the product. If the shell cannot show the next run
  time and deliver a toast, the app is a viewer for work the user must still
  start by hand.
- acceptance:
  - [ ] the next scheduled run time is visible in the app
  - [ ] a schedule can be installed, inspected and removed from the app, and
        from the CLI, with the same result
  - [ ] a native notification is delivered with no terminal attached
  - [ ] every notification links to the local record behind it

### P9-4 — Live run log
- status: todo
- depends: P9-1
- why: trust in this system comes from inspectable decisions. A run that reports
  only a count is indistinguishable from one that did nothing.
- acceptance:
  - [ ] a run shows what was found, what was screened out and by which specific
        rule, what was evaluated, and what it cost
  - [ ] the run is fully reconstructable from the local database after the app
        closes
  - [ ] posting-derived text renders as text, never as markup
  - [ ] the log is readable by a screen reader and navigable by keyboard, and no
        state is conveyed by colour alone

### P9-5 — Assisted application, stopping at submit
- status: todo
- depends: P9-1, P9-4
- why: `agent.md` and `docs/vision.md` §6.4 draw the line here. Filling a form is
  assistance; submitting it is an assertion the user cannot retract.
- acceptance:
  - [ ] the app opens the posting, presents the archetype resume and the drafted
        answers, and stops
  - [ ] no code path in the shell can submit an application, and a test asserts it
  - [ ] every claim shown traces to an approved fact
  - [ ] the human's submit action is recorded as an application record

### P9-6 — Phase 7 is optional at runtime
- status: todo
- depends: P9-1
- why: `docs/vision.md` §10 — a speculative phase must not be a hard dependency
  of the adoption shell.
- acceptance:
  - [ ] the app starts, runs and answers with no retrieval service present
  - [ ] a missing retrieval service degrades a feature with an explanation and
        never fails a run

---

## Named gaps, not yet scheduled

From `docs/vision.md` §11. Each is a real hole; none is started. Promote to
`todo` with acceptance criteria before picking one up.

### G-1 — Backup and recovery policy
- status: deferred
- why: `roleeye backup` exists; a tested restore, export and migration path does
  not. Permanent local history without tested restore is a liability.

### G-2 — Encryption at rest
- status: deferred
- why: the database, imported resumes and demographic answers are plaintext.
  "Local" does not defend against malware, a shared Windows account, or a
  stolen laptop.

### G-3 — Sensitive-answer retention policy
- status: deferred
- why: no position yet on whether demographic, disability, veteran and
  background answers should be stored at all, or how they are deleted.

### G-4 — Installer and update security
- status: deferred
- depends: P9-1
- why: code signing, SmartScreen reputation, update trust and rollback.

### G-5 — Discovery recall
- status: deferred
- why: public ATS feeds miss many roles, and the user has no way to learn what
  was missed. The product's most honest weakness.

### G-6 — Outcome tracking completeness
- status: deferred
- why: manually entered outcomes are selective, which biases the Phase 8
  learning loop before it is built.

### G-7 — Quality metrics
- status: deferred
- why: no target exists for recommendation precision, false-negative rate, or
  trust calibration, so "better" is currently unfalsifiable.

### G-8 — Accessibility and internationalisation
- status: deferred
- why: screen readers, keyboard use, currencies, jurisdictions and non-US
  authorisation regimes. Partly absorbed by P9-3 and P9-4 for new surfaces; the
  existing portal and CLI output have never been audited.

---

## Speculative and gated

### P7 — Career memory / local RAG
- status: deferred
- why: build only if the tool is in daily use and the database holds enough
  history for semantic retrieval to beat the structured search that already
  ships in Phase 6. Must never become a hard dependency of Phase 9.

### P8 — Learning loop
- status: deferred
- depends: G-6
- why: outcome correlation and response rates by role profile and resume
  strategy. Depends on outcome data that is currently selective, and must never
  present correlation as causation.

### P10b — Tool-using agent / application assistant
- status: blocked
- reason: gated by design on the controls in `docs/vision.md` §6.3 — agent
  workspace with junction and symlink escapes blocked, a real sandbox, per-task
  approval, a recorded transcript, workspace-scoped writes and refused egress.
  Not to be started before those exist. Job postings are attacker-controlled
  text, and an approval-bypassed agent turns a prompt injection into code
  execution as the user.
