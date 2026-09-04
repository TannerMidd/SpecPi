# Desktop Compatibility Contract

The validated version is Pi `0.84.4`, matching SpecPi's installer floor. Startup rejects an older, prerelease, or unparseable executable. A newer version is identified as untested and requires explicit confirmation in an Electron-main-owned native dialog before the RPC process is spawned; renderer acknowledgment is not launch authority.

## Required Pi RPC commands

Desktop emits only this reviewed set: `prompt`, `steer`, `follow_up`, `abort`, `clear_queue`, `new_session`, `get_state`, `get_messages`, `get_session_stats`, `get_available_models`, `set_model`, `cycle_model`, `set_thinking_level`, `cycle_thinking_level`, `get_available_thinking_levels`, `set_steering_mode`, `set_follow_up_mode`, `compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `get_commands`, `set_session_name`, `export_html`, `fork`, `clone`, `get_fork_messages`, `get_tree`, `get_last_assistant_text`, `get_entries`, plus `extension_ui_response`. Renderer-supplied `switch_session` paths, `export_html.outputPath`, `new_session.parentSession`, direct shell commands, and unsupported `set_label` are rejected.

Unknown renderer command types fail validation before reaching Pi. Unknown Pi events are preserved as bounded records so a newer host degrades visibly rather than crashing.

## Validated event contract

Pi 0.84.4 is validated for agent/turn lifecycle, `message_start` / `message_update` / `message_end`, tool execution start/update/end, auto-compaction and auto-retry lifecycle, `extension_ui_request`, and `entry_appended`. Assistant deltas are keyed by `contentIndex`; partial tool results replace prior snapshots and `message_end` is authoritative. Successful new/fork/clone responses cause canonical state/messages/entries to be fetched again. Pi reserves a new persistent `sessionFile` before the first entry creates its JSONL leaf; Desktop realpaths the existing parent and retains the missing basename without creating or reading the file. Pi 0.84.4 can return `success: true` with `data.cancelled: true`; Desktop treats that as a no-op and preserves generation, identity, transcript, and draft. Correlated responses never appear as runtime events. Unknown event types remain bounded inert records and never execute renderer logic.

Model choices come from `get_available_models`; thinking choices come from `get_available_thinking_levels`. Provider authentication errors are shown without reading credential state. `set_session_name` is the validated Pi 0.84.4 naming operation. Registered session files are referenced through Pi RPC. An arbitrary native selection is passed opaquely to Pi with startup `--fork` in the active project; Desktop does not inspect its header or resume it under a renderer-selected cwd.

## SpecPi commands

The command palette discovers the actual Pi command registry at runtime. It gives first-class access to `/guard`, `/scope`, `/experiment`, `/challenge`, `/harness-improvement`, `/wishlist`, and `/spec`. `/files` opens the native read-only panel because the extension itself rejects RPC mode.

All nested command grammars remain extension-owned. Desktop sends slash commands through Pi exactly as user prompts; it does not duplicate the policy implementation.

## Extension UI

Supported: `select`, `confirm`, `input`, `editor`, `notify`, `setStatus`, `setWidget`, `setTitle`, and `set_editor_text`. Unknown methods display an unsupported dialog and can be cancelled. `ctx.ui.custom()` is a TUI callback protocol and cannot cross JSONL RPC; no parity claim is made.

## Operating systems

CI typechecks, tests, production-builds, performs development and packaged Electron bridge smoke, and creates release artifacts on Ubuntu, Windows, and macOS. Linux CI configures Electron's root-owned mode-4755 sandbox helper explicitly and does not use `--no-sandbox`. Release targets are Windows x64, macOS universal, and Linux x64. Installer signing/notarization is a separate release authorization step.

## Forward-compatibility procedure

1. Test discovery, startup UI, `get_state`, command registry, prompt streaming, tool calls, session switching, compaction, and shutdown against the candidate Pi version.
2. Add fixtures for every changed record shape.
3. Update the validated schema/allowlist and this file.
4. Raise the minimum only when older behavior can no longer degrade safely.
