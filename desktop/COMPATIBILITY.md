# Desktop Compatibility Contract

The validated version is Pi `0.84.4`, matching SpecPi's installer floor. Startup rejects an older, prerelease, or unparseable executable. A newer version is identified as untested and requires explicit confirmation to continue in compatibility mode.

## Required Pi RPC commands

Desktop emits only this reviewed set: `prompt`, `steer`, `follow_up`, `abort`, `new_session`, `get_state`, `get_messages`, `get_session_stats`, `get_available_models`, `set_model`, `cycle_model`, `get_thinking_level`, `set_thinking_level`, `cycle_thinking_level`, `get_available_thinking_levels`, `compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `bash`, `abort_bash`, `get_commands`, `set_session_name`, `export_html`, `switch_session`, `fork`, `get_fork_messages`, `set_label`, `get_last_assistant_text`, and `get_entries`, plus `extension_ui_response`.

Unknown renderer command types fail validation before reaching Pi. Unknown Pi events are preserved as bounded records so a newer host degrades visibly rather than crashing.

## Validated event contract

Pi 0.84.4 is validated for agent/turn lifecycle, `message_start` / `message_update` / `message_end`, tool execution start/update/end, auto-compaction and auto-retry lifecycle, `extension_ui_request`, and `entry_appended`. Assistant deltas are keyed by `contentIndex`; partial tool results replace prior snapshots and `message_end` is authoritative. New/switch/fork/clone responses cause canonical state/messages/entries to be fetched again. Unknown event types remain bounded inert records and never execute renderer logic.

Model choices come from `get_available_models`; thinking choices come from `get_available_thinking_levels`. Provider authentication errors are shown without reading credential state. Session files are only referenced through Pi RPC and native user selection.

## SpecPi commands

The command palette discovers the actual Pi command registry at runtime. It gives first-class access to `/guard`, `/scope`, `/experiment`, `/challenge`, `/harness-improvement`, `/wishlist`, and `/spec`. `/files` opens the native read-only panel because the extension itself rejects RPC mode.

All nested command grammars remain extension-owned. Desktop sends slash commands through Pi exactly as user prompts; it does not duplicate the policy implementation.

## Extension UI

Supported: `select`, `confirm`, `input`, `editor`, `notify`, `setStatus`, `setWidget`, `setTitle`, and `set_editor_text`. Unknown methods display an unsupported dialog and can be cancelled. `ctx.ui.custom()` is a TUI callback protocol and cannot cross JSONL RPC; no parity claim is made.

## Operating systems

CI typechecks, tests, production-builds, performs an Electron bridge smoke, and creates an unpacked application on Ubuntu, Windows, and macOS. Release targets are Windows x64, macOS universal, and Linux x64. Installer signing/notarization is a separate release authorization step.

## Forward-compatibility procedure

1. Test discovery, startup UI, `get_state`, command registry, prompt streaming, tool calls, session switching, compaction, and shutdown against the candidate Pi version.
2. Add fixtures for every changed record shape.
3. Update the validated schema/allowlist and this file.
4. Raise the minimum only when older behavior can no longer degrade safely.
