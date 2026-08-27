# A worked run

One task, start to finish. Abridged, but the structure is exactly what the skill
produces. The task is `P9-1`, and the code is invented for illustration.

Read this if you want to know what "the critic blocks" means in practice — and,
more usefully, what it means when it *doesn't*.

---

## Step 2 — the work, and the report

The agent implements the task, then writes the report the critics will be checked
against.

```text
## WORK REPORT
Task: P9-1 — Desktop shell over the existing portal
Round: 1

### What I changed and why
A tray helper that starts the Node CLI as a sidecar on 127.0.0.1 and opens the
existing portal in a window. No UI is reimplemented — the shell is a window over
the portal that already exists, which is the point of the phase.

### Files touched
- shell/src/main.rs — spawn the sidecar, bind the window to the local URL
- shell/src/port.rs — pick and probe the port
- shell/tauri.conf.json — window config and allowlist

### Commands run
- `npm run shell:build` -> pass, installer 9.1 MB
- `npm test` -> 412 pass

### Acceptance criteria
- Shell opens the portal without a browser -> met, verified by hand on Windows
- No portal markup duplicated in the shell -> met, the shell has no HTML

### Trade-offs I made
- Fixed port 7777 rather than negotiation. Simpler, and the portal already
  assumes a known port. Cost: collisions need handling.

### Risks and weak spots
- The sidecar's startup is not synchronised with the window load.

### Deliberately not done
- Native notifications — that is P9-3.
```

---

## Step 3 — two critics, in parallel, on different models

Neither sees the other. They are spawned in the same tool block with the report,
the diff, the invariants, and a priming list of what the author would attack.

**`code-review` returns facts:**

```text
[R1] blocker · correctness · shell/src/main.rs:97
     The retry loop is `for i in 0..3`, but the delay is `i * 500ms`. The first
     iteration waits 0ms, so there are effectively two retries, not three.
     Fix: `(i + 1) * 500`.

[R2] minor · correctness · shell/src/port.rs:20
     `is_free()` binds and drops without SO_REUSEADDR, so a port in TIME_WAIT
     reports busy. Cosmetic on Windows, wrong on Linux.
```

**`plan-critic` returns an argument, with prices:**

```text
## CRITIQUE
Task: P9-1 — Desktop shell over the existing portal
Round: 1
Verdict: REVISE

### What I verified
- `npm run shell:build` -> pass, installer 9.1 MB (matches the report)
- bound address -> `main.rs:88` binds 127.0.0.1, confirmed
- "no portal markup duplicated" -> grepped the shell for HTML tags; none. Met.
Questions not applicable here: performance-at-scale, documentation drift

### Findings
[C1] blocker · correctness · shell/src/main.rs:112
     Problem: the report calls the startup race a "risk". It is not a risk, it
     is the current behaviour: the sidecar is spawned and the window loads the
     URL immediately, with no readiness check.
     Evidence: added a 2s delay to the sidecar's listen call; the window
     rendered ERR_CONNECTION_REFUSED with no retry and no message.
     Impact: first-run users see a blank window and have nothing to act on.
     Trade-off: a readiness poll is perhaps 20 lines and one timeout constant;
     the defect makes every cold start on a slow machine look like a crash, and
     it is the first thing a new user sees.
     Recommend: poll the port until it answers, with a timeout and a visible
     error state.

[C2] blocker · security · shell/src/main.rs:64
     Problem: the sidecar is spawned through a shell with the path interpolated
     into the command string. Invariant 6 says every external input is
     untrusted; the report does not say why a config path is exempt.
     Evidence: `Command::new("cmd").args(["/C", &format!("node {} ui --port
     {}", path, port)])`. `path` comes from a config value.
     Impact: a config file the user did not write — restored from a backup,
     synced, or edited by malware — becomes command execution.
     Trade-off: dropping the shell is a three-line change with no behavioural
     cost, against arbitrary command execution. There is nothing to weigh here;
     I state the price only because the protocol asks me to.
     Recommend: spawn the binary directly with argument vectors. No shell.

[C3] major · UX · shell/src/main.rs:120
     Problem: a port collision exits the sidecar silently.
     Impact: indistinguishable from a hang. The user has no next action.
     Recommend: detect, and either pick another port or say what happened.

### Trade-offs the author got right
- Not copying portal markup into the shell. The one-UI rule is the point of the
  phase, and it would have been easy to "just render a bit" here.
```

Three blockers are open — `[R1]`, `[C1]`, `[C2]` — from two critics who never saw
each other's work. `[R2]` and `[C3]` do not block and become follow-ups.

Note what the two critics did *not* produce: any opinion about naming, file
layout or idiom. That belongs to `agent.md` and the linters.

---

## Step 4 — the response, and where the negotiation happens

```text
[C2] FIXED — main.rs:64 now spawns the binary directly with an argument vector.
     No shell, no interpolation. Added a test that a path containing `& calc`
     is passed through as one argument.

[R1] FIXED — main.rs:97 now uses `(i + 1) * 500`. Added a test asserting three
     non-zero waits. This was a factual claim and it was simply correct; there
     was nothing to argue about.

[C1] SETTLEMENT PROPOSED — I accept the race is real and reproducible, and I
     accept the report understated it. I do not accept the remedy as scoped.
     The price as I see it: a visible error state with retry pulls a retry
     component, a new state machine and their tests into a task whose acceptance
     criteria are about the shell opening the portal at all — call it a day of
     work, duplicating what P9-4 will build properly. A readiness poll plus a
     plain native dialog costs an hour and closes the actual defect, which is
     that the failure is silent.
     Proposed: poll the port for up to 10s at 100ms, then show a native dialog
     naming the failure and close. No retry UI, no new state machine.
     Residual risk: a machine slower than 10s to cold-start Node shows a dialog
     instead of a window. I have not seen that, but I cannot rule it out.
     Tracked as: a follow-up for a proper error surface, owned by P9-4.
```

**The author does not close any of these.** All three go back to the critic that
raised them, with the code after the fixes.

---

## Round 2 — the critics answer

`code-review` is spawned fresh and cannot remember `[R1]`, so it is asked
directly whether the fix holds. It confirms the fix and raises nothing new. That
confirmation is what lets `[R1]` close; a defect that had come back would have
kept its original id rather than counting as progress.

```text
## CRITIQUE
Round: 2
Verdict: ACCEPT_WITH_FOLLOWUPS

### What I verified
- C2 -> re-read main.rs:64. Argument vector confirmed, no shell. Ran the new
  test; it fails when reverted to the old spawn. Closed.
- C1 -> reproduced with the 10s poll in place: the window now waits and opens.

### Responses to my previous round
[C2] WITHDRAWN — fixed and pinned by a test that fails on the old code.
[C1] SETTLED
     Residual risk: on a machine where Node takes more than 10 seconds to start,
     the user gets a dialog and no app, with no in-app retry. The defect was the
     silence, not the absence of a retry, and that is gone. A retry surface in
     this task would have duplicated what P9-4 owns.

### Follow-ups (do not hold the task open)
- Sidecar failure needs a real error surface, not a dialog — belongs with P9-4
- Port collision handling (was C3)
```

Zero open blockers across both critics. Validation runs, and the task closes.

---

## The settlement record

```text
## SETTLEMENT RECORD — P9-1 Desktop shell over the existing portal
Verdict: ACCEPT_WITH_FOLLOWUPS   Rounds: 2   Stalls: 0
Author: claude-opus-5   Facts: gemini-3.1-pro-preview   Reasoning: gpt-5.6-luna
Validation: npm run typecheck, npm test (412 pass), npm run build — all green

Built
- A desktop shell that opens the existing portal over 127.0.0.1 and supervises
  the Node CLI as a sidecar. One UI implementation; the browser portal is
  unchanged. Production installer builds at 9.1 MB.

Findings raised: 3 blockers — fixed 2, withdrawn 0, settled 1, escalated 0
[C2] security — FIXED: sidecar spawned via argument vector, not a shell string.
     A config-supplied path can no longer become command execution.
[R1] correctness — FIXED: retry backoff was `i * 500`, so the first of three
     retries waited 0ms. Now `(i + 1) * 500`, pinned by a test and confirmed
     resolved by the round-2 pass rather than merely claimed.
[C1] correctness — SETTLED: 10s readiness poll plus a native failure dialog,
     instead of a retry UI.
     Priced at: a retry component, a state machine and their tests — roughly a
     day, duplicating P9-4 — against an hour to name the failure.
     Residual risk: a machine slower than 10s to start Node gets a dialog and
     no app, with no in-app retry.
     Tracked as: P9-4a

Severities I assigned myself: none — both critics graded their own findings
Findings that were prompted: C1 — my priming list named the startup race

Trade-offs accepted
- Fixed port 7777 over negotiation. Simpler, and the portal already assumes a
  known port. Cost: collisions need handling — now tracked as P9-1a.

Follow-ups created  (awaiting your approval before they become selectable)
- P9-1a — Handle a port collision visibly
- P9-4a — Real error surface for sidecar failure
- P9-1b — Use SO_REUSEADDR in the port probe (was R2)

Not done, deliberately
- Native notifications — P9-3 owns them.
```

Note the two honesty lines. *Findings that were prompted* stops the author
concluding a critic is strong when the priming list was. *Severities I assigned
myself* marks any grading the author did on a critic's behalf, because a finding
you graded is not a finding it graded.

---

## The other ending

Suppose the author had answered `[C2]` — the shell-injection blocker — with a
contest instead:

> `[C2] CONTESTED — the path comes from our own config file, which the user
> owns. Treating it as untrusted is theoretical.`

The critic re-checks and reaffirms, because invariant 6 is explicit that a config
value restored from a backup is not a trusted field, and because a three-line fix
against arbitrary command execution is not a trade-off anyone needs to think
about. The author contests again on the same grounds. Nothing closes.

That is a stalled round, and after three of them the task goes to the human:

```text
Open blocker [C2] security — sidecar spawned through a shell with a
config-supplied path interpolated into the command string.

My position:      the config file is user-owned, so the path is trusted.
The critic's:     invariant 6 admits no exception for config; a synced or
                  restored file is not user-authored in any meaningful sense.
Smallest fix:     spawn with an argument vector — three lines, no behaviour
                  change.
Your call:        does invariant 6 apply to files the app itself writes?
                  Either answer is actionable, and it settles more than this task.
```

Notice what the escalation is *not*: the author does not get to close `[C2]` by
being unconvinced. That is the rule the whole shape rests on — and note also that
the author's position here is the weaker one, which is exactly why it does not
get to be the deciding one.

---

## Counting rounds: the case that looks like a stall and is not

Suppose round 2 goes like this: the critic confirms both open blockers are fixed,
and raises two new ones about claims the *fixes themselves* introduced.

```text
Open blockers entering round 2:  2   [C1] [C2]
Closed during round 2:           2   [C1] fixed, [C2] fixed
Raised during round 2:           2   [C3] [C4]
Open blockers leaving round 2:   2
```

The count did not move, so a rule phrased as "open blockers unchanged" records a
stall. Three rounds like that and a loop resolving two disagreements per round
gets escalated as deadlocked.

It is the opposite of a deadlock. Nothing was re-argued; two findings closed and
the critic found real defects in material that did not exist an hour earlier. So
the rule counts **closures**, from either critic: a round is a stall only when
nothing was fixed, withdrawn or settled, and only rounds that *enter* with an
open blocker are eligible at all.

The counter still cannot see one thing — the same *class* of defect recurring in
new material round after round. Closures keep resetting the count while the work
does not improve. No arithmetic catches that; say it out loud instead.

---

## What to take from this

- **You are the author, so you do not get the last word.** A blocker closes when
  it is fixed, when the critic withdraws it, or when the human decides.
- **Facts and prices are different arguments.** `[R1]` was a fact — the backoff
  multiplied by zero — and there was nothing to negotiate. `[C1]` was a price,
  and got a real negotiation. Sending a fact to the negotiation, or a price to
  the fact-checker, wastes rounds.
- **One critic's ACCEPT cannot close the other's finding.** They never saw each
  other's work.
- Only `blocker` findings hold a task open. `major` and `minor` become follow-ups
  and never delay a merge.
- Progress is **closures, not the net count**.
- Most real disagreements are about **price, not existence** — `[C1]` was never
  "is this a bug", it was "how much fixing does it deserve here".
- Escalation is rare, and it is a success. It arrives phrased as a decision a
  human can actually make.
- The settlement record is the durable artefact. Six months from now, "we accept
  a dialog instead of a retry on slow machines, because the blank window was the
  real defect" is worth more than a green check.
