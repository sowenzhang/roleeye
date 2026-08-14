# RoleEye — Product Vision

Status: agreed direction, not yet built. Phases 0–3b are implemented; everything
here describes where those foundations are heading.

This document exists because the target changed shape. Phases 0–3b were built as
a local CLI that calls a model API. The vision below keeps that engine and wraps
it in a Windows application that can also *delegate* work to an AI agent already
installed on the machine. That is a bigger change than it looks, and section 6
is the part that needs the most scrutiny.

---

## 1. What RoleEye is

A career agent that runs entirely on your own machine, watches the job market on
your behalf, tells you which roles are worth your attention and why, prepares
the materials, and then gets out of the way so you can decide.

It is not an auto-apply bot. It never was, and section 6.4 explains why that
constraint gets *more* important as the app gains the ability to act, not less.

## 2. Who it is for

Phases 0–3b are usable by anyone comfortable with a terminal. The vision widens
that to anyone who can install a Windows application.

The onboarding question is now settled: **the user brings an AI agent they
already pay for.** RoleEye drives that agent's CLI rather than asking for an API
key, so there is no second subscription and no key to obtain. GitHub Copilot CLI
is supported first.

A local model (Ollama) remains supported for people who want nothing to leave
the machine, and a direct API key still works. Neither is the onboarding story.

## 3. The shape of the product

Two front ends over one engine, both first-class:

- **The CLI**, for people who prefer a terminal and their own scheduler.
- **A desktop app (Tauri)**, for everyone else.

Neither is a reimplementation. Anything the app does, the CLI must be able to
do, because that is what keeps the logic testable.

The app has five jobs:

1. **Configure.** Pick companies, roles, locations, pay floor and rules by
   clicking. (The Phase 3c portal is the prototype and already works this way.)
2. **Choose an engine.** Select the agent CLI you already pay for, a local
   model, or an API key.
3. **Schedule.** Run on a cadence using Task Scheduler, with native toasts.
4. **Watch.** Show the work: what was found, what was screened out and by which
   rule, what was evaluated and what it consumed.
5. **Act.** Open a chosen role, present the tailored resume and drafted answers,
   and hand control back for the final step.

### 3.1 Why Tauri, and the constraint it has to respect

`architecture.md` bans bundlers: `tsc` is the only build step. A conventional
Tauri app would add a Rust toolchain *and* a frontend bundler, which breaks
that.

The way through is that Tauri can load a URL. The portal is already a plain
`node:http` server rendering a single page with no build step, so:

- the Tauri window points at `127.0.0.1` and renders the existing portal;
- the Node CLI runs as a **sidecar** process the app starts and stops;
- there is exactly one UI implementation, and the browser portal keeps working.

Open question, deliberately not answered yet: whether the sidecar ships a
bundled Node runtime or requires Node to be installed. That decides the
installer size and the "non-engineer can install it" claim, and it should be
decided with numbers rather than taste.

## 4. Why a desktop app and not a web service

Everything RoleEye holds is personal: an employment history, a salary floor, a
record of who rejected you. A hosted service would need to hold that data to be
useful, and would then have both a reason and an opportunity to monetise it.
Keeping storage and orchestration on the user's machine removes that possibility
structurally rather than by promise.

One honest qualification: **local storage is not local inference.** If the user
selects a hosted model — or an installed agent that calls one — their career
data is sent to that provider, and running the subprocess locally does not
change that. Only a local model (Ollama) makes "nothing leaves this machine"
literally true, which is why the portal states it per option rather than as a
general claim. At-rest protection is a separate, currently unsolved gap (§11).

The app also unlocks the things a CLI cannot do: native notifications, a
schedule the user can see and trust, a visible run log, and — the reason for
section 5 — the ability to reuse an AI agent the user has already installed and
paid for.

## 5. Two ways to think

RoleEye needs a reasoner. There are two fundamentally different ways to get one,
and the app should support both because they fail in different ways.

### 5.1 Model mode (built, Phase 3b)

RoleEye owns the loop. It builds the prompt, fences the untrusted posting text,
calls a model through `ReasoningProvider`, validates the response against a
schema, and computes the score itself in deterministic code. The model only
supplies judgement on bounded questions; it never touches the filesystem, never
runs a command, and cannot take an action.

Works with a hosted API or a local Ollama model. This is the default and the
safe path.

### 5.2 Agent mode (built as a reasoner; tool use still gated)

Many target users already have a coding agent installed and paid for. Agent mode
reuses it: RoleEye launches that agent as a subprocess under the current Windows
user and asks it a question.

**This is now the primary path, and the API key is no longer required.** GitHub
Copilot CLI is the first supported agent.

The decisive detail is that a reasoner does not need an approval bypass.
`--yolo` and `--dangerously-skip-permissions` exist so an agent can *act*
without asking. RoleEye does not want the agent to act; it wants an answer.
So the agent is invoked with every tool denied:

```
copilot -p <prompt> --deny-tool=all --disable-builtin-mcps
        --no-custom-instructions --disallow-temp-dir --no-ask-user
```

`--no-custom-instructions` matters as much as `--deny-tool=all`: an agent
normally loads instruction files from the working directory and the user
profile, and those would silently join a prompt that also contains an untrusted
job posting.

With no tools, no MCP servers, and no instruction files, the agent has the same
blast radius as an API call: it reads text and returns text. That is why this
ships now while §6 stays gated — §6 is about agents that *act*.

### 5.3 What it actually costs (measured, not estimated)

Against a real stored posting, using RoleEye's real extraction prompt:

| | Direct API | Copilot CLI |
| --- | --- | --- |
| Latency | ~2-5s | **92s per call** |
| Input tokens | ~3,400 | **~30,000** |
| Billing | per token, in dollars | subscription quota |
| Structured output | `json_object` mode | prompt-and-parse |

The agent carries a large fixed system prompt, so a trivial 90-character
question still cost 30.2k input tokens. Three consequences, all now reflected in
the design:

1. **Spend accounting cannot be in dollars.** The provider reports
   `requestCount` and leaves `estimatedCostUsd` undefined rather than inventing
   a number. Budgets for agent mode must be expressed in calls, not currency.
2. **Bulk evaluation must be incremental and resumable.** 100 roles × 2 passes ×
   92s is over five hours. The deterministic funnel that already cuts 1,715
   postings to ~123 is what makes this viable at all, and it becomes the
   difference between feasible and not.
3. **Retries are expensive.** The agent provider makes exactly one repair
   attempt, and that attempt names the precise schema violations.

## 6. The security problem in agent mode

This is the part of the vision I am least comfortable with, and I would rather
say so now than discover it later.

### 6.1 What changes

Every phase so far has treated job postings as hostile input. They are
attacker-controlled text: anyone can post a job. `agent.md` §40 and the prompt
fencing in `src/evaluate/prompts.ts` exist for exactly this reason, and the
`embedded_instructions` field in the assessment schema exists so the system can
*report* an injection attempt rather than obey it.

Agent mode inverts that posture. The proposed invocations —
`copilot --yolo`, `claude --dangerously-skip-permissions` — are approval
bypasses. They exist so an agent can act without stopping to ask. Combining an
approval bypass with attacker-controlled text, running as the user's own Windows
account, converts a prompt injection into arbitrary code execution with that
user's full privileges: their documents, their SSH keys, their browser profile,
their cloud sessions, their corporate network.

The attack does not require sophistication. It requires someone to post a job
description containing instructions, and our app to read it aloud to an agent
that has been told not to ask permission.

### 6.2 Why the usual answer is not enough

"We fence the text" is a mitigation for model mode, where the worst outcome is a
wrong score in a database row we control. It is not a mitigation for an
autonomous agent with shell access, because fencing is a *prompt* technique and
the agent's harm comes from *tools*. There is no known reliable defence against
prompt injection at the prompt layer.

### 6.3 What would make agent mode defensible

I would want all of these, not a selection:

1. **The agent never sees raw posting prose.** RoleEye's deterministic layer
   parses postings into structured records. Agent mode should operate on those.
   **This reduces the attack surface; it does not remove it.** Structured is not
   the same as trusted, and the channels below still carry attacker-chosen
   content:
   - Title, company, department, team and location are strings the poster
     chooses. (These were being placed *outside* the prompt fence until a review
     caught it; they are now inside it, with newlines stripped.)
   - Extracted requirements are produced by a *model* reading the posting
     (`agent.md` §2), not by code. An injected instruction can be carried
     forward into a structured field.
   - URLs, redirect targets, and downloaded filenames.
   - The RAG index, which stores normalized descriptions and can replay an
     attack indirectly in a later session.
   - Application form questions, help text, hidden fields and page DOM — which
     defeat the premise entirely for the "fill a form" use case.
   - Artifact paths containing a company slug.
   - Anything persisted earlier: notes, answers, prior evaluations.

   The invariant is therefore not "raw versus structured" but: **any value that
   retains attacker-chosen semantics stays untrusted, whatever its schema.**
2. **A dedicated workspace.** Working directory set to a RoleEye-owned folder
   containing only what the task needs. Never the user's home, never the repo.
   Junctions, symlinks and reparse points are escapes and must be blocked, not
   assumed away.
3. **A sandbox rather than a second user account.** A separate low-privilege
   Windows account sounds tidy and is probably not acceptable: it may need
   elevation, is often prohibited on managed devices, does not inherit the
   agent's existing authentication (so the user does not get "the agent they
   already paid for"), and still has outbound network access. AppContainer/LPAC
   or a disposable VM is the more honest control, and compatibility with
   arbitrary third-party Node agents cannot be assumed.
4. **No approval bypass by default.** `--yolo` is opt-in per task, described in
   plain language, and never the value we ship.
5. **A visible, recorded transcript.** Detective, not preventive — an unattended
   user is not watching. Transcripts also capture PII and must be protected.
6. **Egress and action limits.** Exfiltration paths include HTTP, DNS, browser
   navigation, git, and the model provider itself. A sandboxed agent can also
   reach the localhost RAG service, which holds the entire career history.

Attack classes that must be covered and are easy to forget: PATH hijacking of
the agent executable; auto-loaded agent instruction files, MCP servers, hooks and
plugins; browser downloads, OAuth popups and autofill leakage; resource
exhaustion and token-cost attacks; malicious PDF/DOCX parser input during resume
import; and supply-chain compromise of the agent, the updater or the driver.

### 6.3a A better decomposition

"Agent mode" is really two features with different risk profiles, and merging
them is what makes it indefensible:

- **Agent as reasoner.** No shell, no browser, no filesystem. Schema-only
  output. This is just another `ReasoningProvider` and can ship early.
- **Application assistant.** Narrow browser automation with typed capabilities —
  `readQuestion`, `setField`, `uploadApprovedArtifact` — and no general shell.

A general-purpose coding agent should not be the security boundary for browser
automation. Splitting them also resolves the contradiction in §5.2: the
capabilities that made agent mode attractive were exactly the ones §6.3 forbids.

### 6.4 The submit button

The vision mentions the app opening a role and submitting the resume. I want to
separate two things that sound similar:

- **Assisted application** — the app opens the posting, fills the form from
  approved facts, drafts the additional answers, and shows the user the
  completed form. The human reads it and presses submit. This is a large,
  genuine convenience win.
- **Autonomous submission** — the app presses submit. This is prohibited by
  `agent.md` and should stay prohibited.

The reason is not squeamishness. An application is an assertion about yourself,
made under your name, that a stranger will act on. Every failure mode of this
system — a mis-parsed salary, a hallucinated claim, a fraudulent posting we
failed to screen, an injected instruction — becomes attributable to the user
once it is submitted, and often cannot be withdrawn.

Two caveats I want on the record, because the argument is weaker than it first
appears:

- **Prefilling is not risk-free.** Populating fields already transmits data
  through autosave, validation calls, tracking scripts and file uploads. The
  risk does not begin at the final click; the click is where it becomes an
  assertion.
- **A repeated click is weak consent.** A user who approves forty forms will
  rubber-stamp the forty-first. A policy-level approval ("submit only to
  allowlisted ATS providers, using exact stored facts, with no open-text answers
  and no unanswered protected fields") is arguably more meaningful than a tired
  human clicking through.

The prohibition therefore stands as a **product governance rule**, not as a
claim that one click is a complete safety boundary. It stands mainly because
there is no reliable way to know that a hostile, dynamic, multi-page form
contains only the payload the user reviewed.

## 7. Fewer resumes, not more

Tailoring one resume per *discovered* posting is the obvious design and the
wrong one. But the honest comparison is not 6 archetypes against 100
generations — nobody should generate a resume for a role the user never applies
to. The real alternative is: generate a bounded delta **after** the user chooses
`APPLY`. At 100 discovered roles and eight applications, that is six archetype
generations versus eight deltas.

The design:

- The user defines a small number of **role archetypes** — for example "AI
  platform engineering", "payments backend", "engineering management".
- Each archetype gets **one carefully tailored resume**, generated once and
  reviewed properly, drawn from approved facts.
- A posting is matched to an archetype by a classifier that **does not exist
  yet** and must be built. (`src/portal/presets.ts` compiles UI selections into
  scope configuration; it does not classify postings. An earlier draft of this
  document claimed otherwise and was wrong.)
- On `APPLY`, and only then, RoleEye produces a per-application delta: approved
  fact selection, requirement-specific keyword coverage, summary and skills
  adjustment, bullet selection and ordering — presented as a **diff** to review,
  and skipped entirely when it would be immaterial.

### The honest failure mode

**Safe genericity.** Nothing is fabricated, but the resume is less discoverable
in ATS keyword search and less obviously relevant to a recruiter, because
requisition-specific vocabulary — particular technologies, certifications,
industry terms — is missing. Two roles inside one archetype can also want
completely different evidence.

That failure is nearly invisible: it shows up as silence, which the user will
attribute to the market or to themselves rather than to their resume. The
per-application delta exists specifically to counter it, which is why it is part
of the design and not an optimisation to drop later.

## 8. Answering the extra questions

Application forms ask more than a resume covers: notice period, salary
expectation, work authorisation, why this company, willingness to relocate.

RoleEye should draft these. An earlier draft of this document sorted answers into
"recalled / composed / never invented", which does not survive contact with real
forms: those three are not mutually exclusive. Provenance and policy are separate
axes — a work-authorisation answer is both *recalled* and *never invented*, and
compensation appeared under both headings.

Each stored answer therefore carries independent attributes:

- **Provenance** — user-stated, system-derived, or model-drafted.
- **Permitted transformation** — exact reuse, formatting only, calculated
  (for example "years of Kubernetes experience", derived from approved facts),
  or drafted prose.
- **Sensitivity** — whether it falls in a protected category.
- **Scope** — employer, jurisdiction, or role-specific rather than universal.
- **Freshness** — when it was last confirmed, and when it expires.
- **Confirmation required** — whether a human must re-affirm it for this
  application.
- **Source fact IDs** — exactly which approved facts back it.

This handles the questions the three-way split could not:

| Question | Why it needed attributes |
| --- | --- |
| "Will you now or in future require sponsorship?" | recalled *and* protected; jurisdiction-scoped; expires |
| "Are you willing to relocate to Austin?" | a decision for this role, not a standing fact |
| "How many years of Kubernetes do you have?" | calculated from facts, not recalled or drafted |
| "Have you previously applied here?" | system-derived from our own application history |
| "Are you subject to a non-compete?" | legal judgement; must require confirmation |
| "Why are you leaving your current role?" | sensitive narrative; drafted but never auto-sent |
| "I certify this information is accurate." | an attestation, not an answer — always human |

The absolute rule is unchanged: `agent.md` forbids inventing answers to legal,
demographic, compensation, work-authorisation, disability, veteran and
background-check questions. If the user has not supplied one, the field stays
empty and is flagged. It is never guessed and never copied from a
similar-looking previous answer — superficially identical authorisation
questions can mean materially different things.

Reuse is subject to freshness: salary expectation, notice period, location and
authorisation all go stale, and a stale answer submitted under the user's name
is a false statement.

## 9. What this means for the existing architecture

Most of it survives, which is the point of having built it deterministically.

| Existing | Under the vision |
| --- | --- |
| SQLite as source of truth | unchanged; the app reads the same database |
| Deterministic acquisition, dedupe, screening, scoring | unchanged; still code, not model |
| `ReasoningProvider` | becomes one of two engines; agent mode is a sibling |
| Config portal (Phase 3c) | becomes a screen in the app |
| CLI | stays, and remains the way the app does work |
| Local RAG (Phase 7) | becomes a service the app starts |
| Never auto-apply | unchanged, and load-bearing |

The app is a shell around the CLI, not a rewrite of it. Anything the app can do,
the CLI must still be able to do, because that is what keeps the logic testable
and keeps engineers as first-class users.

## 10. Sequencing

The vision does not change what to build next; it changes what to build after.

1. Finish the engine: notifications (3.5), resume and facts (4), tracking (5).
2. Build archetype resumes (§7) as part of Phase 4 rather than per-posting
   tailoring — a change to the existing plan, not an addition. This requires a
   posting-to-archetype classifier that does not exist yet.
3. Add form answering (§8) to Phase 5, where application records live.
4. Then the Tauri app shell (Phase 9), pointing at the existing portal with the
   CLI as a sidecar.
5. Application assistance and tool-using agent mode last (Phase 10b).

**Done already:** agent-as-reasoner (§5.2) shipped with Phase 3b. It was
sequenced last while it was assumed to require an approval bypass; once it was
clear a reasoner needs no tools at all, it became the safest path rather than
the most dangerous one, and the onboarding contradiction below dissolved.

### The onboarding contradiction, resolved

§2 previously said both prerequisites — a terminal and an LLM subscription — had
to become optional. The agent CLI removes the subscription-and-key requirement
now, and the Tauri shell removes the terminal at Phase 9. What remains is that
the user must already own a coding agent, which is a narrower claim than "no
prerequisites" and should be stated honestly in the product's own description.

One dependency correction stands:

- Phase 9 must not require Phase 7 (local RAG), which `docs/progress.md` marks
  speculative. A speculative phase cannot be a hard dependency of the adoption
  shell; retrieval is optional at runtime.

## 11. What this document does not yet cover

Naming the gaps is more useful than implying they are handled:

- **Backup and recovery.** Permanent local history is a liability without
  tested restore, export and migration. `roleeye backup` exists; a policy does
  not.
- **Encryption at rest.** The database, imported resumes and demographic answers
  are plaintext. "Local" does not protect against malware, a shared Windows
  account, or a stolen laptop.
- **Installer and update security.** Code signing, SmartScreen reputation,
  update trust and rollback.
- **Real application-site workflow.** Account creation, MFA, CAPTCHA, email
  verification, multi-page state, assessments, upload validation, and the
  anti-automation terms of the sites involved.
- **Sensitive-answer retention.** Whether demographic, disability, veteran and
  background answers should be stored at all, and how they are deleted.
- **Discovery recall.** Public ATS feeds miss many roles. There is no position
  yet on LinkedIn, Indeed, recruiter-only postings, or how a user learns what
  was missed — this remains the product's honest weakness.
- **Outcome tracking completeness.** Without email or calendar integration,
  outcomes are manually entered and therefore selective, which biases the
  Phase 8 learning loop.
- **Quality metrics.** No target for recommendation precision, false-negative
  rate, or trust calibration.
- **Accessibility and internationalisation.** Screen readers, keyboard use,
  currencies, jurisdictions and non-US authorisation regimes.
