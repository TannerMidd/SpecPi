# Security

## Trust model

ZenPi is configuration and executable extension code for Pi. Pi extensions run with the invoking user's permissions. Clone and review a tagged release before running `./zenpi install` on Unix or `.\zenpi.cmd install` on Windows; avoid piping remote installer content directly into a shell.

The installer:

- prints a plan and requires confirmation unless `--yes` is passed;
- prints the exact pinned Pi bootstrap package when Pi is missing, installs it only after confirmation, and supports `--skip-package-install`;
- prints the exact optional DonSeTch install command, asks before running it interactively, and supports `--skip-tool-install`; `--yes` selects it when missing;
- backs up only resource files it explicitly replaces and bounded `/zen-subagents` leaves, never complete settings or shell startup files;
- merges documented settings and subagent runtime-config paths instead of replacing complete files;
- modifies AGENTS and shell files only inside marked blocks;
- records checksums and ownership in a private manifest;
- rolls configuration files back when installation fails;
- never reads `auth.json`, provider credentials, sessions, history, or trust decisions, and never persistently copies complete Pi settings or shell startup files;
- never commits, pushes, publishes, or creates remote resources.

When `pi` is absent, the confirmed installer globally installs pinned `@earendil-works/pi-coding-agent@0.84.4` through npm with lifecycle scripts disabled. This is external system state: a failed later step does not remove it, and ZenPi uninstall preserves it. Existing Pi installations must satisfy the minimum version and are not replaced automatically. If npm installs Pi outside the persistent `PATH`, ZenPi reports the exact global executable directory and fails rather than completing with a process-local path that later shells cannot use. The managed browser install is staged before atomic promotion and launch-smoked before use or reuse. A failed install restores the prior runtime and rolls configuration files back. Pinned Pi packages are installed through `pi install`, which installs their declared npm dependencies; the separate browser runtime is installed with `npm ci` from ZenPi's reviewed lockfile. ZenPi does not invoke Playwright `install-deps`; the host must satisfy Playwright's Chromium system requirements. Package installation can leave downloaded npm caches after rollback or uninstall. Those caches are inert when absent from Pi settings.

The optional DonSeTch tool uses pinned global npm and remains external system state, so ZenPi cannot roll it back or remove it. Updates retire legacy ZenPi-managed bat, git-delta, and glow binaries; modified legacy binaries are moved outside the trusted managed `PATH` before their manifest records are removed. `--skip-tool-install` skips DonSeTch without disabling the normal Pi-package or browser-runtime installation.

## Website publishing

The `deploy-pages` GitHub Actions workflow publishes only the checked-in `site/` directory. The deploy job retains read-only repository contents access and adds only the `pages: write` and `id-token: write` permissions required by GitHub Pages. The local ZenPi installer does not invoke this workflow or upload local configuration and state.

## Provider isolation

ZenPi allows native child models to differ only within the parent session's exact Pi provider and disables the bundled external Codex CLI runners. `openai`, `openai-codex`, OpenRouter, and other routes are distinct boundaries even when they expose similarly named models.

The `/zen-subagents` wrapper filters model choices by exact provider and restores that provider's saved role profile and strict `modelScope` on session start and model selection. A changed startup-loaded mapping prompts the user to run Pi's documented `/reload` command; guarded launches fail closed until runtime, mirror, profile, and lease state are aligned. Profiles for `openai`, `openai-codex`, and other exact IDs never merge. An unavailable saved model remains stored and stale rather than being silently replaced. Live processes using different providers fail closed through ephemeral leases instead of racing the shared mirror.

This remains configuration policy, not an operating-system security boundary. Pi gives trusted project settings higher precedence. ZenPi mirrors `pi-subagents` nearest/git-root discovery for the launch `cwd`; when the effective project `.pi/settings.json` replaces the managed scope with an unsafe policy, ZenPi blocks the native `subagent` tool launch and reports the file. File-authored workflows and inline scripts containing a literal child `cwd` are blocked because their child projects cannot be verified before script evaluation. Inline workflow JavaScript can dynamically construct child options; that executable user-authored code, direct user slash-command administration, manually edited package configuration, and other trusted extensions remain user-controlled boundaries ZenPi does not claim to sandbox.

## Local improvement state

Capability-gap collection is disabled until the user makes a one-time local on/off decision. When enabled, ZenPi stores only bounded sanitized summaries plus salted hashes used to count distinct tasks, sessions, and projects. It does not read Pi prompts, source files, sessions, history, credentials, provider authentication state, or trust decisions to construct reports, and it never uploads wishlist state. `/zen-subagents` reads public active provider/model identifiers and available scoped model metadata. Its private `zenpi/subagent-provider-profiles.json` stores only schema metadata, exact provider/model IDs, thinking levels, and timestamps—not credentials, authentication data, prompts, sessions, history, or complete settings. Profiles survive uninstall; stop Pi and manually remove that file to purge them. The ephemeral lease file contains only random tokens, PIDs, exact providers, and timestamps and is excluded from backups.

Sanitization is defense in depth, not a guarantee that arbitrary plain-language identities can always be recognized. Keep reports general, inspect `/wishlist` before copying any draft, and use `/wishlist off` when local persistence is not appropriate.

Observations and lifecycle/alias decisions are append-only. The generated Markdown report is disposable derived state. `/harness-improvement` requires one explicit menu choice for one exact item, records selection, and starts the implementation turn; evidence alone never starts work. Its completion tool is session-bound to that choice, requires source-registry integration, runs the fixed repository check and supported closed validators, and records retirement only after every gate passes. Failed gates leave the item selected. Reports against retired capabilities remain review signals and return to the menu without starting work themselves. Registry validation names resolve only through a closed validator allowlist and are never interpreted as commands.

Confirmed archive/reset prepares a private checksummed snapshot and a recovery transaction before clearing the active queue. If the operation fails after preparation and releases its verified lock, the next locked wishlist operation completes the reset from that snapshot. ZenPi never reclaims an unverified abandoned lock automatically; the existing report explains the required operator check. Collection preference and the private hash salt are intentionally preserved. Wishlist state and archives remain under the ZenPi state directory after uninstall so uninstall cannot silently destroy user evidence; remove them manually only after review.

## Browser isolation

ZenPi launches its managed Chromium in a fresh Playwright context. It does not attach to a running personal browser or load the user's Chrome profile, cookies, saved passwords, or extensions. Browser pages still execute untrusted web content and can reach URLs available to the host. Treat screenshots, page text, downloads, console output, and explicit visual baselines as potentially sensitive artifacts. Default screenshots stay under the private ZenPi state directory; inspect before sharing. Baseline replacement requires an explicit tool argument.

The browser is not an operating-system sandbox. Pi and its extensions already run with user permissions. Browser snapshots, viewports, screenshot dimensions, PNG input sizes, and inline images are bounded to limit resource use. Explicit outputs are published atomically and are not replaced without `overwrite=true`; comparison rejects aliased baseline/current/diff paths. Use containers or stronger host isolation for hostile applications, and use dedicated test accounts rather than personal authenticated sessions.

## External tools

- The managed browser runtime contains pinned Playwright, Chromium, pixelmatch, and pngjs components. It is private to ZenPi and is removed on uninstall; browser artifacts are preserved.
- The in-house `/files` extension reads project files and invokes Git without a shell for repository discovery, status, and diffs. It bounds file count, file size, and review excerpts; rejects symbolic links and binary content; sanitizes terminal control characters; and does not modify files.
- The in-house `/zen-subagents` wrapper uses only documented `settings.json` subagent leaves and `extensions/subagent/config.json` capacity leaves, with a ZenPi-owned provider profile source of truth and ephemeral leases under `zenpi/`. Profile, active mirror, and explicitly edited global capacity form one logical transaction with same-process rollback. It rejects symlinked targets/parents, shares the installer lock, preserves unrelated fields, and retains at most five private controlled-leaf backups containing no leases or complete settings.
- DonSeTch is optional and licensed separately. When selected, ZenPi installs pinned `donsetch@3.4.0` globally through npm; its package installation downloads and verifies the platform binary.
- Shell profiles are convenience wrappers, not sandboxes.

## Reporting issues

Report vulnerabilities through [GitHub private security advisories](https://github.com/TannerMidd/ZenPi/security/advisories/new). Do not disclose unpatched vulnerabilities in public issues.
