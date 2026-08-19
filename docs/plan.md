# RoleEye Plan

The single work queue for the `building-roleeye` skill. One task is taken per
skill invocation, implemented by the worker agent, reviewed by the evaluator
agent, and closed here by the orchestrator.

## Contract

This file has a fixed shape so the skill can read and update it mechanically.
The contract binds **selectable tasks** — the entries under *Ready now*. Backlog
entries below that section are deliberately looser, and nothing there is
selectable.

**Selectable tasks (Ready now):**

- **id** — `P<phase>-<n>` for phase work, `G-<n>` for a promoted gap.
- **status** — `todo`, `in-progress`, `done`, `blocked`, or `folded`.
- **depends** — task ids, or `—`.
- **why** — the reason the work exists, not the remedy.
- **acceptance** — checkable observables: a command, an output, a state change.
- The orchestrator reserves a task by setting `in-progress` with `started`,
  `baseline` (the commit SHA the review is taken from), `attempt` and `stalls`,
  **before** spawning agents, and releases it by moving it to `done`, `blocked`,
  or back to `todo`. `attempt` counts worker cycles and `stalls` counts
  consecutive review rounds in which **no blocker closed** — closures, not the
  net number of open blockers, because a round that closes two and raises two is
  progress rather than a stall; both are updated as the loop
  runs, so a task that has already argued its way to a deadlock cannot quietly
  start over at zero.
- `blocked` means the loop deadlocked — three consecutive rounds closing nothing
  — with a blocker still open. The reason line names the decision a human owes
  the loop. It is never used for work that has not been attempted.
- An interrupted run is **not resumable**. The reports and verdicts lived in the
  orchestrator's context and are gone with it; only `started`, `baseline` and
  `attempt` survive. A reservation found on entry is reported to the human, who
  decides whether to abandon the partial work or restart from a clean tree —
  never silently taken over, and never advertised as a resume.
- Closes as `done` only after an `ACCEPT` or `ACCEPT_WITH_FOLLOWUPS` verdict, and
  records `attempts`, `stalls`, the verdict, and a settlement record naming every
  blocker that was fixed, withdrawn or settled, with the residual risk of each
  settlement.
- `blocked` means the loop deadlocked — three consecutive rounds closing no
  blocker — with one still open. The reason line names the decision a human owes
  the loop. It is never used for work that has not been attempted.
- `folded` means the task was absorbed into another and is kept only as a
  tombstone explaining why. Never selectable. Deleting such an entry would erase
  the reasoning that retired it, which is the part worth keeping.
- A reservation may also carry `waiting-for-human: <decision>` when the worker
  itself reported `BLOCKED`, or `protocol-failure: <reason>`
  when an agent returned output the loop could not route. Both leave the task
  `in-progress` and out of the queue, because both need a person.

**Backlog entries (Named gaps, Speculative and gated):**

- **id** and **why** are required. **status** is `deferred` or `gated`.
  `depends` is optional; `acceptance` is usually absent by design.
- `deferred` means real but unscheduled. `gated` means held by a design
  precondition rather than by a failed attempt.
- Promoting an entry means giving it acceptance criteria and a `todo` status and
  moving it under *Ready now*. That is a deliberate act, not something the
  orchestrator does on its way past.

**Both:**

- Only the orchestrator edits this file. The worker agent must never touch it.
- Review follow-ups are appended as complete entries in whichever section they
  qualify for, tagged `(from <id> review)`, never folded silently into the task
  being closed. A follow-up without checkable acceptance criteria belongs in the
  backlog, not in Ready now.

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

### P9-0 — Decide the desktop shell: Tauri, Wails, or no native shell
- status: done (2026-08-18) — no native shell: a Windows tray helper rendering in
  the user's browser, with the Node runtime bundled; Tauri named as the fallback
  with four reversal conditions. Recorded in `docs/desktop-shell-decision.md`.
- verdict: ACCEPT (round 3) · attempts: 3 · stalls: 0
- baseline: f04f8ca68c18735f054015b5b245ed1cf1b6580e
- depends: —
- why: `docs/vision.md` §3.1 names Tauri, but it argues for a *property* — a
  window that loads `127.0.0.1` and supervises the Node CLI as a sidecar — and
  then reaches Tauri as the way to get it. Several toolchains have that property.
  The same section already refuses to answer the bundled-runtime question by
  taste, and the framework underneath it deserves the same treatment. Deciding
  this once, with numbers, is cheaper than discovering it during P9-3 or G-4.
  This is a spike: its deliverable is a recorded decision, not shipped code.
- acceptance:
  - [ ] a written comparison in `docs/` judges at least three candidates against
        one set of criteria: **Tauri** (Rust), **Wails** (Go), and **no native
        shell** — the browser portal plus a launcher or tray helper. The third is
        not a formality; a comparison of two frameworks that never asks whether a
        framework is needed is rigged.
  - [ ] each candidate is taken as far as a throwaway prototype that opens the
        existing portal over `127.0.0.1` and starts and stops the Node CLI as a
        sidecar — or the specific point where it failed is recorded
  - [ ] measured numbers, not vendor claims: installer size, cold start, resident
        memory, and clean build time, on this machine, stated with how they were
        measured
  - [ ] states what each option costs against the `architecture.md` rule that
        `tsc` is the only build step, and which toolchain each adds to a
        contributor's machine
  - [ ] answers whether the choice constrains a future local analytics MCP server
        (G-9) or is orthogonal to it, and shows the reasoning rather than
        asserting the answer
  - [ ] covers Windows first — native toast delivery, Task Scheduler interaction,
        code signing and the update path (G-4) — and says plainly what is
        unverified on macOS and Linux
  - [ ] answers the open question in `docs/vision.md` §3.1, bundled Node runtime
        against required install, with measured installer sizes for both
  - [ ] the recommendation states the strongest argument against itself, and the
        condition that would reverse it
  - [ ] `docs/vision.md` §3 and §3.1 are updated to match the outcome — including
        if the outcome is that Tauri was right — and one row is added to the
        decisions log in `docs/progress.md`
  - [ ] no prototype code is merged into `src/`

```text
## SETTLEMENT RECORD — P9-0 Decide the desktop shell: Tauri, Wails, or no native shell
Verdict: ACCEPT   Rounds: 3   Stalls: 0
Worker: Claude Opus 5      Evaluator: gpt-5.6-sol

Built
- `docs/desktop-shell-decision.md` (37,738 B): three candidates — Tauri, Wails,
  and no native shell in three variants — each driven against the real
  token-bearing `roleeye ui` portal as a supervised sidecar, measured on this
  machine under one stated method, with the update path, toolchain cost, G-9
  and Windows-specific consequences argued rather than asserted.
- The decision: no native shell. A Windows tray helper rendering in the user's
  browser, with the Node runtime bundled. Tauri is the named fallback with four
  reversal conditions, two testable in P9-1/P9-3.
- `docs/vision.md` §3/§3.1 and `architecture.md` §33 no longer assert Tauri;
  two rows added to the `docs/progress.md` decisions log, one of them marked
  Reversed against the 2026-08-13 Tauri row.

Blockers raised: 4 — fixed 4, withdrawn 0, settled 0, escalated 0
[F1] measurements — FIXED: the resident-memory method counted only new process
     IDs, so the warm-browser candidate's footprint excluded growth inside Edge
     processes that already existed — undercounting the option the
     recommendation favours. Re-measured by command-line process-set membership
     and before/after working-set deltas, 5 runs, medians and ranges. The
     corrected figure moved against the worker's own prediction (440.3 MB →
     185.0 MB warm, 812.8 MB cold) and was reported rather than banked.
[F2] acceptance criteria — FIXED: the Windows update path, an explicit
     criterion, was unaddressed for the chosen option. New §5.1 covers all three
     candidates and establishes four constraints by measurement.
[F3] false measurement claim — FIXED: §5.1 claimed `better-sqlite3` loaded
     "against the shipped runtime", but the test had installed the
     required-Node package and launched system Node. The worker took the harder
     of the two offered remedies and ran the bundled package for real.
[F4] false update-path claim — FIXED: the document claimed install-over-the-top
     destroys colocated data; the NSIS script deletes only on uninstall.
     Re-tested both halves: over-the-top survives, uninstall destroys.

Trade-offs accepted
- The recommendation now rests on an unmeasured behavioural assumption — that
  users keep a browser open. Named as an assumption in §3.3 and §8 rather than
  presented as measured. Given up: a clean headline. Gained: a claim that does
  not overstate its evidence, and a stated case where the decision is worse for
  the user.
- Working sets are summed without correcting for shared pages, inflating every
  multi-process candidate. Distorts absolutes more than the comparison.
- §5.1 stops at analysis: no updater was built and no signed update applied.
  That was the scope the finding set, and it is enough to answer whether the
  update path reverses the shell choice. It does not.
- The bundled-runtime check demonstrates self-sufficiency, not ABI pinning —
  bundled and system Node are the same version here. Recorded in §8 rather than
  overstated.
- `architecture.md` §33 was edited although the task did not list it, because
  leaving it asserting Tauri would have created the documentation drift this
  project logs decisions about.

Follow-ups created
- None. The evaluator raised no non-blocking findings in any round.

Not done, deliberately
- The tray helper itself — P9-1. Prototypes are throwaway and remain outside the
  repository in `%TEMP%\roleeye-p9-0-spike`; `src/` and `tests/` were never
  touched in any round.
- Moving `data/`, `config/`, `profile/` and `artifacts/` out of any install
  layout — recorded as a constraint inherited by P9-1 and G-4, and logged in the
  decisions log, after an uninstall was observed deleting the career database.
- `roleeye ui` exiting when stdin closes, and the tokenized URL landing in
  browser history — both named as costs of this decision, both P9-1.
- The toast-identity experiment, which failed to discriminate and is recorded as
  unverified rather than filled in with a vendor claim. It is reversal
  condition 2 and the load-bearing unknown for P9-3.
- An end-to-end signed update, and a real ABI-mismatch test — §8, scoped to G-4.
```

### P9-1 — Desktop shell over the existing portal
- status: todo
- depends: P9-0
- why: `docs/vision.md` §3 and §10 put the desktop shell next. It is a shell
  around the CLI, not a rewrite: the window loads the existing portal over
  `127.0.0.1` and the Node CLI runs as a sidecar, so there is one UI
  implementation and the no-bundler constraint holds. The toolchain is whatever
  P9-0 concluded; this task does not reopen it.
- acceptance:
  - [ ] the shell chosen in P9-0 opens the existing portal; no portal HTML or
        logic is duplicated into it
  - [ ] the CLI runs as a managed sidecar, started and stopped with the window
  - [ ] the portal still works unchanged via `roleeye ui` in a browser
  - [ ] the shell binds nothing beyond `127.0.0.1`
  - [ ] the bundled-runtime decision from P9-0 is implemented as decided
  - [ ] **a production build command exists and is documented**, and the built
        artefact launches on a machine that is not the development checkout.
        `npm run build`, `npm run typecheck` and `npm test` are the existing
        checks and none of them builds a shell; a task that ships only a
        dev-mode scaffold satisfies them and delivers nothing.
  - [ ] the app starts with no retrieval service present, and never requires one
        (`docs/vision.md` §10: Phase 7 must not be a hard dependency of the
        adoption shell)
  - [ ] lifecycle smoke checks pass and are recorded: sidecar startup failure is
        surfaced rather than hung on; a port collision is handled; a sidecar
        crash is reported to the user; closing the window leaves no orphan
        process
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

### P9-3 — Native notifications and deep links
- status: todo
- depends: P9-1
- why: schedule management already exists in the portal (`src/portal/run-page.ts`
  shows the next run and installs and removes schedules), so P9-1 brings it into
  the app for free. What is genuinely missing is the shell's half: a native
  notification delivered with no terminal attached, and a link in it that opens
  the app on the right record. Without that the unattended loop has no way to
  reach the user.
- acceptance:
  - [ ] a native notification is delivered by a scheduled run with no terminal
        attached and the app closed
  - [ ] clicking a notification opens the app directly on the record behind it,
        by URI or deep link, and does so when the app was not already running
  - [ ] the existing portal schedule controls still work inside the shell — this
        is a regression check, not new implementation
  - [ ] notification text derived from a posting is escaped; a title containing
        quotes or control characters cannot break the notification payload
        (see the Phase 3.5 notes in `docs/progress.md`)

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

### P9-5 — Application handoff
- status: todo
- depends: P9-1, P9-4
- why: `agent.md` and `docs/vision.md` §6.4 draw the line here. The app gathers
  what the human needs and then gets out of the way. Note that `architecture.md`
  places assisted application in Phase 9 while `docs/vision.md` §10 sequences
  application assistance last — this task is deliberately the narrow reading:
  **handoff only, no browser or form automation of any kind.** Populating fields
  on a live site stays in gated P10b, behind the §6.3 controls.
- acceptance:
  - [ ] the app opens the posting, presents the archetype resume and the drafted
        answers, and stops
  - [ ] no code path in the shell drives a browser, fills a field, or submits;
        a test asserts it
  - [ ] every claim shown traces to an approved fact
  - [ ] the application record is created by an explicit user action ("record
        that I submitted"), never inferred — submission happens on a site the
        app cannot observe, so claiming to detect it would be a lie in the data

### P9-6 — Phase 7 is optional at runtime
- status: folded
- into: P9-1
- why: Phase 7 does not exist, so "the app does not require it" is satisfied by
  changing nothing — a criterion that cannot fail is not a task. The startup half
  is now a P9-1 acceptance criterion. Graceful degradation of retrieval features
  becomes a real requirement only once there is a retrieval feature to degrade,
  and belongs to P7 at that point.

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

### G-9 — Local analytics MCP server
- status: deferred
- why: the career history is a local SQLite database that only RoleEye's own
  commands can reach. Exposing it as a local MCP server would let a coding agent
  the user already owns ask questions of it directly, which is the same argument
  that made the agent-as-reasoner (10a) the cheapest engine. It is named here
  because it is a plausible long-term shape, not because it is scheduled — and
  P9-0 must say whether the desktop shell choice constrains it or is orthogonal
  to it, since deciding that later is the expensive order.
- open: whether the server is part of the Node CLI (likely) or of the shell; and
  whether read-only SQL over career history is safe to expose to an agent whose
  context also holds attacker-authored posting text.

---

## Speculative and gated

### P7 — Career memory / local RAG
- status: deferred
- why: build only if the tool is in daily use and the database holds enough
  history for semantic retrieval to beat the structured search that already
  ships in Phase 6. Must never become a hard dependency of Phase 9 — and when it
  exists, it owns the requirement that a missing retrieval service degrades a
  feature with an explanation rather than failing a run (the live half of the
  folded P9-6).

### P8 — Learning loop
- status: deferred
- depends: G-6
- why: outcome correlation and response rates by role profile and resume
  strategy. Depends on outcome data that is currently selective, and must never
  present correlation as causation.

### P10b — Tool-using agent / application assistant
- status: gated
- reason: gated by design on the controls in `docs/vision.md` §6.3 — agent
  workspace with junction and symlink escapes blocked, a real sandbox, per-task
  approval, a recorded transcript, workspace-scoped writes and refused egress.
  Not to be started before those exist. Job postings are attacker-controlled
  text, and an approval-bypassed agent turns a prompt injection into code
  execution as the user.
