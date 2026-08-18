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
   - the **commands** (build, typecheck, lint, test) passed to both agents
   - the **invariants** list — the rules that make a violation a blocker rather
     than a discussion. This is the highest-value part to get right; without it
     the evaluator falls back to generic advice.
   - the **project notes** — OS and shell, language and runtime, and the
     non-obvious traps a reviewer would otherwise miss

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
- **Vague acceptance criteria.** The evaluator cannot check "works well". Every
  criterion should name an observable: a command, an output, a state change.
- **Missing invariants.** Without project rules, "blocker" collapses into
  taste, and the loop stops terminating.
- **An orchestrator that helps.** If the orchestrator fixes things between
  rounds, attempt counting becomes meaningless and neither agent is reviewing
  what actually shipped. Relay verbatim; edit only the plan file.
- **No attempt cap enforcement.** Three is a cap, not a suggestion. Escalation
  to a human is the designed outcome for a real disagreement, not a failure of
  the loop.
