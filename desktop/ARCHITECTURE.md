# SpecPi Desktop Architecture

## Process model

```text
sandboxed React renderer
        │ frozen, typed contextBridge API
        ▼
Electron main process ── spawn without shell ──► bounded pool of pi --mode rpc processes
        │                                      stdin/stdout JSONL
        ├── bounded project file previews
        ├── bounded git status/diff reads
        └── atomic desktop-only preferences
```

The main process owns a bounded pool of up to 32 `PiProcess` instances per `BrowserWindow`. Selecting a session activates its existing process—or starts one when needed—without stopping work in the previously visible session. Only the active process projects transcript and extension events into the renderer; a bounded runtime roster keeps background session status visible, and canonical state is rehydrated whenever a session becomes visible again. Explicit pop-out controls can still create independent windows. Diagnostics, pending extension UI, exports, lifecycle events, and shutdown remain isolated to their owning process and sender window, and closing a window stops every process in its pool. View generations reject stale events across process activation. Requests have unique IDs, explicit allowlisting, bounded validation, and timeouts. A spawned child remains in `starting` until Pi answers a readiness RPC (or exposes a blocking user request), so the renderer does not confuse OS process creation with an initialized session. Stdout is decoded as strict LF-delimited UTF-8 JSONL; stderr is bounded diagnostic data and never interpreted as protocol. Process exits reject outstanding requests and clear pending UI.

## Authority

- **Pi:** agent lifecycle, transcript events, models, thinking, tools, extensions, credentials, session branching/compaction, and session persistence.
- **SpecPi extensions:** command guard and workflow semantics.
- **Desktop:** window/layout preferences, remembered project display records, RPC supervision, safe visual projection, and read-only project/Git inspection.

The desktop state file is atomically replaced in Electron's `userData` directory. It stores paths and UI preferences, never provider secrets or Pi session bodies. Pi session paths are references only.

## Renderer projection

The renderer reduces Pi events into a view model. `message_update` streams assistant text, reasoning, and tool deltas. `message_end`, `tool_execution_start/update/end`, `auto_compaction_*`, retry events, and custom entries remain distinct transcript records. On session load or tree changes, canonical messages and custom entries are fetched from Pi again.

The renderer keeps at most 10,000 projected transcript items and batches message deltas to one animation frame; canonical Pi messages remain on disk under Pi ownership. Incomplete text is displayed as inert plain text until Pi emits the authoritative final message, tool-call argument deltas are never rendered, and running tool output stays behind a compact collapsed activity card. Startup is expected to show the packaged shell within 5 seconds on supported development hardware, while Pi discovery has its own 10-second hard timeout. RPC records are capped at 4 MiB, previews at 512 KiB of text or 10 MiB per reviewed image, attachments at eight 10 MiB images with 32-megapixel/8192-pixel dimension caps, and diagnostics at 200 records of 8 KiB each.

Markdown is parsed without raw HTML and sanitized with DOMPurify. External links are intercepted and delegated to a validated main-process opener. Tool content is rendered as inert text or bounded structured summaries, never executable HTML.

## Native adaptations

Pi extension dialogs map to React dialogs for `select`, `confirm`, `input`, and `editor`. When protection is enabled, routine Command Guard approvals are a one-line, non-modal composer bar with collapsed structured details (severity, category, cwd, target, reason, and safer alternative); the transcript remains inspectable while Pi waits. Notifications, status, widget, title, and editor-text requests update deterministic UI surfaces. Cancellation is returned explicitly when possible. Unsupported custom TUI requests remain visible as unsupported and are never auto-approved.

The composer merges live `get_commands` discovery with native desktop actions. A leading slash opens source-labeled autocomplete and known SpecPi argument completions. Native commands are routed to allowlisted RPC/UI actions; Pi extension commands are always sent as `prompt`, including during streaming, while skills, templates, and ordinary prompts preserve the selected steer/follow-up queue policy. Pi therefore remains the command parser and extension authority.

Desktop marks its owned RPC child with `SPECPI_DESKTOP=1`. Current Command Guard recognizes that host to start Off without opening a blocking selector on every `session_start` and to treat the composer's explicit Off/Guard/Strict selection as the confirmation. Other RPC hosts start in the fail-closed Guard default without a startup prompt. This is required because Pi binds extensions before attaching its RPC stdin reader: a blocking `session_start` prompt cannot consume a host response and waits for its timeout. Older installed Command Guard versions must be updated; the supervisor's narrowly matched legacy response remains defense in depth but cannot bypass that Pi startup ordering. The choice is session-scoped; enabling Guard or Strict restores the unchanged policy. TUI retains its recommended Guard startup interaction.

The native Files panel exists because SpecPi `/files` requires interactive TUI mode. Its APIs resolve and realpath every target under the selected project root, reject symlink escapes, apply size/count limits, and never mutate project files. Git runs with argument arrays and `shell: false`.

## Reuse and provenance audit

The following upstream snapshots were reviewed on 2026-09-03. They were architecture references only; no source, assets, generated files, or dependency graph were copied.

| Project                                                                                    | Reviewed commit                            | License                            | Accepted ideas                                                                                           | Rejected scope                                                          |
| ------------------------------------------------------------------------------------------ | ------------------------------------------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [Ninthless/Tau](https://github.com/Ninthless/Tau)                                          | `251d2a24de9942e23c565d3728941c8fb9f6bf1e` | MIT                                | Electron/RPC ownership and extension dialog feasibility                                                  | Pi auth/config writes and package marketplace                           |
| [Pi Desktop](https://github.com/chadCool/pi-desktop) (repository redirects upstream)       | `5d698433864fbebafa24e141da0ea56297766cfe` | MIT                                | Extension-first host boundary and generation-safe sessions                                               | Tauri stack, terminal, package/update management, auth watching         |
| [nonlooped/nativepi](https://github.com/nonlooped/nativepi)                                | `f4eb1e0233cddc71522339de3d3f6f13c5052379` | MIT                                | Graphical extension boundary, supervised Pi process, searchable session workbench, composer autocomplete | Local/remote servers, terminal, Git mutation, bundled Pi, updates       |
| [StarkInternationalAI/pi-desktop](https://github.com/StarkInternationalAI/pi-desktop)      | public snapshot reviewed                   | MIT                                | Source-aware slash discovery, composer keyboard completion, session outlines                             | Tauri stack and copied implementation material                          |
| [OpenAI Codex app](https://developers.openai.com/codex/app/commands/)                      | public product documentation               | Proprietary                        | Searchable command menu, keyboard-first navigation, composer history                                     | Product code and cloud-specific behavior                                |
| [VS Code agent sessions](https://code.visualstudio.com/docs/copilot/agents/agent-sessions) | public product documentation               | Proprietary                        | Searchable session hub, visible status/change metadata, parallel-session switching                       | Editor-specific orchestration and cloud sessions                        |
| [VS Code agent permissions](https://code.visualstudio.com/docs/copilot/agents/agent-tools) | public product documentation               | Proprietary                        | Inline explicit approvals and reusable narrowly scoped choices                                           | VS Code's policy implementation                                         |
| [getpaseo/paseo](https://github.com/getpaseo/paseo)                                        | `eb753813a198958dcf75a08d65b71b77c60ffdd7` | Apache-2.0 plus component licenses | Cross-platform agent UI risk comparison                                                                  | Daemon, listening network service, remote/mobile control, orchestration |

The implementation instead uses Pi's documented public RPC contract and Electron's documented security model. The review specifically excluded telemetry, remote control, listening servers, automatic updates, terminals, package marketplaces, project mutation, and unrelated orchestration. Since no upstream application material was adopted, no copied-file attribution is required.
