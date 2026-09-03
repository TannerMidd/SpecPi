# SpecPi Desktop

SpecPi Desktop is the local Electron interface for Pi and the SpecPi harness. It supervises `pi --mode rpc`; it does not embed, fork, or replace Pi's agent loop. Pi remains authoritative for models, credentials, tools, extensions, and session JSONL. SpecPi's installed extensions remain authoritative for guard, scope, experiment, challenge, wishlist, improvement, and Spec-mode semantics.

## Requirements

- Node.js 22.19 or later
- Pi 0.84.4 or later on `PATH`, or a selected `pi` / `pi.cmd` executable
- An installed SpecPi environment for the native SpecPi command set
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

1. Open a project directory.
2. Choose Pi's trust decision, ignore project resources for this run, or trust them for this run. Trust is always explicit and session-scoped in Desktop.
3. Complete startup dialogs, including SpecPi Command Guard.
4. Select a model and thinking level, then prompt Pi.
5. Use **Commands** for Pi/SpecPi commands. Commands that require rich TUI rendering use native desktop equivalents where defined.
6. Use **Files** for read-only, project-root-confined file previews and Git status/diffs.
7. Use **Runtime** to inspect redacted diagnostics, select a different Pi executable, restart, or stop.

Prompt submissions while Pi is active are explicitly sent as **Steer now** or **Follow up**. Queued input remains in the composer until Pi accepts it. Image attachments are bounded and sent as Pi RPC image content. Drag-and-drop is intentionally not supported.

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

Desktop stores `desktop-state.json` under Electron's per-user application-data directory (`%APPDATA%` on Windows, `~/Library/Application Support` on macOS, and the XDG configuration directory on Linux). It contains project/session path references and UI preferences, not transcripts or credentials. Corrupt files are quarantined beside it. Uninstallers do not delete Pi state; remove the Desktop application-data directory separately only when those local references should also be forgotten.

## Boundaries and limitations

- No telemetry, listener, remote control, marketplace, auto-update service, embedded terminal, or project editor.
- File previews are text/image only and bounded; SVG is shown as source text rather than active image content.
- Desktop supports Pi's standard RPC extension UI methods. Arbitrary `ctx.ui.custom()` TUI components cannot be represented over the RPC protocol and are reported as unsupported rather than guessed.
- `/files` is replaced by the native Files/Changes panel because the extension is TUI-only. `/spec` keeps SpecPi's command/state semantics and adds native focused presentation.
- Provider authentication remains a Pi CLI responsibility in the MVP. Desktop never reads or writes `auth.json`.
- A window owns one Pi runtime. Additional windows may run independent runtimes; there is no hidden background daemon.

See [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md), [COMPATIBILITY.md](COMPATIBILITY.md), and the [MVP implementation audit](IMPLEMENTATION_AUDIT.md).
