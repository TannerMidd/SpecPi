# Third-party components

When Pi is absent, ZenPi can install the reviewed `@earendil-works/pi-coding-agent@0.84.4` npm package globally after confirmation. The package provides the `pi` executable, is installed with lifecycle scripts disabled, retains its upstream license, and remains external system state after ZenPi uninstall.

ZenPi pins but does not vendor these Pi packages:

- `pi-web-access@0.25.0`
- `pi-subagents@0.58.0`
- `@juicesharp/rpiv-ask-user-question@2.7.1`
- `@llblab/pi-codex-usage@0.9.3`
- `@tunnckocore/pi-gpt-fast-mode@0.4.0`
- `@narumitw/pi-goal@0.54.3`

They retain their own copyright and license terms. Pi downloads them from npm when the installer runs `pi install`. ZenPi's `/zen-subagents` command is a configuration wrapper around the documented `pi-subagents` settings and runtime config. The command guard also calls the package's public `pi-subagents/preflight` export to verify the exact native-child extension plan before dispatch; its installed `jiti` dependency loads that public TypeScript entry. ZenPi pins the accepted preflight contract to `pi-subagents@0.58.0` and fails closed on load or version mismatch. ZenPi does not patch, fork, vendor, or use unsupported deep imports from that package.

ZenPi also installs these exact browser-runtime packages from the reviewed `browser-runtime/package-lock.json`:

- `playwright@1.62.1` and `playwright-core@1.62.1` — Apache-2.0
- `pixelmatch@7.2.0` — ISC
- `pngjs@7.0.0` — MIT
- optional `fsevents@2.3.2` on macOS — MIT

Playwright downloads its matching Chromium build into ZenPi's private runtime directory. Chromium retains its upstream BSD and third-party component licenses. None of these executables are installed globally.

Repository development uses these exact, project-local formatting and linting packages:

- `prettier@3.9.6` — MIT
- `eslint@10.9.1` — MIT
- `@stylistic/eslint-plugin@5.10.0` — MIT
- `@typescript-eslint/parser@8.68.0` — MIT
- `typescript@6.0.3` — Apache-2.0

They are development-only dependencies, are not shipped by the ZenPi installer, and enforce the repository's JavaScript and TypeScript readability rules.

Repository automation uses these official GitHub Actions at pinned major versions:

- `actions/checkout@v4`
- `actions/setup-node@v4`
- `actions/configure-pages@v5`
- `actions/upload-pages-artifact@v4`
- `actions/deploy-pages@v4`

They retain their own copyright and license terms. The Pages actions receive only the permissions documented in `.github/workflows/pages.yml`.

The optional DonSeTch CLI is distributed under AGPL-3.0-only and is not bundled in this repository. When selected during installation, ZenPi installs `donsetch@3.4.0` globally through npm; that package downloads and verifies its platform binary. The included skill documents how to invoke it.

Git is not bundled and retains its own license. ZenPi's in-house `/files` extension uses Pi's built-in themed renderers and invokes Git directly when repository status or diffs are available.
