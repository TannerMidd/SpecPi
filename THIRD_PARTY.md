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

Repository automation uses these official GitHub Actions at pinned major versions:

- `actions/checkout@v4`
- `actions/setup-node@v4`
- `actions/configure-pages@v5`
- `actions/upload-pages-artifact@v4`
- `actions/deploy-pages@v4`

They retain their own copyright and license terms. The Pages actions receive only the permissions documented in `.github/workflows/pages.yml`.

The optional DonSeTch CLI is distributed under AGPL-3.0-only and is not bundled in this repository. The included skill documents how to invoke it.

System tools such as Git, bat, delta, and glow are not bundled and retain their own licenses.
