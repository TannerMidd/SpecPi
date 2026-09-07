# Third-party components

SpecPi Chat is a separate VS Code extension built with the public VS Code Webview View API and Pi `0.84.4`'s documented RPC protocol. VS Code and the installed Pi runtime retain their upstream licenses; neither is bundled in the VSIX. The extension and its ZIP/VSIX packager use Node built-ins and first-party source only, with no added runtime or development dependency. Its tests reuse the repository's pinned Playwright and Pi packages. Provider authentication, requests, billing, and normal Pi background behavior remain owned by the configured Pi runtime.

Chat's provider Limits row recognizes the public RPC `setStatus` presentation contracts of `@llblab/pi-codex-usage` **0.9.3** (`aa-codex-usage`) and `@sreetej510/pi-usage` **0.9.9** (`provider-usage`). Public source was checked at commits `1a97ee5560c5d7dd3b99ce34e2dcfe456592f8a0` and `9dee3b590f736c723011e3bc3717b3f0d6e8072b`, respectively. Tests reproduce their status/notification contracts through synthetic local Pi RPC, not live accounts or upstream provider requests. Text retains each plugin's quota semantics rather than converting or aggregating measurements. Neither plugin is bundled in the VSIX; this compatibility change does not install pi-usage or change SpecPi's existing package pins. Plugins retain ownership of authentication, caching, refresh/backoff, and explicit reset-consumption confirmation.

Chat uses Pi's image content blocks, conversation tree/fork/clone operations, and session statistics, plus the installed VS Code Git extension's public API for diff review. Version 0.3.0 retains a separate Pi process for each connected conversation and uses Pi's `--fork <session>` CLI option to copy branch history before runtime extensions initialize; the original live session remains untouched. Image container validation and base64 framing are first-party code; display uses VS Code's embedded browser image decoders. No image codec, provider SDK, export package, or remote image service is added. Local acceptance of PNG, JPEG, GIF, or WebP does not establish that every configured provider accepts the same formats or animation behavior. RPC records and buffered writes are capped at 64 MiB; image prompts and rendered media have separate, smaller limits documented in the extension guide.

Delegation loads `clampThinkingLevel` from the Pi SDK when exported there, otherwise
from the public `@earendil-works/pi-ai/compat` subpath declared in Pi's
[package exports](https://github.com/earendil-works/pi/blob/main/packages/ai/package.json).
That fallback is guarded: a missing module or function leaves `/delegate` registered
and produces a capability error on activation, rather than an extension-load failure.

When Pi is absent, SpecPi can install the reviewed `@earendil-works/pi-coding-agent@0.84.4` npm package globally after confirmation. The package provides the `pi` executable, is installed with lifecycle scripts disabled, retains its upstream license, and remains external system state after SpecPi uninstall.

The experimental delegation extension uses native discovery and public Pi SDK `createAgentSession`, in-memory sessions and a fresh `ModelRuntime`, with **public SDK capability checks instead of an exact-version allowlist**. Compatible Pi updates can activate without a SpecPi release. Missing APIs are named in the activation error; actual SDK/provider behavior remains subject to runtime checks and regression testing. The installer floor and pinned 0.84.4 bootstrap package are unchanged. Pi supplies the conversation/tool loop, standard configuration, authentication and OAuth. The child receives the parent model and thinking level with Pi clamping; unsupported runtime-only authentication, selected extension-provider overrides and safe descriptor mismatches fail preflight. Children load no ambient extensions, skills, AGENTS files or parent history. Parent hooks, ephemeral settings and session affinity are not inherited. Each SDK invocation is admitted before dispatch. SDK provider retries and compaction are disabled; ordinary tool-argument and report corrections use admitted calls in the same child session. Output length follows Pi's normal provider/model settings without a delegation-specific token cap, and SDK-visible streams are checked without claiming hard raw-transport, hidden-attempt, memory or invoice bounds. SpecPi does not install or vendor another runtime, add a launcher/service, or introduce a direct `pi-agent-core` dependency or additional runtime library. Parent Pi startup, resources and trust remain unchanged.

The [Pi 0.85.0 release](https://github.com/earendil-works/pi/releases/tag/v0.85.0), published 4 September 2026, prompted the additional compatibility review. It does not change the installer pin or imply that every provider/setup has passed. Pi 0.85.1 also passes the isolated native/provider fixtures; its SDK session, agent-session and model-runtime modules match 0.85.0. Compatibility evidence is not an activation allowlist or proof of full parent inference parity.

The child uses configured global transport/thinking budgets without loading project settings. Startup proxy configuration and model-specific headers are unsupported and fail preflight; parent configuration stays unchanged. These limits are part of the experimental SDK integration, not claims about what Pi itself supports.

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

They retain their own copyright and license terms. SpecPi never vendors, bundles, or installs them for end users; the Pi host supplies them at extension load time through loader aliases. Repository development additionally pins local copies for type checking and isolated test launches, as listed below. Pi disables peer resolution for managed package installs, so a peer range would not enforce the host version there. Marking the peers optional also keeps an ordinary npm CLI installation from adding a second copy beside or inside SpecPi. The full managed installation enforces its supported Pi floor through the installer's `MIN_PI_VERSION` compatibility check, and the limited direct Pi mode documents the same host prerequisite.

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

They are development-only dependencies, are not shipped by the SpecPi installer, and enforce the repository's JavaScript and TypeScript readability rules. TypeScript also runs strict no-emit checking for the browser extension.

Browser type checking and registered-tool tests additionally use exact project-local development dependencies: `@earendil-works/pi-coding-agent@0.84.4`, `@earendil-works/pi-ai@0.84.4`, `@earendil-works/pi-tui@0.84.4` (MIT), `typebox@1.3.7` (MIT), `@types/node@22.20.1` (MIT), and `playwright@1.62.1` (Apache-2.0). These reuse the reviewed Pi/runtime versions, do not alter the optional production-peer contract, and are not bundled or installed by SpecPi. Direct development dependencies are pinned; this is not a claim that the development transitive graph is locked. The browser executable test runtime still uses the separately reviewed lockfile. `setup:browser` provisions only `.specpi-test/browser-runtime/`; its explicit `--with-deps` option invokes Playwright OS dependency setup on disposable Linux CI runners. No language-server executable or additional automation framework was added.

The GitHub Pages site vendors the Latin subsets of IBM Plex Sans and IBM Plex Mono. Copyright © 2017 IBM Corp. with Reserved Font Name "Plex". The font files are distributed under the SIL Open Font License 1.1; the required license text is included at `site/fonts/LICENSE.txt`.

The site showcase at `site/media/specpi-showcase.mp4` incorporates “Machina” by Scott Buckley, released under Creative Commons Attribution 4.0 (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/. Source and composer credit: https://www.scottbuckley.com.au/library/machina/ and https://www.scottbuckley.com.au/. The music excerpt is edited, level-adjusted, and faded; its license is separate from SpecPi's MIT license. Credit appears in the film and the player's transcript/credits disclosure. Preserve that attribution with redistribution; YouTube uploads require it in the video description. See `site/media/README.md`.

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
