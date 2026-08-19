# Porting the dual-agent loop to another project

The loop is three parts. Two are generic; one is not.

| Part | File | Generic? |
|---|---|---|
| Worker role and report format | `.github/agents/plan-worker.md` | Yes — copy as is |
| Evaluator role, severities, verdict format | `.github/agents/plan-evaluator.md` | Yes — copy as is |
| Orchestration and project rules | `.github/skills/<name>/SKILL.md` | No — rewrite |
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

- **Same model on both sides.** The loop still runs and produces confident
  agreement about nothing. Check the evaluator's model explicitly.
- **Assuming the evaluator saw a clean baseline.** Both agents share one working
  tree, so spawning the evaluator first proves nothing about what it read — the
  worker may write before it looks. Capture a baseline commit SHA (and the
  pre-existing dirty diff, if any) before spawning, and have the review taken
  against that SHA. Timing is not a baseline.
- **No reservation.** If the task stays `todo` while the worker runs, a second
  invocation or a restart after a crash will start a second worker on the same
  files. Reserve before spawning; release on done, blocked, or abandonment, and
  make a stale reservation a question for the human rather than something the
  orchestrator resolves alone.
- **Trusting the read-only claim.** The evaluator has no edit tool, but it has a
  shell, and a fallback agent may have neither restriction. It is a policy, not
  a sandbox. Re-check `git status` after the verdict and void the review if the
  tree moved.
- **Fallbacks that quietly drop the frontmatter.** If the custom agent types are
  not available and you fall back to a general-purpose agent, the model and tool
  restrictions do not come with it. Reapply them by hand, or stop.
- **Vague acceptance criteria.** The evaluator cannot check "works well". Every
  criterion should name an observable: a command, an output, a state change.
- **Missing invariants.** Without project rules, "blocker" collapses into
  taste, and the loop stops terminating.
- **An orchestrator that helps.** If the orchestrator fixes things between
  rounds, attempt counting becomes meaningless and neither agent is reviewing
  what actually shipped. Relay verbatim; edit only the plan file.
- **Anti-escalation rules that swallow real bugs.** Rules against restating
  findings and against raising late ones exist to stop taste from escalating over
  three rounds. They must carve out genuine defects explicitly, or the loop will
  eventually procedure a security hole into `ACCEPT`. Termination is the attempt
  cap's job, not the severity rules'.
- **No attempt cap enforcement.** Three is a cap, not a suggestion. Escalation
  to a human is the designed outcome for a real disagreement, not a failure of
  the loop.
