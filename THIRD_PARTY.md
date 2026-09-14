# Third-party components

SpecPi's npm artifact contains first-party source and no bundled runtime dependencies. Its installer separately acquires the default packages below through Pi. Its own extensions use the host Pi installation's public extension API, UI components, enum helper, and TypeBox schemas through optional peer dependencies:

- `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui`: MIT, from [Pi](https://github.com/earendil-works/pi).
- `typebox`: MIT, from [TypeBox](https://github.com/sinclairzx81/typebox).

Development fixtures pin Pi packages to **0.84.4** and TypeBox to **1.3.7**. Host installations retain their upstream licenses and manage provider connections themselves. SpecPi does not install or configure providers.

Development formatting uses Prettier **3.9.6** (MIT), ESLint **10.9.1** (MIT), `@stylistic/eslint-plugin` **5.10.0** (MIT), `@typescript-eslint/parser` **8.68.0** (BSD-2-Clause), and TypeScript **6.0.3** (Apache-2.0). Exact versions are recorded in `package.json`; installed packages retain upstream notices. Git and Node.js are external prerequisites.

## Default upstream packages

Reviewed on 2026-09-14 against published npm metadata and integrity-verified source archives. All eight top-level packages declare the MIT license. Pins are authoritative in `templates/settings.json`.

SpecPi requests exact npm dependency saves for these pins and checks installed top-level versions before completing installation. The override applies to package acquisition without changing the user's global npm configuration.

| Package | Version | Upstream |
| --- | --- | --- |
| pi-web-access | 0.29.0 | [nicobailon/pi-web-access](https://github.com/nicobailon/pi-web-access) |
| betterwright | 2.8.1 | [BetterWright/betterwright](https://github.com/BetterWright/betterwright) |
| pi-subagents | 0.67.0 | [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) |
| pi-lens | 4.1.6 | [apmantza/pi-lens](https://github.com/apmantza/pi-lens) |
| pi-background-tasks | 2.5.0 | [ismailsaleekh/pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks) |
| pi-goal-x | 0.31.2 | [tmonk/pi-goal-x](https://github.com/tmonk/pi-goal-x) |
| @sreetej510/pi-usage | 0.10.0 | [Sreetej510/pi-extensions](https://github.com/Sreetej510/pi-extensions) |
| @gotgenes/pi-permission-system | 32.0.2 | [gotgenes/pi-packages](https://github.com/gotgenes/pi-packages) |

Transitive dependencies and their notices remain in Pi's npm installation tree. Top-level pins do not freeze upstream dependency ranges or constitute a full transitive security audit. Pi invokes npm with its upstream package-management semantics, including dependency lifecycle scripts. BetterWright has no browser-download install hook; its separate setup requires Bun 1.4+ and fetches its managed browser. Pi Lens includes native structural tooling and bundled grammars; configured diagnostics and autofixes may invoke additional tools. Pi Subagents includes `@earendil-works/pi-server`. Usage reporting and web packages make their own provider/service connections. Consult upstream licenses and security policies before redistributing their components.

The combined base is tested with Pi 0.84.4. Pi Goal X declares Pi `>=0.83.0 <0.85.0`; compatibility with newer hosts is not assumed. SpecPi's former custom browser, structural-search, delegation, background-task, and command-guard implementations, DonSeTch, and Pi themes have been removed. Removal restores owned package settings but does not delete downloaded upstream packages or tools. Retired private runtimes remain in local backups with their notices.

## Website and README

The website uses the bundled IBM Plex Sans and Plex Mono fonts under the SIL Open Font License 1.1; see [`site/fonts/LICENSE.txt`](https://github.com/TannerMidd/SpecPi/blob/main/site/fonts/LICENSE.txt). The website's scripts and diagrams are first-party code and assets. The README loads public package/license badges from Shields.io and build status from GitHub. Website fonts and media are not included in the npm package.

SpecPi Chat 0.7.1 is a separately packaged VS Code extension with no bundled runtime dependencies. It uses VS Code's host APIs and Pi's RPC protocol. Its read-only pi-subagents adapter consumes the upstream `fleetStatus` v1 contract reviewed at 0.67.0. Generic tool output, visible custom messages, widgets, and dialogs stay owned by their upstream packages. Playwright **1.62.1** (Apache-2.0, [Microsoft Playwright](https://github.com/microsoft/playwright)) is a pinned development dependency for Chat's rendering tests; its browser is installed only for those checks and is not shipped in either artifact.
