# Third-party components

SpecPi's npm artifact contains first-party source and no bundled runtime dependencies. Its installer separately acquires the default packages below through Pi. Its own extensions use the host Pi installation's public extension API, UI components, enum helper, and TypeBox schemas through optional peer dependencies:

- `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui`: MIT, from [Pi](https://github.com/earendil-works/pi).
- `typebox`: MIT, from [TypeBox](https://github.com/sinclairzx81/typebox).

Development fixtures pin Pi packages to **0.84.4** and TypeBox to **1.3.7**. Host installations retain their upstream licenses and manage provider connections themselves. SpecPi does not install or configure providers.

Development formatting uses Prettier **3.9.6** (MIT), ESLint **10.9.1** (MIT), `@stylistic/eslint-plugin` **5.10.0** (MIT), `@typescript-eslint/parser` **8.68.0** (BSD-2-Clause), and TypeScript **6.0.3** (Apache-2.0). Exact versions are recorded in `package.json`; installed packages retain upstream notices. Git and Node.js are external prerequisites.

## Default packages

Reviewed on 2026-09-16 against published npm metadata and integrity-verified source archives. All eight top-level packages declare the MIT license. Pins are authoritative in `templates/settings.json`.

SpecPi requests exact npm dependency saves for these pins and checks installed top-level versions before completing installation. The override applies to package acquisition without changing the user's global npm configuration.

| Package                        | Version | Upstream                                                                  |
| ------------------------------ | ------- | ------------------------------------------------------------------------- |
| pi-web-access                  | 0.29.0  | [nicobailon/pi-web-access](https://github.com/nicobailon/pi-web-access)   |
| specpi-browser-qa              | 0.3.0   | [TannerMidd/SpecPi](https://github.com/TannerMidd/SpecPi/tree/browser-qa-v0.3.0/packages/browser-qa) |
| specpi-delegation              | 0.2.0   | [TannerMidd/SpecPi](https://github.com/TannerMidd/SpecPi/tree/main/packages/delegation) |
| specpi-experiments             | 0.1.0   | [TannerMidd/SpecPi](https://github.com/TannerMidd/SpecPi/tree/main/packages/experiments) |
| pi-goal-x                      | 0.31.2  | [tmonk/pi-goal-x](https://github.com/tmonk/pi-goal-x)                     |
| @sreetej510/pi-usage           | 0.10.0  | [Sreetej510/pi-extensions](https://github.com/Sreetej510/pi-extensions)   |
| @gotgenes/pi-permission-system | 32.0.2  | [gotgenes/pi-packages](https://github.com/gotgenes/pi-packages)           |

Transitive dependencies and their notices remain in Pi's npm installation tree. Top-level pins do not freeze upstream dependency ranges or constitute a full transitive security audit. Pi invokes npm with its upstream package-management semantics, including dependency lifecycle scripts. Browser QA has no install hook: confirmed SpecPi install/update explicitly invokes its installed Node setup bin, unless acquisition or browser setup is skipped. It downloads package-pinned Chromium without installing OS libraries. BetterWright is optional/manual and retains its own Bun-based setup; SpecPi neither removes Bun nor deletes user-owned tools. Usage reporting and web packages make their own provider/service connections. Consult upstream licenses and security policies before redistributing their components.

Pi Lens is no longer a default package. Normal updates retire only unchanged entries added by SpecPi; independent or modified entries and downloaded bytes remain, with their upstream notices. Restart Pi to unload Lens.

The combined base is tested with Pi 0.84.4. Pi Goal X declares Pi `>=0.83.0 <0.85.0`; compatibility with newer hosts is not assumed. SpecPi's former custom browser, structural-search, background-task, and command-guard implementations, DonSeTch, and Pi themes have been removed. Its delegation and experiment implementations were not discarded: they now ship as the independent `specpi-delegation` and `specpi-experiments` packages described below. Removal restores owned package settings but does not delete downloaded upstream packages or tools. Retired private runtimes remain in local backups with their notices.

## Network services

The optional Jev layer, command guard included, reaches TypeSafe's System One endpoint. It is not a bundled dependency: it is first-party source that uses Node's built-in `fetch` and declares no package. The guard used to be a separate pinned package; it is now the layer's eighth system, so one switch, one budget and one key serve the whole thing. That key is resolved the way every other Pi provider credential is resolved, in Pi's own documented order: the `openrouter` entry that `/login openrouter` writes to `<agent-dir>/auth.json`, then `OPENROUTER_API_KEY` from the environment (`TYPESAFE_API_KEY` when `JEV_BACKEND=typesafe` selects the direct API). The two keys are not interchangeable: the other service rejects the wrong one with a bare 401. SpecPi never provisions or stores a provider credential, and reads one only to place it in the request header of the call the user has switched on.

Requests go to `openrouter.ai` by default, or to `api.typesafe.ai` on the direct backend, unless `TYPESAFE_BASE_URL` redirects them, which exists so tests never reach the network and the eval proxy can price advisor traffic. Retention and processing of what is sent are governed by TypeSafe and, on the default route, by OpenRouter as well -- not by SpecPi; the advisor ships off, asks before its first transmission and records a hash of every payload locally. The frozen eval price list carries `jev-1.13.0` at $0.042/MTok input and free output so a measured SpecPi + Jev row never reports a cost that excludes its own advisor.

Worth stating plainly, because it is the part a reader is most likely to assume otherwise: what leaves the machine is a bounded sample of the material being judged, not only counts about it. A tool result contributes up to twelve short lines of its own text, redacted and inside a 1 KB budget, because whether a result is spent or whether a fetched page is addressing the agent cannot be decided from byte counts. When the untrusted-content system is enabled, that sample is drawn from externally fetched pages and browser snapshots as well as from local output. [`SECURITY_MODEL.md`](SECURITY_MODEL.md#jev-advisor) states the exact bound and where it is enforced.

## Standalone delegation and experiments

`packages/delegation` and `packages/experiments` are first-party packages extracted from SpecPi's own retired harness code under MIT. Neither bundles third-party runtime code or declares a production dependency; every runtime import is a Node builtin or a Pi-supplied optional peer. Experiments invokes the user's own `git` as an external program through Pi's `exec` seam; Git is not bundled, vendored or version-pinned. Delegation's extraction drops the Command Guard admission path, which SpecPi no longer ships, and reports its guard posture as `absent`. See their dependency notices and security boundaries: [delegation](packages/delegation/THIRD_PARTY.md) / [boundary](packages/delegation/SECURITY.md), [experiments](packages/experiments/THIRD_PARTY.md) / [boundary](packages/experiments/SECURITY.md).

## Standalone browser QA

The separately released `packages/browser-qa` source reuses the retired QA implementation with Playwright 1.62.1, axe-core and its Playwright adapter 4.13.0, pixelmatch 7.2.0, and pngjs 7.0.0. These are that package's exact runtime dependencies, acquired separately by Pi for the default base, not bundled in SpecPi's npm artifact. See its [dependency notices](packages/browser-qa/THIRD_PARTY.md) and [security boundary](packages/browser-qa/SECURITY.md). Setup uses Node and explicitly downloads Chromium; no Bun or install hook is used. The 0.1.0 registry tarball was integrity-verified against `sha512-lilvlRgSbvNxnueO+CxCvlGI6wqrdtshCLmNkaBAa+P8+6c/aQvB27fP5n3KIFylABchKe7x6vzf3tHleNSikg==`; source tag: `browser-qa-v0.1.0`. Published package bytes are unchanged by this integration. Browser-cache bytes and downloaded packages survive managed rollback and uninstall.

## Website and README

The website uses the bundled IBM Plex Sans and Plex Mono fonts under the SIL Open Font License 1.1; see [`site/fonts/LICENSE.txt`](https://github.com/TannerMidd/SpecPi/blob/main/site/fonts/LICENSE.txt). The website's scripts and diagrams are first-party code and assets. The README loads public package/license badges from Shields.io and build status from GitHub. Website fonts and media are not included in the npm package.

SpecPi Chat 0.8.3 is a separately packaged VS Code extension with no bundled runtime dependencies. It uses VS Code's host APIs and Pi's RPC protocol. Generic tool output, visible custom messages, widgets, and dialogs stay owned by their upstream packages. Playwright **1.62.1** (Apache-2.0, [Microsoft Playwright](https://github.com/microsoft/playwright)) is a pinned development dependency for Chat's rendering tests; its browser is used for those checks and is not shipped in either artifact. The default Browser QA package independently uses the same pinned Playwright version for its runtime. Chat's global Destructive guard preset is a full replacement configuration reviewed against Permission System 32.0.2's schema and native pattern semantics. No upstream patch, new dependency, policy-layer merger, or independent command evaluator is included. See [the security model](SECURITY_MODEL.md) for its limits.
