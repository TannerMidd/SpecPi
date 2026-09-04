# SpecPi Desktop Security

This document supplements the repository [security model](../SECURITY_MODEL.md).

## Renderer boundary

Every application window uses `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, a narrow preload bridge, denied permission requests, disabled navigation, and rejected window creation. Packaged builds always load the packaged renderer file and ignore `ELECTRON_RENDERER_URL`. Development accepts only unauthenticated loopback HTTP(S) origins. Every IPC invocation must come from the owning main frame at its recorded file URL or development origin. The production Content Security Policy permits only packaged local scripts and images (`self`, bounded `data:`, and `blob:` images). There is no listening server.

The renderer receives named methods, not raw `ipcRenderer`. Main-process handlers validate arguments with Zod, cap payloads, verify sender and origin, and expose only reviewed operations. RPC commands use a strict allowlist that rejects unknown fields. Renderer workspace requests contain opaque project/session/import IDs rather than roots, session files, executables, or trust values. Main resolves those capabilities from validated state and native picker results. Pi versions newer than the validated floor require a main-owned native compatibility confirmation before spawn; the renderer cannot authorize compatibility mode. File and Git calls accept only relative paths and use the window's active main-owned project.

## Data handling

Desktop never reads, copies, logs, exports, or modifies Pi authentication, trust, history, mission, or session storage directly. It asks Pi for transcript/session data over RPC. Native selection of an arbitrary session creates a short-lived, single-window capability that main hands to Pi with `--fork` in the already active target project; Desktop does not read the JSONL. Direct resume accepts only a main-registered session belonging to that project.

Revisioned desktop preferences hold canonical path references and bounded display metadata only. Existing session leaves are fully realpathed. Pi may reserve a session filename before creating it; for that missing leaf only, main realpaths the existing parent, rejects any existing unresolved leaf, and stores the basename without creating or reading Pi storage. Complete nested state is validated, collection mutations are atomic in main, and committed revisions are broadcast to every window. Trust is absent from the schema. Migration removes legacy trust and unverified Desktop session associations without touching Pi storage. Files are atomically written with user-only permissions where the platform supports them.

Diagnostics redact credential-like environment names, bearer tokens, URL userinfo/query/fragment data, and home-directory prefixes. They include only bounded recent stderr. Export requires a native save dialog. External links require `https:` and omit credentials.

## Files and subprocesses

Pi and Git are spawned directly with argument arrays and `shell: false`. Windows npm shims are resolved to reviewed package entry points before launch. Each Pi process receives a main-resolved canonical project cwd, and each window's runtime pool is capped at 32 processes. A native main-process dialog obtains the trust choice for each new Pi process; the value exists only in the internal launch object and is never sent to or accepted from the renderer. Runtime commands, extension responses, diagnostics, and export authorization are routed only to the currently visible process; background processes can continue work but cannot project events into another session's view.

Start attempts and child callbacks carry explicit identities. Stop invalidates discovery/probe before spawn, terminates the exact process tree, and rejects pending work. Delayed output, error, or exit from an older child cannot mutate its replacement. Correlated RPC responses stay on the request channel. Window shutdown closes and terminates every owned process tree.

File operations are read-only, project-root-confined, symlink-aware, and bounded by entry count, file size, and preview type. Active SVG/HTML is never rendered from project files. Images are returned as bounded data URLs.

## Command Guard

Desktop does not reimplement Command Guard policy. Its owned RPC child is marked with `SPECPI_DESKTOP=1`, allowing the current installed extension to start **Off** without a blocking startup prompt on each session switch. All RPC hosts avoid blocking `session_start` prompts because Pi attaches its RPC input reader only after extension binding; non-Desktop RPC defaults to Guard. The supervisor's narrowly matched legacy startup response remains compatibility defense in depth, but older installed Command Guard versions still require an explicit SpecPi update because that response cannot be consumed before Pi's legacy startup timeout. It never matches tool approvals. A compact Off/Guard/Strict selector beside Send is enabled only when Pi reports the `guard` command and an authoritative `specpi-command-guard` status. Requested changes remain pending until the matching status event arrives; absence, mismatch, lock, failure, or timeout cannot produce a protected-state claim. The choice is session-scoped and Desktop never persists it.

When Guard or Strict is enabled, command and path decisions still execute inside Pi, where the installed extension applies unchanged policy. Desktop projects approval requests as a minimal inline bar with expandable context. The extension-provided deny, allow-once, exact-call-for-session, and lock values are returned unchanged. Critical unlocks and other consequential extension input remain native dialogs. Unsupported extension UI is never auto-approved.

## Residual boundary

A trusted Pi extension or approved tool executes with the user's OS authority. Electron sandboxing does not sandbox Pi. Use containers, VMs, restricted OS accounts, or other operating-system isolation for hostile code. Trust project resources only after review. Local unsigned packages are development artifacts, not authenticated releases.
