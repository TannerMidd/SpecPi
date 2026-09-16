<p align="center">
  <img src="https://tannermidd.github.io/SpecPi/logo.svg" width="88" alt="SpecPi logo">
</p>

<h1 align="center">SpecPi</h1>

<p align="center">Pi, beside your code.<br>Scope your work. Choose what improves. Keep your own Pi setup.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/specpi"><img src="https://img.shields.io/npm/v/specpi?style=flat-square&amp;color=084bdb" alt="npm version"></a>
  <a href="https://github.com/TannerMidd/SpecPi/actions/workflows/ci.yml"><img src="https://github.com/TannerMidd/SpecPi/actions/workflows/ci.yml/badge.svg?branch=main" alt="Build status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-084bdb?style=flat-square" alt="MIT license"></a>
</p>

<p align="center">
  <a href="#install">Install</a> · <a href="https://tannermidd.github.io/SpecPi/">Website</a> · <a href="https://tannermidd.github.io/SpecPi/wiki/">Documentation</a> · <a href="#vs-code">VS Code</a> · <a href="https://github.com/TannerMidd/SpecPi/releases">Releases</a>
</p>

<p align="center">
  <a href="https://tannermidd.github.io/SpecPi/#vscode-chat">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://tannermidd.github.io/SpecPi/media/specpi-chat.png">
      <img src="https://tannermidd.github.io/SpecPi/media/specpi-chat-light.png" width="1100" alt="SpecPi Chat beside a file in VS Code, discussing a focused code change with a file attached.">
    </picture>
  </a>
</p>
<p align="center"><sub>SpecPi Chat · Example workspace</sub></p>

SpecPi is a small base for the [Pi coding agent](https://pi.dev/). Its own extensions provide **scope control** and a **harness improvement loop**. Six pinned packages handle the supporting tools, and **SpecPi Chat 0.11.0** brings them into VS Code.

| Keep the work focused                                                             | Improve what gets in the way                                                                     | Work beside your code                                                                   |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Declare files and directories with `/scope`. Review drift as the task progresses. | Record recurring problems locally. Choose a change through `/harness-improvement` and verify it. | Chat, attach files, follow subagents, review approvals, and inspect changes in VS Code. |

> **Moving from 0.20 or earlier?** The 0.21 base removes the old custom tools, extra commands, themes, and shell profiles. Read [updating and removal](#update-and-remove) before switching.

## Install

Requires Node.js 22.19+, Git, npm, and an existing Pi installation on PATH. The complete base is tested with Pi **0.84.4**; `pi-goal-x` currently declares Pi `>=0.83.0 <0.85.0` compatibility.

```sh
npm install --global specpi@latest
specpi plan
specpi install
specpi doctor
```

Inspect the plan, confirm the install, then restart Pi. SpecPi installs two first-party extensions, the improvement skill, a marked working agreement, and the packages below using `pi install`. Provider and model settings are preserved. Confirmed install/update also runs the installed Browser QA package's Node setup to download Chromium and verify readiness. No Bun or OS libraries are installed. There are no additional harness extensions, themes, shell profiles, or tool wrappers.

<details>
<summary>Source checkouts, alternate Pi paths, and core-only installs</summary>

For this checkout, run `node scripts/specpi.mjs` in place of `specpi`. `PI_CODING_AGENT_DIR` selects an alternate destination; `SPECPI_PI` selects a Pi CLI path. `specpi install --skip-package-install` installs only the first-party core for offline use and testing. `--skip-browser-install` skips Chromium setup while still acquiring all six packages; `doctor` still checks browser readiness. `--skip-package-install` skips both package acquisition and Chromium setup. A plain `pi install npm:specpi` loads only the packaged first-party resources; use the SpecPi installer above for the complete base, and avoid installing the same first-party resources both ways.

</details>

## Default packages

These are installed on every normal install and update. Exact versions live in [`templates/settings.json`](templates/settings.json); SpecPi merges only the package entries, preserving unrelated configuration and existing resource filters.

| Package                                                                                                           | Pinned version | Purpose                                                |
| ----------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------ |
| [pi-web-access](https://github.com/nicobailon/pi-web-access)                                                      | 0.29.0         | Web search and page retrieval                          |
| [specpi-browser-qa](https://www.npmjs.com/package/specpi-browser-qa)                                               | 0.1.0          | Browser interaction, accessibility and visual QA                                     |
| [pi-subagents](https://github.com/nicobailon/pi-subagents)                                                        | 0.67.0         | Subagents and delegation                               |
| [pi-goal-x](https://github.com/tmonk/pi-goal-x)                                                                   | 0.31.2         | Persistent goals and progress                          |
| [@sreetej510/pi-usage](https://github.com/Sreetej510/pi-extensions/tree/main/extensions/pi-usage)                 | 0.10.0         | Provider usage reporting                               |
| [@gotgenes/pi-permission-system](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system) | 32.0.2         | Tool permission policies                               |

The effective commands are `pi install npm:<package>@<version>` for each row, including the scoped names. These packages supply their own extensions, tools, skills, and prompts according to their upstream defaults. SpecPi does not add a second implementation or configure their policies.

SpecPi requests exact npm dependency saves for these installs and verifies installed versions before completing the transaction. This keeps later package installs from advancing an earlier pin through npm's default version ranges.

Browser QA setup uses the installed package's pinned Playwright and the standard browser cache (or `PLAYWRIGHT_BROWSERS_PATH`). If setup fails, managed configuration rolls back; install missing OS libraries manually and retry `specpi install` (or `specpi update` for an existing installation). `specpi doctor` runs offline rendering, pixel-comparison, and accessibility checks without downloading anything. Provider credentials, web-service configuration, and permission rules remain governed by each package's documentation. Package installation and extension loading do not prove that every external service or tool is ready.

## Browser QA

[`specpi-browser-qa@0.1.0`](https://www.npmjs.com/package/specpi-browser-qa/v/0.1.0) is independently published and now included in the default base. Its 14 tools cover interactions, responsive screenshots, visual comparison, diagnostics, and accessibility checks in an ephemeral browser context. It is QA-focused, not general-browser feature parity with BetterWright. No personal browser, profile, cookie, or private Pi data is migrated.

BetterWright remains an optional manual install, with its own [Bun-based setup](https://github.com/BetterWright/betterwright/blob/main/SETUP.md). SpecPi does not uninstall Bun or user-owned tools.

## VS Code

[SpecPi Chat](https://github.com/TannerMidd/SpecPi/blob/main/vscode/README.md) provides the chat sidebar, file and image attachments, conversation history, tool output, package commands, and approval dialogs. Version **0.11.0** adds provider sign-in: Chat names a missing credential and opens Pi in a terminal for its own `/login`, then reloads Pi so the new models appear. Chat still never reads or stores those credentials. The VSIX remains separate from the npm harness package.

Download the [0.11.0 VSIX](https://github.com/TannerMidd/SpecPi/releases/download/v0.23.0/specpi-chat-0.11.0.vsix), then run **Extensions: Install from VSIX…** in VS Code. Install/update SpecPi separately, then restart Pi in Chat to reload its extensions.

[Download Chat](https://github.com/TannerMidd/SpecPi/releases/download/v0.23.0/specpi-chat-0.11.0.vsix) · [Chat guide](https://github.com/TannerMidd/SpecPi/blob/main/vscode/GUIDE.md) · [Build from source](https://github.com/TannerMidd/SpecPi/blob/main/vscode/DEVELOPMENT.md)

## Scope

Declare the files and directories a task should touch with `/scope set`, then use `/scope status` to review drift.

<details>
<summary>Scope commands</summary>

- `/scope set`: declare project-relative files or directories, one per line.
- `/scope status`: review declared paths, pending drift, and snapshot uncertainty.
- `/scope add <path>` or `/scope remove <path>`: change the declared scope.
- `/scope accept <path>`: acknowledge a finding without adding that path to scope.
- `/scope recheck`: deliberately refresh the baseline after an uncertain snapshot.
- `/scope clear`: turn monitoring off.
- `/scope task`: import the active improvement contract's paths explicitly.

</details>

Interactive writes and edits outside scope ask before proceeding. In headless mode they are recorded as pending. Other tools are checked afterward against bounded Git snapshots. Scope is a drift monitor, not a sandbox: shell commands and custom tools can already have changed files when drift is reported. State follows the current Pi session branch.

## Harness improvement loop

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://tannermidd.github.io/SpecPi/media/improvement-workflow-dark.svg">
  <img src="https://tannermidd.github.io/SpecPi/media/improvement-workflow.svg" width="1200" alt="Observe a recurring gap, select one change, modify the harness, test it, retire with evidence, and review later outcomes.">
</picture>

1. Enable local observations with `/wishlist on`; collection is off by default. `/wishlist off` stops it.
2. Review recurring gaps with `/wishlist` and select one through `/harness-improvement` in a complete SpecPi source checkout.
3. Follow the `specpi-improve` skill: record a bounded contract, implement the smallest sufficient change, and gather direct acceptance evidence.
4. `finish_harness_improvement` verifies the selected contract, source changes, repository checks, and registered capability validators before retirement.
5. Review the journal with `/wishlist history <gap-id>`. A regression returns the item for human selection; it never authorizes an automatic fix.

Observations are leads, not permission. Records stay local, use sanitized summaries and salted identifiers, and are never uploaded automatically. Pi still sends model requests to your selected provider. `/wishlist outcome <gap-id>` records the human's assessment of a local retirement.

## Update and remove

```sh
npm install --global specpi@latest
specpi plan
specpi update
specpi doctor
specpi uninstall
```

Install, update, and uninstall require confirmation; `--yes` supplies it for automation. Modified retained resources require `update --force`. Managed configuration and resources are backed up and checksum-tracked. `update --skip-package-install` preserves an existing base without invoking Pi's package installer. Normal updates reapply the reviewed pins and run Chromium setup unless `--skip-browser-install` is supplied.

BetterWright is no longer a default package. Normal updates use recorded ownership to remove only unchanged SpecPi-added entries or restore pre-existing entries. User-modified entries and downloaded bytes survive; `--skip-package-install` preserves the old base. Restart Pi and each Chat connection to unload retired extensions. Independently retained BetterWright installs require separate user management.

`pi-lens` is no longer included by default. A normal managed update removes unchanged Lens entries originally added by SpecPi; pre-existing or user-modified entries and downloaded files remain. `--skip-package-install` preserves the old base. Restart Pi and each Chat connection to unload Lens. Independently retained installations require separate user management (`pi remove npm:pi-lens` in their installation scope).

`pi-background-tasks` is no longer included by default because its Anthropic wrapper can reject changing message context. A normal update removes an unchanged package entry originally added by SpecPi; pre-existing or user-modified entries and downloaded files remain. `--skip-package-install` preserves the old base. To remove a separately retained installation, run `pi remove npm:pi-background-tasks` in its installation scope, then restart Pi.

Updating from the larger harness retires its recorded extra resources, restores legacy settings that still match ownership records, removes its shell marker block, and installs the new package base. Modified retired files and old runtime directories are preserved under `<agent-dir>/specpi/backups/`. Restart Pi to unload the old extensions. Unrelated configuration and local improvement evidence remain intact.

Uninstall restores package entries that still match SpecPi's recorded changes and preserves subsequent user edits. Downloaded packages, browser caches, npm caches, upstream configuration, and private evidence remain on disk. A failed install rolls back SpecPi-managed files and configuration; package/browser downloads and upstream install-script effects cannot be rolled back. `doctor` checks the core, package settings, installed top-level versions, and actual Browser QA readiness. Core-only installations do not run browser checks.

## Development

```sh
npm install --ignore-scripts --omit=peer --no-package-lock
node --test tests/workflow-controls.test.mjs tests/workflow-controls-extension.test.mjs
npm run check
npm run check:pi-package
npm run check:base
```

Installer tests use disposable Pi directories. `check:base` requires network access, installs the real six packages in isolated state, loads them together through Pi 0.84.4, verifies Chat RPC startup and explicit permission replies, and checks removal. It also runs Chromium setup and offline Browser QA smoke checks, without sending model requests. Set `PLAYWRIGHT_BROWSERS_PATH` to a disposable test cache to avoid touching the normal browser cache. Never test against a live Pi installation. Publication remains explicit and uses the [release procedure](NPM_RELEASE.md).

The website is static HTML and CSS in `site/`. After installing the pinned Playwright browser with `npx --no-install playwright install chromium`, run `npm run check:site` to check versions, links, and desktop, tablet, and mobile layouts. GitHub Pages deploys it from `main` after those checks pass.

[Security model](SECURITY_MODEL.md) · [Third-party components](THIRD_PARTY.md) · [Release notes](CHANGELOG.md) · [MIT License](LICENSE)
