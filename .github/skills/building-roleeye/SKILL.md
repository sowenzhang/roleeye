# Building RoleEye

Implement one task from `docs/plan.md`, then have it criticised by models that
did not write it, and fix what they find before you close it.

## Overview

You do the work yourself. What you do **not** do is decide, alone, that the work
is good.

```text
docs/plan.md → pick ONE task
       │
       ├─ you implement it, and write a WORK REPORT
       │
       ├─ critique (parallel, both on models different from yours and each other)
       │     ├─ code-review  → [R] facts about the lines
       │     └─ plan-critic  → [C] the reasoning, every blocker priced
       │
       ├─ respond: fix / contest with evidence / propose a different price
       │     ↑                                              │
       │     └──── re-critique, while blockers keep closing ┘
       │
       └─ no blockers left → validate → SETTLEMENT RECORD → stop
                             3 rounds that close nothing → ask the human
```

There is no worker agent and no negotiating evaluator. That design was tried and
removed: it cost several model cycles per task to buy one property — *someone
else, on a different model, reads the diff* — which this shape buys directly.

**The one rule that makes this worth anything:** you are the author, so you do
**not** get to dismiss a finding on your own authority. A blocker closes when you
fix it, when the critic that raised it withdraws it, or when the human decides.
Never because you disagreed with it and moved on. Everything else here is
convenience; that rule is the whole product.

## Step 1 — Pick exactly one task

Read `docs/plan.md`. Take the first task in *Ready now* whose `depends` are all
`done`, unless the user named one. Read its `why` and `acceptance` fields, and
the design documents it points at.

State which task you picked and why, then confirm with the user before you start
if the choice was not obvious.

Set the task to `in-progress` with `started: <date>`. You do not need a clean
tree, but if one is not clean, note which files were already modified before you
touch anything — otherwise the critique will be reviewing someone else's work
alongside yours and neither of you will know.

**One task per invocation.** Do not start the next one. If you finish early, stop
early. Scope creep is the failure this whole shape exists to prevent.

## Step 2 — Implement it

Follow, in this order of authority: `agent.md`, `architecture.md`, the design doc
the task names, then the conventions visible in neighbouring code. Existing
convention beats your preference, every time.

- **Smallest complete vertical slice.** Working end to end beats broad and half
  wired.
- **Tests are part of the task.** Add or extend tests that would fail without
  your change.
- **Run what already exists.** Never introduce a new tool to validate a change.
- **Never weaken a check to make it pass.** Do not delete an assertion, skip a
  test, loosen a type, or add a suppression to get green. If a check is wrong,
  say so and leave it failing.
- **Treat external and user-supplied data as hostile**, including text you merely
  display.
- **No secrets** in code, logs, fixtures or commits.

Then write a `## WORK REPORT` — not for ceremony, but because the critics get it
and cannot see your reasoning otherwise. Anything you leave out is something they
have to guess at or go find.

```text
## WORK REPORT
Task: <task id> — <task title>
Round: <n>

### What I changed and why
<2-6 sentences. The intent, not a file listing.>

### Files touched
- <path> — <what changed there, one line>

### Commands run
- `<command>` -> <pass/fail, and the number that matters>

### Acceptance criteria
- <criterion> -> met / not met, and the evidence

### Trade-offs I made
- <choice> — <what I gave up, and why that was the right side of the trade>

### Risks and weak spots
- <the thing you would look at first if this broke in production>

### Deliberately not done
- <in-scope-adjacent work you left alone, and where it belongs instead>
```

Write it honestly. You are about to hand it to two models whose job is to check
it against the diff, and an overstated claim is itself a blocking finding.

## Step 3 — Critique

Spawn both in the **same tool block** so they run in parallel. Neither sees the
other's findings; that independence is the property being bought.

| Critic | Agent | Owns | Negotiable? |
|---|---|---|---|
| **Facts** | `code-review` (built-in) | line-level defects — off-by-one, unhandled error paths, regex gaps, races, circular tests | No |
| **Reasoning** | `plan-critic` (`.github/agents/plan-critic.md`) | is the premise true, were the criteria met *as written*, is the trade-off priced or asserted | **Yes — this is the negotiation** |

Style and convention belong to **neither**. They are declarative and live in
`agent.md`, `.editorconfig` and the linters, which apply every time without a
model. A critique finding about naming or formatting is a defect in the critique.

**Model selection.** Both must run on a model different from your session model
and, where possible, from each other. `plan-critic` declares its own model in its
frontmatter — override it only to raise it, never to save money. If you cannot
get two distinct non-session models, say so rather than quietly doubling up: a
critic sharing your model shares your blind spot, which is the one thing you are
paying to avoid.

**Prime them.** Before spawning, write down what you would attack if you were
trying to break this change, name the files and the specific properties you
doubt, and put that list in both prompts. A critic told "review this diff" and
one given five concrete hypotheses to disprove do not perform comparably, and the
gap is large enough to be mistaken for model quality. When you report what each
found, say whether the finding was prompted — otherwise you will conclude a model
is strong when your prompt was.

Both prompts carry, in full (they are stateless):

- the task id, title and acceptance criteria, quoted from the plan
- the workspace root from `git rev-parse --show-toplevel`, never a remembered
  path, plus the OS and shell you detected
- `Review the change: git --no-pager diff` (name the pre-existing dirty files, if
  any, as not under review)
- your `## WORK REPORT` verbatim
- the standards documents: `agent.md`, `architecture.md`, and the RoleEye
  invariants below
- the priming list
- `You are read-only. Do not edit, create or delete any file.`
- for `code-review` only: `Report findings as [R<n>] with a severity of blocker,
  major or minor, a file:line, the problem, and the smallest fix. Facts only — no
  style, formatting or naming preferences. Skip anything that would have applied
  equally before this change.`
- from round two on, for `code-review` only: the `[R]` findings you have fixed,
  quoted, with `State for each whether the fix holds or the defect has recurred.`

That last line matters. `code-review` is spawned fresh each round and cannot
remember what it raised, so a fix that silently did not work comes back as a
brand-new finding — which reads as progress while the same defect circulates. Ask
it directly instead. Do not try to match the texts yourself: deciding whether "an
off-by-one" and "loop bound excludes the last element" are one flaw is triage,
and you are the author.

## Step 4 — Respond to the findings

Keep one list for the task: every finding with its id (`[R<n>]`, `[C<n>]`), its
severity, and its state — open, fixed, withdrawn, or settled. Only `blocker`
findings hold the task open; `major` and `minor` become follow-ups and are not
fixed now. Do not fix them to be helpful; that is unrequested work and it forces
the critics onto new ground.

**A blocker is a blocker regardless of which critic raised it**, and an accepting
verdict from one says nothing about the other's findings — they never saw each
other's work.

But they are not the same kind of claim:

- **`[R<n>]` — facts about your lines.** Either the claim is true and you fix it,
  or it is false and you show it is false. There is nothing to negotiate and no
  price to argue. A contest must be **re-runnable**: name a command or a test and
  the output that disproves the finding. A citation alone is not enough, because
  reading and interpreting it is exactly the judgement you are too close to make.
- **`[C<n>]` — the reasoning.** It arrives with a price: what the defect costs
  against what the fix costs. That price is an opening position, and you may meet
  it with a better one.

For each **blocker**, do one of three things and say which:

- **FIXED** — you changed the code. Name the file and what you did.
- **CONTESTED** — you believe the finding is wrong, with concrete evidence: a
  file and line, a test result, a documented behaviour. "I disagree" is not
  evidence. For an `[R]`, it must be something that can be re-run.
- **SETTLEMENT PROPOSED** — `[C]` only. You accept the risk is real but believe
  the remedy is the wrong price. State both sides as you see them — what the
  defect actually costs, and what the demanded fix actually costs — then offer a
  narrower fix that covers the realistic case, or a bounded deferral naming what
  guards the gap and which task closes it. State plainly what residual risk the
  project is accepting.

**You may not close a blocker yourself.** Send your response back to the critic
that raised it, along with the code after any fix, and let it withdraw, reaffirm,
settle, or reject. If you find yourself about to write "I disagree, moving on",
that is the moment this whole shape exists to catch: escalate it to the user
instead.

**Do not fix things that were not raised.** A revision round that also refactors
something else forces the critics onto new ground and is how these loops run
away.

## Step 5 — Loop, or stop

Re-run both critics with your responses. Repeat until **no blocker remains open**
— every one fixed, withdrawn, or settled.

What stops the loop is not moving. After each round ask: **did at least one
blocker close?**

| Round outcome | Action |
|---|---|
| Round 1 (entered with no open blockers) | Not eligible to stall; continue |
| One or more blockers closed | Converging — continue, reset the stall count |
| No blocker closed | Stalled — continue, increment the stall count |
| **3 consecutive stalled rounds** | Real disagreement — ask the human |
| **6 rounds total** | Runaway — stop regardless, and say so |

**Count closures, not the net number of open blockers.** A round that closes two
and raises two is progress, not a stall: two disagreements were resolved and a
critic found real material in work that did not exist before. New findings
neither reset nor inflate the counter.

Watch for what the counter cannot see: if the same *class* of defect appears in
three successive rounds — not the same blocker re-argued, but the same kind of
mistake made again in new material — you are converging on paper while the work
is not improving. Say so rather than riding the counter down.

**On escalation**, set the task to `blocked` in `docs/plan.md` with a one-line
reason, leave the tree as it is, and report: the deadlocked blocker, your
position, the critic's position, the smallest change it says would resolve it,
and the one question only a human can answer.

## Step 6 — Validate

Not optional, and it comes after the findings close, not before. Run the
project's own commands, read from `package.json` rather than assumed:

```powershell
npm run typecheck
npm test
npm run build
```

`npm run typecheck` covers tests too and is the cheapest signal, so run it first.
Add whatever else the task's own `validation` field names. **A green critique
does not overrule a red command.**

## Step 7 — Close, record, stop

Update `docs/plan.md`:

- flip the task to `done` with today's date and a one-line result
- add the follow-ups as complete contract-compliant entries
- record the rounds and the final verdict

### Recording follow-ups

A follow-up arrives as one line — an item and a destination. The plan file's
contract needs more, so **you** write the task: an id in the existing scheme,
`status: todo`, `depends`, a `why` that names the defect rather than the remedy,
and `acceptance` criteria stating an observable. Tag it `(from <task id>
critique)`.

Turning one line into a scoped task is authorship, not transcription. So **show
the user both** the critic's original line and the entry you wrote, and **get
their confirmation before adding anything to Ready now.** Backlog entries you may
add and report; selectable tasks a human approves.

If you cannot state checkable acceptance criteria, it is not a task yet. Put it
in the backlog as a gap entry, where nothing will select it by mistake.

### The settlement record

Print this to the user and append it under the task in `docs/plan.md`. It is the
point of the whole exercise: not that the critics accepted, but *what was decided
and what it cost*. A reader six months from now needs to know which risks were
accepted deliberately and on what reasoning — that is the difference between a
considered trade-off and an oversight nobody noticed.

```text
## SETTLEMENT RECORD — <task id> <task title>
Verdict: <final verdict>   Rounds: <n>   Stalls: <n>
Author: <model>   Facts: <code-review model>   Reasoning: <plan-critic model>
Validation: <the commands run, and their results>

Built
- <what now exists that did not before, 2-3 lines>

Findings raised: <n> — fixed <n>, withdrawn <n>, settled <n>, escalated <n>
[R1] <category> — FIXED: <what changed, and that the next pass confirmed it>
[C1] <category> — WITHDRAWN: <why the finding did not hold>
[C2] <category> — SETTLED: <what was agreed>
     Priced at: <cost of the defect vs cost of the fix, as both sides argued it>
     Residual risk: <what the project is now carrying>
     Tracked as: <follow-up id, or "not tracked, and why">

Severities I assigned myself: <ids the critic left ungraded, or "none">
Findings that were prompted: <ids that came from my priming list, or "none">

Trade-offs accepted
- <the choice, what was given up, and why that was the right side>

Follow-ups created
- <id> — <title>   (awaiting your approval before it becomes selectable)

Not done, deliberately
- <what was left alone, and where it belongs>
```

If a blocker was **escalated**, the record says so and the task is `blocked`, not
`done`. Never write a record implying agreement where a human still has to
decide.

If the change involved a design decision worth remembering beyond this task,
append one row to the decisions log at the top of `docs/progress.md`.

Then **stop.** One task per invocation, and ask before starting the next. The
human stays in the loop between steps, which is the rule RoleEye itself is built
on.

Do not commit or push unless the user asks.

## RoleEye invariants — pass these to both critics

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

## Reusing this elsewhere

`plan-critic.md` is project-agnostic and can be copied to any repository as it
is. See `references/porting.md`.

A worked run — the report, both critiques, a settlement and the escalation branch
— is in `references/example-run.md`. Read it before your first run; it is faster
than inferring the shape from the rules above.
