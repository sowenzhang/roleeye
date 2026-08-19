# A worked run

One task, start to finish, showing what the two agents actually say to each
other. Abridged, but the structure and the verdicts are exactly what the protocol
produces. The task is `P9-1`, and the code is invented for illustration.

Read this if you want to know what "the evaluator blocks" means in practice —
and, more usefully, what it means when it *doesn't*.

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

The orchestrator forwards this verbatim with the diff stat, and the evaluator
answers.

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
     Recommend: poll the port until it answers, with a timeout and a visible
     error state.

[F2] blocker · security · shell/src/main.rs:64
     Problem: the sidecar is spawned through a shell with the port interpolated
     into the command string.
     Evidence: `Command::new("cmd").args(["/C", &format!("node {} ui --port
     {}", path, port)])`. `path` comes from a config value.
     Impact: a config file the user did not write — restored from a backup,
     synced, or edited by malware — becomes command execution.
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
follow-ups. Two blockers are open, so there is a round 2.

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

[F1] SETTLEMENT PROPOSED — I accept the race is real and reproducible. I do not
     accept the remedy as scoped. Polling with a visible error state pulls a
     retry UI into a task whose acceptance criteria are about the shell opening
     the portal at all, and P9-4 owns run-state display.
     Proposed: poll the port for up to 10s at 100ms, then show a plain native
     dialog naming the failure and close. No retry UI, no new state machine.
     Residual risk: a machine slower than 10s to cold-start Node shows a dialog
     instead of a window. I have not seen that, but I cannot rule it out.
     Tracked as: a follow-up for a proper error surface, owned by P9-4.
```

The evaluator now has to decide whether that is a real answer or a dodge.

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

Zero open blockers. The loop closes on round 2 — not because the worker gave in,
and not because the evaluator did.

---

## The settlement record

```text
## SETTLEMENT RECORD — P9-1 Desktop shell over the existing portal
Verdict: ACCEPT_WITH_FOLLOWUPS   Rounds: 2   Stalls: 0
Worker: claude-opus-4.6          Evaluator: gpt-5.6-luna

Built
- A desktop shell that opens the existing portal over 127.0.0.1 and supervises
  the Node CLI as a sidecar. One UI implementation; the browser portal is
  unchanged. Production installer builds at 9.1 MB.

Blockers raised: 2 — fixed 1, withdrawn 0, settled 1, escalated 0
[F2] security — FIXED: sidecar spawned via argument vector, not a shell string.
     A config-supplied path can no longer become command execution.
[F1] correctness — SETTLED: 10s readiness poll plus a native failure dialog,
     instead of a retry UI.
     Residual risk: a machine slower than 10s to start Node gets a dialog and
     no app, with no in-app retry.
     Reasoning: the defect was the silent blank window, and that is gone. The
     retry surface belongs to P9-4, which owns run state.
     Tracked as: P9-4a

Trade-offs accepted
- Fixed port 7777 over negotiation. Simpler, and the portal already assumes a
  known port. Cost: collisions need handling — now tracked as P9-1a.

Follow-ups created  (awaiting your approval before they become selectable)
- P9-1a — Handle a port collision visibly
- P9-4a — Real error surface for sidecar failure
- P9-1b — Narrow the shell.open allowlist

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

## What to take from this

- A `REVISE` is a round, not a stop. The worker keeps working through it.
- Only `blocker` findings hold a task open. `major` and `minor` become
  follow-ups and never delay a merge.
- Most real disagreements are about **price, not existence** — F1 was never
  "is this a bug", it was "how much fixing does it deserve here". That is what
  the settlement path is for, and it is the path most rounds should take.
- Escalation is rare, and it is a success. It happens when a question is
  genuinely above both agents' pay grade, and it arrives phrased as a decision
  you can actually make.
- The settlement record is the durable artefact. Six months from now, "we accept
  a dialog instead of a retry on slow machines, because the blank window was the
  real defect" is worth more than a green check.
