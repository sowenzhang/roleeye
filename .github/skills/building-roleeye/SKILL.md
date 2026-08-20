---
name: building-roleeye
description: Build RoleEye one plan step at a time using a dual-agent loop — a worker agent implements a single task from docs/plan.md while an evaluator agent on a different model independently critiques it for correctness, security, performance, UX and accessibility. The two negotiate over findings until no blockers remain, and escalate to a human only on genuine deadlock. Use when implementing, continuing, or resuming RoleEye feature work, phases, or plan tasks.
---

# Building RoleEye

## Overview

RoleEye is built by two agents supervised by you, the orchestrator. You never
implement plan tasks yourself.

```text
docs/plan.md → reserve ONE task, commit it, THEN record baseline SHA
                  ├─ spawn plan-worker    (session model, full tools)
                  └─ spawn plan-evaluator (the agent file's model, no edit tool)  ← spawned together
worker implements → WORK REPORT
        │                 │
        │                 ├─ rubber-duck pass (third model, line-level facts)  → [R]
        │                 └─ you forward the report → evaluator → REVIEW VERDICT → [F]
        ↑                                                          │
        │   [R] facts:        fix, or contest with evidence you re-run
        │   [F] reasoning:    each blocker priced → fix / withdraw / settle on the price
        └──────────── negotiate, while the merged ledger keeps closing ────────┘
                                                                   │
                    merged ledger clear → SETTLEMENT RECORD → stop and report
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
| **Single pass** | Ordinary implementation inside existing patterns | Worker, one in-loop rubber-duck pass, and one evaluator pass. Expect it to close in one or two rounds. |
| **Full loop** | Migrations, trust boundaries, hostile input, auth, money, accessibility surfaces, architecture decisions | The whole protocol below, with the evaluator raised above its declared model and a `security-review` pass alongside it (see Step 2). |

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

2. **Reserve the task, then commit the reservation.** In `docs/plan.md`, set the
   task to `in-progress` and add `started: <date>`, `attempt: 1`, `stalls: 0`.
   Those fields are the run's durable state — everything else lives only in this
   session's context and dies with it.

   On entry, if any task is already `in-progress`, do not spawn anything. Report
   it to the user with its `started` date and ask them to choose. Be honest about
   the options: an interrupted run **cannot be resumed** — the attempt history,
   the reports and the verdicts are gone with the session that held them. The
   real choices are to abandon it (revert or keep the partial work as a human
   decision, then set the task back to `todo`) or to restart it from a clean
   tree. Do not offer "resume" as though it were free.

3. **Record the baseline — after committing the reservation.** Writing the
   reservation dirties the very tree step 1 just required to be clean, so a SHA
   taken before it no longer matches `HEAD` and the worker's diff arrives
   carrying your plan-file edit. Commit the reservation, then `git rev-parse
   HEAD`, then write that SHA into the task's `baseline` field when you close it.
   Do not try to record the baseline in the same edit that creates it — that is
   circular, and the SHA will be wrong.

   Both agents share one working tree, so "the evaluator started first"
   guarantees nothing about what it read — the worker may write before the
   evaluator looks. A commit SHA does not race; timing does.

If any of these fails, stop. Do not spawn a worker you cannot later account for.

## Step 2 — Spawn both agents together

Spawn them in the **same** tool block, in background mode. The evaluator starts
with the worker so it can read the task and the standards documents and form its
own expectation of a correct change before it ever sees the worker's account of
what it did. Its view of *the code* comes from the baseline SHA, not from timing.

**Worker** — agent type `plan-worker`, session default model, all tools.
**Evaluator** — agent type `plan-evaluator`, the model declared in its agent
file, and no `edit` tool. Override that model only to raise it.

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

**Use the model declared in `.github/agents/plan-evaluator.md`. Do not pass a
cheaper override.** The agent file names the evaluator's model deliberately;
overriding it downward is the one configuration mistake known to degrade a run,
because the loop still *looks* like it ran a full review. Pass an explicit model
only to go **up**, or on the fallback path where there is no frontmatter to
inherit — and there, pass the agent file's declared model, not a cheaper one.

Two different models with separate context are less likely to share a blind spot,
and that is the whole of the claim. It is **not** a safety gate, and nothing here
has been measured: no seeded-defect benchmark has been run, so treat its clean
verdicts as weak evidence rather than assurance.

Consequences worth acting on:

- On a **full tier** task — a migration, a trust boundary, hostile input,
  accessibility, an architecture decision — raise the evaluator *above* its
  declared model, and add a `security-review` pass alongside it. Cheap review of
  the changes that can actually hurt you is a false economy.
- Never present an `ACCEPT` to the user as "reviewed and safe". Report which
  model gave the verdict, so its weight is visible.

### What the evaluator is for, and what it is not for

**The evaluator reviews the worker's reasoning. It is not a linter and it is not
a style authority.**

Its object of review is the *argument* the worker made: the premises it relied
on, the trade-offs it claims to have priced, the acceptance criteria it says it
met. A work report is a claim, and the evaluator's job is to test whether the
claim holds — not to have opinions about how the code is written.

**Coding style and convention are defined declaratively, in files, and are never
the evaluator's call.** They live in `agent.md`, `.editorconfig`, and whatever
linters the repo runs. A style rule adjudicated per-review is worse than useless:
it competes with the file that already owns the rule, it is applied
inconsistently from run to run, and it spends the evaluator's scarce attention on
something that should have been mechanical. If a style rule is worth enforcing,
encode it where it belongs and it will be enforced every time, by everyone, for
free.

So an evaluator finding about naming, formatting, file layout or idiom is itself
a defect in the review. The correct response is not to argue the point but to say
so, and to put the rule in the file that owns it.

So point each reviewer at what it is good for:

| Reviewer | Owns | Negotiable? | Examples |
|---|---|---|---|
| **Instruction files and linters** | Style and convention | n/a | naming, formatting, file placement, idiom, import order — declarative, always on, no model required |
| **Rubber-duck** (in-loop, third model) | Line-level correctness | No — factual | off-by-one, regex false negatives, state not carried across lines, circular tests, import cycles, error paths that can throw |
| **`security-review`** (full tier only) | Reachable vulnerabilities | No — factual | untrusted input reaching a sink, missing authz, secrets in source or logs |
| **Evaluator** | The worker's reasoning | **Yes — this is the negotiation** | Is the premise true? Does the argument survive checking? Were the acceptance criteria met *as written*, or reinterpreted? Is an invariant broken? Is the trade-off priced correctly, or asserted? Is the change proportionate, or 30 lines of fix wearing 350 lines of scaffolding? |
| **PR bot** | Free mechanical pass | No — factual | Runs on the PR anyway. Costs nothing. Let it run before you spend model budget. |

That third column is the one that governs the protocol. A factual finding has no
price: the line does what it does, and the worker either fixes it or proves the
claim wrong. A reasoning finding always has a price — what the defect costs
against what the fix costs — and pricing it is what turns a review into a
decision instead of a demand. So the evaluator must state a `Trade-off:` on every
blocker it raises, and a verdict that omits one is malformed. The worker is then
entitled to answer with a different price rather than only with compliance, and
the settlement record exists to write down which price the project chose and what
it is now carrying because of it.

That is the whole shape of the exchange: **facts get checked, trade-offs get
argued, and nothing closes until it has been either verified or decided.**

The evaluator's strongest move is to take a claim from the work report and check
it. A worker that asserts its self-checks pin the real detector, when executing
one mutation would show they do not, has made a reasoning failure — squarely in
the evaluator's lane, and the kind of thing to demand rather than accept.

### Prime your reviewers — it changes what they find

A reviewer given "review this diff" and a reviewer given five concrete hypotheses
to disprove do not perform comparably, and the difference is large enough that it
can be mistaken for a difference in model quality.

Two consequences:

- **Do the priming.** Before you spawn a reviewer, write down what you would
  attack if you were trying to break this change, and put that list in the
  prompt. Name the file and the specific property you doubt.
- **Do not credit the model for what your prompt supplied.** When reporting which
  reviewer found what, say whether the finding was prompted. Otherwise you will
  conclude a model is stronger when your prompt was.

### The in-loop rubber-duck pass

Run this on every task above Direct tier, **after the worker reports and before
you forward anything to the evaluator**. Use `rubber-duck` on a third model,
different from both the worker and the evaluator.

It exists because the loop otherwise has no line-level defect pass at all. A
rubber-duck that runs only as a *pre-PR* gate surfaces mechanical defects after
the task has already been closed and a settlement record written — too late, and
the record then describes an agreement reached over an artifact that was still
wrong.

Forward its findings to the worker in the same round as the evaluator's verdict,
tagged `[R<n>]` so the settlement record can distinguish them.

**A rubber-duck finding is not negotiated.** It is a factual claim about what a
line does, and a factual claim has no price: either it is true and the worker
fixes it, or it is false and the worker shows it is false. So the worker gets two
responses on an `[R<n>]`, not four — FIXED, or CONTESTED with evidence you can
re-run. There is no settlement, because the rubber-duck is a one-shot pass with
no counterparty to accept one, and you are not permitted to accept one on its
behalf.

**Resolving a contested `[R<n>]` is fact-checking, not adjudication.** Run the
evidence the worker gave you. If it holds, mark the finding withdrawn and say in
the settlement record that you verified it and how. If it does not hold, return
it to the worker unchanged with the output that contradicts the contest. This is
the one place you legitimately close a finding yourself, and it is legitimate
precisely because you are executing a command rather than forming a view. If a
contest offers no re-runnable evidence, it is a non-response: send it back and
say so.

If the worker contests an `[R<n>]` on grounds you cannot settle by running
something — a design argument rather than a fact — that finding was mis-filed.
**Do not drop it on the worker's say-so.** You have no independent view of the
code, so "this objection sounds reasonable" is not a judgement you are entitled
to make, and a worker who learns that a design-flavoured contest makes a finding
disappear has been handed a way to launder real defects.

Re-file it instead. Withdraw the `[R<n>]` from the ledger — recording in the
settlement record that it was withdrawn as mis-filed, not as wrong — and put the
underlying question to the evaluator in its next round as a hypothesis to probe,
quoting the finding and the worker's argument. If the evaluator agrees there is a
problem it raises its own `[F<n>]`, priced, and the negotiation proceeds
normally; if it does not, the matter is closed by someone entitled to close it.

Note what this is *not*: you are not handing the evaluator an `[R]` to
adjudicate. Its agent file forbids that, and for good reason — it never saw the
rubber-duck's reasoning. You are retiring a finding that was filed in the wrong
category and asking the right reviewer the underlying question from scratch. The
routing is mandatory; the outcome is not yours.

**Do not relay the rubber-duck's findings into the evaluator's pre-read**, and do
not let the evaluator see them before it forms its own verdict on a round. Its
independence is the property being protected.

From the second round on, the pass has one extra job: quote it every `[R]` the
worker has reported FIXED and require it to say, for each, whether the fix holds
or the defect has recurred. It cannot remember its own findings, and a fix that
silently did not work is otherwise indistinguishable from progress — see *The
merged finding ledger* in Step 4.

Both prompts must include, in full (they are stateless and cannot see this
session):

- the task id, title, description and acceptance criteria, quoted from the plan
- the **absolute path of the current workspace root** — resolve it at runtime
  with `git rev-parse --show-toplevel`, never a remembered path — together with
  the operating system and shell you actually detected, and the path separator
  they imply
- the baseline commit SHA
- the standards documents to obey: `agent.md`, `architecture.md`, and the
  RoleEye invariants in the *RoleEye invariants* section below
- the commands, read from `package.json` rather than assumed: currently
  `npm run typecheck`, `npm test`, `npm run build`, `npm run test:unit`,
  `npm run test:integration`, `npm run catalog:check`
- `Round 1. The loop continues while blockers are being closed; it stops only on
  deadlock, so treat a review as a negotiation, not a countdown. Every blocker
  carries a price — the cost of the defect against the cost of the fix — and
  closes with a decision that names what the project chose to carry and why.`
- for the evaluator only: `The worker's report will follow in a later message.
  Review the change as the diff from <baseline sha>, which was a clean tree.
  Before it arrives, do the pre-read your agent file requires and reply with your
  independent expectation — not an acknowledgement. Read the task, the standards
  documents and any code you consult at <baseline sha> (git show <baseline
  sha>:<path>), not from the working tree, which the worker is changing while you
  read. Do not modify the working tree; it is checked byte for byte.`

### The evaluator's pre-read is not optional

The evaluator's first reply should be its independent expectation of a correct
change, per the "Your first output is not a verdict" section of its agent file.
Check that it is. On our first real run the evaluator came back in 46 seconds
with a single line — "Ready for the worker's report" — and only did the work when
asked again; the second attempt produced a committed prior, a list of claims it
intended to verify itself, and the observation that the portal's URL carries a
token, which set the bar for what counted as a real prototype. None of that would
have existed had the acknowledgement been accepted.

So if the first reply is an acknowledgement, send it back once, before the worker
reports, naming the specific items the agent file asks for. This costs one model
cycle while the worker is still working, and it buys the independence the
second model is there to provide. Do not relay the pre-read to the worker — it is
for the evaluator's own use, and feeding it forward would contaminate exactly
what it exists to protect.

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
- lists a `blocker` with no `Trade-off:` line — an unpriced blocker is an
  instruction, not an opening position, and the worker has nothing to negotiate
  against
- is truncated mid-structure

On the first invalid verdict, return it to the evaluator once. For a pure shape
defect — a missing or misspelled `Verdict:` line, a truncated reply, a severity
that contradicts the verdict — send: `Your verdict did not parse: <the specific
defect>. Re-issue it in the required format. Do not change your findings or your
reasoning — this is a formatting correction.`

A **missing `Trade-off:` line is not a formatting defect**, and telling the
evaluator not to change its reasoning while demanding a price it never formed
would be an instruction it cannot satisfy. Send instead: `Blocker <id> carries no
price. Re-issue the verdict with a Trade-off line on it: what the defect costs if
it ships, against what your recommended fix costs to make. Keep every finding and
its severity as they are — you are completing this finding, not revising it.`

Either retry **does not consume a worker attempt**; the worker has done nothing
wrong.

If the re-issued verdict is still invalid, stop. Record `protocol-failure` on the
task with the reason, leave it `in-progress`, and take it to the user with both
malformed outputs. Do not guess what the evaluator meant, and never infer an
`ACCEPT` from an unparseable reply.

### Then route

Route on the **merged ledger**, not on the verdict alone. The evaluator does not
see the rubber-duck's findings, so its `ACCEPT` is a statement about *its own*
findings and says nothing about an open `[R<n>]`. Treating it as closure is how a
known defect ships with a settlement record saying two agents agreed.

- **ACCEPT** or **ACCEPT_WITH_FOLLOWUPS**, and **no open `[R<n>]` blocker** → go
  to Step 5. Record follow-ups as described below.
- **ACCEPT** or **ACCEPT_WITH_FOLLOWUPS**, but an `[R<n>]` blocker is still open
  → **do not close.** Return those blockers to the worker as the next round,
  exactly as you would a `REVISE`. Say plainly that the evaluator accepted and
  which findings remain, so the worker is not confused about why it is being
  asked again.
- **REVISE** → forward the `## REVIEW VERDICT` verbatim to the worker, together
  with any still-open `[R<n>]` findings, with `This is round <n+1>. Blockers
  only. For [F] findings: fix, contest with evidence, or counter the price with a
  settlement. For [R] findings: fix, or contest with evidence I can re-run —
  there is no price to argue.` Return to Step 3.

### The merged finding ledger

You own it, because you are the only participant who sees every reviewer.

Keep one list for the task. Every finding gets a stable id — `[F<n>]` from the
evaluator, `[R<n>]` from the rubber-duck or any other factual reviewer — its
severity, and its state: open, fixed, withdrawn, or settled. Preserve the source
id when relaying, so the worker and the settlement record can tell who raised
what.

Five rules follow, and they are what make the ledger worth keeping:

- **A rubber-duck blocker blocks.** It carries ordinary weight and cannot be
  closed by an evaluator that never saw it. But it closes only two ways — the
  worker fixes it, or the worker contests it and you verify the contest by
  running something. It is never settled, because a fact has no price.
- **A `FIXED` claim on an `[R]` is provisional until the next pass agrees.** The
  rubber-duck cannot remember what it raised last round, so if the worker's fix
  did not work it will re-raise the same defect as a brand-new finding. Treated
  naively that is a closure followed by a fresh finding, which resets the stall
  count and lets one defect circulate forever while the loop reports progress.
  **Do not fix this by matching the two texts yourself.** Deciding whether "an
  off-by-one" and "loop bound excludes the last element" are the same underlying
  flaw is defect triage, it needs a view of the code, and it is exactly the
  judgement you are not entitled to. Give the work to the reviewer that is: in
  each rubber-duck prompt after the first, list the `[R]` findings the worker has
  reported FIXED, quote them, and require the pass to state for each whether it
  is genuinely resolved or has recurred. A recurrence keeps its original id, the
  earlier closure is rescinded, and the round that claimed it does not count as
  progress. You are recording the reviewer's answer, not forming one.
- **Only `[F<n>]` findings are negotiated.** The evaluator prices its blocker, the
  worker may counter with a narrower fix or a bounded deferral, and the two of
  them reach a decision. You relay that exchange; you do not take part in it.
- **Closure requires the whole ledger clear.** Not the latest verdict.
- **Stalls are counted over merged closures.** A round is stalled when *nothing*
  on the ledger closed, from any source. A round that closes an `[F]` while an
  `[R]` stays open is not a stall, and neither is the reverse.

Only the rubber-duck's severities feed this. If its output is unstructured,
assign the severity yourself when you enter it in the ledger, and say in the
settlement record that you did — a finding you graded is not a finding it graded.

### What actually stops the loop

The loop runs until **no open blockers remain** on the merged ledger. An `[F<n>]`
closes three ways, all of them legitimate: the worker fixes it, the evaluator
withdraws it, or the two settle on a narrower fix or a bounded deferral after
pricing the trade-off. An `[R<n>]` closes two ways: fixed, or contested with
evidence you re-ran and confirmed. `major` and `minor` findings never block; they
become follow-ups and the work continues past them.

So a `REVISE` is not a stop. It is the next round of a negotiation, and the worker
keeps working through it.

What stops the loop is **not moving**. After each round, ask one question: **did
at least one blocker close?** A blocker closes by being fixed, withdrawn or
settled.

| Round outcome | Meaning | Action |
|---|---|---|
| Round entered with no open blockers | Initial finding round — not eligible | Continue; the stall count stays where it is |
| One or more blockers closed | Converging | Continue, and reset the stall count to zero |
| No blocker closed | Stalled round | Continue, and increment the stall count |
| Three consecutive stalled rounds | Deadlock — a real disagreement | Escalate |
| 8 worker attempts on one task | Runaway | Stop regardless, and say so |

**Only rounds that begin with an open blocker can stall.** The first review
enters with none — the worker has not been told anything yet — so it is
arithmetically incapable of closing one. Counting it would charge the task a
deadlock attempt for the crime of receiving its first `REVISE`, and would leave
a task escalating after just two real worker responses. The stall counter
measures whether the worker and reviewer can resolve a disagreement, and there
is no disagreement to resolve until one has been stated.

**Count closures, not the net number of open blockers.** These come apart the
moment a fix introduces a new claim: a round that closes two blockers and raises
two fresh ones leaves the count unchanged at two, and a net rule would call that
a stall. It is the opposite of a stall — two disagreements were resolved and the
reviewer found new material in work that did not exist before. Three such rounds
would escalate a loop that is doing exactly what it was built to do. So the
question is never "is the number smaller", it is "did anything get resolved".

New blockers raised in a round neither reset nor inflate the stall count. Only
closures reset it.

Track `attempt` (worker cycles) and `stalls` (consecutive rounds that closed
nothing) in the plan file, and report both at the end, along with the total
number of distinct blockers raised — that last figure is what makes a three-round
run legible later, because `stalls: 0` alone does not distinguish a clean first
pass from a hard-fought four-blocker negotiation.

Watch for one thing the counter cannot see: if the same *class* of defect appears
in three successive rounds — not the same blocker re-argued, but the same kind of
mistake made again in new material — the loop is converging on paper and the work
is not improving. Say so to the user rather than riding the counter down.

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

That bar is about *judgement*, not about facts. Re-running a command a worker
offered as evidence against an `[R<n>]` is not breaking a tie; it is reading a
result, and you are the right participant to do it. The line is simple: if
closing the finding requires you to have an opinion, you may not close it.

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
Rubber-duck (in-loop): <model>

Built
- <what now exists that did not before, 2-3 lines>

Findings raised: <n> — fixed <n>, withdrawn <n>, settled <n>, escalated <n>
[F1] <category> — FIXED: <what changed>
[F2] <category> — WITHDRAWN: <why the finding did not hold>
[F3] <category> — SETTLED: <what was agreed>
     Priced at: <cost of the defect vs cost of the fix, as the two sides argued it>
     Residual risk: <what the project is now carrying>
     Reasoning: <why this was the right price>
     Tracked as: <follow-up id, or "not tracked, and why">
[R1] <category> — FIXED: <what changed>
[R2] <category> — WITHDRAWN: <the evidence the worker gave, and the command I re-ran
     to confirm it>

Severities I assigned myself: <the [R] ids the rubber-duck left ungraded, or "none">

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
