# Third-party components

When Pi is absent, SpecPi can install the reviewed `@earendil-works/pi-coding-agent@0.84.4` npm package globally after confirmation. The package provides the `pi` executable, is installed with lifecycle scripts disabled, retains its upstream license, and remains external system state after SpecPi uninstall.

The experimental delegation extension uses native Pi package discovery and the public `ctx.modelRegistry.complete` API, reviewed at compatibility-test floor **Pi 0.84.4**. It checks capability availability rather than imposing an exact SDK version or claiming every future version is compatible. It does not install or vendor another runtime, add a launcher, override trust/proxy/resource discovery, or introduce a direct `pi-agent-core` dependency or additional runtime library. Pi retains authentication, OAuth refresh and registry provider routing. Delegated completions do not inherit parent context/header/payload/response hooks, transport/thinking settings or session affinity; they use provider-default reasoning. The API returns a completed message, so output acceptance limits apply after completion and do not bound midstream buffering, raw bytes, process memory or invoices.

Architecture charts are committed static SVG/CSV/JSON assets. Their optional authoring script uses ReportLab 4.4.9 (BSD license); it is not installed by SpecPi or shipped as a runtime dependency. The site runs without a plotting library or remote chart service.

SpecPi pins but does not vendor these Pi packages:

- `pi-web-access@0.25.0`
- `@juicesharp/rpiv-ask-user-question@2.7.1`
- `@llblab/pi-codex-usage@0.9.3`
- `@tunnckocore/pi-gpt-fast-mode@0.4.0`
- `@narumitw/pi-goal@0.54.3`

They retain their own copyright and license terms. Pi downloads them from npm when the installer runs `pi install`. SpecPi does not patch, fork, vendor, or use unsupported deep imports from these packages.

The published `specpi` npm package declares the Pi host runtime modules its extensions import as optional peer dependencies, each at Pi's documented `"*"` range:

- `@earendil-works/pi-coding-agent` — extension API, theme, markdown, and highlighting helpers
- `@earendil-works/pi-ai` — the `StringEnum` tool-schema helper
- `@earendil-works/pi-tui` — terminal component, key, and width primitives
- `typebox` — the unscoped TypeBox package Pi bundles, used for tool input schemas

They retain their own copyright and license terms. SpecPi never vendors, bundles, or installs them; the Pi host supplies them at extension load time through loader aliases. Pi disables peer resolution for managed package installs, so a peer range would not enforce the host version there. Marking the peers optional also keeps an ordinary npm CLI installation from adding a second copy beside or inside SpecPi. The full managed installation enforces its supported Pi floor through the installer's `MIN_PI_VERSION` compatibility check, and the limited direct Pi mode documents the same host prerequisite.

SpecPi also installs these exact browser-runtime packages from the reviewed `browser-runtime/package-lock.json`:

- `playwright@1.62.1` and `playwright-core@1.62.1` — Apache-2.0
- `pixelmatch@7.2.0` — ISC
- `pngjs@7.0.0` — MIT
- optional `fsevents@2.3.2` on macOS — MIT

Playwright downloads its matching Chromium build into SpecPi's private runtime directory. Chromium retains its upstream BSD and third-party component licenses. None of these executables are installed globally.

Repository development uses these exact, project-local formatting and linting packages:

- `prettier@3.9.6` — MIT
- `eslint@10.9.1` — MIT
- `@stylistic/eslint-plugin@5.10.0` — MIT
- `@typescript-eslint/parser@8.68.0` — MIT
- `typescript@6.0.3` — Apache-2.0

They are development-only dependencies, are not shipped by the SpecPi installer, and enforce the repository's JavaScript and TypeScript readability rules.

The GitHub Pages site vendors the Latin subsets of IBM Plex Sans and IBM Plex Mono. Copyright © 2017 IBM Corp. with Reserved Font Name "Plex". The font files are distributed under the SIL Open Font License 1.1; the required license text is included at `site/fonts/LICENSE.txt`.

The npm release workflow installs `npm@11.19.1` as its pinned publishing client. npm is distributed under the Artistic License 2.0 and runs only on the ephemeral GitHub-hosted release runner.

Repository automation uses these official GitHub Actions. General CI and Pages workflows track the listed major versions; the npm publishing workflow pins exact reviewed commit SHAs so the OIDC job does not execute mutable action tags:

- `actions/checkout@v4`
- `actions/setup-node@v4`
- `actions/configure-pages@v5`
- `actions/upload-pages-artifact@v4`
- `actions/deploy-pages@v4`
- `actions/upload-artifact@v4`
- `actions/download-artifact@v4`

They retain their own copyright and license terms. These actions receive only the permissions declared in their respective workflows.

The optional DonSeTch CLI is distributed under AGPL-3.0-only and is not bundled in this repository. When selected during installation, SpecPi installs `donsetch@3.4.0` globally through npm; that package downloads and verifies its platform binary. The included skill documents how to invoke it.

Git is not bundled and retains its own license. SpecPi's in-house `/files` extension uses Pi's built-in themed renderers and invokes Git directly when repository status or diffs are available.
