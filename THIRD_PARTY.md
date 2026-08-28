# Third-party components

ZenPi pins but does not vendor these Pi packages:

- `pi-web-access@0.25.0`
- `pi-subagents@0.58.0`
- `@juicesharp/rpiv-ask-user-question@2.7.1`
- `@llblab/pi-codex-usage@0.9.3`
- `@tunnckocore/pi-gpt-fast-mode@0.4.0`
- `@narumitw/pi-goal@0.54.3`
- `@tmustier/pi-files-widget@0.2.0`

They retain their own copyright and license terms. Pi downloads them from npm when the installer runs `pi install`.

ZenPi also installs these exact browser-runtime packages from the reviewed `browser-runtime/package-lock.json`:

- `playwright@1.62.1` and `playwright-core@1.62.1` — Apache-2.0
- `pixelmatch@7.2.0` — ISC
- `pngjs@7.0.0` — MIT
- optional `fsevents@2.3.2` on macOS — MIT

Playwright downloads its matching Chromium build into ZenPi's private runtime directory. Chromium retains its upstream BSD and third-party component licenses. None of these executables are installed globally.

Repository automation uses these official GitHub Actions at pinned major versions:

- `actions/checkout@v4`
- `actions/setup-node@v4`
- `actions/configure-pages@v5`
- `actions/upload-pages-artifact@v4`
- `actions/deploy-pages@v4`

They retain their own copyright and license terms. The Pages actions receive only the permissions documented in `.github/workflows/pages.yml`.

The optional DonSeTch CLI is distributed under AGPL-3.0-only and is not bundled in this repository. The included skill documents how to invoke it.

System tools such as Git, bat, delta, and glow are not bundled and retain their own licenses.
