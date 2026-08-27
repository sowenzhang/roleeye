# Porting this to another repository

What this is: an agent implements one planned task, then two critics on models
that did not write it review the result, and the author is not allowed to dismiss
their findings alone.

**Read this first: it replaced a more elaborate design, and the reason matters.**
The earlier version spawned a *worker* subagent and an *evaluator* subagent in
parallel, gave them a shared checkout and a baseline commit SHA, had the
evaluator produce an "independent expectation" before the work existed, and
relayed a negotiation between them through a neutral orchestrator. It worked. It
was also several model cycles per task, and essentially all of its measured value
came from one cheap property: **a different model read the diff.** None of the
observed catches were traceable to the simultaneity, the pre-read, or the
baseline-race machinery. If you are tempted to build the elaborate version, build
this one first and measure the gap before you pay for it.

## The three parts

1. **Copy `plan-critic.md`** into the target repo's `.github/agents/`. Change
   nothing but the `model:` field. The agent type name comes from the `name:`
   frontmatter, not the filename, so renaming the file is safe — but discovery is
   not, so verify it.

   The model must be *different* from the one the orchestrating agent runs on,
   and it must be **capable**. An earlier version of this file said a cheap model
   was correct because "the evaluator reads a diff and applies a rubric". That
   was wrong twice over: the critic does not apply a rubric, it tests an
   argument, and a downgraded critic still produces a record that reads exactly
   like a thorough one. Set the model in the agent file and override it only to
   raise it.

2. **Write a skill** in `.github/skills/<name>/SKILL.md`. Copy the structure of
   `building-roleeye/SKILL.md` and replace four things:

   - the **plan file path** and the standards documents to read in Step 1
   - the **commands** (build, typecheck, lint, test), read from the project's own
     manifest rather than remembered
   - the **invariants** — the rules that make a violation a blocker rather than a
     discussion. This is the highest-value part to get right; without it the
     critic falls back to generic advice.
   - the **project notes** — OS and shell, language and runtime, and the
     non-obvious traps a reviewer would otherwise miss

   Do not hard-code a checkout path. Resolve it at runtime with `git rev-parse
   --show-toplevel` and pass it, with the detected OS and shell, into both
   prompts — otherwise the critics inherit whichever machine the skill was
   written on.

3. **Write the plan file.** Task ids, one-line status, explicit dependencies, and
   acceptance criteria written so that "met" is checkable rather than arguable. A
   task that cannot say how it will be proved is not ready.

Then verify the wiring before trusting it: confirm the agent is discovered, run
the skill on a small low-risk task, and read the transcript. Did both critics
spawn on different models? Did the findings cite real file and line evidence? Did
the author actually respond to each blocker rather than closing them silently?

## What tends to break

- **The author closing its own findings.** This is the failure that makes the
  whole thing theatre, and it is the easiest one to slip into, because the author
  is also the agent writing the summary at the end. A blocker closes when it is
  fixed, when the critic withdraws it, or when a human decides. "I disagree,
  moving on" is not a closure. If you keep one rule from this document, keep that
  one.
- **A critic on the author's model.** Two instances of one model with separate
  context share most of a blind spot. That is the entire property you are buying,
  and it is the cheapest thing here to get right.
- **Asking one critic to do two jobs.** Reviewing *reasoning* — is the premise
  true, were the acceptance criteria met as written or quietly reinterpreted, was
  a trade-off priced or merely asserted — is a different activity from hunting
  line-level defects, and a critic told to do both drifts to whichever is easier
  to say something about. That is usually style commentary, which is the least
  valuable of the three because style is declarative: it belongs in instruction
  files and linters that run every time without a model.

  Watch for this surviving the split. It is not enough to add a paragraph saying
  the critic reviews reasoning; you have to rewrite whatever contradicts it. A
  "review angles" checklist listing off-by-one errors and *"does it match the
  project's existing patterns"* will win against one corrective paragraph every
  time, because it is longer and easier to act on. Recast each angle as a
  question about the author's belief — not "find the race condition" but "which
  interleaving did the author assume was impossible, and is that written down?"
- **Giving a factual finding a settlement path.** Only a finding with a price can
  be negotiated. A code-level critic reports what a line does: either true or
  false, with no middle position to trade toward, and it is a one-shot pass with
  nobody left to accept a settlement. So a factual finding closes two ways —
  fixed, or contested with evidence that can be *re-run*. Requiring a re-runnable
  contest is what keeps the author from talking its way past a fact.
- **A negotiation with nothing to negotiate over.** The mirror of the mistake
  above. If the critic hands down a blocker without pricing it — the cost of the
  defect against the cost of the fix — the author can only obey or refuse, and
  the loop degenerates into compliance. Make the `Trade-off:` line mandatory on
  every blocker and treat a verdict that omits one as malformed. What you want is
  not agreement; it is a *decision*, recorded with the price the project chose to
  pay.
- **One critic's ACCEPT closing the other's findings.** They never saw each
  other's work. Keep one list of findings with their sources and states, and
  require all of it clear before closing.
- **A stateless critic re-raising a defect as new.** A code-level pass spawned
  fresh each round cannot remember what it found, so a fix that silently did not
  work returns as a brand-new finding — which reads as progress while the same
  defect circulates forever. Ask it directly: quote the findings reported fixed
  and require it to say whether each holds or has recurred. Do not try to match
  the texts yourself; that is triage, and the author is the worst-placed
  participant to do it.
- **Prompting one critic better than another and calling it a model result.** A
  critic handed a numbered list of specific hypotheses to disprove finds more
  than one told to "review this diff", and the gap is large enough to be mistaken
  for model quality. Prime deliberately, and record whether a finding was
  prompted before concluding anything about which model is stronger.
- **A cap that counts the wrong thing.** Capping total rounds punishes a loop
  that is converging and stops work that was nearly finished. Count *stalled*
  rounds — ones that closed no blocker — and keep a separate runaway ceiling on
  total rounds for the case where one trivial blocker closes per round forever.
- **Counting the first review as a stall.** It enters with no open blockers, so
  it is arithmetically incapable of closing one. Only rounds that *enter* with an
  open blocker are eligible.
- **Severity rules with no floor.** If everything is negotiable, a loop under
  time pressure will eventually procedure a security hole into `ACCEPT`. Keep an
  explicit override: a real defect stays a defect regardless of which round it
  was noticed in or how often it has been argued.
- **A worked example that goes stale.** If your skill points first-time users at
  an example run, that example is part of the specification. When the protocol
  changes and the example does not, you have shipped a document that contradicts
  the rules — and by this loop's own standard, a stale document is a claim the
  project is still making.
- **Believing any of this is measured.** No seeded-defect benchmark has been run
  on this design. Two anecdotes support the core claim — a different model found
  real defects a frontier model missed in its own work, twice — and nothing
  supports the specific round counts, severity boundaries or model choices. If
  you want to know what your critics are worth, seed known defects and count what
  each configuration catches, including how often it flags a clean diff.
