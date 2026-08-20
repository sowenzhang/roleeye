# Porting the dual-agent loop to another project

The loop is three parts. Two are generic; one is not.

| Part | File | Generic? |
|---|---|---|
| Worker role and report format | `.github/agents/plan-worker.md` | Yes — copy as is |
| Evaluator role, severities, verdict format | `.github/agents/plan-evaluator.md` | Yes — copy as is |
| Orchestration and project rules | `.github/skills/<name>/SKILL.md` | No — rewrite |
| A worked run | `references/example-run.md` | Mostly — swap the task and the code |
| The plan | `docs/plan.md` | No — rewrite |

## Steps

1. **Copy both agent files** into the target repo's `.github/agents/`. Change
   nothing. They take the plan file path, task, commands and attempt count from
   the prompt, so they do not know or care which project they are in.

   The only field worth revisiting is the evaluator's `model:`. It must be a
   *different* model from the one the worker and orchestrator run on, and it must
   be a **capable** one. An earlier version of this file said a cheap model was
   correct because "the evaluator reads a diff and applies a rubric". That was
   wrong twice over: the evaluator does not apply a rubric, it tests an argument,
   and a downgraded reviewer still produces a settlement record that reads
   exactly like a thorough one. **Set the model in the agent file and pass an
   override only to raise it.**

2. **Write a new skill** in `.github/skills/<name>/SKILL.md`. Copy the structure
   of `building-roleeye/SKILL.md` and replace four things:

   - the **plan file path** and the standards documents to read in Step 1
   - the **commands** (build, typecheck, lint, test) passed to both agents, read
     from the project's own manifest rather than remembered
   - the **invariants** list — the rules that make a violation a blocker rather
     than a discussion. This is the highest-value part to get right; without it
     the evaluator falls back to generic advice.
   - the **project notes** — OS and shell, language and runtime, and the
     non-obvious traps a reviewer would otherwise miss

   Do not hard-code a checkout path anywhere. The orchestrator resolves the
   workspace root at runtime with `git rev-parse --show-toplevel` and passes it,
   with the detected OS and shell, into both prompts — otherwise the agents
   inherit whichever machine the skill was written on.

   Keep the frontmatter `description` specific enough that the skill is selected
   for "implement the next task" and not for unrelated questions.

3. **Write the plan file.** The skill's task-selection step depends on a stable
   shape. See the contract at the top of `docs/plan.md`: task ids, one-line
   status, explicit dependencies, and acceptance criteria written so that "met"
   is checkable rather than arguable.

4. **Verify the wiring before trusting it.** Run `/env` (or `/agent`) and confirm
   both agents are discovered. Then run the skill on a small, low-risk task and
   read the transcript: did both agents actually spawn, did the evaluator run on
   a different model, did the verdict cite real file and line evidence, and did
   the orchestrator stop after one task?

## What tends to break

- **Same model on both sides.** Two models with separate context are less likely
  to share a blind spot — that is the whole claim, and it is worth having. It is
  not a safety gate: a cheap reviewer is a cheap reviewer, and the loop still
  produces a settlement record that reads exactly like a thorough one. Never
  override the declared evaluator model downward; raise it for migrations, trust
  boundaries and architecture decisions. Do not let a light `ACCEPT` be reported
  as "reviewed and safe". If you want to know what your reviewer is worth, seed a
  few known defects and see how many it finds.
- **Asking one reviewer to do two jobs.** Reviewing *reasoning* — is the premise
  true, were the acceptance criteria met as written or quietly reinterpreted, was
  a trade-off priced or merely asserted, is the evidence actually evidence — is a
  different activity from hunting line-level defects, and a reviewer told to do
  both will drift to whichever is easier to say something about. That is usually
  style commentary, which is the least valuable of the three because style is
  declarative: it belongs in instruction files and linters that run every time
  without a model. Give the evaluator the reasoning, give a separate code-level
  reviewer the defects, and say so in both prompts.

  Watch for this surviving the split. It is not enough to add a paragraph saying
  the evaluator reviews reasoning; you have to go through the rest of the agent
  file and rewrite whatever contradicts it. A "review angles" checklist listing
  off-by-one errors, unhandled rejections and *"does it match the project's
  existing patterns"* will win against one corrective paragraph every time,
  because it is longer, more concrete and easier to act on. Recast each angle as
  a question about the worker's belief — not "find the race condition" but "which
  interleaving did the worker assume was impossible, and is that written down?"
- **A code-level pass that runs after the task closes.** If the only mechanical
  reviewer is a pre-merge gate, its findings arrive after a settlement record has
  already been written over an artifact that was still wrong. Run it inside the
  loop, between the worker's report and the reviewer's verdict.
- **Two reviewers, one verdict.** The moment a second source of findings exists,
  routing on the evaluator's verdict alone is a hole: it never saw the other
  reviewer's findings, so its `ACCEPT` cannot close them. Keep a merged ledger of
  every finding with its source, severity and state; require the whole ledger to
  be clear before closure; and count stalls over closures from both sources.
- **Giving a factual finding a settlement path.** Once the ledger has more than
  one source, it is tempting to say every finding may be fixed, contested or
  settled. That is wrong for the code-level and security reviewers, and the
  reason is worth being precise about: **only a finding with a price can be
  negotiated.** The rubber-duck reports what a line does. That is either true or
  false — there is no middle position to trade toward, and the reviewer is a
  one-shot pass with nobody left to accept a settlement anyway. So a factual
  finding closes two ways, fixed or contested-with-evidence, and the orchestrator
  resolves the contest by *running* the evidence. That is fact-checking, not
  tie-breaking, and it is the one closure the orchestrator may perform itself —
  legitimate precisely because it requires no opinion.
- **A negotiation with nothing to negotiate over.** The mirror of the mistake
  above. If the evaluator hands down a blocker without pricing it — the cost of
  the defect against the cost of the fix — the worker can only obey or refuse,
  and the loop degenerates into compliance. Make the `Trade-off:` line mandatory
  on every evaluator blocker and treat a verdict that omits one as malformed.
  What you want from this loop is not agreement; it is a *decision*, recorded
  with the price the project chose to pay and the risk it chose to carry.
- **Prompting one reviewer better than another and calling it a model result.**
  A reviewer handed a numbered list of specific hypotheses to disprove finds more
  than one told to "review this diff", and the gap is large enough to be mistaken
  for model quality. Prime deliberately, and record whether a finding was
  prompted before concluding anything about which model is stronger.
- **Assuming the evaluator saw a clean baseline.** Both agents share one working
  tree, so spawning the evaluator first proves nothing about what it read — the
  worker may write before it looks. Record a baseline commit SHA and review the
  diff from it. Timing is not a baseline. Capture it **after committing the
  reservation**, not before: writing the reservation into the plan file dirties
  the very tree you just required to be clean, so a SHA taken first no longer
  matches `HEAD` and the worker's diff arrives carrying the orchestrator's own
  edit. It also cannot be written in the same edit that creates it, so if your
  plan contract requires the field at reservation time, that contract is
  unsatisfiable — record it at closure instead.
- **Starting from a dirty tree.** Requiring a clean tree looks fussy and removes
  four problems at once: attribution of pre-existing edits, an unbounded diff in
  every prompt, the exactness of the post-review tree check, and most of the
  recovery machinery. Take the simplification.
- **A "resume" that cannot resume.** Reports, verdicts and attempt history live
  in the orchestrator's context and die with the session. Unless you persist
  them, an interrupted run can only be abandoned or restarted — say that plainly
  rather than offering a resume that silently reclassifies the worker's partial
  edits as pre-existing.
- **A reservation that reserves nothing.** A status written to a file is not a
  lock: two sessions can both read `todo` first, and a second worktree never sees
  it. Either take a real lock or declare one worktree, one loop, as a
  precondition.
- **An unclosed state machine.** The attempt cap only terminates the well-formed
  path. Decide in advance what happens when the worker reports BLOCKED on the
  last attempt, when a verdict does not parse, when `REVISE` arrives with no
  blocker, or when `ACCEPT` arrives carrying one. Allow one formatting-only
  retry that does not consume a worker attempt, then stop and fetch a human.
  Never infer an ACCEPT from an unparseable reply.
- **Trusting the read-only claim.** The evaluator has no edit tool, but it has a
  shell. It is a policy, not a sandbox. Compare the exact tree state before and
  after — a full diff plus hashes of untracked files, not `--stat`, which is
  blind to an edit that keeps the line count and to a rewritten untracked file.
- **Fallbacks that quietly drop the frontmatter.** If the custom agent types are
  not available, a general-purpose fallback inherits neither the model nor the
  tool restrictions, and the spawn interface may offer no way to reimpose the
  latter. Say so and ask, rather than claiming the restriction was reapplied.
- **Checklist theatre.** Long lists of angles to cover, each requiring an
  explicit not-applicable note, teach a small model to spend its attention
  proving it visited the headings. Ask it to consider the angles internally and
  report only what applies.
- **Vague acceptance criteria.** The evaluator cannot check "works well". Every
  criterion should name an observable: a command, an output, a state change. Beware
  the criterion that cannot fail — "does not depend on a component that does not
  exist" is satisfied by doing nothing.
- **Missing invariants.** Without project rules, "blocker" collapses into taste,
  and the loop stops terminating.
- **An orchestrator that helps.** If it fixes things between rounds, attempt
  counting becomes meaningless and neither agent is reviewing what shipped.
  Relay verbatim; edit only the plan file.
- **An orchestrator that authors the backlog.** Turning a one-line follow-up into
  a task with acceptance criteria is authorship. Show the original and the entry,
  and get a human's agreement before anything joins the selectable queue.
- **Anti-escalation rules that swallow real bugs.** Rules against restating
  findings and against raising late ones exist to stop taste from escalating over
  three rounds. They must carve out genuine defects explicitly, or the loop will
  eventually procedure a security hole into `ACCEPT`. Termination is the attempt
  cap's job, not the severity rules'.
- **One tier for everything.** Six model cycles to review a typo is ceremony.
  Tier it: direct for mechanical work, a code-level pass plus one evaluator pass
  for ordinary changes, the full loop for migrations and trust boundaries.
- **A cap that counts the wrong thing.** Capping total rounds punishes a loop
  that is converging and stops work that was nearly finished. Count *stalled*
  rounds — ones that closed no blocker — and keep a separate runaway ceiling on
  total attempts, since "converging" can be gamed by closing one trivial blocker
  per round.
- **Counting open blockers instead of closures.** The subtler version of the
  same mistake, and it survived our first real run: if a stall is defined as "the
  open-blocker count did not fall", then a round that closes two findings and
  raises two new ones is recorded as a stall. That is backwards — it is the loop
  working, since a fix that introduces a new claim *should* attract a new
  finding. Three such rounds would escalate a healthy negotiation. Define a
  stalled round as one in which **nothing closed**, and let new findings neither
  reset nor inflate the counter.
- **Counting the opening review as a stall.** The trap immediately underneath
  that fix, and a reviewer caught it in ours before it ever ran: "nothing closed"
  also describes round 1, which enters with no blockers and cannot possibly close
  one. Left alone, every task that receives an initial `REVISE` starts one
  deadlock attempt down and escalates after two real worker responses. Make only
  rounds that *enter* with an open blocker eligible to stall.
- **No independent expectation before the report.** If the reviewer's first act
  is to read the author's account of why the work is correct, it is grading a
  justification, not the work. Spawn it with the worker and require a committed
  prior — its own answer to the task, what it will verify itself, and where it
  expects an honest failure — as a *required first output*. Ours replied "ready"
  in 46 seconds until it was asked twice; the real pre-read then found the
  constraint that defined what a valid prototype was. Treat an acknowledgement
  as a non-answer and send it back.
- **No detector for a repeated class of defect.** The stall counter sees
  closures, so a worker that keeps making the *same kind* of error in new
  material looks like steady progress forever. Ask the reviewer to name it as a
  pattern when it recurs across rounds, because no counter will.
- **No settlement path.** If a reviewer's only moves are accept and reject, every
  disagreement about *price* is forced to look like a disagreement about
  *existence*, and one side has to capitulate. Let the worker propose a narrower
  fix or a bounded deferral, and require the reviewer to answer it with a
  settlement, a condition, or the specific case it leaves open.
- **No record of what was settled.** The valuable output is not "two agents
  agreed" but which risks were accepted, by whom, and why. Without that, an
  accepted trade-off is indistinguishable from an oversight six months later.
- **No attempt cap enforcement.** Escalation to a human is the designed outcome
  for a real disagreement, not a failure of the loop.
