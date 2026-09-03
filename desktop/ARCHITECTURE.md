# SpecPi Desktop Architecture

## Process model

```text
sandboxed React renderer
        │ frozen, typed contextBridge API
        ▼
Electron main process ── spawn without shell ──► pi --mode rpc
        │                                      stdin/stdout JSONL
        ├── bounded project file previews
        ├── bounded git status/diff reads
        └── atomic desktop-only preferences
```

The main process owns exactly one `PiProcess` per BrowserWindow in the MVP. Runtime generations identify stale events after restart. Requests have unique IDs, explicit allowlisting, bounded validation, and timeouts. Stdout is decoded as strict LF-delimited UTF-8 JSONL; stderr is bounded diagnostic data and never interpreted as protocol. Process exits reject outstanding requests and clear pending UI.

## Authority

- **Pi:** agent lifecycle, transcript events, models, thinking, tools, extensions, credentials, session branching/compaction, and session persistence.
- **SpecPi extensions:** command guard and workflow semantics.
- **Desktop:** window/layout preferences, remembered project display records, RPC supervision, safe visual projection, and read-only project/Git inspection.

The desktop state file is atomically replaced in Electron's `userData` directory. It stores paths and UI preferences, never provider secrets or Pi session bodies. Pi session paths are references only.

## Renderer projection

The renderer reduces Pi events into a view model. `message_update` streams assistant text, reasoning, and tool deltas. `message_end`, `tool_execution_start/update/end`, `auto_compaction_*`, retry events, and custom entries remain distinct transcript records. On session load or tree changes, canonical messages and custom entries are fetched from Pi again.

The renderer keeps at most 10,000 projected transcript items and batches message deltas to one animation frame; canonical Pi messages remain on disk under Pi ownership. Startup is expected to show the packaged shell within 5 seconds on supported development hardware, while Pi discovery has its own 10-second hard timeout. RPC records are capped at 4 MiB, previews at 512 KiB of text or 10 MiB per reviewed image, attachments at eight 10 MiB images with 32-megapixel/8192-pixel dimension caps, and diagnostics at 200 records of 8 KiB each.

Markdown is parsed without raw HTML and sanitized with DOMPurify. External links are intercepted and delegated to a validated main-process opener. Tool content is rendered as inert text or bounded structured summaries, never executable HTML.

## Native adaptations

Pi extension dialogs map to React dialogs for `select`, `confirm`, `input`, and `editor`. Notifications, status, widget, title, and editor-text requests update deterministic UI surfaces. Cancellation is returned explicitly when possible. Unsupported custom TUI requests remain visible as unsupported and are never auto-approved.

The native Files panel exists because SpecPi `/files` requires interactive TUI mode. Its APIs resolve and realpath every target under the selected project root, reject symlink escapes, apply size/count limits, and never mutate project files. Git runs with argument arrays and `shell: false`.

## Reuse and provenance audit

The following upstream snapshots were reviewed on 2026-09-03. They were architecture references only; no source, assets, generated files, or dependency graph were copied.

| Project | Reviewed commit | License | Accepted ideas | Rejected scope |
| --- | --- | --- | --- | --- |
| [Ninthless/Tau](https://github.com/Ninthless/Tau) | `251d2a24de9942e23c565d3728941c8fb9f6bf1e` | MIT | Electron/RPC ownership and extension dialog feasibility | Pi auth/config writes and package marketplace |
| [Pi Desktop](https://github.com/chadCool/pi-desktop) (repository redirects upstream) | `5d698433864fbebafa24e141da0ea56297766cfe` | MIT | Extension-first host boundary and generation-safe sessions | Tauri stack, terminal, package/update management, auth watching |
| [nonlooped/nativepi](https://github.com/nonlooped/nativepi) | `f4eb1e0233cddc71522339de3d3f6f13c5052379` | MIT | Graphical extension boundary and supervised Pi process | Local/remote servers, terminal, Git mutation, bundled Pi, updates |
| [getpaseo/paseo](https://github.com/getpaseo/paseo) | `eb753813a198958dcf75a08d65b71b77c60ffdd7` | Apache-2.0 plus component licenses | Cross-platform agent UI risk comparison | Daemon, listening network service, remote/mobile control, orchestration |

The implementation instead uses Pi's documented public RPC contract and Electron's documented security model. The review specifically excluded telemetry, remote control, listening servers, automatic updates, terminals, package marketplaces, project mutation, and unrelated orchestration. Since no upstream application material was adopted, no copied-file attribution is required.
