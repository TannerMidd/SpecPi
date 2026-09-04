# PR #26 Desktop Remediation Plan

## Objective

Bring `feat/specpi-desktop-gui` to a mergeable state by resolving every finding from the full review of PR #26 at head `d501513`, while preserving SpecPi's core boundaries:

- Pi remains authoritative for credentials, trust evaluation, tools, extensions, transcripts, and session JSONL.
- Desktop never reads or modifies Pi authentication, trust, history, mission, or session files directly.
- The renderer is treated as untrusted; Electron main owns paths, process launch authority, and consequential user consent.
- Trust and Command Guard choices are scoped to one live Pi process/session and are never silently persisted.
- Fixes use the existing dependency graph and the smallest testable abstractions; no new runtime or executable dependency is planned.

**Status:** Implemented and locally validated on Windows as of 2026-09-03. The final hosted Windows/macOS/Linux CI matrix remains an external merge gate; unchecked hands-on or hosted-run items below are not claimed as observed.

## Merge gate

The PR is ready only when all of the following are true:

- [ ] Every P1 finding has a regression test and an observed passing acceptance check; B7 still awaits hosted Linux evidence.
- [x] Every P2 finding is fixed or explicitly deferred by the maintainer with rationale.
- [ ] Linux Electron smoke runs with Chromium sandboxing enabled; `--no-sandbox` is not an acceptable fix.
- [ ] Windows, macOS, and Linux desktop checks and packaged smoke checks are green.
- [x] `npm run check` passes from the repository root.
- [x] The live integration suite passes against the compatibility floor, Pi `0.84.4`.
- [x] Rendered desktop, tablet, and mobile behavior is revalidated after the renderer changes.
- [x] Documentation describes the implemented behavior rather than the pre-fix design.
- [x] The final diff contains no unrelated cleanup, generated artifacts, screenshots, credentials, or Pi session content.

## Finding inventory

| ID | Priority | Finding | Primary phase |
| --- | --- | --- | --- |
| B1 | P1 | Per-run project trust is persisted and reused | 1 |
| B2 | P1 | An arbitrary session can run under a different cwd with the selected project's trust/UI | 1 |
| B3 | P1 | Renderer origin and path/process capabilities are not authorized in main | 1 |
| B4 | P1 | Start/stop and stale-child events can orphan or detach Pi processes | 2 |
| B5 | P1 | Cancelled session transitions are treated as successful boundaries | 2 and 3 |
| B6 | P1 | Ctrl/Cmd+N can save a stale draft | 3 |
| B7 | P1 | Ubuntu Electron smoke is red | 6 |
| C1 | P2 | Image limits exceed the 4 MiB outbound RPC record limit | 4 |
| C2 | P2 | Session rename uses unsupported `set_label` | 4 |
| C3 | P2 | Restart can use a stale `lastSessionPath` | 3 |
| C4 | P2 | Stale windows can overwrite each other's project registry | 1 |
| C5 | P2 | Universal path lowercasing aliases distinct case-sensitive paths | 1 |
| C6 | P2 | Persisted desktop state is only shallowly validated | 1 |
| C7 | P2 | Correlated RPC responses are emitted again as runtime events | 2 |
| C8 | P2 | Stale file/Git requests can overwrite a newer project or selection | 5 |
| C9 | P2 | Porcelain v1 `-z` rename/copy records retain the source path instead of destination | 5 |
| C10 | P2 | Guard UI reports a requested mode without authoritative acknowledgment | 4 |

## Architectural decisions

These decisions close the findings without weakening the documented trust model.

### A. Split renderer requests from internal launch options

`StartRuntimeOptions` currently crosses preload with raw `cwd`, `piPath`, `sessionPath`, and `trust`. Replace that single type with two contracts:

1. **Renderer-facing workspace request** — opaque identifiers only, for example:
   - `projectId`
   - optional registered `sessionId`
   - optional one-time session-import token
   - bounded non-path flags such as `offline` or `noSession`
2. **Main-only runtime launch options** — canonical `cwd`, resolved Pi executable, ephemeral trust override, and either a registered session path or import/fork path.

The main process must be the only layer that converts the first form into the second.

### B. Move consequential trust consent to Electron main

A compromised renderer can synthesize any IPC call, so a React-only trust modal cannot authorize `--approve`. When a request needs a new process, main will show a native `dialog.showMessageBox` containing the canonical project path and these choices:

- Use Pi's default trust decision — no override flag.
- Ignore project resources for this run — `--no-approve`.
- Trust project resources for this run — `--approve`.
- Cancel — no process is created.

No trust value is returned to or accepted from the renderer. React may explain the flow, but main owns the actual choice. Reactivation of an already-running process does not prompt because it does not create a new trust scope. Restart, pop-out, and any other operation that creates a new process must prompt again.

### C. Import arbitrary session files by forking through Pi

Desktop must not inspect a JSONL header to discover its cwd. The native session picker will therefore mean **Import session as a fork into this project**, not resume an arbitrary file in place:

- Main canonicalizes the user-selected file and mints a short-lived, single-use opaque token bound to that window.
- The UI clearly says the source will be forked and the original is not modified.
- Main consumes the token only with an authorized target `projectId` and starts Pi with `--fork <selected-session>` in the target project's canonical cwd.
- Pi reads the source and creates the target session; Desktop never reads the source file.
- Direct `--session` resume is allowed only for a main-owned `SessionRecord` whose `projectId` matches the requested project.
- A token is reserved during launch, released on cancellation/failure, consumed after successful startup, and expires after a short fixed interval.

This preserves Pi ownership, prevents an embedded session cwd from receiving another project's trust, and keeps displayed Files/Git context aligned with the runtime.

### D. Make desktop state authoritative and revisioned in main

Renderer snapshots are projections, not mutation authority:

- Bump desktop state to schema `2` and add a monotonically increasing `revision`.
- Remove `trust` from `ProjectRecord` and every persisted schema/API.
- Restrict the generic preferences patch to theme/layout and other non-collection preferences.
- Add main-owned atomic methods for project upsert, Pi executable selection, active-session registration, draft/title updates, and session removal.
- Broadcast each committed state revision to every application window.
- Renderers apply only state whose revision is at least the latest observed revision.
- Derive the selected project and active session from IDs plus the current state snapshot; do not retain independently mutable record objects.

Schema `1` migration will preserve canonical project references, Pi executable preference, theme, and layout, but discard persisted trust. Because schema `1` may contain sessions misassociated by B2, clear its Desktop-only session index and `lastSessionPath` references during migration. Pi's session files remain untouched and can be imported safely through Pi afterward.

### E. Use canonical, platform-aware path identity

All filesystem authority enters through Electron main and is canonicalized with `realpath` before storage or use. Path keys will:

- normalize separators and absolute form;
- case-fold on Windows only;
- preserve case on POSIX, including Linux and case-sensitive macOS volumes;
- use canonical paths returned by main rather than renderer-derived lowercase strings.

Runtime/session UI matching should use stable runtime/session IDs. Paths remain display values and a main-side fallback, not the renderer's primary identity key.

## Phase 0 — Establish regression seams

Create small pure/testable modules before changing behavior so security and lifecycle cases do not depend on driving the full React app.

### Tasks

- [x] Add a shared finding-to-test checklist to the relevant test descriptions using the IDs in this plan.
- [x] Extract pure renderer helpers for:
  - applying revisioned desktop state;
  - deciding whether a session transition completed or was cancelled;
  - obtaining the current command/draft snapshot at shortcut invocation time;
  - mapping authoritative Guard status text to UI mode.
- [x] Extract main helpers/classes for:
  - renderer target/origin selection;
  - platform-aware canonical path keys;
  - workspace/project/session capability resolution;
  - trust selection injection, so production uses a native dialog and tests use a deterministic fake.
- [x] Make `PiProcess` runtime discovery, probe, spawn, and process-tree termination injectable in tests without changing production defaults.
- [x] Do not introduce a new browser-test framework solely for these fixes. Prefer Vitest unit/integration coverage around extracted logic plus existing Electron smoke and rendered manual QA.

### Initial failing tests

Add focused tests that reproduce the reviewed behavior before implementing the fixes:

- [x] Persisted `approve` survives a reload and is reused (B1).
- [x] A selected external session can be associated with another project (B2).
- [x] A non-loopback renderer URL is accepted and raw path requests reach handlers (B3).
- [x] Stop during deferred discovery/probe permits a later spawn (B4).
- [x] A delayed old-child exit affects a replacement child (B4).
- [x] `success: true, data.cancelled: true` increments generation or clears transition state (B5).
- [x] A shortcut registered before typing observes the old draft (B6).
- [x] Near-limit image input passes the UI but fails `PiProcess.#write()` (C1).
- [x] Rename sends `set_label` (C2).
- [x] Restart reads an older project record (C3).
- [x] Two stale project snapshots lose one addition (C4).
- [x] `/tmp/A` and `/tmp/a` collide under Linux semantics (C5).
- [x] A malformed nested project/session survives `StateStore.load()` (C6).
- [x] One RPC response also emits one runtime event (C7).
- [x] A late preview/diff result replaces a newer selection (C8).
- [x] `R  new.txt\0old.txt\0` resolves to `old.txt` (C9).
- [x] A missing `/guard` command can still produce success feedback (C10).

## Phase 1 — Main-owned authority, trust, sessions, and state

Addresses B1, B2, B3, C4, C5, and C6.

### 1.1 State schema and migration

Primary files:

- `desktop/src/shared/domain.ts`
- `desktop/src/shared/ipc.ts`
- `desktop/src/shared/schemas.ts`
- `desktop/src/main/state-store.ts`
- `desktop/tests/unit/state-store.test.ts`

Tasks:

- [x] Change `DesktopState.schema` to `2` and add an integer `revision`.
- [x] Remove `ProjectRecord.trust` and reject trust in all renderer-facing patches.
- [x] Parse disk JSON as `unknown`; normalize/migrate it; then validate the complete result with `desktopStateSchema` before assigning `#state`.
- [x] Quarantine malformed, unsupported, or failed-migration files and load a validated default.
- [x] Implement schema `1` to `2` migration as specified in decision D.
- [x] Validate every post-mutation state before writing it.
- [x] Keep writes atomic and mode `0600`; increment revision exactly once per committed mutation.
- [x] Add atomic `upsertProject`, `setPiExecutable`, `saveActiveSession`, `removeSession`, and existing draft/title methods that operate on the latest in-memory state.
- [x] Remove collection replacement (`projects`, `sessions`) from renderer-facing `DesktopStatePatch`.

Acceptance tests:

- [x] Valid schema `2` round-trips with its revision.
- [x] Schema `1` loses trust/session associations but preserves safe preferences and project paths.
- [x] Malformed nested project, session, layout, revision, and theme values are quarantined.
- [x] Concurrent project upserts from two simulated windows retain both projects and do not duplicate a canonical path.
- [x] State revisions are monotonic and failed validation is never written.

### 1.2 Renderer origin enforcement

Primary files:

- `desktop/src/main/index.ts`
- new focused main helper such as `desktop/src/main/renderer-origin.ts`
- `desktop/tests/unit/security.test.ts`

Tasks:

- [x] In packaged builds, ignore `ELECTRON_RENDERER_URL` and always load the packaged `index.html`.
- [x] In development, accept only `http:`/`https:` URLs whose hostname is `localhost`, `127.0.0.1`, or `::1`; reject credentials and every non-loopback target.
- [x] Store the expected renderer file URL or origin in `WindowContext`.
- [x] Extend `contextFor()` to verify both the owning main frame and its expected URL/origin.
- [x] Keep navigation, permission, and child-window denial unchanged.
- [x] Enable DevTools only for an accepted development renderer, not merely because an environment variable is present.

Acceptance tests:

- [x] Packaged mode never loads an environment-provided URL.
- [x] Loopback development URLs are accepted.
- [x] Remote hosts, credentials, malformed URLs, subframes, foreign windows, and changed origins are rejected.

### 1.3 Workspace capability controller

Primary files:

- new `desktop/src/main/workspace-controller.ts`
- `desktop/src/main/index.ts`
- `desktop/src/main/runtime-pool.ts`
- `desktop/src/main/pi-process.ts`
- `desktop/src/preload/index.ts`
- `desktop/src/shared/ipc.ts`
- `desktop/src/shared/rpc.ts`
- `desktop/src/shared/schemas.ts`
- new `desktop/tests/unit/workspace-controller.test.ts`

Tasks:

- [x] Replace renderer-facing raw launch paths with project/session/import IDs.
- [x] Resolve project paths, session paths, and the selected Pi executable from `StateStore` in main.
- [x] Add per-window active-project authority; Files/Git handlers resolve that project internally.
- [x] Change file APIs to accept only a bounded relative path and Git APIs to use the active project; remove renderer-provided `projectRoot`.
- [x] Change Pi selection so the native picker canonicalizes and stores the executable in main. The renderer receives updated state/display data, not authority to persist an arbitrary path.
- [x] Change project selection so the native picker canonicalizes and atomically upserts the project in main.
- [x] Implement the native per-process trust dialog and cancellation behavior from decision B.
- [x] Implement expiring one-time session-import tokens and `--fork` launch semantics from decision C.
- [x] Validate registered session ownership before direct resume.
- [x] Cache the active Pi-reported `sessionId` and `sessionFile` in `RuntimePool` after `get_state`.
- [x] Replace renderer-supplied `SessionRecord` identity/path fields with `saveActiveSessionMetadata`; main constructs identity from the active runtime and project.
- [x] Include stable `projectId` and `sessionId` in runtime descriptors so renderer routing no longer depends on normalized paths.
- [x] Remove or wrap path-bearing generic RPC operations that the UI does not require, especially renderer-supplied `switch_session` paths and `export_html.outputPath`.
- [x] Keep export authorization as a main-owned exact-path capability derived from Pi's response.
- [x] Adapt `openWorkspace`/pop-out to pass safe IDs. A new window must obtain a fresh native trust decision before spawning its own process.
- [x] Keep smoke automation main-owned: `--smoke` may inject deterministic `deny`/`noSession` behavior for a main-created temporary capability, but no production preload method may accept a trust value or raw path.

Acceptance tests:

- [x] Renderer requests cannot name `/`, another project, an arbitrary executable, or an unregistered session path.
- [x] File/Git reads remain confined to the active main-owned project even if request payloads are forged.
- [x] `approve` and `deny` exist only in a live launch object and never in `desktop-state.json` or renderer state.
- [x] Every new process prompts once; activating an existing process prompts zero times; cancelling prompts spawns nothing.
- [x] An imported session is launched with `--fork` in the selected project's cwd, creates a new Pi-owned session, and leaves the source untouched.
- [x] Import tokens reject wrong-window use, wrong-project binding, expiry, replay, and concurrent duplicate consumption.
- [x] A registered session cannot be resumed through a different project ID.
- [x] Desktop does not open or parse the selected JSONL in any test or production path.

### 1.4 State broadcasting and renderer projection

Primary files:

- `desktop/src/main/index.ts`
- `desktop/src/preload/index.ts`
- `desktop/src/shared/ipc.ts`
- `desktop/src/renderer/src/App.tsx`
- `desktop/src/renderer/src/mock-api.ts`

Tasks:

- [x] Add a validated `desktop:state-changed` event and frozen preload subscription.
- [x] Broadcast the validated state after every successful mutation to all live windows.
- [x] Centralize renderer state application and ignore lower revisions.
- [x] Store `selectedProjectId`, not a mutable `ProjectRecord`; derive the record from the latest state.
- [x] Derive `activeSession` from the latest state and stable ID.
- [x] Update mock API behavior to use revisions and atomic project operations.

Acceptance tests:

- [x] Two windows that add projects retain both entries and converge on the same revision.
- [x] A late response carrying an older revision cannot roll back newer renderer state.
- [x] Theme and layout updates still apply and window theme projection remains correct.

## Phase 2 — Process supervision and RPC boundary correctness

Addresses B4, the main-process portion of B5, and C7.

### 2.1 Attempt-scoped process lifecycle

Primary files:

- `desktop/src/main/pi-process.ts`
- `desktop/src/main/runtime-discovery.ts`
- `desktop/src/main/runtime-pool.ts`
- `desktop/tests/integration/pi-process.test.ts`
- `desktop/tests/unit/runtime-pool.test.ts`

Tasks:

- [x] Give each start attempt a unique epoch/token and cancellation signal.
- [x] Invalidate the attempt at the beginning of `stop()`, even when no RPC child has been assigned yet.
- [x] Pass cancellation into version probing and terminate the probe child when cancelled.
- [x] Check the attempt after every asynchronous boundary and immediately before spawn, readiness status, and final status publication.
- [x] Capture the child and attempt in stdout/end/error/exit listeners. Ignore callbacks that do not belong to the current child and attempt.
- [x] Make `#fail()` and `#handleExit()` operate on the child that caused the callback; they must never clear or terminate a replacement child.
- [x] Ensure `stop()` awaits termination of the current probe/RPC child and leaves no unresolved request/UI waiter.
- [x] Make `RuntimePool.stopActive()` coordinate with `runtime.starting`; do not delete a runtime until its start has been cancelled/settled and stop has completed.
- [x] Guard pool finalizers with runtime/promise identity so an old start cannot clear a newer `starting` promise or active runtime.
- [x] Preserve POSIX process-group termination and Windows `taskkill /t`; verify direct child and descendant termination.

Acceptance tests:

- [x] Stop during launch resolution, probe, spawn, and readiness leaves zero child processes.
- [x] A start cancelled before spawn can never spawn afterward.
- [x] A delayed exit/error/stdout callback from child A cannot change child B's status, pending requests, or identity.
- [x] Rapid start-stop-start produces one tracked child and an idle replacement.
- [x] Window close and application quit stop every foreground/background runtime.
- [x] Pending RPC requests and extension UI waiters reject exactly once on stop/failure.

### 2.2 Correct response classification

Primary files:

- `desktop/src/main/pi-process.ts`
- `desktop/tests/integration/pi-process.test.ts`

Tasks:

- [x] Treat every `type: "response"` record as request-channel data, not a runtime event.
- [x] Resolve/reject a matching pending request, record bounded diagnostics for an invalid unsolicited response if useful, and return unconditionally.
- [x] Preserve the 64 MiB exception only for a correlated response to an allowlisted bulk command.
- [x] Ensure bulk data crosses Electron IPC once through `invoke`, not again through `runtime:event`.

Acceptance tests:

- [x] Successful, failed, cancelled, and bulk responses emit zero runtime events.
- [x] Agent and extension event records still emit exactly once.
- [x] An oversized uncorrelated response remains rejected.

### 2.3 Cancelled replacement semantics in `PiProcess`

Tasks:

- [x] Add a strict helper that recognizes `data.cancelled === true` without trusting unrelated truthy values.
- [x] Increment process generation and clear replacement-scoped UI/Guard state only after a successful, non-cancelled `new_session`, `switch_session`, `fork`, or `clone` response.
- [x] Do not clear the recent Guard startup response when merely sending a replacement request; clear it only when a real boundary completes.
- [x] Leave session path/identity unchanged on cancellation.

Acceptance tests:

- [x] Each of the four replacement commands is tested with success, protocol failure, and successful cancellation.
- [x] Cancellation preserves generation, pending projection, session identity, and idle status.

## Phase 3 — Session transitions, drafts, and restart correctness

Addresses the renderer portion of B5, B6, and C3.

Primary files:

- `desktop/src/renderer/src/App.tsx`
- new renderer helper such as `desktop/src/renderer/src/lib/session-transitions.ts`
- `desktop/src/renderer/src/state/sessions.ts`
- `desktop/tests/unit/sessions.test.ts`
- new `desktop/tests/unit/session-transitions.test.ts`

### Tasks

- [x] Route `new_session`, `fork`, and `clone` through one serialized transition helper.
- [x] Before a transition, cancel the draft debounce and flush the latest draft for the current session.
- [x] If Pi reports cancellation, leave draft, transcript, active session, runtime generation, selection, and session registry untouched.
- [x] Hydrate/register the new session only after a confirmed transition.
- [x] Clear the composer only after the new active session identity has been observed and registered.
- [x] For fork, use Pi's returned `data.text` as the authoritative draft, with the locally selected text only as a compatibility fallback.
- [x] Prevent stale draft-save completions from applying an older desktop revision.
- [x] Replace shortcut closures with a stable dispatcher that reads current refs/snapshot at invocation time.
- [x] Ensure Ctrl/Cmd+N awaits the current draft flush before requesting the new session.
- [x] Implement Restart using the current active session ID through the main capability API, never `selectedProject.lastSessionPath`.
- [x] Prompt for trust again on Restart because it creates a new Pi process.
- [x] Disable conflicting transition controls while a transition is pending and restore them after cancellation/failure.

### Acceptance tests

- [x] Cancelled new/clone/fork operations preserve a non-empty draft and do not issue `saveSessionDraft` for an empty replacement.
- [x] Successful fork initializes the new composer with Pi's returned selected text.
- [x] Register a shortcut, change draft/session state, invoke it, and verify it sees the latest values.
- [x] Restart after switching A → B reopens B.
- [x] A failed restart leaves the previous session metadata/draft available for retry.

## Phase 4 — RPC feature contracts

Addresses C1, C2, and C10.

### 4.1 Transport-aware image attachments

Primary files:

- new shared limits module such as `desktop/src/shared/limits.ts`
- `desktop/src/shared/schemas.ts`
- `desktop/src/main/pi-process.ts`
- `desktop/src/renderer/src/App.tsx`
- `desktop/src/renderer/src/lib/content-blocks.ts`
- related unit tests

Tasks:

- [x] Define `MAX_RPC_COMMAND_BYTES = 4 * 1024 * 1024` once and import it in schema, renderer preflight, and `PiProcess`.
- [x] Reduce the per-file attachment limit from 10 MiB to a transport-safe value (target: 2 MiB) while retaining the eight-file count and existing dimension limits.
- [x] Validate the exact UTF-8 byte size of the complete serialized prompt/steer/follow-up command, including message, IDs, JSON overhead, and all base64 strings.
- [x] Reject an attachment before send when the aggregate command would exceed the limit and report the remaining/required size clearly.
- [x] Keep attachments selected if validation or write fails; clear them only after Pi accepts the command.
- [x] Keep the 10 MiB image-preview limit separate from the outbound attachment limit.
- [x] Update schemas so a single image string cannot individually consume the former 20 MiB allowance.

Acceptance tests:

- [x] Commands exactly below the byte ceiling pass and those above it fail before writing to stdin.
- [x] Message bytes plus multiple images are counted together.
- [x] Rejected attachments remain available to remove or retry.
- [x] Text-only prompts retain their current 1,000,000-character schema bound but still obey the exact byte ceiling.

### 4.2 Supported session naming

Primary files:

- `desktop/src/shared/schemas.ts`
- `desktop/src/renderer/src/App.tsx`
- renderer command/session tests

Tasks:

- [x] Replace `set_label` with Pi 0.84.4's supported `set_session_name` command.
- [x] Remove `set_label` from the renderer RPC allowlist unless another validated UI feature genuinely needs entry labels.
- [x] On success, rehydrate Pi state and let main update the active session's Pi-owned name.
- [x] On cancellation/failure, retain the prior name and dialog input.

Acceptance tests:

- [x] Rename emits `set_session_name` with the bounded name and no entry ID.
- [x] The live Pi 0.84.4 test confirms the name is returned by `get_state`.
- [x] An unsupported command can no longer leave the local registry ahead of Pi.

### 4.3 Authoritative Command Guard state

Primary files:

- `desktop/src/renderer/src/App.tsx`
- `desktop/src/renderer/src/state/conversation.ts` or a focused Guard helper
- `desktop/src/main/runtime-pool.ts`
- renderer/command tests

Tasks:

- [x] Derive Guard availability from `get_commands`; disable the native selector and show “SpecPi update required” when `/guard` is absent.
- [x] Track the last confirmed mode from `extension_ui_request` records with `method: "setStatus"` and `statusKey: "specpi-command-guard"`.
- [x] Install an acknowledgment waiter before sending `/guard <mode>` so an immediate status event cannot be missed.
- [x] Show a pending state while the command runs; announce success only after the expected authoritative status arrives.
- [x] On timeout, command failure, lock refusal, or mismatched status, restore the last confirmed mode and show an actionable error.
- [x] Preserve and display `locked` as authoritative even though it is not a normal selectable target.
- [x] Rehydrate/replay the stored status projection when switching back to a background runtime.

Acceptance tests:

- [x] Missing Guard command never sends `/guard` and never reports protection enabled.
- [x] Matching Off/Guard/Strict status acknowledges the request.
- [x] Mismatched/locked/no-status outcomes do not optimistically change the mode.
- [x] Switching runtimes restores each runtime's own confirmed Guard state.

## Phase 5 — Files and Git correctness

Addresses C8 and C9.

### 5.1 Scope asynchronous Files panel results

Primary files:

- `desktop/src/renderer/src/components/FilesPanel.tsx`
- a small request-generation/reducer helper and unit test
- `desktop/src/renderer/src/mock-api.ts`

Tasks:

- [x] Add monotonically increasing request generations for preview, diff, and Git status operations.
- [x] Capture project ID/root generation, selected path, tab, and request token before each call.
- [x] Apply success/error only if all captured values still match current state.
- [x] Invalidate outstanding work and clear preview, diff, selection, Git state, line range, and errors when the active project changes.
- [x] Invalidate the appropriate request when tab or selected file changes.
- [x] Keep the existing unmount cancellation for directory listings.
- [x] Add deterministic delayed mock responses for rendered/manual race validation if this can be done without affecting production behavior.

Acceptance tests:

- [x] A slow result for project A cannot render after switching to B.
- [x] A slow file A result cannot replace a newer file B selection.
- [x] Errors from stale requests are discarded.
- [x] Project switching immediately removes prior project content from the panel.

### 5.2 Parse porcelain rename/copy pairs correctly

Primary files:

- `desktop/src/main/git-service.ts`
- new `desktop/tests/unit/git-service.test.ts` or focused parser test

Tasks:

- [x] Extract a pure parser for `git status --porcelain=v1 --branch -z`.
- [x] For `R`/`C`, keep the first record's destination path and consume the following source path.
- [x] Optionally add bounded `originalPath` metadata if the UI will display `source → destination`; do not replace the actionable destination path.
- [x] Preserve NUL framing so spaces, tabs, quotes, and newlines in filenames are not reparsed as shell text.

Acceptance tests:

- [x] Rename and copy records report the destination and consume exactly one source record.
- [x] Mixed rename/ordinary/untracked records remain aligned.
- [x] Filenames with spaces and embedded newlines parse correctly.
- [x] A real temporary Git repository reproduction matches the pure fixture.

## Phase 6 — Restore Linux Electron and packaged smoke

Addresses B7.

Primary files:

- `.github/workflows/ci.yml`
- `desktop/scripts/smoke-packaged.mjs` only if artifact lookup/launch needs adjustment
- smoke-mode handling in `desktop/src/main/index.ts`

### Tasks

- [x] Preserve the exact current Linux failure log as regression evidence.

  From GitHub Actions run `33821489472`, job `100864923361`:

  ```text
  [2883:0904/002236.080882:FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:166] The SUID sandbox helper binary was found, but is not configured correctly. Rather than run without sandboxing I'm aborting now. You need to make sure that /home/runner/work/SpecPi/SpecPi/desktop/node_modules/electron/dist/chrome-sandbox is owned by root and has mode 4755.
  /home/runner/work/SpecPi/SpecPi/desktop/node_modules/electron/dist/electron exited with signal SIGTRAP
  ```

- [x] After `npm --prefix desktop ci`, configure `desktop/node_modules/electron/dist/chrome-sandbox` on the ephemeral Ubuntu runner as root-owned and mode `4755` using an explicit Linux-only CI step.
- [x] Assert the owner/mode before the development Electron smoke.
- [x] After `electron-builder` creates `dist/linux-unpacked`, configure and assert the packaged `chrome-sandbox` helper before packaged smoke if its copied metadata is not already valid.
- [x] Do not add `--no-sandbox`, `ELECTRON_DISABLE_SANDBOX`, or a production code path that disables Chromium sandboxing.
- [x] Keep `xvfb-run --auto-servernum` and verify both development and packaged bridge smoke complete.
- [x] Update smoke calls to the safe-ID/main-owned launch API from Phase 1 without exposing a test-only trust bypass through preload.

### Acceptance checks

- [ ] Ubuntu development smoke prints `SPECPI_DESKTOP_SMOKE_OK` with sandboxing enabled.
- [ ] Ubuntu packaged smoke prints `SPECPI_PACKAGED_SMOKE_OK` with sandboxing enabled.
- [ ] `dist` completes after smoke instead of being skipped by the failing step.
- [ ] Windows and macOS smoke behavior remains unchanged.
- [ ] The GitHub Actions `desktop` matrix is green on all three operating systems.

## Phase 7 — Documentation and final evidence

### Documentation updates

Update these files in the same change as the behavior they describe:

- [x] `desktop/README.md`
  - trust is native and per newly spawned process;
  - arbitrary session selection imports/forks into the selected project;
  - attachment limits reflect the outbound RPC ceiling;
  - missing Guard support is visible and disabled.
- [x] `desktop/ARCHITECTURE.md`
  - main-owned project/session capabilities and safe IDs;
  - revisioned state broadcast;
  - attempt-scoped process lifecycle;
  - response/event separation;
  - platform-aware path identity.
- [x] `desktop/SECURITY.md`
  - packaged renderer is always local;
  - development renderer is loopback-only and origin-checked;
  - main resolves active project and executable paths;
  - trust never crosses preload or persists;
  - session import is delegated to Pi via `--fork`, with no Desktop JSONL reads.
- [x] `SECURITY_MODEL.md`
  - keep the existing “never reads session files directly” statement and describe the opaque import handoff if clarification is needed.
- [x] `desktop/COMPATIBILITY.md`
  - document `data.cancelled` semantics and `set_session_name` at Pi 0.84.4.
- [x] `desktop/IMPLEMENTATION_AUDIT.md`
  - replace claims with the new tests and observed CI/runtime evidence.
- [x] `CHANGELOG.md`
  - summarize security, lifecycle, state-migration, and compatibility changes without implying a release.

### Focused validation order

Run the narrowest suites after each phase, then the full matrix:

1. State/security/workspace authority:
   - `npm --prefix desktop test -- --run tests/unit/state-store.test.ts tests/unit/security.test.ts tests/unit/workspace-controller.test.ts`
2. Process lifecycle/RPC:
   - `npm --prefix desktop test -- --run tests/integration/pi-process.test.ts tests/unit/runtime-pool.test.ts`
3. Session/renderer logic:
   - `npm --prefix desktop test -- --run tests/unit/sessions.test.ts tests/unit/session-transitions.test.ts tests/unit/commands.test.ts`
4. Files/Git/content limits:
   - run the focused file-service, Git parser, and content-block tests.
5. Desktop aggregate:
   - `npm --prefix desktop run typecheck`
   - `npm --prefix desktop run test`
   - `npm --prefix desktop run build`
   - `npm --prefix desktop run smoke`
6. Compatibility floor:
   - run `desktop/tests/integration/live-pi.test.ts` with `SPECPI_LIVE_PI=1` and Pi `0.84.4`.
7. Repository aggregate:
   - `npm run check`
   - `git diff --check`
   - `npm --prefix desktop audit --omit=dev`
8. Packaging/CI:
   - run platform-native `dist` and packaged smoke on Windows, macOS, and Linux through CI.

Observed local evidence on Windows (2026-09-03):

- `npm run check` passed: 143 root tests, Desktop typecheck, 98 Desktop tests passed with the single live-Pi test skipped by default, production build, and package-content checks.
- `SPECPI_LIVE_PI=1 npm --prefix desktop test -- tests/integration/live-pi.test.ts` passed against Pi 0.84.4.
- Unpacked and packaged Electron smoke passed with `ELECTRON_RUN_AS_NODE` unset, printing `SPECPI_DESKTOP_SMOKE_OK` and `SPECPI_PACKAGED_SMOKE_OK`.
- `npm --prefix desktop run package` completed for the local Windows unpacked target. The final cross-platform release build remains a hosted CI gate.
- The production dependency audit passed offline with zero vulnerabilities; the online registry audit timed out and was not treated as evidence.

### Rendered/manual acceptance matrix

Use an isolated test Pi configuration and non-sensitive temporary projects. Do not inspect real Pi sessions or credentials.

- [x] Desktop: 1440×900.
- [x] Tablet/narrow desktop: approximately 900×900.
- [x] Mobile-width stress case: approximately 390×844, acknowledging the app's documented minimum desktop window size while checking overflow and dialogs.
- [ ] Native trust dialog displays the canonical project path and cancellation spawns nothing.
- [ ] New process, restart, and pop-out each request fresh trust; background runtime activation does not.
- [ ] Session import visibly creates a fork in the selected project and leaves the source untouched.
- [ ] Cancel new/clone/fork with a non-empty draft; no state changes.
- [ ] Ctrl/Cmd+N after typing preserves the old session draft.
- [ ] Switch A → B and Restart; B reopens.
- [ ] Add projects from two windows; both remain visible.
- [ ] On Linux, case-distinct temporary project/session paths remain distinct.
- [ ] Switch projects/files while delayed preview and Git calls are outstanding; stale content never appears.
- [ ] Exercise attachments just below and above the aggregate command limit.
- [ ] Test Guard selector with current SpecPi, missing Guard, mismatched status, and locked status.
- [x] Confirm session rename against live Pi 0.84.4.

## Final review checklist

- [x] Inspect the full `main...HEAD` diff, not only the last commit.
- [x] Confirm no preload API accepts raw project roots, session paths, executable paths, or trust values.
- [x] Confirm no renderer-controlled operation can create a `SessionRecord` path/project association.
- [x] Confirm no state file contains project trust after migration or normal use.
- [x] Confirm Desktop source does not read Pi session JSONL.
- [x] Confirm no process callback can mutate a newer attempt.
- [x] Confirm cancelled replacements are no-ops in both main and renderer.
- [x] Confirm all correlated responses remain off the runtime event channel.
- [x] Confirm path comparisons are case-sensitive on Linux fixtures.
- [x] Confirm Linux smoke did not disable Chromium sandboxing.
- [x] Review test output, current GitHub checks, audit output, rendered screenshots, and final `git status` before declaring completion.

## Rollback and risk notes

- The schema `1` → `2` migration intentionally resets Desktop-only session indexing because old associations cannot be proven safe without reading Pi-owned JSONL. It does not delete or modify Pi sessions.
- Arbitrary “Open session” becomes an explicit import/fork operation. This is a deliberate compatibility-safe security change, not merely a label change.
- The IPC refactor is the highest-risk portion. Land it as one coherent main/preload/shared contract change with tests; do not keep a temporary raw-path fallback.
- The lifecycle refactor must not be mixed with unrelated renderer cleanup. Its correctness depends on attempt and child identity being explicit in every callback.
- If the Linux SUID helper approach is unsupported on a future hosted runner, reassess the runner/container configuration. Do not silently fall back to `--no-sandbox`.
- No commit, push, release, package publication, signing, notarization, or deployment is part of this plan without separate explicit instruction.
