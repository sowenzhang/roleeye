---
name: building-roleeye
description: Build RoleEye one plan step at a time using a dual-agent loop — a worker agent implements a single task from docs/plan.md while an evaluator agent on a different model independently critiques it for correctness, security, performance, UX and accessibility, with a hard cap of 3 attempts. Use when implementing, continuing, or resuming RoleEye feature work, phases, or plan tasks.
---

# Building RoleEye

## Overview

RoleEye is built by two agents supervised by you, the orchestrator. You never
implement plan tasks yourself.

```text
docs/plan.md → pick ONE task
                  ├─ spawn plan-worker    (session model, full tools)
                  └─ spawn plan-evaluator (light GPT model, read-only)   ← spawned together
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

**Your job is orchestration only:** pick the task, spawn both agents, relay
messages verbatim, count attempts, enforce the cap, update the plan file, and
stop. You do not write feature code, you do not grade the work, and you do not
overrule the evaluator on a blocker.

## Step 1 — Load context and pick exactly one task

Read, in this order:

1. `docs/plan.md` — the plan file this skill owns. Task IDs, status, dependencies.
2. `agent.md` — the operating principles. They are binding, not advisory.
3. `architecture.md` — the phase definitions (§33) and the module boundaries.
4. `docs/progress.md` — what shipped and why; the decisions log at the top.

Pick the first task whose status is `todo` and whose dependencies are all `done`.
If the user named a task, use theirs, but say so if its dependencies are unmet.

Announce the chosen task to the user in one line before spawning anything. If
zero tasks are ready, say that and stop — do not invent work.

## Step 2 — Spawn both agents together

Spawn them in the **same** tool block, in background mode. The evaluator starts
when the worker starts so it can read the pre-change state of the repository and
form its own view of the task before it ever sees the worker's account of it.

**Worker** — agent type `plan-worker`, session default model, all tools.
**Evaluator** — agent type `plan-evaluator`, model `gpt-5.6-luna`, read-only.

If those agent types are not offered by the task tool, fall back to
`general-purpose` and begin the prompt with: `Read and follow
.github/agents/plan-worker.md` (or `plan-evaluator.md`) `completely; it defines
your role. Then:` — and for the evaluator pass the model override explicitly.
The evaluator **must** run on a different model from the worker; if it cannot,
stop and tell the user rather than running both on one model, because a
same-model review is close to worthless here.

Both prompts must include, in full (they are stateless and cannot see this
session):

- the task id, title, description and acceptance criteria, quoted from the plan
- `Repo: C:\personal\projects\roleeye` (Windows, PowerShell, use backslash paths)
- the standards documents to obey: `agent.md`, `architecture.md`, and the
  RoleEye invariants listed in Step 5 below
- the commands: `npm run typecheck`, `npm test`, `npm run build`,
  `npm run test:unit`, `npm run test:integration`, `npm run catalog:check`
- `Attempt 1 of 3`
- for the evaluator only: `The worker's report will follow in a later message.
  Until then, read the task, the standards documents and the current state of
  the repository, and form your own expectation of what a correct change looks
  like.`

Then end your turn and wait for the worker's completion notification. Do not
poll.

## Step 3 — Relay the work report

When the worker reports, forward its `## WORK REPORT` **verbatim** to the
evaluator, plus:

- the output of `git --no-pager diff --stat` and `git --no-pager status --short`
- `Attempt <n> of 3. Return your REVIEW VERDICT.`

Do not summarize, soften, or pre-filter the report. Do not add your own opinion
of the work — your opinion is not part of this loop, and colouring the evaluator's
input destroys the independence that makes it useful.

If the worker returns `Status: BLOCKED`, skip the evaluator, and take the block
to the user with the specific decision that would unblock it.

## Step 4 — Route the verdict

- **ACCEPT** → go to Step 5.
- **ACCEPT_WITH_FOLLOWUPS** → go to Step 5, and add each follow-up to
  `docs/plan.md` as a new `todo` task with its source noted.
- **REVISE** and attempt < 3 → forward the `## REVIEW VERDICT` verbatim to the
  worker with `This is attempt <n+1> of 3. Address the blockers only.` Return to
  Step 3.
- **REVISE** and attempt = 3 → **stop the loop.** Do not spawn a fourth attempt
  and do not resolve the disagreement yourself.

An attempt is one worker work cycle. The first implementation is attempt 1; each
revision round increments it. The cap is 3 and it is hard.

**On escalation at attempt 3**, mark the task `blocked` in `docs/plan.md` with a
one-line reason, then report to the user: the outstanding blocker, the worker's
position, the evaluator's position, the smallest change the evaluator says would
resolve it, and the one question only a human can answer. Leave the working tree
as it is. Do not revert the worker's changes.

## Step 5 — Close the task, then stop

You, and only you, update `docs/plan.md`:

- flip the task to `done` with today's date and a one-line result
- add any follow-ups as new `todo` tasks, with `(from <task id> review)`
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
