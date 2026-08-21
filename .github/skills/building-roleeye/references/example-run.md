# A worked run

One task, start to finish, showing what the two agents actually say to each
other. Abridged, but the structure and the verdicts are exactly what the protocol
produces. The task is `P9-1`, and the code is invented for illustration.

Read this if you want to know what "the evaluator blocks" means in practice —
and, more usefully, what it means when it *doesn't*.

---

## Round 0 — the evaluator's pre-read

The two agents are spawned together, so the evaluator has forty minutes before
there is anything to review. That time is not idle: its required first output is
its own expectation, sent before the report exists.

```text
I read the task, agent.md, architecture.md §33 and docs/vision.md §3, and enough
of src/portal to know what a shell would be wrapping.

My own answer: the shell should own no UI. If the diff contains portal markup,
that is the defect regardless of what else is right.

What would discriminate: whether the sidecar is spawned with an argument vector
or a command string; whether the window survives a sidecar that never becomes
ready; whether closing the window leaves an orphan. Installer size is nearly
noise at this stage.

What I will verify myself: the spawn call, the allowlist, and the close path. I
will take the build output on trust unless a number looks wrong.

Where I expect an honest failure: code signing. There is no certificate on this
machine, and saying so is not a shortfall.
```

Note what this buys. When the report later argues the change is correct, the
evaluator already holds a view formed without that argument in front of it — and
it has committed, in writing, to checking the spawn call itself. An evaluator
that replies "ready" to this prompt has given up both, and the orchestrator sends
it back.

---

## Round 1

Orchestrator reserves the task, records baseline `a1b2c3d`, and spawns both
agents. Forty minutes later the worker reports.

```text
## WORK REPORT
Task: P9-1 — Desktop shell over the existing portal
Attempt: 1
Status: COMPLETE

### What I changed and why
Added a shell that opens the existing portal at 127.0.0.1 and runs the Node CLI
as a sidecar. The window owns the sidecar's lifetime: it spawns on open and is
killed on close. No portal markup was copied into the shell.

### Files touched
- shell/src/main.rs — window, sidecar spawn, close handler
- shell/tauri.conf.json — build config, allowlist
- package.json — `shell:dev`, `shell:build`

### Commands run
- `npm run typecheck` -> pass
- `npm test` -> pass, 412 tests
- `npm run shell:build` -> pass, produced a 9.1 MB installer

### Acceptance criteria
- opens the existing portal -> met, no duplicated markup
- sidecar started and stopped with the window -> met
- `roleeye ui` still works in a browser -> met, verified manually
- binds nothing beyond 127.0.0.1 -> met
- production build launches -> met on this machine
- lifecycle smoke checks -> partially met, see risks

### Trade-offs I made
- Fixed port 7777 rather than negotiating one. Simpler, and the portal already
  assumes a known port.

### Risks and weak spots
- If port 7777 is taken, the sidecar exits and the window shows a blank page.
- Sidecar kill on close is best-effort; I did not test a hung process.

### Deliberately not done
- Native notifications — that is P9-3.
```

Before the report goes anywhere near the evaluator, the orchestrator runs the
in-loop rubber-duck on a third model, and gets back facts rather than arguments.

```text
[R1] blocker · correctness · shell/src/main.rs:97
     The retry loop is `for i in 0..3`, but the delay is `i * 500ms`. The first
     iteration waits 0ms, so there are effectively two retries, not three.
     Fix: `(i + 1) * 500`.

[R2] minor · correctness · shell/src/port.rs:20
     `is_free()` binds and drops without SO_REUSEADDR, so a port in TIME_WAIT
     reports busy. Cosmetic on Windows, wrong on Linux.
```

Note what these are not: neither is negotiable, neither carries a price, and
neither is the evaluator's business. `[R1]` blocks; `[R2]` becomes a follow-up.
The orchestrator enters both on the ledger and forwards them to the worker in the
same round as the verdict below — but does **not** show them to the evaluator,
whose independence is the whole reason it was spawned early.

The orchestrator forwards the work report verbatim with the diff stat, and the
evaluator answers.

```text
## REVIEW VERDICT
Task: P9-1 — Desktop shell over the existing portal
Round: 1
Verdict: REVISE

### What I verified
- `npm run shell:build` -> pass, installer 9.1 MB (matches the report)
- `npm test` -> 412 pass
- bound address -> `main.rs:88` binds 127.0.0.1, confirmed
Angles not applicable here: none — this change touches process, network and UI

### Findings
[F1] blocker · correctness · shell/src/main.rs:112
     Problem: the sidecar is spawned and the window loads the URL immediately.
     There is no readiness check, so on a cold start the window races the server.
     Evidence: added a 2s delay to the sidecar's listen call and the window
     rendered ERR_CONNECTION_REFUSED with no retry and no message.
     Impact: first-run users see a blank window and have nothing to act on.
     Trade-off: a readiness poll is perhaps 20 lines and one timeout constant;
     the defect makes every cold start on a slow machine look like a crash, and
     it is the first thing a new user sees. The fix is much cheaper than the
     first support conversation about it.
     Recommend: poll the port until it answers, with a timeout and a visible
     error state.

[F2] blocker · security · shell/src/main.rs:64
     Problem: the sidecar is spawned through a shell with the port interpolated
     into the command string.
     Evidence: `Command::new("cmd").args(["/C", &format!("node {} ui --port
     {}", path, port)])`. `path` comes from a config value.
     Impact: a config file the user did not write — restored from a backup,
     synced, or edited by malware — becomes command execution.
     Trade-off: dropping the shell is a three-line change with no behavioural
     cost, against arbitrary command execution. There is nothing to weigh here,
     and I am stating the price only because the protocol asks me to.
     Recommend: spawn the binary directly with argument vectors. No shell.

[F3] major · UX · shell/src/main.rs:120
     Problem: a port collision exits the sidecar silently.
     Impact: indistinguishable from a hang. The user has no next action.
     Trade-off: cheap to fix now, awkward later once error paths multiply.
     Recommend: detect, and either pick another port or say what happened.

[F4] minor · maintainability · shell/tauri.conf.json:22
     Problem: the allowlist enables `shell.open` for the whole app.
     Recommend: narrow to the posting-URL case when P9-5 needs it.

### Trade-offs the worker got right
- Not copying portal markup into the shell. The one-UI rule is the point of the
  phase, and it would have been easy to "just render a bit" here.
```

**The worker is not stopped.** F3 and F4 do not block — they will become
follow-ups. The ledger now carries three open blockers, `[F1]`, `[F2]` and
`[R1]`, from two reviewers who never saw each other's work. All three must close
before the task can.

---

## Round 2 — where the negotiation happens

```text
## WORK REPORT
Task: P9-1 — Desktop shell over the existing portal
Attempt: 2
Status: COMPLETE

### Response to findings
[F2] FIXED — main.rs:64 now spawns the binary directly with an argument vector.
     No shell, no interpolation. Added a test that a path containing `& calc`
     is passed through as one argument.

[R1] FIXED — main.rs:97 now uses `(i + 1) * 500`. Added a test asserting three
     non-zero waits. I note this was a factual claim and it was simply correct;
     there was nothing to argue about.

[F1] SETTLEMENT PROPOSED — I accept the race is real and reproducible. I do not
     accept the remedy as scoped. Polling with a visible error state pulls a
     retry UI into a task whose acceptance criteria are about the shell opening
     the portal at all, and P9-4 owns run-state display.
     The price as I see it: the evaluator's version costs a retry component, a
     new state machine and the tests for both — call it a day, in a task that is
     otherwise done — and it duplicates work P9-4 will do properly. Mine costs
     an hour and closes the actual defect, which is that the failure is silent.
     Proposed: poll the port for up to 10s at 100ms, then show a plain native
     dialog naming the failure and close. No retry UI, no new state machine.
     Residual risk: a machine slower than 10s to cold-start Node shows a dialog
     instead of a window. I have not seen that, but I cannot rule it out.
     Tracked as: a follow-up for a proper error surface, owned by P9-4.
```

The orchestrator re-runs the rubber-duck, which confirms `[R1]` is genuinely
fixed rather than merely claimed, and raises nothing new. That closure is what
lets the ledger clear; a claimed fix that came back would have kept the finding
open under its original id.

The evaluator now has to decide whether the settlement is a real answer or a
dodge.

```text
## REVIEW VERDICT
Round: 2
Verdict: ACCEPT_WITH_FOLLOWUPS

### What I verified
- F2 -> re-read main.rs:64. Argument vector confirmed, no shell. Ran the new
  test; it fails when reverted to the old spawn. Closed.
- F1 -> reproduced with the 10s poll in place: the window now waits and opens.

### Settlements
[F1] SETTLED
     Residual risk: on a machine where Node takes more than 10 seconds to start,
     the user gets a dialog and no app, with no in-app retry.
     Reasoning: the failure is now named rather than blank, which was the actual
     defect. A retry UI in this task would have duplicated what P9-4 builds.

### Follow-ups (do not block this task)
- Sidecar failure needs a real error surface, not a dialog — belongs with P9-4
- Port collision handling (was F3)
- Narrow the shell.open allowlist (was F4)
```

Zero open blockers **on the merged ledger** — `[F2]` and `[R1]` fixed, `[F1]`
settled. The loop closes on round 2: not because the worker gave in, not because
the evaluator did, and not because one reviewer's `ACCEPT` was allowed to speak
for the other's findings.

---

## The settlement record

```text
## SETTLEMENT RECORD — P9-1 Desktop shell over the existing portal
Verdict: ACCEPT_WITH_FOLLOWUPS   Rounds: 2   Stalls: 0
Worker: claude-opus-4.6          Evaluator: gpt-5.6-luna
Rubber-duck (in-loop): gemini-3.1-pro-preview   Security-review: not run (single pass)

Built
- A desktop shell that opens the existing portal over 127.0.0.1 and supervises
  the Node CLI as a sidecar. One UI implementation; the browser portal is
  unchanged. Production installer builds at 9.1 MB.

Findings raised: 3 blockers — fixed 2, withdrawn 0, settled 1, escalated 0
[F2] security — FIXED: sidecar spawned via argument vector, not a shell string.
     A config-supplied path can no longer become command execution.
[R1] correctness — FIXED: retry backoff was `i * 500`, so the first of three
     retries waited 0ms. Now `(i + 1) * 500`, pinned by a test. Confirmed
     resolved by the round-2 rubber-duck pass, not merely claimed.
[F1] correctness — SETTLED: 10s readiness poll plus a native failure dialog,
     instead of a retry UI.
     Priced at: a retry component, a state machine and their tests — roughly a
     day, duplicating P9-4 — against an hour to name the failure. The defect
     was the silence, not the absence of a retry.
     Residual risk: a machine slower than 10s to start Node gets a dialog and
     no app, with no in-app retry.
     Reasoning: the defect was the silent blank window, and that is gone. The
     retry surface belongs to P9-4, which owns run state.
     Tracked as: P9-4a

Severities I assigned myself: none — the rubber-duck graded both of its findings

Trade-offs accepted
- Fixed port 7777 over negotiation. Simpler, and the portal already assumes a
  known port. Cost: collisions need handling — now tracked as P9-1a.

Follow-ups created  (awaiting your approval before they become selectable)
- P9-1a — Handle a port collision visibly
- P9-4a — Real error surface for sidecar failure
- P9-1b — Narrow the shell.open allowlist
- P9-1c — Use SO_REUSEADDR in the port probe (was R2)

Not done, deliberately
- Native notifications — P9-3 owns them.
```

---

## The other ending

Suppose the worker had answered F2 — the shell-injection blocker — with a
contest instead:

> `[F2] CONTESTED — the path comes from our own config file, which the user
> owns. Treating it as untrusted is theoretical.`

The evaluator re-checks and reaffirms, because RoleEye invariant 6 is explicit
that a config value restored from a backup is not a trusted field, and because a
one-line change makes the argument moot. The worker holds. Round 3 closes
nothing, round 4 closes nothing.

That is three stalled rounds, so it escalates:

```text
Task P9-1 is blocked. Rounds: 4. Stalls: 3.

Open blocker [F2] security — sidecar spawned through a shell with a
config-supplied path interpolated into the command string.

Evaluator: a config file is not a trusted field (invariant 6). The fix is one
line: spawn with an argument vector.
Worker: the config is user-owned; the threat model requires an attacker who can
already write to the config directory.
Smallest resolving change: spawn the binary directly with an argument vector.

The question for you: does RoleEye treat its own config directory as a trust
boundary? Invariant 6 says posting text is untrusted but is silent on config.

The working tree is left as it is. Nothing was reverted.
```

Note what the orchestrator does **not** do: decide. It has no independent view of
the code, which is exactly why it is not qualified to break the tie — and a
security question settled by the participant who read neither the diff nor the
threat model is not settled, it is buried.

---

## Counting rounds: the case that looks like a stall and is not

The escalation above turns on three rounds that closed nothing. It is worth being
precise about what "nothing" means, because the obvious reading is wrong and the
first real run of this loop hit it immediately.

Suppose round 2 goes like this: the evaluator confirms both open blockers are
fixed, and raises two new ones about claims the *fixes themselves* introduced —
a number the new method does not support, a test the new prose oversells.

```text
Open blockers entering round 2:  2   [F1] [F2]
Closed during round 2:           2   [F1] fixed, [F2] fixed
Raised during round 2:           2   [F3] [F4]
Open blockers leaving round 2:   2
```

The count did not move, so a rule phrased as "open blockers unchanged" records a
stall. Three rounds like that and a loop resolving two disagreements per round
gets escalated to a human as deadlocked.

It is the opposite of a deadlock. Nothing was re-argued; two findings were
settled and the reviewer found real defects in material that did not exist an
hour earlier. That is the second model doing precisely what it is for — and in
that run, [F3] and [F4] were both false empirical claims caught by reading the
spike's scripts rather than the prose asserting them.

So the rule counts **closures on the merged ledger**: a round is a stall only
when nothing was fixed, withdrawn or settled — from *either* reviewer — and only
rounds that *enter* with an open blocker are eligible at all. A round that closes
an `[R]` while an `[F]` stays open is not a stall, and neither is the reverse.
Round 1 has nothing to close, so it is never a stall — which is
why the escalation above reaches three only after rounds 2, 3 and 4. New findings
neither reset nor inflate the counter. Say which reading you applied when you
report a round, so the human can see the loop's state rather than infer it from a
number.

The counter still cannot see one thing — the same *class* of defect recurring in
new material round after round. Closures keep resetting the count while the work
does not actually improve. No arithmetic catches that; the evaluator is asked to
name it as a pattern, and the orchestrator to pass it on unsoftened.

---

## What to take from this

- A `REVISE` is a round, not a stop. The worker keeps working through it.
- Only `blocker` findings hold a task open. `major` and `minor` become
  follow-ups and never delay a merge.
- **Facts and prices are different arguments.** `[R1]` was a fact: the backoff
  multiplied by zero on the first pass, and there was nothing to negotiate — it
  was fixed and confirmed by re-running the pass. `[F1]` was a price, and got a
  real negotiation. Sending a fact to the negotiation, or a price to the
  fact-checker, is how a loop wastes rounds.
- **One reviewer's `ACCEPT` cannot close another's finding.** The evaluator never
  saw `[R1]`. Closure runs on the merged ledger, and nowhere else.
- Progress is **closures, not the net count**. A round that closes two and raises
  two is converging, not stalling.
- Most real disagreements are about **price, not existence** — F1 was never
  "is this a bug", it was "how much fixing does it deserve here". That is what
  the settlement path is for, and it is the path most rounds should take.
- Escalation is rare, and it is a success. It happens when a question is
  genuinely above both agents' pay grade, and it arrives phrased as a decision
  you can actually make.
- The settlement record is the durable artefact. Six months from now, "we accept
  a dialog instead of a retry on slow machines, because the blank window was the
  real defect" is worth more than a green check.
