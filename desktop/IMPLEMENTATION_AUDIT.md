# Desktop implementation audit

This audit maps the production-readiness contract to shipped source and repeatable gates. It does not authorize publication or claim signed installers.

| Requirement | Implementation evidence | Verification gate |
| --- | --- | --- |
| Explicit project and trust selection | Native directory picker, canonical path, three per-launch trust choices in `App.tsx`; mapped to `--approve` / `--no-approve` in `pi-process.ts` | Browser project/trust flow; fake and live RPC tests |
| Compatible Pi discovery and diagnostics | PATH/manual discovery, safe npm-shim resolution, bounded version probe, 0.84.4 floor, explicit newer-version compatibility confirmation, runtime troubleshooting/export view | `runtime-discovery.test.ts`; packaged smoke |
| Supervised strict RPC | LF-only `StringDecoder` framing, 4 MiB limits, 256 pending-request cap, IDs/timeouts, generations, lifecycle phases, bounded stderr, process-tree shutdown | `jsonl.test.ts`; `pi-process.test.ts`; isolated live test |
| Complete transcript and composer | Canonical hydration plus text/thinking/tool streaming, retries/compaction/errors, prompt/steer/follow-up, clear/abort recovery, bounded pasted/attached images, drafts, history recall, tail-aware scrolling, copy controls | `conversation.test.ts`; browser flows |
| Composer command execution | Live `get_commands` discovery merged with native actions; source labels; slash autocomplete; keyboard navigation; SpecPi argument completion; direct extension-command `prompt` routing while streaming; command feedback | `commands.test.ts`; isolated live `/guard` and `/spec` execution; browser composer flow |
| Model and thinking controls | Runtime model list grouped by provider with native type-ahead, actionable auth error, runtime thinking-level list, context/token/cost status | Typecheck/build; browser snapshot |
| Persistent sessions and actions | Searchable sessions with model/time/runtime status; bounded concurrent Pi runtimes with in-window activation while background work continues; Pi-owned rename/compact/fork/clone/tree/export commands; explicit pop-out windows; collapsible navigation and shortcuts; desktop stores references and drafts only | RPC allowlist tests; runtime-pool concurrency and lifecycle regressions; Off-by-default/no-startup-prompt regression; fake/live switch tests; browser search/switch flow; multi-window Electron smoke |
| Extension and SpecPi UI | Composer-level Off/Guard/Strict selector, minimal inline approvals with expandable details, accessible consequential select/confirm/input/editor dialogs, safe unsupported fallback, toasts/history, keyed status/widgets/title/editor draft, keyboard command palette and checked SpecPi completions | Fake RPC test; isolated command discovery; browser protection/approval/palette flow |
| Native Files and Changes | Lazy bounded tree, heavy-directory exclusion, UTF-8/text/binary/image previews, canonical/symlink confinement, fixed-argv Git status/diff, bounded line review comments, no mutations | `file-service.test.ts`; security test; browser desktop/tablet flow |
| Native Spec mode | First-class mid-conversation toggle, immediate focused presentation during active turns, deferred authoritative `/spec` synchronization, reconstructed `spec-mode` entries, focused banner/phases/counters/scope state, collapsed reasoning/tools, held streaming prose, final authoritative message | Conversation unit tests; renderer interaction |
| Renderer security/privacy | Electron sandbox, no Node integration, context isolation, frozen narrow bridge, sender/schema checks, denied permissions/navigation/windows/devtools, strict CSP, sanitization, no credential API, telemetry, listener, or remote service | Source boundary audit; security unit tests; Electron bridge smoke |
| Packaging and documentation | Isolated pinned lockfile, Electron Builder targets/icon/notices/checksums, unsigned labeling, three-platform CI, architecture/security/compatibility/release/rollback docs, root npm tarball isolation | Root `npm run check`; platform CI matrix; local unpacked packaged smoke |

## Required acceptance commands

```bash
npm run check
SPECPI_LIVE_PI=1 npm --prefix desktop test -- --run tests/integration/live-pi.test.ts
npm --prefix desktop run smoke
npm --prefix desktop run package
```

The live test creates a temporary `PI_CODING_AGENT_DIR`, installs repository resources there without external package/tool installation, preserves an authentication canary by metadata, starts `--no-session --offline`, verifies prompt-free Off startup and session replacement, changes Strict/Off without duplicate confirmation UI, executes `/guard` and `/spec` through Pi, and verifies the SpecPi command catalog. Release CI repeats the desktop check, isolated live Pi smoke, Electron bridge smoke, checksummed platform artifact build, and packaged-app launch on Ubuntu, Windows, and macOS. Publishing, signing, notarization, installation, and remote release creation remain separate human-authorized operations.
