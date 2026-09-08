# PLAN.md — Background Task Execution for SpecPi

Status: **implemented and locally validated; PR preparation**. The human explicitly
authorized repository-native implementation, narrow Command Guard integration, release
preparation, and a PR. This plan addresses background/long-running task execution only.
`TASK.md` captures the implementation decisions, requirements, paths, rollback, and
non-goals. No wishlist retirement, publication, tag, merge, or deployment is authorized.

## 1. Purpose and scope

Let the model start a development server, long test suite, or watch build, continue other
work, inspect bounded output, and stop the task. Keep execution session-scoped with
explicit human approval, bounded extension-owned resources, and best-effort cleanup.

This is a single-feature plan. MCP integration is out of scope, not a subsequent phase
or dependency of this work.

Repository references: `SECURITY_MODEL.md` (Command Guard, workflow controls, privacy,
and non-goals), `scripts/specpi.mjs` (installer and doctor), and existing extension tests.
Before implementation, verify Pi's documented tool, cancellation, and session lifecycle
APIs against the installed package. Proposed behavior below is not evidence that those
APIs or platform cleanup mechanisms already satisfy it.

## 2. Constraints and trust boundary

- **Custom execution is outside Guard's normal seams.** Guard covers documented
  `bash`, `powershell`, `read`, `write`, and `edit` tools; Strict also prompts for
  uncatalogued tools. Background execution needs its own approval and admission policy.
- **Confirmation is not equivalent to Guard policy.** `/experiment` demonstrates
  operation-specific confirmation, but its constrained Git argv is not a safety
  precedent for arbitrary shell execution. Background tools must not become a route
  around a denied command or enforcement lock.
- **No OS containment claim.** Approved commands run with the user's permissions.
  They may access files, use network services, spawn descendants, or write their own
  output files. Time limits and process groups cannot contain hostile processes.
- **Privacy boundary.** The extension must not inspect Pi authentication, credential
  stores, sessions, history, or trust decisions. It creates no command/output journal
  or persistent task registry. Returned tool output can enter Pi conversation storage
  and the model-provider boundary; memory-only buffers do not prevent that retention.
- **Dependencies.** Prefer Node built-ins and existing reviewed project dependencies.
  No new executable dependencies are planned; any required addition needs separate
  justification and the repository's dependency/security documentation updates.
- **Installer and verification.** Add explicit installer/doctor integration. The current
  verification inventory already includes `extensions` and `tests`; do not change
  `verification.mjs` merely to add a directory beneath them. Check capability-registry
  and supported-validator integration. Verification-policy changes require the separate
  human review and selection prescribed by the repository.

## 3. Proposed tool surface

New extension: `extensions/background-tasks/`.

- `background_start { command, cwd?, label?, timeoutSeconds? }`
  - Start a noninteractive command using `child_process.spawn`.
  - Resolve and validate cwd before approval; default to the active workspace cwd.
  - Default timeout: 1,800 seconds; accepted integer range: 1–28,800 seconds.
  - Shell identity and quoting must be explicit per platform. `shell: true` uses the
    platform default and must not be presented as guaranteed Bash compatibility.
  - Return an opaque task ID and observed process state. Spawn success is not proof
    that a server is ready or a job completed successfully.
- `background_list {}`
  - Return bounded task metadata: ID, label, status, elapsed time, exit code/signal,
    cleanup outcome, and a bounded, best-effort redacted command preview.
- `background_logs { id, offset? }`
  - Return output after an absolute byte cursor, a next cursor, and explicit loss/
    truncation metadata. Reject invalid or future cursors; report stale cursors whose
    data has been evicted.
  - Retain at most 256 KiB combined stdout/stderr per task; return at most 64 KiB of
    output per call. Define cursor semantics over the retained output stream, including
    stream markers. Preserve UTF-8 decoding across chunks; never buffer an unbounded
    line while waiting for a newline. Cross-stream ordering is observed arrival order.
- `background_stop { id }`
  - Idempotently request termination and return observed cleanup status.
  - Stopping a known task remains available when new starts are blocked.

Registry entries include task ID, owning session generation, command, resolved cwd,
PID/process-group identity, timestamps, timeout, exit code/signal, and cleanup outcome.
States distinguish `starting`, `running`, `stopping`, `exited`, `killed`, `failed`, and
`cleanup-unconfirmed`. Record `killed` only after observed termination; a timeout or
successful kill-helper invocation alone is insufficient evidence.

## 4. Admission, approval, and resource policy

### 4.1 Approval

- Require interactive approval for the first exact execution fingerprint in a session;
  deny starts without approval UI, including attempts to reuse a cached approval.
- Bind approval to command, resolved cwd, shell/execution policy, timeout, and session/
  policy generation. Display execution scope and arbitrary-process risks clearly.
- Revalidate admission before every start, including cached approvals and after a prompt
  resolves. Changed inputs, expired prompts, cancellation, session changes, or changed
  policy must not authorize a stale start.
- Clear approvals on session lifecycle transitions and relevant policy changes.
  Bound the approval cache; no persistent grants in v1.

### 4.2 Guard integration: approved design

Reuse `decideCommand` through a synchronous admission event carrying the active Guard
mode, generation, and decision. Recheck at execution time, after prompts and before
spawn. Critical denials and locks remain non-overridable. Strict's requested approval is
presented in the background command prompt; Off still requires background approval.
Missing Guard uses shared Guard-mode static policy; old, unavailable, or ambiguous Guard
responders fail closed. List/logs/stop remain available under locks and validate their own
inputs. Policy reuse does not imply OS containment.

Acceptance requires tests proving that a Guard-denied operation cannot simply be retried
through `background_start`, with absent, Off, Guard, Strict, locked, and unavailable
states covered. This narrow Guard integration was explicitly approved by the human.

### 4.3 Resource bounds

- At most 4 concurrent tasks, with slots reserved atomically before spawning.
- Maximum requested execution duration: 8 hours. Deadline expiry initiates termination;
  it does not guarantee all process activity has ended by that instant.
- Bound command/cwd/label lengths, registry entries, approval entries, output buffers,
  metadata, and serialized responses. Set concrete limits during the design checkpoint.
- Retain at most 32 completed task records, evicting oldest completed buffers first.
  Never evict an unconfirmed cleanup record merely to free a running slot.
- These bound extension-owned resources, not child CPU, memory, disk, or network use.
  Resource quotas and persistent settings are out of scope.

## 5. Lifecycle and cleanup

- POSIX: use a dedicated process group and signal it, escalating from SIGTERM to SIGKILL
  after a bounded grace period (proposed: 5 seconds).
- Windows: use fixed-argv `taskkill /PID <pid> /T /F`, with bounded helper execution.
  Do not interpolate commands into a shell to invoke termination helpers.
- Track natural exit, spawn failure, stop, timeout, and cancellation races. Leader exit
  alone must not be treated as proof that its descendants have exited. Avoid signaling
  stale/reused PIDs and document limits of process identity tracking on each platform.
- On session switch, reload, or shutdown, revoke approvals and initiate bounded cleanup
  of all owned tasks. Verify which documented Pi events support these transitions.
  If a transition cannot reliably run cleanup, document that limitation before shipping.
- Define cancellation ownership: an aborted start cannot leave an unreported process;
  once successfully registered, the task intentionally outlives that tool call until
  stop, deadline, or session cleanup. Cancelling a log read does not stop its task.
- Report unsuccessful or unconfirmed cleanup while the UI/runtime permits it; preserve
  in-memory tracking while the runtime remains alive. Do not promise reporting after
  process death or persistence across restart.
- Escaped descendants, forced host termination, crashes, and permission failures remain
  residual risks. Tests demonstrate supported fixture behavior, not universal tree kill.

## 6. Expected files

- `extensions/background-tasks/index.ts` — tools, approval, policy and lifecycle hooks.
- `extensions/background-tasks/core.mjs` — process registry, output buffers, termination.
- `extensions/background-tasks/smoke.mjs` — deterministic offline doctor self-check.
- `tests/background-tasks.test.mjs` and narrowly scoped fixtures — regression coverage.
- `scripts/specpi.mjs` — copy manifests, doctor wiring, and installed smoke dependencies.
- Relevant installer tests — isolated lifecycle and packaged/installed smoke coverage.
- `extensions/tool-wishlist/capabilities.json` — reviewed capability registration if
  required by the selected improvement's retirement contract.
- `SECURITY_MODEL.md`, `README.md`, and `CHANGELOG.md` — boundary, usage, and release notes.

The approved shared policy change is in `extensions/command-guard/index.ts`; the parser
is reused, not duplicated. Package-validation scripts also assert the new packaged files
and extension discovery. `AGENTS.md` guidance changes were separately requested by the
human. No installed resources or global agreement changes.

## 7. Tests and acceptance

Preserve the original background requirement IDs; extend their checks to avoid unsupported
safety promises. Use deterministic local Node fixtures, no network services or arbitrary
sleeps. Exercise supported Windows and POSIX behavior; disclose untested platforms.

- **R1.1 — Tool contract.** All four tools register; malformed inputs, invalid cwd,
  out-of-range timeout, unknown IDs, and oversized inputs fail predictably. Verify the
  selected shell's quoting behavior on each supported platform.
- **R1.2 — Admission and approvals.** Starts fail closed without UI. Exact fingerprints,
  session/policy invalidation, changed inputs during prompts, cancelled prompts, cache
  bounds, and Guard-denial/lock behavior pass negative tests. Cleanup remains available.
- **R1.3 — Resource bounds.** Concurrent starts cannot exceed four slots; completed-record
  eviction is bounded; output flooding and oversized lines stay bounded. Timeout initiates
  termination and reports observed or unconfirmed results accurately.
- **R1.4 — Cleanup.** Stop, deadline, natural leader exit, start cancellation, and session
  teardown cover children/grandchildren, spawn failure, helper failure, repeated stops,
  and exit races. Verify supported descendant cleanup; test and report unconfirmed cases
  without claiming escaped processes are contained.
- **R1.5 — Output contract.** Absolute cursors, wraparound, stale/future offsets, mixed
  stdout/stderr, split UTF-8, single oversized chunks/lines, and bounded reads pass.
  Returned content is untrusted; metadata and diagnostics use bounded safe rendering.
  No extension-owned command/output files are created.
- **R1.6 — Validation.** Run `node --test tests/background-tasks.test.mjs`, relevant Guard
  and installer suites, then `npm run format` and `npm run check`. Exercise plan/install/
  update/doctor/uninstall in a fresh temporary `PI_CODING_AGENT_DIR`, skipping external
  package/tool installation. Verify installed smoke tests need no absent test fixtures.
  Inspect the final diff and obtain fresh read-only security review before completion.

## 8. Execution sequence and rollback

1. **Authorization and design checkpoint:** record the task contract; settle Guard policy,
   shell/environment behavior, lifecycle hooks, remaining input limits, and cleanup
   observability. Use `/scope task` only by explicit human choice.
2. **Core implementation:** build registry, buffers, process launch, bounded termination,
   and deterministic regression fixtures.
3. **Policy and integration:** wire tools, approvals, lifecycle, installer/doctor, and
   capability registration; update security and user documentation.
4. **Verification:** run R1.1–R1.6, review evidence and residual risks, and use the selected
   improvement's verification gate if applicable. Do not infer completion from tests alone.

Rollback: stop tracked tasks first and report unconfirmed cleanup, then revert only this
feature's source, registration, installer, tests, and documentation changes. No task-state
migration is planned. Removing the extension does not itself terminate orphaned processes
or undo changes made by executed commands.

## 9. Non-goals

- MCP client integration or other tool ecosystems.
- Remote/cloud execution, cross-session persistence, daemonization, or automatic restart.
- PTY/interactive stdin, TUI widgets, notifications that automatically trigger model turns.
- OS sandboxing, process resource quotas, or universal descendant-termination guarantees.
- Persistent grants, user-configurable cap settings, telemetry, or cost accounting.
- Replacing Command Guard or allowing a denied operation through a different tool.
