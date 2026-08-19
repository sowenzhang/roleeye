---
name: building-roleeye
description: Build RoleEye one plan step at a time using a dual-agent loop — a worker agent implements a single task from docs/plan.md while an evaluator agent on a different model independently critiques it for correctness, security, performance, UX and accessibility, with a hard cap of 3 attempts. Use when implementing, continuing, or resuming RoleEye feature work, phases, or plan tasks.
---

# Building RoleEye

## Overview

RoleEye is built by two agents supervised by you, the orchestrator. You never
implement plan tasks yourself.

```text
docs/plan.md → reserve ONE task, record baseline SHA
                  ├─ spawn plan-worker    (session model, full tools)
                  └─ spawn plan-evaluator (light GPT model, no edit tool)  ← spawned together
worker implements → WORK REPORT → you forward it → evaluator → REVIEW VERDICT
        ↑                                                          │
        └──────────── REVISE, max 3 worker attempts ───────────────┘
                                                                   │
                             ACCEPT → you update docs/plan.md → stop and report
```

The two agents are defined in `.github/agents/plan-worker.md` and
`.github/agents/plan-evaluator.md`. Those files are deliberately generic and
carry the full protocol; this skill carries what is specific to RoleEye. Do not
duplicate the agents' instructions into your prompts — reference them.

**Your job is orchestration only:** reserve the task, record the baseline, spawn
both agents, relay messages verbatim, count attempts, enforce the cap, verify the
reviewer did not touch the tree, update the plan file, and stop. You do not write
feature code, you do not grade the work, and you do not overrule the evaluator on
a blocker.

## Step 1 — Load context and pick exactly one task

Read, in this order:

1. `docs/plan.md` — the plan file this skill owns. Task IDs, status, dependencies.
2. `agent.md` — the operating principles. They are binding, not advisory.
3. `architecture.md` — the phase definitions (§33) and the module boundaries.
4. `docs/progress.md` — what shipped and why; the decisions log at the top.

Pick the first task in **Ready now** whose status is `todo` and whose
dependencies are all `done`. If the user named a task, use theirs, but say so if
its dependencies are unmet. Backlog entries (`G-*`, `P7`, `P8`, `P10b`) are not
selectable until they have been normalized into Ready now — see the plan file's
contract.

Announce the chosen task to the user in one line. If zero tasks are ready, say
that and stop — do not invent work.

### Reserve the task, and record the baseline

Two bookkeeping steps must happen **before** any agent is spawned, because both
of them are unrecoverable afterwards.

1. **Reserve.** Set the task's status to `in-progress` in `docs/plan.md` and add
   `started: <date>`. A task left `todo` while a worker is running invites a
   second invocation, or a restart after an interruption, to pick up the same
   task and run a second worker against the same files.

   On entry, if a task is already `in-progress`, do not spawn anything. Report it
   to the user with its `started` date and ask whether to resume it, release it
   back to `todo`, or take it over. A crashed run leaves a stale reservation, and
   only a human can tell the difference between stale and live.

2. **Record the baseline.** Capture and keep in your own context:

   ```powershell
   git rev-parse HEAD
   git --no-pager status --short
   git --no-pager diff
   ```

   This is the immutable reference the review is taken against. Both agents share
   one working tree, so "the evaluator started first" guarantees nothing about
   what it observed — the worker may write before the evaluator reads. A commit
   SHA plus the pre-existing dirty diff does not race. If the tree is dirty at
   the start, say so to the user and include that diff in the evaluator's prompt,
   so pre-existing changes are never attributed to the worker.

If reservation or baseline capture fails, stop. Do not spawn a worker you cannot
later account for.

## Step 2 — Spawn both agents together

Spawn them in the **same** tool block, in background mode. The evaluator starts
with the worker so it can read the task and the standards documents and form its
own expectation of a correct change before it ever sees the worker's account of
what it did. Its view of *the code* comes from the baseline SHA, not from timing.

**Worker** — agent type `plan-worker`, session default model, all tools.
**Evaluator** — agent type `plan-evaluator`, model `gpt-5.6-luna`, and no `edit`
tool.

If those agent types are not offered by the task tool, fall back to
`general-purpose` and begin the prompt with: `Read and follow
.github/agents/plan-worker.md` (or `plan-evaluator.md`) `completely; it defines
your role. Then:`. For the evaluator fallback you must also reproduce by hand
what its frontmatter would have applied, because a fallback inherits none of it:

- pass the model override explicitly
- restrict its tools to the read-only set (`read`, `search`, `execute`, `web`);
  never hand a fallback evaluator an edit tool
- state in the prompt that it may run only verifying commands, and that any
  write to the working tree is a protocol violation that voids its verdict

The evaluator **must** run on a different model from the worker. If it cannot,
stop and tell the user rather than running both on one model — a same-model
review is close to worthless here.

Both prompts must include, in full (they are stateless and cannot see this
session):

- the task id, title, description and acceptance criteria, quoted from the plan
- the **absolute path of the current workspace root** — resolve it at runtime
  with `git rev-parse --show-toplevel`, never a remembered path — together with
  the operating system and shell you actually detected, and the path separator
  they imply
- the baseline commit SHA, and the pre-existing dirty diff if there was one
- the standards documents to obey: `agent.md`, `architecture.md`, and the
  RoleEye invariants listed in Step 5 below
- the commands, read from `package.json` rather than assumed: currently
  `npm run typecheck`, `npm test`, `npm run build`, `npm run test:unit`,
  `npm run test:integration`, `npm run catalog:check`
- `Attempt 1 of 3`
- for the evaluator only: `The worker's report will follow in a later message.
  Review the change as the diff from <baseline sha>, not as whatever the working
  tree happens to hold when you first look at it. Until the report arrives, read
  the task and the standards documents and form your own expectation of what a
  correct change looks like. Do not modify the working tree; it is checked.`

Then end your turn and wait for the worker's completion notification. Do not
poll.

## Step 3 — Relay the work report

When the worker reports, forward its `## WORK REPORT` **verbatim** to the
evaluator, plus:

- `git --no-pager diff --stat <baseline sha>` and
  `git --no-pager status --short`
- `Review the diff from <baseline sha>. Attempt <n> of 3. Return your REVIEW
  VERDICT.`

Do not summarize, soften, or pre-filter the report. Do not add your own opinion
of the work — your opinion is not part of this loop, and colouring the evaluator's
input destroys the independence that makes it useful.

If the worker returns `Status: BLOCKED`, skip the evaluator, release the
reservation by setting the task back to `todo` with a one-line reason, and take
the block to the user with the specific decision that would unblock it.

### Check the reviewer

The evaluator has no edit tool, but it does have a shell, and a shell can write.
That boundary is a policy, not a sandbox, so verify it rather than trusting it:
after each verdict, run `git --no-pager status --short` and
`git --no-pager diff --stat <baseline sha>` again and compare against what the
worker reported touching.

If the evaluator changed anything, its verdict is void. Tell the user, show the
unexpected paths, and stop. Do not silently revert — a reviewer that edited the
code under review is a fact the human needs to see.

## Step 4 — Route the verdict

- **ACCEPT** → go to Step 5.
- **ACCEPT_WITH_FOLLOWUPS** → go to Step 5, and record each follow-up as
  described below.
- **REVISE** and attempt < 3 → forward the `## REVIEW VERDICT` verbatim to the
  worker with `This is attempt <n+1> of 3. Address the blockers only.` Return to
  Step 3.
- **REVISE** and attempt = 3 → **stop the loop.** Do not spawn a fourth attempt
  and do not resolve the disagreement yourself.

An attempt is one worker work cycle. The first implementation is attempt 1; each
revision round increments it. The cap is 3 and it is hard.

### Recording follow-ups

A follow-up arrives as one line — an item and a destination. The plan file's
contract needs more than that, so **you** write the task; you do not paste the
evaluator's line into the queue and call it an entry. For each follow-up produce
a complete entry: an id in the existing scheme, `status: todo`, `depends` (at
minimum the task it came from, if the work builds on it), a `why` that names the
defect rather than the remedy, and `acceptance` criteria stating an observable —
a command, an output, a state change. Tag it `(from <task id> review)`, and carry
the evaluator's `Recommend` line into the acceptance criteria where it is already
concrete enough to check.

If you cannot state checkable acceptance criteria for a follow-up, it is not a
task yet. Put it in the backlog section as a gap entry with its reason, where the
contract does not require acceptance criteria and nothing will select it by
mistake. A malformed entry in Ready now is worse than an honest one in the
backlog, because the next invocation will hand it to a worker.

**On escalation at attempt 3**, set the task to `blocked` in `docs/plan.md` with
a one-line reason naming the decision it is waiting on, then report to the user:
the outstanding blocker, the worker's position, the evaluator's position, the
smallest change the evaluator says would resolve it, and the one question only a
human can answer. Leave the working tree as it is. Do not revert the worker's
changes.

## Step 5 — Close the task, then stop

You, and only you, update `docs/plan.md`:

- flip the task from `in-progress` to `done` with today's date and a one-line
  result — this releases the reservation taken in Step 1
- add the follow-ups, each as a complete contract-compliant entry per Step 4
- record `attempts: <n>` and the final verdict on the task line

If the change involved a real design decision or a trade-off worth remembering,
append one row to the decisions log at the top of `docs/progress.md` — decision
and rationale, in the voice already used there. Do not write a phase-notes essay
unless the task completes a whole phase.

Then **stop**. Report to the user in under ten lines: what shipped, the verdict,
the attempts used, and the next ready task. Ask before starting it. One task per
skill invocation is the contract; the human stays in the loop between steps,
which is the same rule RoleEye itself is built on.

Do not commit or push unless the user asks.

## RoleEye invariants — pass these to both agents

These come from `agent.md` and `docs/vision.md`. A change that breaks one of them
is a blocker, not a discussion:

1. **Human in the loop.** The system may recommend, draft, tailor and even fill a
   form. It must never submit an application. No code path may press submit.
2. **Local first.** The local SQLite database is authoritative. No feature may
   require a remote service to function.
3. **Deterministic code before model calls.** Fetching, parsing, dedupe,
   timestamps, persistence, filtering, state changes and scheduling are code, not
   prompts. A posting that fails a deterministic filter must never reach a model.
4. **Never invent resume facts.** Every generated claim traces to an approved
   fact in the fact store.
5. **Preserve history.** Nothing discovered is ever deleted — closed, expired,
   rejected and skipped roles all stay queryable.
6. **Every posting is untrusted input.** Titles, company names, descriptions,
   extracted requirements and form questions are attacker-controlled text.
   Render as text, never as markup; never as shell, SQL or prompt instructions.
7. **Spend is accounted, not estimated.** Every model call records stage, model,
   tokens and cost against the budget; an exhausted budget stops the run cleanly.
8. **No business logic in the web layer.** The portal is a client over existing
   modules and writes the same YAML through the same schemas the CLI uses; it
   binds to `127.0.0.1` only.
9. **Migrations are forward-only TypeScript modules**, and a backup is taken
   before every migration.
10. **The database is the answer before RAG is.** Structured questions get SQL.

## Notes on this project

- Windows and PowerShell. `&&` chains only external commands; use `;` otherwise.
- Node 22+, strict TypeScript, ESM. `tsx` runs sources directly; `npm run build`
  is `tsc`. Tests are `node:test` via `tsx --test`.
- `npm run typecheck` uses `tsconfig.tests.json` and covers tests too — it is the
  cheapest signal, so run it before the full suite.
- The portal's page script lives as a string inside a `.ts` file, so the compiler
  never sees it. It has a DOM-shim harness in `tests/`; a change to that script
  that does not exercise the harness is untested, whatever the typechecker says.
- CI (`.github/workflows/ci.yml`) runs build, typecheck and tests on every push.
- Accessibility applies to terminal output too: colour must never be the only
  thing carrying meaning.

## Reusing this loop elsewhere

The two agent files are project-agnostic and can be copied to any repository as
they are. See `references/porting.md`.
