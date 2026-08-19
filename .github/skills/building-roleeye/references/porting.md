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
   *different* model from the one the worker and orchestrator run on, and a
   cheap one is correct — the evaluator reads a diff and applies a rubric, which
   is not where reasoning budget pays off. `gpt-5.6-luna` is the default.

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
  not a safety gate: a cheap reviewer is a cheap reviewer. Raise the model for
  migrations, trust boundaries and architecture decisions, and do not let a light
  `ACCEPT` be reported as "reviewed and safe". If you want to know what your
  reviewer is worth, seed a few known defects and see how many it finds.
- **Assuming the evaluator saw a clean baseline.** Both agents share one working
  tree, so spawning the evaluator first proves nothing about what it read — the
  worker may write before it looks. Record a baseline commit SHA and review the
  diff from it. Timing is not a baseline.
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
  Tier it: direct for mechanical work, one evaluator pass for ordinary changes,
  the full loop for migrations and trust boundaries.
- **A cap that counts the wrong thing.** Capping total rounds punishes a loop
  that is converging and stops work that was nearly finished. Count *stalled*
  rounds — ones that closed no blocker — and keep a separate runaway ceiling on
  total attempts, since "converging" can be gamed by closing one trivial blocker
  per round.
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
