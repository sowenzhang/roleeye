---
name: building-roleeye
description: Build RoleEye one plan step at a time using a dual-agent loop — a worker agent implements a single task from docs/plan.md while an evaluator agent on a different model independently critiques it for correctness, security, performance, UX and accessibility. The two negotiate over findings until no blockers remain, and escalate to a human only on genuine deadlock. Use when implementing, continuing, or resuming RoleEye feature work, phases, or plan tasks.
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
        │                        blockers open: fix / withdraw / settle
        └──────────── negotiate, while blockers keep closing ──────┘
                                                                   │
                         no blockers left → SETTLEMENT RECORD → stop and report
                         3 rounds that close nothing → escalate to the human
```

The two agents are defined in `.github/agents/plan-worker.md` and
`.github/agents/plan-evaluator.md`. Those files are deliberately generic and
carry the full protocol; this skill carries what is specific to RoleEye. Do not
duplicate the agents' instructions into your prompts — reference them.

**Your job is orchestration only:** check the preconditions, reserve the task,
record the baseline, spawn both agents, relay messages verbatim, count attempts,
enforce the cap, verify the reviewer did not touch the tree, update the plan
file, and stop.

Be precise about what that neutrality covers, because it is narrower than it
sounds. **You do not judge the implementation** — you never write feature code,
never grade the work, and never overrule the evaluator on a blocker. You *do*
exercise judgement elsewhere: choosing the task, deciding the review tier below,
turning a one-line follow-up into a scoped task, and deciding whether a decision
belongs in the progress log. Those are real editorial powers over what gets
built next, so they are done visibly and, where they change the queue, with the
user's agreement. Claiming to be a neutral relay while quietly authoring the
backlog would be the more comfortable story and the false one.

## Choose the review tier first

The full loop costs up to six model cycles plus verification. That is worth it
for a migration and absurd for a typo. Match the ceremony to the risk, and say
which tier you picked and why:

| Tier | When | What runs |
|---|---|---|
| **Direct** | Docs, comments, a rename, a version bump — nothing behavioural | No loop. Do it yourself, run the checks, show the diff. |
| **Single pass** | Ordinary implementation inside existing patterns | Worker plus one evaluator pass. Expect it to close in one round. |
| **Full loop** | Migrations, trust boundaries, hostile input, auth, money, accessibility surfaces, architecture decisions | The whole protocol below, and consider a stronger evaluator model than the default (see Step 2). |

The tier is a judgement call you announce, not a rule you hide behind. When in
doubt, go up a tier.

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

### Preconditions, reservation, and baseline

Three things must be true or done **before** any agent is spawned.

1. **A clean working tree, and one loop at a time.** If `git status --porcelain`
   is not empty, stop and ask the user to commit, stash or discard. This
   precondition is doing a great deal of work: it makes the baseline exactly
   `HEAD`, it removes any question of whether an edit is the worker's, it keeps
   an unbounded diff out of the agents' prompts, and it makes the post-review
   tree check exact. Do not work around it.

   This skill assumes **one working tree and one active loop**. It has no lock: a
   reservation written to a file cannot stop a second session that read the file
   first, and a second worktree never sees it at all. Do not run two loops
   against one checkout.

2. **Reserve the task.** In `docs/plan.md`, set the task to `in-progress` and add
   `started: <date>`, `baseline: <sha>`, `attempt: 1`. Those three fields are the
   run's durable state — everything else lives only in this session's context and
   dies with it.

   On entry, if any task is already `in-progress`, do not spawn anything. Report
   it to the user with its `started` date and ask them to choose. Be honest about
   the options: an interrupted run **cannot be resumed** — the attempt history,
   the reports and the verdicts are gone with the session that held them. The
   real choices are to abandon it (revert or keep the partial work as a human
   decision, then set the task back to `todo`) or to restart it from a clean
   tree. Do not offer "resume" as though it were free.

3. **Record the baseline.** `git rev-parse HEAD`. With a clean tree that is the
   whole baseline. Both agents share one working tree, so "the evaluator started
   first" guarantees nothing about what it read — the worker may write before the
   evaluator looks. A commit SHA does not race; timing does.

If any of these fails, stop. Do not spawn a worker you cannot later account for.

## Step 2 — Spawn both agents together

Spawn them in the **same** tool block, in background mode. The evaluator starts
with the worker so it can read the task and the standards documents and form its
own expectation of a correct change before it ever sees the worker's account of
what it did. Its view of *the code* comes from the baseline SHA, not from timing.

**Worker** — agent type `plan-worker`, session default model, all tools.
**Evaluator** — agent type `plan-evaluator`, model `gpt-5.6-luna`, and no `edit`
tool.

If those agent types are not offered by the task tool, the fallback is
`general-purpose` with a prompt beginning `Read and follow
.github/agents/plan-worker.md` (or `plan-evaluator.md`) `completely; it defines
your role. Then:`.

For the worker that is a fair substitute. For the evaluator it is not, and you
must say so rather than paper over it: a fallback inherits none of the
frontmatter, and the spawn interface exposes a model override but **no per-agent
tool whitelist**. The read-only boundary therefore cannot be enforced at all on
this path — it degrades from a policy to a request. So:

- pass the model override explicitly; it is the one restriction you can enforce
- put the read-only rule in the prompt, and state that any write to the working
  tree is a protocol violation that voids the verdict
- **tell the user the boundary is unenforced on this path and ask before
  proceeding.** Do not describe the restrictions as "reapplied" — they are not.
  The post-review tree check in Step 3 becomes the only real control, which is
  detection after the fact, not prevention.

Preferably, fix the cause: register the custom agents (`/skills reload` and a
restart) so the frontmatter applies.

The evaluator **must** run on a different model from the worker. If it cannot,
stop and tell the user rather than running both on one model.

### What the second model is, and is not

`gpt-5.6-luna` is a deliberately cheap independent second pass. Two different
models with separate context are less likely to share a blind spot, and that is
the whole of the claim. It is **not** a safety gate, and nothing here has been
measured: no seeded-defect benchmark has been run, so treat its clean verdicts as
weak evidence rather than assurance.

Consequences worth acting on:

- On a **full tier** task — a migration, a trust boundary, hostile input,
  accessibility, an architecture decision — raise the evaluator to a stronger
  model, or add a specialist pass (`security-review`, `code-review`) alongside
  it. Cheap review of the changes that can actually hurt you is a false economy.
- Never present an `ACCEPT` from the light evaluator to the user as "reviewed and
  safe". Report which model gave the verdict, so its weight is visible.

Both prompts must include, in full (they are stateless and cannot see this
session):

- the task id, title, description and acceptance criteria, quoted from the plan
- the **absolute path of the current workspace root** — resolve it at runtime
  with `git rev-parse --show-toplevel`, never a remembered path — together with
  the operating system and shell you actually detected, and the path separator
  they imply
- the baseline commit SHA
- the standards documents to obey: `agent.md`, `architecture.md`, and the
  RoleEye invariants listed in Step 5 below
- the commands, read from `package.json` rather than assumed: currently
  `npm run typecheck`, `npm test`, `npm run build`, `npm run test:unit`,
  `npm run test:integration`, `npm run catalog:check`
- `Round 1. The loop continues while blockers are being closed; it stops only on
  deadlock, so treat a review as a negotiation, not a countdown.`
- for the evaluator only: `The worker's report will follow in a later message.
  Review the change as the diff from <baseline sha>, which was a clean tree.
  Until the report arrives, read the task and the standards documents and form
  your own expectation of what a correct change looks like. Do not modify the
  working tree; it is checked byte for byte.`

Then end your turn and wait for the worker's completion notification. Do not
poll.

### When the task is a decision, not a change

Some plan tasks (`P9-0` is the first) produce a recorded decision rather than
shipped code. The loop is unchanged, but two things are:

- tell the worker plainly that prototypes are throwaway, that the deliverable is
  the written comparison and the updated design document, and that nothing from
  the spike is to be left in `src/`
- tell the evaluator that this is a decision task, so it reviews the reasoning
  and the evidence rather than a diff — the agent file has a section for it

The baseline SHA and the tree check still apply. A spike that quietly leaves a
prototype behind is exactly the kind of thing they exist to catch.

## Step 3 — Relay the work report

When the worker reports, forward its `## WORK REPORT` **verbatim** to the
evaluator, plus:

- `git --no-pager diff --stat <baseline sha>` and
  `git --no-pager status --short`
- `Review the diff from <baseline sha>. Round <n>, <k> open blockers. Return your
  REVIEW VERDICT.`

Do not summarize, soften, or pre-filter the report. Do not add your own opinion
of the work — your opinion is not part of this loop, and colouring the evaluator's
input destroys the independence that makes it useful.

If the worker returns `Status: BLOCKED`, it has hit something it cannot decide —
not a review disagreement. Do not send it to the evaluator, and do **not** release
the task back to `todo`, which would return a question a human owes an answer to
into a queue that will pick it up again, forever. Instead leave the task
`in-progress`, add `waiting-for-human: <the decision needed>`, and stop.

Record `attempt: <n>` and `stalls: <n>` in the plan file before you stop. Both
persist whether or not the run reached a verdict, so a task that has already
burned its way to a deadlock cannot silently start over at zero.

### Check the reviewer

The evaluator has no edit tool, but it does have a shell, and a shell can write.
That boundary is a policy, not a sandbox, so verify it — and verify it exactly,
because `--stat` is not evidence. Line counts can be identical after an edit, and
an untracked file can be rewritten without moving `git status` at all.

Before handing the report to the evaluator, capture:

```powershell
git --no-pager diff <baseline sha> | Out-String
git status --porcelain=v1 -uall
git ls-files --others --exclude-standard | Get-FileHash
```

Capture the same three after the verdict and compare them **exactly**, not by
eye and not against the worker's list of files.

If anything differs, the verdict is void. Tell the user, show what moved, and
stop. Do not silently revert — a reviewer that edited the code under review is a
fact the human needs to see. This is detection, not prevention; it is the honest
limit of what this layer can do without an isolated checkout.

## Step 4 — Route the verdict

### Validate it first

An instruction is not a schema, and the evaluator can return something the
protocol has no route for. Check before you route, because improvising here is
where your neutrality actually leaks. A verdict is **invalid** if it:

- has no `Verdict:` line, or one that is not `ACCEPT`, `ACCEPT_WITH_FOLLOWUPS`
  or `REVISE`
- says `REVISE` with no finding marked `blocker`
- says `ACCEPT` or `ACCEPT_WITH_FOLLOWUPS` while listing a `blocker`
- is truncated mid-structure

On the first invalid verdict, return it to the evaluator once with: `Your verdict
did not parse: <the specific defect>. Re-issue it in the required format. Do not
change your findings or your reasoning — this is a formatting correction.` That
retry **does not consume a worker attempt**; the worker has done nothing wrong.

If the re-issued verdict is still invalid, stop. Record `protocol-failure` on the
task with the reason, leave it `in-progress`, and take it to the user with both
malformed outputs. Do not guess what the evaluator meant, and never infer an
`ACCEPT` from an unparseable reply.

### Then route

- **ACCEPT** → go to Step 5.
- **ACCEPT_WITH_FOLLOWUPS** → go to Step 5, and record each follow-up as
  described below.
- **REVISE** → forward the `## REVIEW VERDICT` verbatim to the worker with
  `This is round <n+1>. Blockers only — fix, contest with evidence, or propose a
  settlement.` Return to Step 3.

### What actually stops the loop

The loop runs until **no open blockers remain**. A blocker closes three ways, all
of them legitimate: the worker fixes it, the evaluator withdraws it, or the two
settle on a narrower fix or a bounded deferral. `major` and `minor` findings never
block; they become follow-ups and the work continues past them.

So a `REVISE` is not a stop. It is the next round of a negotiation, and the worker
keeps working through it.

What stops the loop is **not moving**. After each round, count the open blockers:

| Round outcome | Meaning | Action |
|---|---|---|
| Open blockers went down | Converging | Continue |
| Open blockers unchanged | Stalled round | Continue, and increment the stall count |
| Three consecutive stalled rounds | Deadlock — a real disagreement | Escalate |
| 8 worker attempts on one task | Runaway | Stop regardless, and say so |

Track `attempt` (worker cycles) and `stalls` (consecutive rounds that closed
nothing) in the plan file, and report both at the end. Three is the number that
matters, but it now counts *stuck* rounds rather than rounds — a loop making
steady progress over five rounds is working exactly as intended, and cutting it
off at three would have thrown away work that was nearly finished.

The runaway ceiling exists because "converging" can be gamed by an agent that
closes one trivial blocker per round forever. If you hit it, that is what
happened, and it is worth telling the user.

**On escalation**, set the task to `blocked` in `docs/plan.md` with a one-line
reason naming the decision it is waiting on, then report to the user: the
deadlocked blocker, the worker's position, the evaluator's position, the smallest
change the evaluator says would resolve it, and the one question only a human can
answer. Leave the working tree as it is. Do not revert the worker's changes, and
do not settle it yourself — you are the one participant with no independent view
of the code, which is exactly why you are not qualified to break the tie.

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

Be aware of what you are doing here. Turning one line from a light model into a
scoped task with acceptance criteria is authorship, not transcription — you are
deciding what future work means. So:

- **show the user both** the evaluator's original line and the entry you wrote
- **get their confirmation before adding anything to Ready now.** Backlog entries
  you may add and report; selectable tasks a human approves. A queue that grows
  itself from review chatter is how scope arrives without anyone choosing it.

If you cannot state checkable acceptance criteria for a follow-up, it is not a
task yet. Put it in the backlog section as a gap entry with its reason, where the
contract does not require acceptance criteria and nothing will select it by
mistake. A malformed entry in Ready now is worse than an honest one in the
backlog, because the next invocation will hand it to a worker.

## Step 5 — Close the task, write the settlement record, then stop

You, and only you, update `docs/plan.md`:

- flip the task from `in-progress` to `done` with today's date and a one-line
  result — this releases the reservation taken in Step 1
- add the follow-ups, each as a complete contract-compliant entry per Step 4
- record `attempts`, `stalls` and the final verdict on the task line

### The settlement record

Print this to the user, and append it under the task in `docs/plan.md`. It is the
point of the whole loop: not that two agents agreed, but *what they agreed to and
what it cost*. A reader six months from now needs to know which risks were
accepted deliberately, by whom, and on what reasoning — that is the difference
between a considered trade-off and an oversight nobody noticed.

```text
## SETTLEMENT RECORD — <task id> <task title>
Verdict: <final verdict>   Rounds: <n>   Stalls: <n>
Worker: <model>            Evaluator: <model>

Built
- <what now exists that did not before, 2-3 lines>

Blockers raised: <n> — fixed <n>, withdrawn <n>, settled <n>, escalated <n>
[F1] <category> — FIXED: <what changed>
[F2] <category> — WITHDRAWN: <why the finding did not hold>
[F3] <category> — SETTLED: <what was agreed>
     Residual risk: <what the project is now carrying>
     Reasoning: <why this was the right price>
     Tracked as: <follow-up id, or "not tracked, and why">

Trade-offs accepted
- <the choice, what was given up, and why that was the right side>

Follow-ups created
- <id> — <title>   (awaiting your approval before it becomes selectable)

Not done, deliberately
- <what was left alone, and where it belongs>
```

If a blocker was **escalated**, the record says so and the task is `blocked`, not
`done`. Never write a settlement record that implies agreement where a human still
has to decide.

If the change involved a design decision worth remembering beyond this task,
append one row to the decisions log at the top of `docs/progress.md` — decision
and rationale, in the voice already used there. Do not write a phase-notes essay
unless the task completes a whole phase.

Then **stop**. One task per skill invocation, and ask before starting the next.
The human stays in the loop between steps, which is the rule RoleEye itself is
built on.

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

A full worked run — both agents' messages, a settlement, and the escalation
branch — is in `references/example-run.md`. Read it before your first run; it is
faster than inferring the protocol from the rules above.
