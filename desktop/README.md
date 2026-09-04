# SpecPi Desktop

SpecPi Desktop is the local Electron interface for Pi and the SpecPi harness. It supervises `pi --mode rpc`; it does not embed or replace Pi's agent loop. Pi remains authoritative for models, credentials, tools, extensions, and session JSONL. SpecPi's installed extensions remain authoritative for guard, scope, experiment, challenge, wishlist, improvement, and Spec-mode semantics.

## Requirements

- Node.js 22.19 or later
- Pi 0.84.4 or later on `PATH`, or a selected `pi` / `pi.cmd` executable
- A current SpecPi installation for the native command set and prompt-free RPC startup; after updating this repository, run `specpi update` before testing Desktop
- Git is optional; without it the Changes view reports that Git is unavailable

## Development

The desktop dependency graph and release artifact are deliberately separate from the root `specpi` npm package.

```bash
npm --prefix desktop ci
npm --prefix desktop run dev
npm --prefix desktop run check
npm --prefix desktop run smoke
```

`npm run check` at the repository root performs a script-free clean desktop install and runs its typecheck, tests, and production build. The Electron smoke requires lifecycle scripts so Electron's reviewed binary is present.

## Use

1. Open a project directory. Electron main canonicalizes and remembers the selected path; the renderer cannot nominate an arbitrary filesystem root.
2. In the native Electron prompt, choose Pi's trust decision, ignore project resources for this run, or trust them for this run. Trust applies only to the new Pi process, never crosses the preload bridge, and is never persisted. Restarting or opening another process asks again.
3. Desktop starts Command Guard **Off** without an interstitial. Change protection at any time with the compact **Off / Guard / Strict** selector beside Send, or type `/guard`; the selector changes only after the installed `/guard` command emits an authoritative status. It is disabled when Guard is unavailable or locked.
4. Select a model and thinking level, then prompt Pi.
5. Type `/` in the composer to discover and run Pi extension commands, skills, prompt templates, and native desktop actions. Use arrows to navigate, Tab to complete, Enter to run, and Up/Down at an empty prompt to recall composer history. Extension commands execute through Pi's authoritative `prompt` RPC even during an active turn.
6. Use **Spec** in the top bar to enter or leave focused Spec mode at any point. During an active turn the visual mode changes immediately and the authoritative `/spec` state synchronizes as soon as that turn settles.
7. Use **Commands** or Ctrl+K / Ctrl+Shift+P for a searchable keyboard command palette. Commands that require rich TUI rendering use native desktop equivalents where defined.
8. Search sessions by title, model, or path. A fresh session is labeled **New session**, then receives a compact local title from its first meaningful prompt; an explicit Pi session name always takes precedence. Selecting a registered session keeps prior sessions running and swaps the visible workspace in place; status dots show background work. Selecting an arbitrary JSONL file is an explicit **Import session as fork** operation: main gives the opaque selection to Pi with `--fork` in the current project and Desktop never reads the source. Use pop-out controls when a separate window is wanted. `/new` and Ctrl+N start a fresh session in the current window, Ctrl+B collapses the session rail, Ctrl+O opens a project, and Ctrl+L focuses the composer.
9. Use **Files** for read-only, project-root-confined file previews and Git status/diffs.
10. Expand or collapse **Session pulse** for live context, token, cost, model, elapsed-time, message, tool, queue, change, and policy metrics.
11. Use **Runtime** to inspect redacted diagnostics, select a different Pi executable, restart, or stop.

Prompt submissions while Pi is active are explicitly sent as **Steer now** or **Follow up**. Extension commands remain immediate, as required by Pi RPC. Streaming prose and reasoning use the same sanitized Markdown renderer as completed messages; display-only closing delimiters keep common partial constructs stable without changing Pi's content. When Guard or Strict is enabled, approvals use a one-line bar above the composer; details stay collapsed until requested, and deny/once/session/lock remain Command Guard decisions. Image attachments are limited to eight images, 2 MiB per source image, 32 megapixels, 8192 pixels per dimension, and the shared 4 MiB serialized RPC-command ceiling. Failed preflight or writes preserve selected attachments. Drag-and-drop is intentionally not supported.

A normal local RPC startup should complete in roughly a second before session-file parsing costs. If every cold session start takes about 30 seconds, update the installed SpecPi resources: older Command Guard versions opened a blocking `session_start` prompt before Pi's RPC input reader was available and therefore waited for its timeout. Desktop keeps the startup card visible until Pi actually answers RPC; process creation alone is not treated as readiness.

## Packaging

```bash
npm --prefix desktop run package       # unpacked app for this platform
npm --prefix desktop run dist          # unsigned installer artifacts
npm --prefix desktop run dist:win
npm --prefix desktop run dist:mac
npm --prefix desktop run dist:linux
```

Targets are NSIS and a portable executable on Windows, DMG and ZIP on macOS, and AppImage and DEB on Linux. `dist*` writes `dist/CHECKSUMS.sha256` for the resulting release files. Local builds are unsigned and clearly development artifacts. Signing, notarization, publishing, releases, and automatic updates are outside this repository command and require explicit maintainer authorization.

### Release and rollback

Desktop release is manual and separate from npm. After explicit human approval, build each target on its matching CI runner, verify `CHECKSUMS.sha256`, install/launch the artifact with an isolated Pi configuration, complete a startup approval, then uninstall it. Signing and notarization must use protected release credentials and the exact validated files. To roll back, remove the affected installer from distribution, publish no in-place replacement, and prepare a new reviewed version; user Pi sessions and credentials remain untouched because Desktop does not own them.

### Local data and retention

Desktop stores revisioned schema-2 `desktop-state.json` under Electron's per-user application-data directory (`%APPDATA%` on Windows, `~/Library/Application Support` on macOS, and the XDG configuration directory on Linux). It contains project/session path references, bounded first-prompt display titles, and UI preferences—not transcripts, credentials, or trust choices. Main validates complete state, commits collection changes atomically, and broadcasts revisions to every window. Corrupt files are quarantined beside it. Migration from schema 1 removes persisted trust and clears the old Desktop-only session index because its project association cannot be proven without reading Pi JSONL; Pi session files remain untouched and can be imported safely afterward. Uninstallers do not delete Pi state.

## Boundaries and limitations

- No telemetry, listener, remote control, marketplace, auto-update service, embedded terminal, or project editor.
- File previews are text/image only and bounded; SVG is shown as source text rather than active image content.
- Desktop supports Pi's standard RPC extension UI methods. Arbitrary `ctx.ui.custom()` TUI components cannot be represented over the RPC protocol and are reported as unsupported rather than guessed.
- `/files` is replaced by the native Files/Changes panel because the extension is TUI-only. `/spec` keeps SpecPi's command/state semantics and adds native focused presentation.
- Provider authentication remains a Pi CLI responsibility in the MVP. Desktop never reads or writes `auth.json`.
- A window owns a bounded pool of up to 32 supervised Pi runtimes. Session-row navigation activates one runtime without stopping the others; explicit new/import/pop-out actions can still create an independent application window. File and Git calls resolve only the active main-owned project capability. There is no hidden background daemon or listening service, and closing a window stops every runtime it owns.

See [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md), [COMPATIBILITY.md](COMPATIBILITY.md), and the [MVP implementation audit](IMPLEMENTATION_AUDIT.md).
