# SpecPi Chat implementation plan

## Objective

Create a native VS Code sidebar for a complete local Pi conversation, preserving SpecPi's runtime, human approvals, and explicit control over context. Work starts from `main` commit `70db6fa` on `codex/specpi-chat-vscode`. The extension is a separately packaged artifact under `vscode/`; the npm installer remains independent.

## Architecture

The extension host owns a coordinator with a separate Pi RPC child process for each connected conversation. Selecting a conversation changes the displayed controller without cancelling another process, response, or approval. An application-scoped executable setting or PATH discovery selects Pi and an external supported Node runtime. Launch uses fixed arguments and no shell. Pi owns provider authentication, agent tools, extension loading, and conversation persistence. The extension never reads authentication or the user's terminal session collection.

A webview view lives in the native Activity Bar and can be moved with VS Code's regular view controls. It uses VS Code theme variables, local resources, a strict content security policy, and safe text/Markdown rendering. A small validated message protocol connects the view to the extension host. Provider objects are reduced to presentation fields before entering the webview.

New conversations are written by Pi into an extension-owned workspace-specific session directory. An atomic bounded catalog records only sessions created by this extension, including names and archive flags. Resuming uses that catalog and Pi RPC; it never enumerates unrelated Pi sessions. Drafts and attachments remain in memory per conversation. Archiving is reversible and does not delete conversation evidence or terminate a connected process.

## Delivery sequence and acceptance

1. **Runtime and trust:** executable discovery, framed RPC, request correlation, disconnect/reconnect, cancellation, startup timeout, and trusted-workspace gates. Exercise failures with an isolated fake process and real Pi startup without provider access.
2. **Conversation:** streamed Markdown, sealed thinking, collapsed tool results, pending/busy/error states, queue or steer, stop that clears queued work, model and thinking selection, context usage, and discovered slash commands. Completion uses `agent_settled`, including retry/compaction cycles.
3. **Human control:** visible exact extension approvals, selection/input/multiline editor dialogs, stale-response rejection, explicit attachment chips, selected editor text, bounded file selection, canonical workspace boundaries, and sensitive-file exclusions.
4. **Session experience:** new, resume, rename, and forget extension-owned conversations; multi-root workspace selection; no automatic agent execution merely from opening the view.
5. **Distribution and verification:** local installable VSIX, documented setup, unit and integration tests, rendered light/dark/high-contrast and narrow/wide sidebar checks, installed VS Code extension-host tests, full repository validation, and fresh read-only security review.

## Scope limits

This extension uses the supported Pi RPC interface. Terminal-only custom TUI components cannot be embedded in a webview; commands requiring them must present an explicit limitation or use supported RPC dialogs. The sidebar does not implement a second provider credential store, bypass Command Guard, automatically share files, scan historical conversations, publish to a marketplace, or install/upgrade the user's Pi environment. Real paid provider calls require a configured provider and are separate from deterministic offline verification.

## Evidence sources

- Pinned Pi `0.84.4`: `node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`, RPC implementation and type declarations.
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview).
- [VS Code Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust).
- [VS Code extension testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension).

Implementation findings and test results are recorded in the extension documentation and final handoff. No claims of live model verification are made from synthetic responses.

## Initial preview verification (0.1.0)

All five delivery stages are implemented. Verification on Windows on 2026-09-05:

- Full `npm run check` with the repository-pinned Pi CLI and `SPECPI_VSCODE_BROWSER_TESTS=1`: **475 passed, zero failures, four skips**. The skips are the separate existing public-site/browser-tool suites and the POSIX-only launcher case. Formatting, syntax, scoped types, and npm package/install lifecycle checks passed.
- The sidebar's actual Chromium suite passed all **22** layout and interaction checks, including 280/390/768/1200-pixel layouts, light/dark/high-contrast themes, short-window approvals, keyboard input, streaming, and safe rendering. Screenshots are synthetic, ignored artifacts; no visual baselines were changed.
- Installed VS Code **1.136.1** accepted the final VSIX and passed the isolated extension-host suite, including the packaged webview's actual ready handshake, context attachments, model/thinking controls, streamed messages/tools, Stop, session retention, New Chat, and disconnect.
- Real Pi **0.84.4** loaded every repository extension in isolated state and passed RPC/Guard/dialog regressions without invoking a provider. Fresh read-only security review verified the lifecycle, workspace-switch, approval, and retention fixes.

The initial local deliverable was `.specpi-test/vscode/specpi-chat-0.1.0.vsix`. No live credentials or terminal conversations were used, and no commit, push, marketplace publication, or deployment was performed. Live provider behavior and non-Windows hosts remain outside this verification evidence.

## Connection startup fix (0.1.1)

A user reported `Pi did not respond to get_state in time` even though Pi worked in the terminal. Isolated reproduction with the actual Guard from `main` identified the conflict: its startup selector waits 30 seconds, Pi 0.84.4 attaches the RPC stdin reader only after startup handlers finish, and Chat 0.1.0 starts its 30-second request timeout immediately after process spawn. Installing the sidebar does not update the installed harness.

Chat now runs a separate read-only readiness probe with a 90-second limit before normal requests. Their existing deadlines remain unchanged. Startup dialogs receive cancellation only; the view explains the older Guard fallback and keeps mode selection available through `/guard` after readiness. Startup has visible progress and cancellation. Cancelling an initial send restores its draft; generation checks prevent cancelled work from migrating to a replacement connection.

The real `main` Guard reproduction connected at **30.622 seconds** with the new handshake; `/guard strict` then reported strict mode. The repeatable integration uses the production npm-shim resolver and bundled Pi, with a shorter synthetic legacy fallback and isolated profile. Controller coverage exercises readiness, early dialogs, cancellation, and reconnect races; rendered coverage includes the startup banner above a restored transcript at 280 pixels. Fresh read-only review verified the cancellation fixes. Installed VS Code 1.136.1 accepted the updated package and passed its isolated extension-host suite.

Final `npm run check` with pinned Pi and `SPECPI_VSCODE_BROWSER_TESTS=1` passed: **490 passed, zero failures, four pre-existing skips** (494 total). This includes **46 controller tests**, both real Pi integrations, **23 browser checks**, formatting, syntax, types, and isolated package/install lifecycle validation. The final VSIX also passed the native installation and extension-host suite.

The updated local deliverable is `.specpi-test/vscode/specpi-chat-0.1.1.vsix` (200,253 bytes), SHA-256 `b3874e0cd06c2cd18abcbf958afa054ff7e50596da8a7506f5e905625e4e9017`. Third-party extensions that wait indefinitely during startup still need an RPC-compatible startup path; the sidebar reports the timeout without bypassing them or modifying installed resources.

## Compact composer (0.1.2)

The empty composer previously occupied about 154 pixels: three reserved input lines and separate option/send rows. It now starts with one input line and a consolidated toolbar, measuring **71 pixels** at 280-, 390-, and 768-pixel sidebar widths. The whole idle footer shrank from about 189 to 99 pixels. Multiline drafts grow to a bounded scrolling height and shrink on clearing or sending. Follow-up timing appears during a run, and input-limit guidance appears when needed. Keyboard descriptions and control labels remain available.

All **27 rendered checks** passed, including compact sizing, multiline growth and shrinkage, toolbar keyboard navigation, and Stop/follow-up at 280×500. Before and after screenshots and measured dimensions are ignored local artifacts; no visual baselines were changed. VS Code accepted the 0.1.2 VSIX and passed the isolated extension-host suite.

Full `npm run check` with the pinned Pi CLI and rendered checks enabled passed: **494 passed, zero failures, four pre-existing skips** (498 total), including formatting, syntax, types, and package/install lifecycle checks.

The 0.1.2 package is `.specpi-test/vscode/specpi-chat-0.1.2.vsix` (200,739 bytes), SHA-256 `73753c762eb93fa3502e0e61b17c873de64f43cc180a9599ab5b528b59befa78`.

## Recovery, streaming controls, and code references (0.1.3)

User-reported regressions reproduced and fixed: interrupted connections now release their transient run latch; a failed status refresh cannot restore a prompt Pi already accepted; and the thinking selector includes supported `max`. Refresh status performs read queries only and preserves newer runtime errors. The 71-pixel composer remains stable during streaming, with timing and Stop controls in its footer.

Markdown file links, inline code references, and plain file-and-line references now open a validated workspace file in VS Code at the requested line, column, or range. The host enforces containment, sensitive-path restrictions, regular-file checks, and position bounds independently of the renderer. Code samples inside fences remain literal. The extension README now explicitly distinguishes text attachments from unsupported image attachments, clipboard screenshots, and inline image previews.

Final validation: **519 passed, zero failures, four pre-existing skips** (523 tests) under full `npm run check`, including **31 browser checks**. Native VS Code installation and extension-host tests passed exact line/range navigation, maximum thinking, interrupted-run reconnect followed by a new prompt, and the existing session/attachment/streaming workflows. The reconnect test exposed a test-fixture-only Windows path-casing comparison, which was corrected; one transient test-profile cleanup lock cleared on a clean rerun. Fresh read-only reviews verified the lifecycle fixes and navigation boundary, including the newer-error refresh race.

The 0.1.3 local package was `.specpi-test/vscode/specpi-chat-0.1.3.vsix` (217,110 bytes), SHA-256 `b231015d80a5f970013eb86da239152692ed03096496d89c5e505c54cfdf264a`. Verification used isolated test profiles and synthetic content; provider-backed image use and live provider requests are outside the evidence. Filesystem races and a compromised host remain outside the navigation isolation guarantee.

## Images and conversation tools (0.2.0)

This iteration adds native image input and display, then completes the related recovery, history, and conversation actions. PNG, JPEG, GIF, and WebP inputs use explicit selection, screenshot paste, or image file drop; workspace URI drops and `@` suggestions reuse host context validation. The image picker can select files outside the workspace. Image-only prompts are supported, an image-capable model is required, failed drafts retain their attachments, and image-bearing slash commands are rejected because Pi does not consume their images.

User and tool images are normalized before display and restored from extension-owned history. Clicked local Markdown image references require workspace path validation before preview; external image URLs use the human-initiated browser link action. Image data stays in bounded memory caches during display, is referenced by media identifiers during streaming, and is never fetched from a remote URL by the webview. Sent images remain part of Pi's conversation persistence.

The limits are eight mixed attachments, 5 MiB per image, 20 MiB of images per prompt, 16,384 pixels per side, and 40 million pixels. The displayed transcript retains 32 images / 20 MiB and reports omissions. RPC records and pending writes are each capped at 64 MiB. Pi returns text only from `clear_queue`; recovery therefore requires a retained snapshot, an exact unambiguous text match, and a user-selected restore action. Ambiguous or unmatched images are not silently reused.

Conversation actions use Pi's active tree and public fork/clone APIs. Editing an earlier prompt captures its original text and images, creates a branch before it, and restores a draft for the user. Cloning retains the current conversation on a new branch. Neither changes workspace files or starts another agent. Search operates on the displayed transcript. Copy and Export produce visible Markdown with image placeholders; Export opens an unsaved native document. Usage reports include available cache, cost, and context measurements, with unknown values kept unavailable. Git review opens selected working-tree/staged changes through VS Code's native integration and does not stage or restore files.

### Acceptance checklist

The 0.2.0 acceptance checks are complete with the verification scope recorded below.

- [x] Image picker, screenshot paste, image file drop, workspace URI drop, and `@` file selection preserve explicit user selection and reject malformed, sensitive, or out-of-bound inputs.
- [x] Image-only and mixed prompts reach the RPC peer unchanged; image-incompatible models and image-bearing slash commands preserve unsent drafts.
- [x] User/tool images render, enlarge, and restore through New Chat/history/reconnect; local Markdown previews stay inside the selected workspace and no remote image request occurs.
- [x] Media caches, transcript projection, image parsing and dimensions, JSONL records, and write buffers remain bounded under valid large input and malicious overflow.
- [x] Stop/reconnect and accepted-message failures do not lose recoverable queued image drafts, duplicate accepted prompts, or reuse images on unrelated messages.
- [x] Editing an earlier prompt and cloning preserve the original conversation and image content; no file checkpoint, code rollback, or automatic send is implied.
- [x] Copy/export, search, usage, and native working-tree/staged review match the visible state and preserve unavailable measurements.
- [x] Narrow/wide sidebar layouts, light/dark/high-contrast themes, keyboard interaction, image load errors, and recovery panels remain usable.
- [x] Source and installed VSIX native host checks cover the packaged webview and actual fake-process transport in isolated state.
- [x] Full repository validation, package checks, and fresh read-only review complete on the final sources without modifying installed Pi resources or live private state.

### Final verification (0.2.0 checkpoint)

Full `npm run check` on Windows with the repository-pinned Pi CLI and `SPECPI_VSCODE_BROWSER_TESTS=1` passed: **666 passed, zero failures, four pre-existing skips** (670 tests). Formatting, lint, syntax, scoped types, and isolated npm package/installer lifecycle checks passed. The skips are the two separate public-site checks, the separate registered-browser-tool suite, and the POSIX-only launcher case.

All **58 rendered browser checks** passed, including image previews, exact 40 MiB cache replacement, asynchronous clipboard/context races, native VS Code multi-file drag formats, approval focus, conversation actions, file mentions, search, and startup/streaming scroll behavior. The composer remains compact at idle and during streaming. Existing viewport/theme coverage remains green; no visual baselines were replaced.

Real Pi **0.84.4**, using a deterministic synthetic vision provider and fresh isolated state, accepted image-only input, preserved exact image bytes in messages and entries, cloned/forked image turns, emitted tool images, and restored them after reconnect. VS Code **1.136.1** accepted the final VSIX and passed native activation, executable webview, attachment, source-navigation, model/thinking, image sending, Stop, reconnect, and owned-history tests. Source-host and packaged-host runs completed with profile cleanup. Test profiles disable VS Code's unrelated built-in agent host; cleanup has bounded asynchronous retries and fails explicitly if removal cannot complete.

Fresh read-only reviews verified image boundaries, media caching, stale-context handling, queue correlation, branch recovery, workspace lookup/diff review, and oversized history handling. Recognized oversized history responses now drain without disconnecting Pi and produce an explicit omitted-history notice; unknown oversized protocol records still fail closed. Reviewed defects were fixed and covered by regressions.

The package at this checkpoint was `.specpi-test/vscode/specpi-chat-0.2.0.vsix`: **378,987 bytes**, SHA-256 `d56650fa0422fe6b21e658a3a37ec743a6d28343e440c126f19b4d4207c80ccb`. Logs are `.specpi-test/vscode-0.2-check.log` and `.specpi-test/vscode-0.2-final-host.log`. Work at this checkpoint was uncommitted and unpublished on `codex/specpi-chat-vscode`.

Live provider calls, provider-specific image formats/animation, and non-Windows extension hosts require separate evidence. The 0.2.0 build did not provide inline completions, automatic file undo/checkpoints, or multiple concurrent Pi connections in one sidebar; 0.3.0 replaces the single-connection architecture below. No competitor feature-parity claim is made.

### 0.2.1: visible conversation cost

The footer now displays the aggregate cost from Pi's `get_session_stats` beside context/token usage, for example `12% · $0.0123`. It preserves known zero and tiny positive amounts, omits unavailable values, and provides the detailed USD amount on hover and through the keyboard-accessible Usage details action. The total refreshes after settled turns and on conversation changes; streaming retains the most recent reported total. No extra row or composer height was added.

Focused controller, rendered-browser, and webview checks passed **157/157**. The **60 rendered checks** include all existing viewport/theme coverage, narrow streaming layout, session cost replacement/clearing, aggregate versus per-message cost, zero/tiny/large/invalid amounts, and keyboard activation. An existing image-preview focus assertion now waits for the asynchronous dialog close event to restore focus. No visual baselines were changed.

Full `npm run check` with the pinned Pi CLI and browser suite enabled passed **668 tests, zero failures, four pre-existing skips** (672 total), including formatting, lint, syntax, types, and package validation. The 0.2.1 VSIX passed the isolated native VS Code install/workflow suite and profile cleanup. A fresh read-only cost review found no actionable issues.

Package: `.specpi-test/vscode/specpi-chat-0.2.1.vsix`, **380,333 bytes**, SHA-256 `6a18f0fd5aa8b5e8d4dba659248406a8c71c143f1b9bb4714c9823da908f9589`. Logs: `.specpi-test/vscode-0.2.1-focused.log`, `.specpi-test/vscode-0.2.1-check.log`, and `.specpi-test/vscode-0.2.1-host.log`. Changes at this checkpoint were uncommitted and unpublished on `codex/specpi-chat-vscode`.

### 0.3.0: searchable history and live conversations

History is now a themed sidebar popover with title search, date groups, current/running/unread/needs-input states, inline rename, and reversible archive/restore. Keyboard navigation, search focus, inline editing, loading/errors, and narrow layouts are covered. Picker source files use `chat-picker` names so the existing source-inventory privacy filter can include them without changing its sensitive-filename policy.

The coordinator holds an independent controller and Pi process for each connected conversation. Selection and workspace changes preserve those processes and their events, approvals, queues, attachments, usage, and drafts. New Chat is a local draft until explicitly connected or sent. The webview retains per-conversation scroll, selection, follow-up mode, and pending-send state; authoritative in-memory host drafts restore after view recreation. Background recovery and late replies stay scoped to their originating conversation. Stop/Disconnect affect the selected conversation; extension-host shutdown closes all owned processes. Concurrent chats share workspace files, without automatic worktree isolation.

Branches use Pi's pre-runtime `--fork` copy, followed by the requested active-branch or prompt fork in the copied runtime. The original process and session remain unchanged. Transitional targets reject sends/model changes until ready. Session identities are reserved before asynchronous catalog persistence so history refresh cannot create duplicate owners. Rename/archive retain locked, atomic metadata writes and never directly open transcripts.

Verification completed:

- Full `npm run check` with pinned Pi and rendered tests enabled: **703 passed, zero failures, four pre-existing skips** (707 total); formatting, lint, syntax (82 sources), scoped types, source inventory, and package checks passed.
- **101 focused controller tests** (17 coordinator and 84 existing controller regressions), **64 rendered checks** including the existing dark/light/high-contrast matrix at 280/390/768/1200px, four picker unit tests, and native-action/session regressions passed. Existing visual baselines were not changed.
- Installed VSIX on VS Code 1.136.1 passed **15 native workflow checks**, including two distinct live PIDs, switching during a held response, background dialog ownership, draft/image restoration, selected-only disconnect, reconnect, and isolated profile cleanup.
- Real Pi 0.84.4 synthetic-provider tests verified a second process starts from `--fork` before runtime hooks, can clone/edit/run an image prompt, and leaves the original PID, session identity, messages, and isolated session-file bytes unchanged. The original then continues independently.
- Fresh read-only review found and verified fixes for branch transition/stale cleanup, duplicate session ownership during persistence, stale native/file-mention actions, and complete background draft restoration. The final held-stop/reconnect regression confirms old cleanup cannot stop or add an error to a replacement connection. No remaining actionable findings in the reviewed scope.

Final package: `.specpi-test/vscode/specpi-chat-0.3.0.vsix`, **450,872 bytes**, SHA-256 `4861ee99e30b6323fb3dc50b1f991c8b99e19185c6c8cc1c157e3ac2a6938825`. Verification logs: `.specpi-test/vscode-0.3-check.log`, `.specpi-test/vscode-0.3-final-host.log`, and `.specpi-test/vscode-0.3-ui.log`. Work at this checkpoint was uncommitted and unpublished on `codex/specpi-chat-vscode`. Live provider availability and non-Windows hosts remained outside this local evidence.

### 0.3.1 / SpecPi 0.15.0 release preparation

A subsequent adversarial review identified three runtime defects and a stale README VSIX filename. Composer `/model` now uses a host-only model-selection path while preserving the send lock; webview messages cannot bypass it. Read-only Usage details work during ready/busy/retrying/compacting states but reject connection/session transitions. Both failed Stop paths recheck the teardown generation after asynchronous cleanup so obsolete errors cannot contaminate a replacement connection. New regressions reproduced the failures before the fixes and passed afterward. A bounded fresh read-only review of these fixes found no actionable defects; executable results remain the parent's evidence.

The root package is now **0.15.0**, and the separate Chat VSIX is **0.3.1**. README, Pages, release notes, and the release runbook describe installation, independent conversations, shared-file ownership, archive/branch semantics, and privacy boundaries. A packaging regression keeps documented VSIX filenames aligned with the extension manifest. Reusable browser CI now executes Chat rendering.

Local release checks passed:

- `SPECPI_VSCODE_BROWSER_TESTS=1 npm run check`: **710 passed, zero failures, four skips** (714 total), including **64 rendered Chat checks**, formatting, syntax, scoped types, and isolated npm/installer lifecycle validation.
- The skipped public-site and registered-browser-tool suites passed separately: **11 site tests** and **one browser-tool integration test**. Only the POSIX launcher case is inapplicable to this Windows host.
- `npm --prefix vscode run test:vsix`: isolated VSIX install/native-host workflow checks and profile cleanup passed.
- `npm run check:pi-package`, `npm publish --dry-run --ignore-scripts --provenance=false`, `npm pack --dry-run --json`, and `git diff --cached --check` passed. The npm artifact contains 87 allowlisted files and excludes Chat.
- Local Pages navigation and screenshots were inspected at desktop, tablet, and mobile widths; diagnostics recorded no runtime/request errors. No visual baselines were created or replaced.

Artifact: `.specpi-test/vscode/specpi-chat-0.3.1.vsix`, **451,756 bytes**, SHA-256 `9882495971be4703d1e8ef2aa251e1f37111bc1f32a649d74a0715733784a299`. Logs use `.specpi-test/release-*.log`. This prepares a PR, not a publication or deployment. Live provider/billing behavior and native non-Windows VS Code hosts still require separate evidence.
