# Security

## Trust model

ZenPi is configuration and executable extension code for Pi. Pi extensions run with the invoking user's permissions. Clone and review a tagged release before running `./zenpi install` on Unix or `.\zenpi.cmd install` on Windows; avoid piping remote installer content directly into a shell.

The installer:

- prints a plan and requires confirmation unless `--yes` is passed;
- prints exact optional-tool commands, asks about each missing tool interactively, and supports `--skip-tool-install`; `--yes` selects all missing optional tools;
- backs up only resource files it explicitly replaces, never complete settings or shell startup files;
- merges documented settings instead of replacing the complete file;
- modifies AGENTS and shell files only inside marked blocks;
- records checksums and ownership in a private manifest;
- rolls configuration files back when installation fails;
- never reads `auth.json`, provider credentials, sessions, history, or trust decisions, and never persistently copies complete Pi settings or shell startup files;
- never commits, pushes, publishes, or creates remote resources.

The managed browser install is staged before atomic promotion and launch-smoked before use or reuse. A failed install restores the prior runtime and rolls configuration files back. Pinned Pi packages are installed through `pi install`, which installs their declared npm dependencies; the separate browser runtime is installed with `npm ci` from ZenPi's reviewed lockfile. ZenPi does not invoke Playwright `install-deps`; the host must satisfy Playwright's Chromium system requirements. Package installation can leave downloaded npm caches after rollback or uninstall. Those caches are inert when absent from Pi settings.

Optional tools use reviewed versions. Windows bat, git-delta, and glow installs invoke Winget with exact versions; Linux/macOS installs download pinned release archives, verify recorded SHA-256 digests, and atomically publish the executable under ZenPi state. DonSeTch uses pinned global npm. Managed release binaries participate in rollback and are removed by `zenpi uninstall`; Winget and global npm changes remain external system state and are not rolled back or removed. Pi adds the managed bin directory to `PATH` only when every entry is backed by the current manifest and matches its installed checksum; modified tools are moved outside that trusted directory during uninstall. `--skip-tool-install` skips optional tools without disabling the normal Pi-package or browser-runtime installation.

## Website publishing

The `deploy-pages` GitHub Actions workflow publishes only the checked-in `site/` directory. The deploy job retains read-only repository contents access and adds only the `pages: write` and `id-token: write` permissions required by GitHub Pages. The local ZenPi installer does not invoke this workflow or upload local configuration and state.

## Provider isolation

ZenPi enforces native child model inheritance and disables the bundled external Codex CLI runners. This prevents ordinary OpenRouter parent sessions from silently consuming a Codex subscription.

This is a user-settings policy, not an operating-system security boundary. Pi gives trusted project settings higher precedence. A project `.pi/settings.json` can replace model scope or agent overrides. Review trusted project configuration, especially when `defaultProjectTrust` is `always`.

## Local improvement state

Capability-gap collection is disabled until the user makes a one-time local on/off decision. When enabled, ZenPi stores only bounded sanitized summaries plus salted hashes used to count distinct tasks, sessions, and projects. It does not read Pi prompts, source files, sessions, history, credentials, provider state, or trust decisions to construct reports, and it never uploads wishlist state.

Sanitization is defense in depth, not a guarantee that arbitrary plain-language identities can always be recognized. Keep reports general, inspect `/wishlist` before copying any draft, and use `/wishlist off` when local persistence is not appropriate.

Observations and explicit lifecycle/alias decisions are append-only. The generated Markdown report is disposable derived state. Retirement requires an explicit command with validation evidence; reports against retired capabilities are retained as review signals but never reopen or modify anything automatically. Registry validation names resolve only through a closed validator allowlist and are never interpreted as commands.

Confirmed archive/reset prepares a private checksummed snapshot and a recovery transaction before clearing the active queue. If the operation fails after preparation and releases its verified lock, the next locked wishlist operation completes the reset from that snapshot. ZenPi never reclaims an unverified abandoned lock automatically; the existing report explains the required operator check. Collection preference and the private hash salt are intentionally preserved. Wishlist state and archives remain under the ZenPi state directory after uninstall so uninstall cannot silently destroy user evidence; remove them manually only after review.

## Browser isolation

ZenPi launches its managed Chromium in a fresh Playwright context. It does not attach to a running personal browser or load the user's Chrome profile, cookies, saved passwords, or extensions. Browser pages still execute untrusted web content and can reach URLs available to the host. Treat screenshots, page text, downloads, console output, and explicit visual baselines as potentially sensitive artifacts. Default screenshots stay under the private ZenPi state directory; inspect before sharing. Baseline replacement requires an explicit tool argument.

The browser is not an operating-system sandbox. Pi and its extensions already run with user permissions. Browser snapshots, viewports, screenshot dimensions, PNG input sizes, and inline images are bounded to limit resource use. Explicit outputs are published atomically and are not replaced without `overwrite=true`; comparison rejects aliased baseline/current/diff paths. Use containers or stronger host isolation for hostile applications, and use dedicated test accounts rather than personal authenticated sessions.

## External tools

- The managed browser runtime contains pinned Playwright, Chromium, pixelmatch, and pngjs components. It is private to ZenPi and is removed on uninstall; browser artifacts are preserved.
- `@tmustier/pi-files-widget` invokes Git, bat, delta, and glow. Avoid hostile filenames and unreviewed repositories.
- DonSeTch is optional and licensed separately. When selected, ZenPi installs pinned `donsetch@3.4.0` globally through npm; its package installation downloads and verifies the platform binary.
- Shell profiles are convenience wrappers, not sandboxes.

## Reporting issues

Report vulnerabilities through [GitHub private security advisories](https://github.com/TannerMidd/ZenPi/security/advisories/new). Do not disclose unpatched vulnerabilities in public issues.
