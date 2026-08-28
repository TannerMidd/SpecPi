# Security

## Trust model

ZenPi is configuration and executable extension code for Pi. Pi extensions run with the invoking user's permissions. Clone and review a tagged release before running `./zenpi install`; avoid piping remote installer content directly into a shell.

The installer:

- prints a plan and requires confirmation unless `--yes` is passed;
- backs up only resource files it explicitly replaces, never complete settings or shell startup files;
- merges documented settings instead of replacing the complete file;
- modifies AGENTS and shell files only inside marked blocks;
- records checksums and ownership in a private manifest;
- rolls configuration files back when installation fails;
- never reads `auth.json`, provider credentials, sessions, history, or trust decisions, and never persistently copies complete Pi settings or shell startup files;
- never commits, pushes, publishes, or creates remote resources.

The managed browser install is staged before atomic promotion and launch-smoked before use or reuse. A failed install restores the prior runtime and rolls configuration files back. ZenPi does not invoke `sudo`, `apt`, or Playwright `install-deps`; the host must satisfy Playwright's Chromium system requirements. Package installation can leave downloaded npm caches after rollback or uninstall. Those caches are inert when absent from Pi settings.

## Website publishing

The `deploy-pages` GitHub Actions workflow publishes only the checked-in `site/` directory. The deploy job retains read-only repository contents access and adds only the `pages: write` and `id-token: write` permissions required by GitHub Pages. The local ZenPi installer does not invoke this workflow or upload local configuration and state.

## Provider isolation

ZenPi enforces native child model inheritance and disables the bundled external Codex CLI runners. This prevents ordinary OpenRouter parent sessions from silently consuming a Codex subscription.

This is a user-settings policy, not an operating-system security boundary. Pi gives trusted project settings higher precedence. A project `.pi/settings.json` can replace model scope or agent overrides. Review trusted project configuration, especially when `defaultProjectTrust` is `always`.

## Browser isolation

ZenPi launches its managed Chromium in a fresh Playwright context. It does not attach to a running personal browser or load the user's Chrome profile, cookies, saved passwords, or extensions. Browser pages still execute untrusted web content and can reach URLs available to the host. Treat screenshots, page text, downloads, console output, and explicit visual baselines as potentially sensitive artifacts. Default screenshots stay under the private ZenPi state directory; inspect before sharing. Baseline replacement requires an explicit tool argument.

The browser is not an operating-system sandbox. Pi and its extensions already run with user permissions. Browser snapshots, viewports, screenshot dimensions, PNG input sizes, and inline images are bounded to limit resource use. Explicit outputs are published atomically and are not replaced without `overwrite=true`; comparison rejects aliased baseline/current/diff paths. Use containers or stronger host isolation for hostile applications, and use dedicated test accounts rather than personal authenticated sessions.

## External tools

- The managed browser runtime contains pinned Playwright, Chromium, pixelmatch, and pngjs components. It is private to ZenPi and is removed on uninstall; browser artifacts are preserved.
- `@tmustier/pi-files-widget` invokes Git, bat, delta, and glow. Avoid hostile filenames and unreviewed repositories.
- DonSeTch is optional and licensed separately. ZenPi never installs its global executable.
- Shell profiles are convenience wrappers, not sandboxes.

## Reporting issues

Report vulnerabilities through [GitHub private security advisories](https://github.com/TannerMidd/ZenPi/security/advisories/new). Do not disclose unpatched vulnerabilities in public issues.
