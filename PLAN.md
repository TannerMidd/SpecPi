# SpecPi Desktop Implementation Plan

## Objective

Build a minimal, local-first desktop frontend for Pi that feels like a focused Codex-style workbench while preserving Pi as the agent runtime and SpecPi as the policy/workflow layer.

The application should provide:

- project and session selection;
- streaming chat, thinking, tool activity, and usage;
- model and thinking-level controls;
- prompt, steering, follow-up, image, abort, and queue workflows;
- a command palette for Pi resources and SpecPi commands;
- graphical handling of SpecPi approvals, selectors, confirmations, inputs, and editors;
- read-only file, Git status, and diff review;
- a native visual equivalent of SpecPi's focused `/spec` mode;
- cross-platform desktop packaging without moving credentials, sessions, or policy decisions out of Pi.

The desktop application is a host for Pi, not a replacement agent implementation. Pi remains authoritative for models, credentials, messages, tools, extensions, session files, compaction, and command execution. SpecPi remains authoritative for command guard, scope, experiments, completion challenge, wishlist, and improvement-loop behavior.

## Feasibility baseline

The implementation is supported by observed behavior rather than architectural assumption:

- Pi 0.84.4 documents `pi --mode rpc` specifically for custom UIs and IDE integrations.
- A live local RPC smoke returned model/session state and every installed SpecPi command through `get_commands`.
- Command Guard emitted its startup selection as an `extension_ui_request` in RPC mode.
- Pi RPC exposes streaming message and tool events, prompts, queues, models, thinking levels, compaction, session switching, forks, trees, stats, and extension UI dialogs.
- Existing independent Pi desktop applications demonstrate both Electron and Tauri implementations of the same boundary.
- The installed `ask_user_question` package has an RPC fallback built around Pi's standard `select` and `input` dialogs.

The remaining work is desktop hosting, state projection, native presentation, lifecycle hardening, and explicit adapters for terminal-only UI—not a new coding-agent engine.

## Product principles

1. **Pi owns agent state.** Do not create a second conversation format or agent loop.
2. **SpecPi owns policy.** Do not duplicate Command Guard, Scope, Challenge, or wishlist decisions in the renderer.
3. **Local by default.** The application opens no listening network port and adds no telemetry.
4. **Human control remains explicit.** Trust, approvals, destructive actions, updates, and external opens require visible user actions.
5. **The renderer is unprivileged.** Filesystem, process, Git, and Pi access live behind a narrow main-process API.
6. **RPC data is untrusted.** Validate every command, response, event, extension request, file path, and URL at the boundary.
7. **Recover from process loss.** A crashed or upgraded Pi subprocess must not corrupt the GUI or silently lose the persisted Pi session.
8. **One writer per worktree.** The GUI does not invent parallel writers; SpecPi `/experiment` remains the explicit isolated-worktree path.
9. **Minimal means focused scope.** Do not turn the first release into an IDE, terminal emulator, remote daemon, multi-agent orchestrator, or package marketplace.
10. **Compatibility is measured.** Maintain an explicit Pi/SpecPi capability matrix and automated live protocol smoke tests.

## Architectural decisions

### Desktop shell

Use **Electron with TypeScript** for the first implementation.

Reasons:

- SpecPi and Pi are Node/TypeScript projects.
- Electron's main process can supervise a Pi subprocess without a Rust bridge.
- It offers a direct path to SDK helpers if a later phase needs APIs missing from RPC.
- The main, preload, renderer, and shared protocol can all use one type system.
- It minimizes new maintainer tooling even though its packaged runtime is larger than Tauri.

Keep Tauri as a future packaging option, not a parallel implementation. Reconsider only after the Electron MVP establishes stable host interfaces and measured packaging size is a material problem.

### Pi integration

Use a supervised **`pi --mode rpc` subprocess** as the primary runtime.

Do not embed or recreate the agent loop in the renderer. Do not use a pseudo-terminal for agent communication. Communicate through strict LF-delimited JSONL on stdin/stdout and keep stderr separate for bounded diagnostics.

RPC is preferred over direct SDK embedding for the session loop because it:

- runs the same mode intended for external UIs;
- preserves Pi's resource discovery and extension behavior;
- gives extensions the standard RPC UI sub-protocol;
- isolates extension/runtime failures from Electron;
- allows the Pi CLI to be upgraded independently within a tested compatibility range.

Use Pi SDK helpers only after an explicit gap is proven. Any SDK dependency must be version-aligned with the supported Pi runtime and must not read or expose `auth.json` to the renderer.

### Runtime distribution

The MVP depends on an existing compatible Pi installation and discovers its executable in this order:

1. a user-selected executable path stored in desktop app settings;
2. the executable used successfully on the previous launch;
3. `pi` resolved through the main process environment.

Every candidate must pass `pi --version` before use. Do not execute a project-local binary merely because it is named `pi`. Display the resolved path and version in diagnostics.

Bundling Pi is deferred. If later adopted, bundle one reviewed Pi version as a separate runtime asset, continue using the user's normal `PI_CODING_AGENT_DIR`, and document the upgrade and rollback boundary.

### Runtime concurrency

The MVP supports **one active Pi RPC process per application window**. Sessions remain persistent in Pi, and switching sessions reuses or replaces the active runtime safely.

Do not start one permanent process per sidebar item in the first release. Multi-runtime tabs may be considered after memory, lifecycle, approval routing, and worktree ownership tests exist.

### Frontend stack

Use:

- Electron main process;
- a sandboxed renderer with `contextIsolation: true` and `nodeIntegration: false`;
- a small preload `contextBridge` API;
- React or Preact with TypeScript for stateful UI components;
- a lightweight validated store for transient view state;
- a tested Markdown renderer with raw HTML disabled;
- syntax highlighting loaded only for displayed languages;
- a virtualized transcript once long-session measurements justify it.

The implementation may select React for ecosystem familiarity or Preact for bundle size during Phase 0. That choice must not alter the main-process or RPC contracts.

### Repository layout

Create the desktop application as an independently packaged subtree so the existing `specpi` npm installer contract remains unchanged:

```text
desktop/
  package.json
  package-lock.json
  electron-builder.yml
  tsconfig.json
  src/
    main/
      app.ts
      windows.ts
      runtime-discovery.ts
      pi-process.ts
      rpc-channel.ts
      project-store.ts
      session-store.ts
      file-service.ts
      git-service.ts
      diagnostics.ts
    preload/
      index.ts
    renderer/
      app/
      components/
      features/chat/
      features/commands/
      features/dialogs/
      features/files/
      features/projects/
      features/sessions/
      features/spec-mode/
      features/settings/
      state/
      styles/
    shared/
      ipc.ts
      rpc.ts
      schemas.ts
      capabilities.ts
  tests/
    unit/
    integration/
    fixtures/
```

Do not add `desktop/` to the root `package.json.files` allow-list. Desktop releases are separate artifacts from the `specpi` installer package.

## Process and trust boundaries

```text
Untrusted project files / model output / extension output
                         │
                         ▼
              Pi RPC subprocess
        tools · extensions · sessions · auth
                         │ strict JSONL
                         ▼
              Electron main process
    schema validation · lifecycle · filesystem · Git
                         │ allowlisted typed IPC
                         ▼
                Sandbox renderer
       display · user intent · modal responses
```

### Renderer restrictions

- No Node integration.
- No direct filesystem access.
- No direct shell/process APIs.
- No direct access to environment variables.
- No credential or provider-token values.
- No arbitrary IPC channel names.
- No remote navigation in the primary renderer.
- No raw HTML from Markdown, tool output, diffs, or extension messages.
- Open external links only after protocol allowlisting and explicit user action.

### Main-process restrictions

- Spawn Pi with an argv array and `shell: false`.
- Never interpolate prompts, paths, or session identifiers into a shell command.
- Bound stderr and protocol logs in memory and redact likely secrets before diagnostics export.
- Resolve and canonicalize project/file paths before access.
- Use fixed Git argv for status and diff operations.
- Never read Pi authentication files, provider credentials, trust decisions, or unrelated session contents.
- Do not expose complete environment variables to the renderer.
- Kill the complete Pi child process tree on explicit shutdown or unrecoverable startup failure.

### Project trust

Pi RPC is noninteractive for project trust. The GUI must make the launch choice explicit:

- **Use Pi's saved/default decision:** pass no trust override.
- **Trust for this run:** pass `--approve` after a GUI confirmation.
- **Ignore project resources for this run:** pass `--no-approve`.

Do not write `trust.json` directly. If persistent trust management is later required, use a reviewed Pi API or send the user to Pi's own trust flow. Clearly indicate when project-local extensions/settings may have been ignored.

### Credentials

The MVP reuses credentials already configured in Pi. If no authenticated model is available, show an onboarding screen that explains how to run `pi` and `/login`.

A later graphical login flow must use Pi's public `ModelRuntime` auth APIs, keep secret entry in the main process, never echo secrets into logs, and support OAuth cancellation and timeout. It must not parse or edit `auth.json` directly.

## UX scope

### Primary window

The primary window has three restrained regions:

1. **Left rail:** projects and known GUI sessions.
2. **Center:** transcript, active work state, and composer.
3. **Optional right panel:** project files, file preview, Git status, and diff.

The default state should remain chat-focused. The file panel is closed until requested. There is no permanent terminal panel in the MVP.

### Transcript

Render:

- user messages;
- assistant text blocks;
- collapsible thinking blocks;
- tool calls with name and validated arguments;
- running, successful, failed, and aborted tool states;
- partial tool output replacement using `toolCallId`;
- images where Pi provides supported image content;
- retry and compaction notices;
- queued-message indicators;
- extension notifications;
- known SpecPi custom entries;
- a safe generic representation for unknown custom entries.

`message_end.message` is authoritative. Streaming deltas are provisional and must be replaced by the final message rather than treated as a second copy.

### Composer

Support:

- Enter to prompt while idle;
- configurable Shift+Enter or Ctrl+Enter for newline;
- steer and follow-up actions while Pi is running;
- image paste and file selection with MIME and size validation;
- queue chips with remove/restore behavior;
- Escape to clear queues first and then abort, matching Pi RPC guidance;
- draft retention per active GUI session;
- slash-command suggestions;
- visible disabled state while an extension modal owns input.

Do not silently turn an ordinary prompt into steering or follow-up. The selected delivery behavior must be visible.

### Command palette

Populate runtime commands from `get_commands` and preserve their source metadata:

- extension;
- prompt template;
- skill;
- user/project/temporary scope when supplied.

Send extension, prompt, and skill commands through RPC `prompt` with the leading slash.

Map built-in UI actions directly rather than submitting unsupported TUI commands:

| User action | Implementation |
| --- | --- |
| Model | `get_available_models`, `set_model` |
| Thinking | `get_available_thinking_levels`, `set_thinking_level` |
| New | `new_session` |
| Rename | `set_session_name` |
| Compact | `compact` |
| Fork | `get_fork_messages`, `fork` |
| Clone | `clone` |
| Session info | `get_state`, `get_session_stats` |
| Copy | renderer clipboard action on last assistant text |
| Export | `export_html` plus native save/open flow |
| Quit | controlled application shutdown |

RPC does not expose extension argument completion callbacks. For the MVP, provide command-name completion and a checked local completion table for SpecPi's stable subcommands. Never claim generic extension argument completion.

## SpecPi compatibility contract

### Fully supported through standard RPC UI

Implement first-class paths for:

- `/guard` status and mode changes;
- Command Guard startup selection;
- Command Guard tool/path approvals;
- `/scope set`, add, remove, accept, recheck, status, and clear;
- Scope out-of-contract decisions;
- `/experiment` start, status, close, recovery, export-path editing, and confirmation;
- `/harness-improvement` selection;
- `/wishlist` confirmation and status flows;
- `/challenge` activation/status/clear and its structured tool result;
- `ask_user_question` RPC fallback;
- extension `select`, `confirm`, `input`, and `editor` requests;
- extension `notify`, `setStatus`, `setWidget` string arrays, `setTitle`, and editor prefill requests.

Every blocking extension request must be keyed by its RPC request ID. The response must preserve the expected shape:

- select/input/editor: `{ type: "extension_ui_response", id, value }`;
- confirm: `{ type: "extension_ui_response", id, confirmed }`;
- cancel: `{ type: "extension_ui_response", id, cancelled: true }`.

Persist pending modal state in the main process until answered, cancelled, timed out by Pi, or invalidated by process exit. The renderer may disappear and reconnect without losing which decision Pi is awaiting.

### Native GUI adaptation required

#### `/files`

The current SpecPi `/files` command deliberately refuses non-TUI mode. Implement its desktop equivalent as a native read-only panel:

- project-root tree;
- bounded text preview;
- rendered Markdown preview with sanitized HTML;
- image preview for explicitly supported local MIME types;
- Git working-tree diff;
- copied project-relative path;
- bounded line selection;
- "Send review comment" action that creates an ordinary user prompt or follow-up through Pi.

Do not attempt to serialize Pi TUI components over RPC. Keep `/files` invokable so it can return its honest TUI-only warning, but advertise the native Files button as the desktop path.

#### `/spec`

Preserve `/spec on|off|status` as the authority for Spec mode state. Reconstruct the latest `spec-mode` custom entry from `get_entries`, and update on `entry_appended`.

When active, the GUI should:

- reduce nonessential chrome;
- keep tool output collapsed by default;
- collapse thinking by default;
- show the current phase and turn/tool counts;
- display scope as unset, clean, or review;
- avoid rendering routine transient notifications as prominent banners;
- keep the final answer visible when complete.

The semantic system guidance continues to come from the SpecPi extension. The GUI must not inject a second copy.

RPC streams original assistant content and does not carry Pi's terminal Markdown transformer output. Therefore the desktop version should not claim exact TUI "held stream" behavior unless it deliberately buffers prose while Spec mode is active and has tests for abort, errors, tool calls, and final-message replacement.

#### Custom entries

Support known renderers for:

- completion challenge entries;
- wishlist report entries;
- harness-improvement state entries;
- Spec mode entries;
- scope state entries when present.

Unknown entries get a compact label and optional sanitized JSON detail. Never execute renderer code or HTML received from an extension entry.

### TUI-only extension behavior

Pi RPC cannot carry arbitrary `ctx.ui.custom()` components, custom headers/footers/editors, terminal input hooks, themes, or autocomplete providers.

The desktop compatibility statement must say:

- ordinary Pi tools and commands work;
- standard RPC extension dialogs work;
- extensions with their own RPC fallback work;
- arbitrary terminal components are not automatically graphical.

Do not advertise universal Pi extension UI parity.

## Session and project ownership

### Project registry

Store only desktop-owned metadata in the OS application-data directory:

- project ID;
- canonical project path;
- display label;
- pinned/recent order;
- last selected session path;
- trust launch preference;
- UI layout state.

Do not copy source files, Pi credentials, SpecPi wishlist state, or full session transcripts into desktop state.

### Session registry

The MVP records session paths returned by `get_state` for sessions created or opened in the GUI. Each record may contain:

- Pi session ID;
- absolute Pi session file path;
- project ID;
- display name;
- last opened timestamp;
- last known model identifier;
- UI draft and scroll position.

Pi's JSONL file remains authoritative. If a file is missing or invalid, mark the record unavailable rather than rewriting it.

Initial import of arbitrary historical Pi sessions is deferred unless a public version-aligned `SessionManager.list` integration can be added without credential access or duplicate-runtime ambiguity. Provide an explicit "Open Pi session file" action as the fallback.

### Replacement lifecycle

On `new_session`, `switch_session`, `fork`, or clone:

1. disable session-mutating controls;
2. preserve the current draft locally;
3. wait for the correlated RPC response;
4. clear provisional streaming/tool state;
5. refresh `get_state`, `get_messages`, `get_entries`, `get_commands`, models, and thinking levels;
6. rebind the transcript to the new session ID;
7. restore the destination draft;
8. ignore late events tagged to the previous process/session generation.

Use a monotonically increasing runtime generation in the main process. Every renderer event includes that generation so stale events cannot alter a replacement session.

## Implementation phases

## Phase 0 — Reuse audit and architecture proof

Before adopting code from another Pi desktop project:

- [ ] Audit Tau's RPC transport, Electron security settings, license, dependencies, tests, and release state.
- [ ] Audit the extension-first Tauri Pi Desktop RPC/state implementation as a reference even if Electron remains selected.
- [ ] Audit NativePi's graphical extension handling only for reusable protocol ideas; do not inherit its remote/network scope.
- [ ] Record source, license, commit, copied files, and modifications for any reused code in `THIRD_PARTY.md` or a desktop-specific attribution file.
- [ ] Reject reuse that brings remote control, telemetry, auto-update, terminal, package marketplace, or unrelated orchestration into the MVP.
- [ ] Build a disposable Electron proof that starts Pi RPC only after the renderer subscribes.
- [ ] Prove `get_state`, `get_commands`, and Command Guard's startup selection render and respond correctly.
- [ ] Prove the process exits cleanly and no Pi session is created when launched with `--no-session` for the smoke.
- [ ] Write a short architecture decision record fixing Electron, RPC subprocess ownership, runtime discovery, and one-process concurrency.

Acceptance:

- A visible desktop window can complete the Command Guard startup prompt and display all SpecPi command names.
- The selected implementation path has a documented license and provenance.
- No production architecture depends on terminal ANSI scraping or a pseudo-terminal.

## Phase 1 — Secure desktop scaffold

- [ ] Add `desktop/package.json` with pinned reviewed runtime and development dependencies.
- [ ] Commit a desktop lockfile and configure dependency review.
- [ ] Add Electron main, preload, renderer, and shared TypeScript projects.
- [ ] Enable renderer sandboxing, context isolation, CSP, and navigation blocking.
- [ ] Define the preload API before implementing features.
- [ ] Validate every IPC request and response with closed schemas.
- [ ] Add structured error codes rather than passing raw exceptions to the renderer.
- [ ] Add app-data storage with atomic writes and corruption recovery.
- [ ] Add bounded redacted diagnostics with an explicit user export action.
- [ ] Add dark, light, and system UI modes independent of Pi TUI themes.
- [ ] Add root scripts for desktop formatting, type checking, unit tests, and packaging checks without changing the existing npm tarball contents.

Acceptance:

- Renderer code cannot call Node or Electron primitives outside the preload allowlist.
- CSP and external-navigation tests pass.
- Corrupt desktop settings are quarantined and replaced without touching Pi state.
- Root `npm run check` either includes the desktop checks or clearly delegates to a separately required desktop gate.

## Phase 2 — Runtime discovery and RPC bridge

- [ ] Implement executable-path selection and persistence.
- [ ] Probe `pi --version` with a timeout and bounded output.
- [ ] Enforce the supported Pi compatibility range and show actionable upgrade errors.
- [ ] Spawn `pi --mode rpc` with `shell: false`, selected cwd, trust override, and optional session target.
- [ ] Implement strict LF-only JSONL framing with `StringDecoder`; do not use Node `readline`.
- [ ] Enforce maximum line, event, stderr, and pending-request limits.
- [ ] Correlate command responses by unique request ID.
- [ ] Distinguish responses, agent events, extension UI requests, parse errors, and unknown protocol messages.
- [ ] Add startup, idle, streaming, waiting-for-user, retrying, compacting, failed, and stopped runtime states.
- [ ] Queue fire-and-forget status requests without blocking command responses.
- [ ] Queue blocking extension requests until the renderer acknowledges receipt.
- [ ] Handle timeout, stdin failure, malformed JSON, child exit, renderer reload, and app shutdown.
- [ ] Kill process trees reliably on Windows, macOS, and Linux.
- [ ] Add a runtime generation to every forwarded event.
- [ ] Add protocol fixtures captured from Pi 0.84.4 without secrets or user content.

Acceptance:

- Split UTF-8 and split JSON chunks reassemble correctly.
- U+2028 and U+2029 inside JSON strings do not split records.
- A malformed or oversized line fails the runtime safely and cannot crash the Electron main process.
- Requests cannot resolve against a response from another runtime generation.
- Closing the app leaves no Pi child process.

## Phase 3 — Conversation state and composer

- [ ] Build a reducer that projects Pi events into transcript state.
- [ ] Assemble streaming text, thinking, and tool-call deltas by `contentIndex`.
- [ ] Treat final `message_end` payloads as authoritative.
- [ ] Correlate tool start/update/end by `toolCallId`.
- [ ] Replace accumulated partial tool output rather than appending duplicate snapshots.
- [ ] Render assistant Markdown with raw HTML disabled and URLs sanitized.
- [ ] Render tool arguments/results as bounded collapsible content.
- [ ] Render provider errors, retries, compaction, aborts, and extension errors visibly.
- [ ] Implement prompt, steer, follow-up, clear queue, and abort commands.
- [ ] Implement Escape behavior as `clear_queue` followed by `abort`, restoring returned text to the composer.
- [ ] Add image paste/attach with type, dimension, and byte limits.
- [ ] Add per-session drafts without placing draft text in logs.
- [ ] Add transcript auto-scroll that stops when the user scrolls away from the tail.
- [ ] Add copy actions for messages and code blocks.
- [ ] Refresh state from `get_messages` after reconnect or runtime replacement.

Acceptance:

- Long streamed responses contain no duplicated text after finalization.
- Parallel tool updates remain attached to the correct tool calls.
- Queue state matches `queue_update` and survives renderer rerenders.
- Abort restores queued text and reaches an idle state.
- A renderer reload reconstructs the current transcript without starting a second Pi process.

## Phase 4 — Extension UI and SpecPi command support

- [ ] Render `select`, `confirm`, `input`, and multiline `editor` requests as accessible modal dialogs.
- [ ] Render notifications as bounded toasts and retain warning/error history in the transcript activity rail.
- [ ] Map `setStatus` to keyed status badges.
- [ ] Map string-array `setWidget` to restrained blocks above or below the composer.
- [ ] Map `setTitle` without allowing title text to affect HTML.
- [ ] Map `set_editor_text` to the active draft only when its runtime generation and session match.
- [ ] Implement modal cancellation and stale-request invalidation.
- [ ] Ensure Command Guard defaults focus the deny/recommended choice.
- [ ] Prevent keyboard shortcuts from submitting the composer while a modal is open.
- [ ] Populate the command palette from `get_commands`.
- [ ] Add checked SpecPi subcommand completion metadata for `/spec`, `/guard`, `/scope`, `/experiment`, `/challenge`, and `/wishlist`.
- [ ] Route `/harness-improvement` and all discovered extension commands through `prompt` rather than reproducing handlers.
- [ ] Verify the installed `ask_user_question` RPC fallback with single-select, multi-select, custom text, cancellation, and previews represented as plain safe text.
- [ ] Verify `/goal` status and confirmation paths in RPC mode.
- [ ] Handle `entry_appended` and implement known SpecPi entry cards.
- [ ] Show unknown custom entries safely without executing extension rendering logic.

Acceptance:

- Every SpecPi blocking dialog can be answered or cancelled from the GUI.
- Command Guard denies when the renderer closes or the request becomes stale.
- `/scope set`, `/experiment start`, `/harness-improvement`, and a guarded tool approval complete end to end in isolated state.
- Unknown custom entries and ANSI-bearing statuses cannot inject DOM or corrupt layout.

## Phase 5 — Projects, sessions, and native built-in actions

- [ ] Add a native directory picker and canonical project registry.
- [ ] Add explicit per-launch trust choice.
- [ ] Start new persistent Pi sessions and record returned session metadata.
- [ ] Reopen known GUI sessions with `switch_session` or a session-targeted runtime start.
- [ ] Implement new, rename, compact, fork, clone, stats, and HTML export actions.
- [ ] Display current model, thinking level, context usage, token totals, and cost where available.
- [ ] Add model search/grouping and unsupported-auth feedback without exposing credential values.
- [ ] Add thinking-level choices from `get_available_thinking_levels` rather than a hardcoded subset.
- [ ] Add read-only session tree display from `get_tree`.
- [ ] Defer in-place tree navigation until Pi exposes a public RPC command or a version-aligned SDK adapter is approved.
- [ ] Add "Open Pi session file" with validation for sessions not in the desktop index.
- [ ] Implement compatibility restart for resource reload, with a warning that transient extension state and session approvals reset.
- [ ] Restore project/session selection, drafts, and panel layout on app restart.

Acceptance:

- Creating, switching, renaming, compacting, forking, and cloning sessions preserves Pi's session files.
- Session replacement cannot mix messages or approvals between session generations.
- The app never edits Pi JSONL session files directly.
- An unavailable session file is reported without removing or rewriting unrelated Pi state.

## Phase 6 — Native Files panel and Spec mode

### Files

- [ ] Implement a lazy project-root file tree with ignored heavy directories collapsed or excluded by default.
- [ ] Bound directory entry count, recursion, file size, and preview output.
- [ ] Canonicalize requested paths and reject paths outside the selected project root.
- [ ] Define explicit symlink behavior and test links that escape the project.
- [ ] Add text/code preview with encoding detection limited to reviewed formats.
- [ ] Add sanitized Markdown preview with relative asset resolution constrained to the project.
- [ ] Add image preview for reviewed MIME types.
- [ ] Implement Git status and unified diff through fixed argv with `shell: false`.
- [ ] Avoid stage, discard, commit, push, pull, or arbitrary Git execution in the MVP.
- [ ] Add bounded line selection and a "Send review comment" action.
- [ ] Send the comment as a project-relative path and selected line range, not an uncontrolled full-file copy.
- [ ] Refresh changed files after relevant tool completion with debounce and generation checks.

### Spec mode

- [ ] Reconstruct active state from SpecPi's `spec-mode` entries.
- [ ] Detect `/spec` state changes through new entries and notifications.
- [ ] Add a focused layout with reduced chrome and collapsed tool/thinking defaults.
- [ ] Derive working phase from agent and tool events.
- [ ] Display turn and tool counters scoped to the current session runtime.
- [ ] Display Scope state from keyed status/events where available.
- [ ] Decide whether to buffer assistant prose until `message_end`; if implemented, test every completion and failure path.
- [ ] Restore the user's previous panel and expansion state when Spec mode turns off.

Acceptance:

- The Files panel offers the practical desktop equivalent of `/files` without weakening root boundaries.
- A symlink or crafted path cannot preview a file outside the chosen project.
- Git commands are read-only and fixed-argv.
- `/spec on`, `/spec off`, session restore, abort, retry, and tool failure all leave the desktop in a coherent visual state.

## Phase 7 — Reliability, accessibility, and performance

- [ ] Add keyboard navigation and visible focus for every modal, command item, tool card, and panel.
- [ ] Add screen-reader labels and live regions for status changes without announcing every token delta.
- [ ] Respect reduced-motion and system light/dark preferences.
- [ ] Test minimum supported window size and high-DPI scaling.
- [ ] Add transcript virtualization only after preserving selection, copy, and streaming behavior.
- [ ] Coalesce high-frequency streaming updates to one renderer frame while retaining complete final content.
- [ ] Add memory and startup-time budgets.
- [ ] Add crash recovery that offers to reopen the last persisted Pi session.
- [ ] Add bounded protocol diagnostics with no prompt/source capture by default.
- [ ] Add an explicit troubleshooting view for Pi path, version, cwd, mode, process state, and extension load errors.
- [ ] Test renderer crashes, main-process restart during development, Pi crashes, machine sleep, and slow provider responses.

Acceptance:

- Core workflows are keyboard accessible.
- A long tool-heavy session remains responsive within the documented memory budget.
- Process or renderer failure never fabricates completion, approval, or successful persistence.

## Phase 8 — Packaging and release

- [ ] Choose Electron Builder or Electron Forge and pin the packaging toolchain.
- [ ] Produce Windows x64, macOS arm64/x64, and Linux x64 artifacts only where CI runners validate them.
- [ ] Keep desktop release artifacts separate from the `specpi` npm package.
- [ ] Include licenses and third-party notices.
- [ ] Add artifact checksums.
- [ ] Add code signing and macOS notarization before calling installers production-ready; otherwise label builds unsigned.
- [ ] Add a first-run Pi executable/version check.
- [ ] Do not add automatic Pi, SpecPi, or desktop updates in the MVP.
- [ ] If update checks are later added, make them explicit, bounded, disableable, and separate from telemetry.
- [ ] Add release smoke tests that install, launch, connect to an isolated Pi config, complete an RPC UI prompt, and uninstall.
- [ ] Document supported Pi and SpecPi versions and known TUI-only limitations.
- [ ] Require explicit human approval before publishing installers or creating releases.

Acceptance:

- Packaged applications start Pi and complete a no-model-cost RPC smoke on each supported platform.
- Install and uninstall do not alter Pi configuration or remove Pi/SpecPi private state.
- Release artifacts are attributable to one reviewed commit and checksum set.

## Test strategy

### Unit tests

- JSONL framing across arbitrary chunks, CRLF input, Unicode separators, malformed JSON, and line limits.
- Request/response correlation and timeout cleanup.
- Runtime generation rejection of stale events.
- Streaming message assembly by content index.
- Tool-call lifecycle correlation and partial-result replacement.
- Queue state and Escape restoration.
- Extension UI request/response encoding.
- ANSI stripping/sanitization.
- Markdown URL and HTML sanitization.
- Project and session registry migrations.
- Canonical path/root checks including symlinks and Windows path forms.
- Spec mode reconstruction and visual-state transitions.

### Integration tests with a fake RPC child

- Startup handshake.
- Interleaved responses, events, and extension UI requests.
- Command Guard modal before ordinary command responses.
- Renderer disconnect while a modal is pending.
- Child exit during streaming, compaction, and dialog wait.
- Session replacement with late old-generation events.
- Oversized stdout/stderr and backpressure.
- Graceful and forced shutdown.

### Live isolated Pi tests

Use a temporary `PI_CODING_AGENT_DIR`; never target the developer's live Pi state.

- Load SpecPi extensions from isolated installed resources.
- Run `get_state` and `get_commands` without making a provider request.
- Complete Command Guard startup selection.
- Invoke `/guard status`, `/spec status`, and `/files` to verify documented RPC behavior.
- Exercise `/scope set` through the editor protocol.
- Exercise `/harness-improvement` with a controlled fixture candidate.
- Exercise one Command Guard approval and denial with fake/non-destructive tools.
- Verify `entry_appended` delivery for Spec mode and challenge fixtures.
- Verify new/switch/fork/clone lifecycle in temporary sessions.
- Preserve an authentication canary without reading its contents.

### Browser-rendered UI tests

Use the repository browser tooling against the renderer development server or packaged app test bridge:

- desktop viewport;
- compact desktop viewport;
- high-DPI-equivalent dimensions;
- long Markdown and code;
- parallel tool cards;
- every extension modal type;
- focused Spec mode;
- file tree and large diff;
- light/dark/system theme;
- keyboard-only workflows.

Create visual baselines only when explicitly approved.

### Platform matrix

| Area | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Pi discovery and manual path | Required | Required | Required |
| JSONL RPC and shutdown | Required | Required | Required |
| Session paths | Required | Required | Required |
| File/root canonicalization | Required | Required | Required |
| Git status/diff | Required | Required | Required |
| Installer launch smoke | Required | Required | Required |
| Signing/notarization | Signing target | Notarization target | Checksums/package metadata |

## Compatibility matrix to maintain

For every supported Pi version, record:

- RPC command set;
- emitted event set;
- extension UI methods;
- `entry_appended` availability;
- message-delta shape;
- model/thinking-level behavior;
- session replacement behavior;
- known unsupported TUI methods;
- SpecPi command discovery;
- installed supporting-package behavior.

Fail startup on a known-incompatible Pi version. For an untested newer version, warn and offer either cancel or continue in compatibility mode; never silently claim full support.

## Documentation deliverables

- Desktop installation and prerequisites.
- Existing Pi and SpecPi installation expectations.
- Runtime discovery and manual executable selection.
- Project trust choices.
- Credentials and `/login` limitation.
- Session ownership and recovery.
- Supported SpecPi commands.
- `/files` native replacement.
- `/spec` desktop behavior and differences from TUI.
- Arbitrary TUI extension limitations.
- Local data locations and retention.
- Diagnostics and redaction.
- Security architecture and renderer/main/Pi boundaries.
- Development setup and platform packaging requirements.
- Release and rollback procedure.

Update `SECURITY_MODEL.md`, `THIRD_PARTY.md`, `CHANGELOG.md`, and the README only when implementation changes their contracts. Do not describe planned behavior as shipped behavior.

## Risks and mitigations

### Pi RPC evolves

Mitigation:

- closed protocol schemas with forward-compatible unknown-event handling;
- supported-version matrix;
- live isolated smoke tests;
- runtime version shown in diagnostics;
- no dependence on undocumented stdout text.

### Extensions expect TUI-only components

Mitigation:

- clearly support standard RPC dialogs first;
- render known SpecPi entries natively;
- provide honest generic fallback;
- do not claim universal graphical extension compatibility.

### Approval requests are missed or routed to the wrong session

Mitigation:

- spawn only after renderer subscription;
- hold requests in the main process;
- key responses by request ID and runtime generation;
- deny/cancel on stale state or renderer loss;
- visibly mark Pi as waiting for the user.

### Global Pi executable discovery is unreliable

Mitigation:

- manual path selection;
- remembered last-known-good path;
- version probe and diagnostics;
- no project-local executable auto-discovery;
- consider a bundled reviewed runtime only after MVP evidence.

### Session formats or paths change

Mitigation:

- Pi owns and writes sessions;
- the GUI stores only references;
- use RPC state/messages/entries to reconstruct;
- avoid direct JSONL mutation.

### GUI weakens SpecPi's privacy model

Mitigation:

- no telemetry or listening server;
- no credential reads;
- no transcript duplication by default;
- bounded redacted diagnostics;
- explicit local data inventory and deletion controls.

### File preview becomes an escape boundary

Mitigation:

- canonical root checks;
- explicit symlink policy;
- supported MIME allowlist;
- sanitized Markdown/HTML;
- no script execution or unrestricted iframe navigation;
- read-only initial scope.

### Electron expands supply-chain and package size

Mitigation:

- separate lockfile and release artifact;
- minimal dependency set;
- dependency review and pinned packaging tools;
- renderer sandbox/CSP;
- revisit Tauri only from measured evidence.

## Milestones and estimates

Estimates assume one developer familiar with TypeScript and the existing SpecPi codebase. They are planning ranges, not release commitments.

| Milestone | Scope | Estimate |
| --- | --- | --- |
| M0 | Reuse audit and live Electron/RPC proof | 2–5 days |
| M1 | Secure scaffold and hardened RPC bridge | 1–2 weeks |
| M2 | Streaming chat, tools, composer, queues | 1–2 weeks |
| M3 | Extension UI and SpecPi command compatibility | 1–2 weeks |
| M4 | Projects, sessions, models, native actions | 1–2 weeks |
| M5 | Files/diffs and native Spec mode | 1–2 weeks |
| M6 | Cross-platform hardening and accessibility | 1–2 weeks |
| M7 | Packaging, signing, documentation, release smoke | 1–2 weeks plus signing lead time |

A narrow internal MVP is approximately **3–5 developer weeks**. A polished cross-platform release is approximately **8–12 developer weeks**, depending on signing, session-history scope, and compatibility findings.

## MVP definition of done

- A user can select a project and explicitly choose its trust behavior.
- The app finds a compatible Pi executable and shows actionable failure diagnostics.
- Pi runs as a supervised RPC subprocess with strict JSONL handling.
- Streaming text, thinking, tool calls, retries, errors, and final messages render correctly.
- Prompt, steer, follow-up, queue restore, image, and abort workflows work.
- Models and supported thinking levels can be selected.
- Persistent Pi sessions can be created, reopened from the GUI registry, renamed, compacted, forked, cloned, and exported.
- Runtime-discovered extension, prompt, and skill commands appear in the command palette.
- Command Guard and all standard SpecPi extension dialogs are usable from the GUI.
- Known SpecPi custom entries have safe native rendering.
- `/files` has a read-only native project/file/diff equivalent.
- `/spec` has a coherent native focused presentation while SpecPi still owns semantic guidance.
- The renderer has no direct Node, filesystem, process, environment, or credential access.
- No telemetry or listening network service is introduced.
- Unit, fake-RPC integration, isolated live Pi, rendered UI, and supported-platform package smoke checks pass.
- Security model, third-party inventory, limitations, and release procedure are documented.
- Final diff and packaged artifacts receive fresh read-only review.
- No commit, tag, release, signing request, publish, deployment, or remote update occurs without explicit human authorization.

## Post-MVP candidates

Only consider these after usage evidence:

- graphical provider login/OAuth through public Pi APIs;
- imported browsing of all historical Pi sessions;
- in-place session tree navigation when publicly exposed;
- multiple simultaneous Pi runtimes;
- bundled Pi runtime with controlled updates;
- graphical package management;
- editable files with explicit conflict handling;
- terminal panel;
- worktree dashboard around `/experiment`;
- versioned graphical extension API;
- optional Tauri packaging.

Each candidate requires a separate scope, threat-model update, and acceptance plan.

## Explicit non-goals

- Reimplementing Pi's agent loop, provider clients, tool execution, session storage, or extension loader.
- Duplicating SpecPi policy decisions in frontend code.
- Claiming an operating-system sandbox.
- Running multiple autonomous agents by default.
- Automatically creating, committing, merging, pushing, publishing, or deploying Git work.
- A built-in terminal in the MVP.
- Writing or editing project files from the Files panel in the MVP.
- Reading or editing Pi authentication or trust files directly.
- Opening a LAN server, remote-control API, cloud relay, or browser-accessible daemon.
- Telemetry, analytics, account creation, or hosted storage.
- A package marketplace or automatic package installation.
- Silent Pi, SpecPi, package, Chromium, or desktop self-updates.
- Exact visual emulation of arbitrary Pi TUI components.
- Shipping unsigned builds as production-ready.
- Including desktop binaries or dependencies in the existing `specpi` npm installer tarball.
