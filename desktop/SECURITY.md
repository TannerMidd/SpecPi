# SpecPi Desktop Security

This document supplements the repository [security model](../SECURITY_MODEL.md).

## Renderer boundary

Every application window uses `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, a narrow preload bridge, denied permission requests, disabled navigation, and rejected window creation. The production Content Security Policy permits only packaged local scripts and images (`self`, bounded `data:`, and `blob:` images). There is no listening server.

The renderer receives named methods, not raw `ipcRenderer`. Main-process handlers validate arguments with Zod, cap payloads, verify the sender belongs to an application window, and expose only reviewed operations. RPC commands use a strict allowlist.

## Data handling

Desktop never reads, copies, logs, exports, or modifies Pi authentication, trust, history, mission, or session storage directly. It asks Pi for transcript/session data over RPC. Desktop preferences hold paths and display metadata only and are atomically written with user-only permissions where the platform supports them.

Diagnostics redact credential-like environment names, bearer tokens, URL userinfo/query/fragment data, and home-directory prefixes. They include only bounded recent stderr. Export requires a native save dialog. External links require `https:` and omit credentials.

## Files and subprocesses

Pi and Git are spawned directly with argument arrays and `shell: false`. Windows npm shims are resolved to reviewed package entry points before launch. Pi receives an explicit project cwd. Shutdown closes stdin, waits briefly, then terminates the owned process tree.

File operations are read-only, project-root-confined, symlink-aware, and bounded by entry count, file size, and preview type. Active SVG/HTML is never rendered from project files. Images are returned as bounded data URLs.

## Command Guard

Desktop does not reimplement or bypass Command Guard. Startup approval requests block interaction and are shown natively; tool calls still execute inside Pi, where the installed extension applies its policy. Unsupported extension UI is never auto-approved.

## Residual boundary

A trusted Pi extension or approved tool executes with the user's OS authority. Electron sandboxing does not sandbox Pi. Use containers, VMs, restricted OS accounts, or other operating-system isolation for hostile code. Trust project resources only after review. Local unsigned packages are development artifacts, not authenticated releases.
