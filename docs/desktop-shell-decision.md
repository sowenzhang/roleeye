# Desktop shell decision (P9-0)

Status: decided, 2026-08-18. Supersedes the Tauri assertion in `docs/vision.md`
§3.1 and the Phase 9 heading in `architecture.md` §33.

`docs/vision.md` §3.1 named Tauri, but the paragraph underneath it argues for a
*property*, not a product: a window that loads `127.0.0.1`, renders the existing
portal, and supervises the Node CLI as a sidecar. Several toolchains have that
property, and one of the candidates is not a toolchain at all. This document
takes all three as far as a working prototype on one machine and decides with
numbers.

**Outcome: no native shell for now.** Ship a Windows tray helper that supervises
the CLI and hands the URL to the user's browser. **Bundle the Node runtime.** If
a native shell later becomes necessary, it is **Tauri** — the conditions that
would trigger that are named in "What would reverse this".

---

## 1. What was compared

| | Candidate |
| --- | --- |
| 1 | **Tauri** (Rust) — window on `WebviewUrl::External`, sidecar spawned from `setup()` |
| 2 | **Wails v2** (Go) — window on the Wails asset server, sidecar spawned from `main()` |
| 3 | **No native shell** — a tray helper that starts the CLI and opens the browser |

Candidate 3 was prototyped in three sub-variants, because "use the browser" is
not one option:

- **3a — a shortcut to `roleeye ui`.** Already shipped. `roleeye ui` starts the
  portal and opens the default browser. Cost to build: zero.
- **3b — a chromeless window**, `msedge --app=<url>` with its own profile. Own
  taskbar entry, no URL bar.
- **3c — a tray helper** (`RoleEyeTray.exe`) that supervises the sidecar, reads
  the tokenized URL off its stdout, offers Open / Stop and quit, and raises a
  native balloon notification. This is the variant measured as "no shell"
  below, because it is the only one that supervises the process the way a
  native shell does.

Every prototype is throwaway and lives outside the repository, under
`%TEMP%\roleeye-p9-0-spike`. Nothing from the spike is merged; `src/` is
untouched.

---

## 2. How the numbers were produced

All measurements are from this machine, on 2026-08-18. Nothing below is a
vendor figure. Where a number is missing it is called missing.

**Machine.** Windows 11 Enterprise Insider Preview, 10.0.26671 (24H2). Intel
Core Ultra 7 165H, 22 logical CPUs, 31.5 GB RAM. Node v22.16.0. WebView2
Runtime 151.0.4129.93.

**Toolchains.** rustc/cargo 1.94.1 (already installed, not by this spike);
`tauri` crate 2.11.5 via `@tauri-apps/cli` v2 from npm; Go 1.26.6 and Wails CLI
v2.15.0 (both installed for this spike); `csc.exe` from
`C:\Windows\Microsoft.NET\Framework64\v4.0.30319`, which ships with Windows.

**Cold start** is wall-clock milliseconds from the moment the shell process is
launched to the moment the rendered window issues its **first HTTP GET** against
the loopback sidecar. The sidecar records it itself, against a timestamp stamped
immediately before `Start-Process`, so there is one clock and no skew. Median of
5 runs; a warm-up run is discarded first, because Windows caches the image and
WebView2 initialises a user-data directory on first use.

This is time-to-first-request, not time-to-first-paint. It is a lower bound on
what the user sees, and it is the same lower bound for every candidate.

**The sidecar used for timing is a stub** (`harness.mjs`) that prints a URL in
the same shape `roleeye ui` prints and does nothing else, so the numbers isolate
the shell rather than measuring RoleEye's boot five times. The real boot cost is
measured separately and added back in §3.2.

**Resident memory** is the **delta in total working set across a process set
identified by command line**, sampled before the shell is launched and again
after the page has loaded (10 s settle). Both halves matter:

- *Membership by command line, not by PID.* Every child of a WebView2 host or an
  Edge instance inherits `--user-data-dir`, so a per-candidate data directory
  identifies the process set exactly — including processes that already existed,
  and excluding same-named processes belonging to other applications.
- *A delta over totals, not a sum over new processes.* Opening a tab grows the
  browser, GPU and network processes that were already running, and that growth
  is part of the cost.

For a native shell the "before" set is empty, so the delta equals the whole
footprint and the two kinds of candidate go through one identical procedure.

> **This replaces a wrong measurement, and the correction matters.** Round 1 of
> this spike defined membership as a PID diff — processes that did not exist
> before the launch — and ran the browser case against the machine's real,
> already-busy Edge. That method is complete for a native shell, which starts
> every process it uses, and wrong in *both* directions for a browser tab: it
> misses growth inside existing processes, and it attributes entire newly
> spawned browser processes to us when a busy browser starts processes for its
> own reasons. It reported 440.3 MB for the warm-tab case. The corrected method
> reports 185.0 MB. The round-1 number was too high, not too low, and the
> conclusion drawn from it — that the options were memory-identical — was wrong.
> §3.3 carries the corrected result.

**Installer size** is one NSIS script (`installer.nsi`, LZMA solid, per-user
install, Start Menu shortcut) applied to every candidate, so the only thing
differing between the numbers is what is being installed. Each framework's own
bundler output is reported separately where it exists.

**Clean build** is the framework's own build command after removing its build
output, with the dependency cache warm — `cargo clean` for Tauri, `go clean
-cache` for Wails. That is the number a contributor pays on a normal day. The
first-ever build, which includes downloading dependencies, is reported
separately.

### Known limitations of this method

- **Summing working sets over-counts shared pages.** Chromium processes share a
  great deal, and none of these figures corrects for it. This inflates every
  multi-process candidate — Tauri's six webview processes as much as Edge's
  eleven — so it distorts the absolute numbers more than the comparison.
- The warm-browser case uses a **controlled** Edge instance on a dedicated
  profile with one blank tab. A real browser with thirty tabs open has more
  warm infrastructure to share and would plausibly show a *smaller* marginal
  cost, so 185.0 MB should be read as an upper bound for the warm case.
- Time-to-first-paint was not measured at all.
- **Nothing here was measured on macOS or Linux.** See §8.

---

## 3. Results

### 3.1 Build and toolchain

| | Clean build, warm cache | First build, cold cache | Shell binary |
| --- | ---: | ---: | ---: |
| Tauri | **149.2 s** (cargo: 2m22s) | 264.5 s | 2,998,272 B (2.86 MB) |
| Wails | **18.6 s** | — (see note) | 11,316,736 B (10.79 MB) |
| No shell | **0.56 s** | 0.56 s | 7,680 B |

Wails has no comparable cold-cache number: installing the CLI (87.9 s) and
`wails init` populated the module cache before the first build of the project
itself, so a like-for-like figure was not captured. The clean-build number is
the one that matters and it is measured.

What each option adds to a contributor's machine, measured after the spike:

| | Footprint |
| --- | ---: |
| Tauri | rustup toolchains 1,290,533,322 B + cargo home 446,786,918 B + NSIS/WiX cache 129,115,304 B + per-project `target/` 1,218,322,748 B ≈ **3.08 GB** |
| Wails | Go SDK 235,904,330 B + module cache 404,142,887 B + Wails CLI 35,791,872 B + build cache 147,521,692 B ≈ **823 MB** |
| No shell | 12,072 B of sources and binary. The compiler is already in Windows. ≈ **0** |

Attribution caveat: Rust was already installed on this machine before the spike,
so the 1.29 GB rustup figure is "what a Rust toolchain occupies here", not "what
the spike added". The Go figures are entirely attributable — `GOPATH` was a
fresh directory.

Two costs found only by doing it:

- **Tauri silently downloads its own bundling tools.** The first `tauri build`
  fetched NSIS and the WiX toolset into `%LOCALAPPDATA%\tauri`: **129,115,304
  bytes** that appear in no manifest and no lockfile.
- **`wails build` compiles and *runs* your `main()`** to generate TypeScript
  bindings. The first build hung indefinitely because it started a real sidecar
  at build time and then waited for a URL that a build has no business
  producing. `-skipbindings` avoids it. A build step that executes the
  application is a property worth knowing about before choosing the tool.

### 3.2 Cold start

| | Median | Range (n=5) |
| --- | ---: | --- |
| No shell — tab in an already-running browser | **392 ms** | 370–1,265 |
| Wails | 1,962 ms | 1,942–2,956 |
| Tauri | 2,023 ms | 1,975–2,913 |
| No shell — `msedge --app`, fresh profile | 2,047 ms | 1,992–2,122 |

The real `roleeye ui` boots — process start to the tokenized URL on stdout — in
**457 ms** (median of 5, range 437–475), against an empty scratch database. The
stub used for timing costs roughly 40 ms, so **add about 420 ms to every row**
for the real product. The ordering does not change: roughly 0.8 s for a browser
tab against roughly 2.4 s for either native shell.

The reason is not that webviews are slow. It is that the browser is already
running and the webview is not, so the native shells pay a Chromium start-up the
browser has already paid.

### 3.3 Resident memory

Delta in total working set, median of 5 runs, warm-up discarded. Every row is
what RoleEye costs *in addition to what was already running*, and every row
includes the Node sidecar.

| | Median delta | Range | Process set after |
| --- | ---: | --- | --- |
| Tray helper + sidecar, **no window at all** | **80.6 MB** | 80.4–81.3 | 2 |
| **No shell — tab in a browser already open** | **185.0 MB** | 162.7–192.2 | 12 Edge (was 11) |
| Tauri | 437.8 MB | 435.5–438.8 | 6 webview + node + shell |
| Wails | 498.3 MB | 495.4–501.2 | 6 webview + node + shell |
| No shell — `msedge --app`, **no browser already running** | 812.8 MB | 810.4–873.0 | 11 Edge + node + tray |

The controlled browser at rest, before RoleEye existed, was 770.3 MB across 11
processes.

Decomposed, subtracting the 80.6 MB engine, the *window* costs:

| | Cost of rendering the portal |
| --- | ---: |
| A tab in a browser already open | **104.4 MB** |
| Tauri (WebView2) | 357.2 MB |
| Wails (WebView2) | 417.7 MB |
| A browser started for the purpose | 732.2 MB |

**WebView2 is Chromium**, and a native shell starts a second one that shares
nothing with the user's browser. So the answer is conditional, and the condition
is the one thing this document cannot measure:

- **If the user already has a browser open** — reusing it costs 185.0 MB against
  437.8 MB for a Tauri window. The no-shell option is **2.4× lighter**.
- **If they do not** — a browser started for the purpose costs 812.8 MB against
  437.8 MB. The no-shell option is **1.9× heavier**.

Most desktop users keep a browser open, which is an assumption and is named here
as one rather than smuggled in as a fact. What is not an assumption is that a
native shell never gets the cheap case: Tauri pays 437.8 MB whether or not a
browser is running, because it cannot use it.

The 80.6 MB row is the useful one for later: rendering the portal is between 1.3×
and 9× the cost of the engine that does the actual work, in every candidate.

### 3.4 Installer size, and the bundled-runtime question

`docs/vision.md` §3.1 left open whether the sidecar bundles a Node runtime or
requires one. Both were built, for all three candidates, with the same NSIS
script and the same application payload (`dist/` plus production-only
`node_modules`, 32,830,239 B staged).

| | Installer, Node required | Installer, Node bundled | Installed, required | Installed, bundled |
| --- | ---: | ---: | ---: | ---: |
| No shell | **4,832,339 B** (4.61 MiB) | **26,720,813 B** (25.5 MiB) | 32,850,383 B | 117,970,023 B |
| Tauri | 5,752,636 B (5.49 MiB) | 27,645,515 B (26.4 MiB) | 35,840,975 B | 120,960,615 B |
| Wails | 8,316,334 B (7.93 MiB) | 30,154,052 B (28.8 MiB) | 44,159,439 B | 129,279,079 B |

For reference, each framework's own bundler, shell only with no application
payload: Tauri produced NSIS 1,074,612 B **and** MSI 1,548,288 B with nothing
extra installed, and did so by downloading its own copies — `%LOCALAPPDATA%\tauri`
holds NSIS (7,168,591 B) and WixTools314 (121,946,713 B), so it did not use the
WiX already on this machine's `PATH`. Wails produced NSIS 6,265,230 B, but only
after I supplied it a `makensis` — `wails doctor` reports NSIS as an optional
dependency and it was not present, so the Wails installer was built with the
NSIS binary **Tauri** downloaded (v3.11).

**The framework choice is 15% of the installer question and the runtime choice
is 85%.** The spread between the three shells is 3,483,995 B (3.32 MiB).
Bundling `node.exe` costs **+21,888,474 B (20.9 MiB) compressed** and
**+85,119,640 B (81.2 MiB) installed** — the installed delta is `node.exe`
exactly — uniformly, whichever shell is used.

**Answer: bundle the runtime.** 21 MiB of extra download is unremarkable, and
two things are bought with it. The obvious one is that "a non-engineer can
install it" stops being false — otherwise the first instruction is "install Node
22 or later". The second matters more: `better-sqlite3` ships a prebuilt native
binary pinned to a Node ABI, so a machine with the wrong Node major version
produces a native-module load failure, which is precisely the error a
non-engineer cannot diagnose. Bundling pins the ABI to the binary we tested.

One consequence for P9-1: `src/schedule/os-scheduler.ts` builds the scheduled
command as `"<nodePath>" "<root>\dist\index.js" run`. With a bundled runtime,
`nodePath` must resolve to the bundled `node.exe` and `root` to the install
directory, or the daily task will run against whatever Node happens to be on
`PATH` — or none.

### 3.5 Does the property actually work? (the functional test)

Each prototype was run with the **real** CLI as its sidecar — `node
dist/index.js ui --no-open --port <p>` against a scratch project root, so the
repository's own database was never touched.

| | Window reached | Sidecar is a child | Portal served | Stopped on close |
| --- | --- | --- | --- | --- |
| Tauri | yes (6 webview processes) | yes | HTTP 200, 106,932 B | yes |
| Wails | yes (6 webview processes) | yes | HTTP 200, 106,932 B | yes |
| No shell (tab) | yes (5 browser processes) | yes | HTTP 200, 106,932 B | yes¹ |
| No shell (`--app`) | yes (11 browser processes) | yes | HTTP 200, 106,932 B | yes¹ |

¹ The tray helper has no main window, so the test could not close it the way it
closes the other two. Its own "Stop and quit" path was exercised through a test
hook that calls the same `Quit()` the menu item calls: sidecar count went 1 → 0
and the tray process exited. Precisely: `Quit()` closes the sidecar's stdin,
waits 3 seconds, and then terminates it. Since the CLI does not act on stdin
closing (see below), it is the termination that does the work.

All three reached the property. None of them failed. That is the point: the
property is not scarce.

### 3.6 Two findings that are about the CLI, not about the shell

**Nothing supervises the sidecar if the shell is killed.** Terminated with
`TerminateProcess` rather than closed, every candidate leaves the real CLI
running:

| Shell terminated | Cooperating sidecar orphaned | Real `roleeye ui` orphaned |
| --- | ---: | ---: |
| Tauri | 0 | **1** |
| Wails | 0 | **1** |
| No shell | 0 | **1** |

The left-hand column used a sidecar that exits when its stdin closes. That one
line of cooperation fixes it in all three. `src/cli/ui.ts` today waits only on
`SIGINT`/`SIGTERM`, and Windows has no `SIGTERM`, so a shell's only honest
options are "close stdin and hope" or `TerminateProcess`. The fix belongs to the
CLI, or to a Windows Job Object with `KILL_ON_JOB_CLOSE`. It is code we write,
identically, in whichever candidate. It is not a framework feature and must not
be chosen as if it were.

Mitigating context: `src/core/run-lock.ts` detects a stale lock by process
liveness first and a heartbeat second, so an orphaned or killed run does not
wedge the database permanently. The cost of a hard kill is a leaked process and
an open source-run row, not a corrupt state.

**The portal's own origin check refuses the Wails architecture.** Measured
against the running portal, `PUT /api/config/criteria` with a valid token:

| `Origin` sent | Result |
| --- | --- |
| none (curl, same-origin fetch) | 200 |
| `http://127.0.0.1:<port>` | 200 |
| `http://localhost:<port>` | 200 |
| `tauri://localhost` | 200 |
| **`http://wails.localhost`** | **403 cross-origin requests are refused** |
| `https://evil.example` | 403 |

Wails v2 has no "load an external URL" option — a window is always served from
its asset server on the `wails.localhost` origin. The natural Wails design,
reverse-proxying the portal through that asset server, therefore fails the CSRF
control the portal already enforces, on every state-changing request. The
prototype works only because its asset server serves a single redirect document
out to `127.0.0.1`, after which the Wails asset server does nothing at all. That
is paying for a framework and then using none of it.

(Incidental, recorded but not acted on: `tauri://localhost` passes because
`isLoopbackHost` matches the hostname regardless of scheme. It is not reachable
from a browser page, so it is a curiosity rather than a hole.)

---

## 4. The cost against "`tsc` is the only build step"

The rule (`docs/progress.md`, 2026-08-12; `architecture.md` §33 Phase 9) exists
so that a contributor can clone, `npm ci`, and build with one command, and so
that no asset pipeline can sit between the source and what runs.

| | What it adds to the build | What a contributor must install |
| --- | --- | --- |
| Tauri | `cargo build` plus a silent 129 MB download of NSIS and WiX on first run | Rust toolchain (~3.08 GB with caches on this machine) |
| Wails | `wails build`, whose default template ships `npm install` + `vite build` and had to be blanked out; and which executes `main()` at build time unless `-skipbindings` is passed | Go SDK + Wails CLI (~823 MB with caches); **plus NSIS separately** to produce an installer |
| No shell | `csc.exe Launcher.cs` — 0.56 s, one command, no download | Nothing on Windows. **Nothing at all on macOS or Linux, because it does not build there** |

None of the three keeps `tsc` as the only build step. That was never achievable
once a native binary is shipped, and pretending otherwise would be the taste
problem this task exists to fix. What differs is the size of the breach: a
0.56-second in-box compile of one 130-line file is a different kind of violation
from a 149-second Rust build behind a 3 GB toolchain.

Candidate 3a — a Start Menu shortcut to `roleeye ui` — is the only option that
does not breach the rule at all, and it remains available as the fallback if
even the tray helper proves not worth its second language.

---

## 5. Windows specifics

**Native toasts already work with no shell.** Phase 3.5 shipped them
(`src/notify/desktop.ts`): Windows PowerShell 5.1, WinRT, borrowing PowerShell's
own registered `AppUserModelID`. The tray helper additionally raises a
`NotifyIcon` balloon under its own icon with no framework involved.

What a shell would add is *identity and activation*: the toast showing RoleEye's
name and icon, and clicking it opening the app on the right record (P9-3).

**This is where the spike failed, and the failure is recorded rather than
papered over.** The experiment registered a custom `AppUserModelID` under
`HKCU\Software\Classes\AppUserModelId` and compared three cases:

| | Result |
| --- | --- |
| A. shipped mechanism (PowerShell's AUMID) | ACCEPTED |
| B. RoleEye's own AUMID, **not** registered | ACCEPTED |
| C. RoleEye's own AUMID, registered in HKCU | ACCEPTED |

The WinRT call accepts every AUMID, including one that is not registered, so
acceptance is not evidence of display — and nothing in this session can see the
screen. **Whether a registered AUMID makes a toast show RoleEye's name is
therefore unverified**, and so is whether toast activation can be reached
without a native shell. P9-3 must settle it by looking at a screen. What *is*
established is that toast delivery does not need a shell, because it already
happens without one.

**Task Scheduler is unaffected by this decision.**
`src/schedule/os-scheduler.ts` installs `schtasks /create /tn ... /tr "<node>"
"<root>\dist\index.js" run`. The scheduled task invokes Node directly and never
touches a shell, under all three candidates. The only thing that changes it is
the bundled-runtime decision (§3.4).

**Code signing** is `signtool` against the executable and the installer in every
candidate; none of the three does it for you. Measured differences that bear on
G-4: Tauri emitted **both** an MSI and an NSIS installer with nothing extra
installed, and `tauri signer generate` produced a real updater keypair (348-byte
private, 152-byte public — generated, inspected, deleted). Wails has no signer
or updater subcommand at all — its `update` command updates the Wails CLI — and
could not produce an installer until it was handed an NSIS it does not install.
The no-shell option has whatever installer we write; the one written for this
spike is 4.61 MiB.

### 5.1 The update path (G-4)

P9-0 has to say whether the update path reverses the shell decision, because
finding out during G-4 is the expensive order. It does not — but it produced the
sharpest constraint in this document, and that constraint is not about the shell
at all.

Four things were established on this machine.

**1. A per-user install updates without a UAC prompt, and the bundled package
runs on its own runtime.** Both installers were run for real from a
non-elevated shell.

`setup-noshell-requirednode.exe /S` returned exit code 0 and wrote 32,889,055
bytes across 2,813 files to `%LOCALAPPDATA%\RoleEye` with a Start Menu shortcut.
`uninstall.exe /S` returned 0 and removed the directory and the shortcut. So an
unattended updater needs no elevation, in any of the three candidates — this is
a property of per-user installation, not of a framework.

`setup-noshell-bundlednode.exe /S` was then installed and launched with its
*own* runtime rather than the system one:

| | Observed |
| --- | --- |
| Bundled `node.exe` present | yes, `v22.16.0` |
| Running sidecar's image path | `%LOCALAPPDATA%\RoleEye\app\node.exe` — the bundled copy, not `PATH` |
| Portal | HTTP 200, 106,932 bytes |
| SQLite database created | yes, 4,096 bytes |

The database opening is the part that matters: `better-sqlite3` is a prebuilt
native binary, so it loaded and ran against the bundled runtime. The recommended
configuration therefore works end to end from a per-user install.

One thing this does **not** establish: the bundled runtime here is the same
version as the system one, so the run demonstrates self-sufficiency, not ABI
*pinning*. That a mismatched system Node would fail is the documented behaviour
of a prebuilt native module and the reason §3.4 gives for bundling — it is
reasoned, not demonstrated, and is listed in §8.

**2. A running binary cannot be replaced in place, but it can be renamed.**
Tested against the running tray helper:

| | Result |
| --- | --- |
| Overwrite the running `.exe` | **REFUSED** — "the process cannot access the file because it is being used by another process" |
| Rename the running `.exe`, then write the new one at the old path | **SUCCEEDED**, old image still running |

So every candidate's updater must use the same rename-then-replace-then-restart
sequence, and every candidate must restart to finish an update. Tauri's updater
plugin implements this; for Wails and for the tray helper it is ours to write.
This is perhaps 50 lines and it is the same 50 lines in all three.

**3. The scheduled task pins two absolute paths, and nothing rewrites them.**
Asked of RoleEye's own `buildInstallCommand` with a versioned install directory:

```
schtasks /create /tn "RoleEye Daily Scan" /tr "\"...\RoleEye\app-1.2.0\node.exe\"
         \"...\RoleEye\app-1.2.0\dist\index.js\" run" /sc daily /st 07:30 /f
```

An update that installs beside the old version — the usual way to make rollback
cheap — leaves the daily task pointing at the previous directory. This is the
exact failure `docs/progress.md` already records for 2026-08-16: the task fires
at 07:30 against a path that no longer works, and nobody is watching. **The
update path must therefore install to a stable directory, not a versioned one**,
which means rollback has to be a restore rather than a pointer swap, or the
updater must rewrite the scheduled task as part of every update. That decision
belongs to G-4, but it is now a constraint G-4 inherits rather than discovers.

**4. Uninstalling deletes the career database. Installing over the top does
not.** Both were tested, with a stand-in `app\data\roleeye.db` written between
the steps:

| | Colocated data survives |
| --- | --- |
| Install the new package directly over the old one | **yes** |
| Uninstall | **no** — `$INSTDIR` and everything under it is gone |

The install section does `SetOutPath` and `File /r`, which overwrite without
deleting; `RMDir /r "$INSTDIR"` exists only in the uninstall section. So the
hazard is narrower than "any update" and sharper than it looks: an updater that
overwrites is safe, and an updater that **uninstalls first — or clears the
directory to drop files the new version no longer ships — destroys the user's
history**, which is invariant 5. Uninstall-before-install is a normal updater
design, and it is the one that silently loses everything.

**The database, `config/`, `profile/` and `artifacts/` must live outside the
install directory**, and the uninstaller must be explicit about not touching
them. That removes the hazard from every update strategy rather than banning
one of them, and it is shell-independent. It is the most valuable thing this
spike found about G-4.

**What is still not measured:** no candidate was made to actually discover,
verify, download and apply a signed update. The comparative position is that
Tauri ships a signature-verified updater primitive in the box, and Wails and the
no-shell option would each need one written or adopted — for the no-shell
option, against the tray helper and the bundled runtime rather than against a
framework binary. That difference is real but small next to constraints 3 and 4,
which apply identically to all three and are about where files live rather than
what renders them. **It does not reverse the decision.**

---

## 6. Does this constrain the local analytics MCP server (G-9)?

**No — it is orthogonal, and here is the reasoning rather than the assertion.**

G-9 asks whether the career database can be exposed to a coding agent the user
already owns. Its own open question is "whether the server is part of the Node
CLI (likely) or of the shell". The evidence says CLI, and once it is in the CLI
the shell cannot constrain it:

1. **The existing unattended path already runs without any shell.** The
   scheduled task invokes `node dist/index.js run` directly (§5). A daily run
   happens with no window in existence. An MCP server has the same shape — a
   long-lived process over the same database — so it inherits the same
   independence.
2. **An MCP server has no window and no user.** A stdio server is spawned by its
   client; an HTTP server binds a loopback port. Neither needs a webview, and a
   shell that is closed must not take the server with it — which argues for the
   CLI owning it *even if* a shell exists.
3. **Supervising a second process costs the same everywhere.** All three
   prototypes supervise a child by reading its stdout, and all three fail the
   same way when killed (§3.6). A second supervised process is the same code in
   Tauri, in Wails, and in the tray helper.
4. **Putting it in the shell is already forbidden by an existing rule.**
   `architecture.md` §39 says no business logic in the web layer because it
   would become the only thing that knew how to do something. A query planner
   living in a Rust or Go binary would be worse: unreachable from the CLI,
   untestable by the existing suite, and invisible to `roleeye ask`.

So the shell decision does not constrain G-9. The real constraint on G-9 is the
other half of its own open question — read-only SQL exposed to an agent whose
context also holds attacker-authored posting text — and that is untouched by
anything decided here.

Conversely, this cuts the other way too, and is part of why the recommendation
lands where it does: **if the engine must work with no window, the window is not
where the product lives.**

---

## 7. Decision

**No native shell for now.** Ship candidate 3c: a tray helper that supervises
the CLI, reads the tokenized URL from its stdout, opens the user's browser, and
stops the sidecar on quit. **Bundle the Node runtime** (§3.4).

The numbers that decide it, in order of weight:

1. **A native shell costs 5× the cold start** — 2,023 ms against 392 ms — because
   the user's browser has already paid the Chromium start-up and the webview has
   not. Adding the real portal's own 457 ms boot, that is roughly 0.8 s against
   2.4 s.
2. **On memory a native shell is worse in the common case and better in the
   uncommon one.** Reusing an open browser costs 185.0 MB against Tauri's
   437.8 MB; starting a browser costs 812.8 MB. A native shell always pays the
   437.8 MB, because it can never use the browser that is already running. The
   recommendation therefore rests on users typically keeping a browser open,
   which is stated as an assumption in §3.3, not as a measurement.
3. **The installer difference is noise.** 3.32 MiB between the three shells,
   against 20.9 MiB for the runtime decision that applies to all of them.
4. **The property is not scarce.** All three prototypes drove the real portal
   and supervised the real CLI. Nothing about the shell frameworks was needed to
   get it.
5. **The supervision gap is ours, not the framework's** (§3.6), and so is most of
   the update path (§5.1), so buying a framework does not buy a fix for either.
6. **The toolchain cost is real and recurring**: 3.08 GB and 149 s per clean
   build for Tauri, 823 MB and 18.6 s for Wails, against 12 KB and 0.56 s.

### If a native shell becomes necessary, it is Tauri

Not because it is faster or smaller to build — Wails beats it 8× on clean build
and nearly 4× on disk, and those are the numbers a contributor feels every day.
Tauri wins on the three that a *user* feels, and on the one gap that is already
scheduled:

- it loads an external URL as a first-class window target, which is the entire
  property; Wails has no such option and its natural design is refused by the
  portal's own CSRF check (§3.6);
- it uses 12% less memory than Wails and produces a 3.8× smaller binary;
- it produced both MSI and NSIS with nothing extra installed, and ships an
  updater signing primitive — and **G-4 (installer and update security) is a
  named gap that depends on P9-1**. Build time is paid by contributors; update
  trust is paid by users holding a career history on disk.

Wails' build-time execution of `main()` (§3.1) is the disqualifier on top: a
build step that starts the application is a build step that can start the
application on a build server.

### What this gives up

Stated plainly, because the browser is not free:

- **Predictable rendering.** A webview is a version we choose. The user's
  browser is a version, an extension set, and possibly an enterprise policy that
  we do not choose.
- **A session token in browser history.** `roleeye ui` puts the token in the
  query string and a browser records the full URL in history. This is a
  pre-existing property, not a regression — but a native shell would have fixed
  it for free, and now it stays open. It is a portal fix (one-time redirect to a
  cookie), and that fix is cheaper than a framework.
- **Taskbar identity.** A tab is "Edge", not "RoleEye". `--app` mode restores it
  and its own taskbar entry — for 812.8 MB and a second browser profile, which
  is why it is not the default.
- **The window's lifetime is not ours.** Closing the browser closes the app's
  window, and the user did not mean to close the app.
- **The cheap memory case is conditional.** A user who does not keep a browser
  open pays 812.8 MB where a Tauri window would have cost 437.8 MB (§3.3). They
  are the minority on a desktop, but they exist, and this decision is worse for
  them.

### The strongest argument against this decision

The audience in `docs/vision.md` §2 is "anyone who can install a Windows
application", and this product asks that person to trust it with an employment
history, a salary floor, and a record of who rejected them. Trust is the
product. A browser tab with a token in the URL bar does not look like an
application that holds those things, and "it uses less memory when your browser
is already open" is not an argument a user will ever make. 1.6 seconds and 3 GB
of a contributor's disk are a cheap price for looking like a real program, and
this
decision optimises the number that is measurable over the one that matters.

That argument is good, it is not answered by anything above, and it is why the
reversal conditions are named rather than left to be discovered.

### What would reverse this

Any one of these, and the answer becomes Tauri:

1. A trial with a non-engineer finds the browser handoff reads as unfinished, or
   the tokenized URL confuses or leaks.
2. **P9-3 needs toast activation into a specific record and a URL protocol
   handler cannot deliver it.** This is the most likely trigger, because §5
   leaves it unverified.
3. A requirement appears for something a browser will not do: a real file drop
   with paths, a custom protocol, or chrome we control.
4. Enterprise browser policy is found to break the portal on target machines.

Conditions 1 and 2 should be tested during P9-1 and P9-3 rather than assumed.
Nothing in the tray helper is expensive enough to regret if they fire: it is 130
lines of C#, and the sidecar-supervision work it needs (§3.6) is work Tauri
would need identically.

---

## 8. What is unverified

- **macOS and Linux entirely.** Every number here is from one Windows machine.
  Specifically unknown: Tauri and Wails both use the *system* webview on those
  platforms — WKWebView and WebKitGTK, not Chromium — so neither the memory and
  start-up figures nor the rendering of the existing portal page transfers. The
  tray helper does not build or run there at all; candidate 3 would need a
  different helper per platform, or none.
- **Whether a registered `AppUserModelID` gives a toast RoleEye's identity**, and
  whether toast activation can reach a browser-based app (§5). The experiment
  could not discriminate.
- **An end-to-end signed update.** §5.1 establishes the mechanics — per-user
  install without elevation, rename-then-replace, the scheduled-task path
  constraint, and the data-loss constraint — but no candidate was made to
  discover, verify and apply a real signed update.
- **That a mismatched Node ABI actually breaks the bundled package.** §5.1
  confirms the bundled runtime runs `better-sqlite3` successfully, but the
  bundled and system runtimes were the same version here, so the failure mode
  that §3.4 uses to argue for bundling was not reproduced.
- **Time-to-first-paint.** Only time-to-first-request was measured.
- **How much of the multi-process memory is shared pages.** Working sets are
  summed without correcting for sharing, which inflates every candidate (§2).
- **Whether users of this product keep a browser open.** The recommendation
  assumes they typically do (§3.3). It is an assumption about behaviour, and it
  is the one this decision is most exposed to.
- **Behaviour with a populated database.** The 457 ms `roleeye ui` boot was
  measured against an empty scratch database; a real one with a search index
  will be slower, equally for all candidates.
- **Wails' cold-cache first build**, for the reason given in §3.1.
- **A Wails-installed NSIS.** The Wails installer was produced with the NSIS
  binary Tauri downloaded.

## 9. An honest note on toolchain installation

Installing Go by its MSI failed on this machine: `winget install GoLang.Go`
returned exit code 1602 because the installer requires elevation that was not
available. The zip archive worked without administrator rights. This changed no
measurement, but a contributor on a managed device meets the same wall, and it
is one more thing that a candidate needing no toolchain does not have.
