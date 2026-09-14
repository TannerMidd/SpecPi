# SpecPi

A small base for the [Pi coding agent](https://pi.dev/). Set the scope of a task, notice recurring problems, and choose what to improve. Eight upstream packages provide the supporting tools.

**0.21.0 resets the base.** SpecPi's own Pi extensions now provide only `/scope` and the harness improvement loop. Custom tools, extra workflow commands, themes, and shell profiles have been removed. **SpecPi Chat 0.7.1** remains the VS Code frontend. Read [the release notes](CHANGELOG.md) and the migration instructions below before updating.

[Website](https://tannermidd.github.io/SpecPi/) · [Download Chat](https://github.com/TannerMidd/SpecPi/releases/download/v0.21.0/specpi-chat-0.7.1.vsix) · [Releases](https://github.com/TannerMidd/SpecPi/releases)

## Install

Requires Node.js 22.19+, Git, npm, and an existing Pi installation on PATH. The complete base is tested with Pi **0.84.4**; `pi-goal-x` currently declares Pi `>=0.83.0 <0.85.0` compatibility.

```sh
npm install --global specpi@latest
specpi plan
specpi install
specpi doctor
```

Inspect the plan, confirm the install, then restart Pi. SpecPi installs two first-party extensions, the improvement skill, a marked working agreement, and the packages below using `pi install`. Provider and model settings are preserved. There are no additional SpecPi extensions, themes, shell profiles, tool wrappers, or browser bootstrap scripts.

For this checkout, run `node scripts/specpi.mjs` in place of `specpi`. `PI_CODING_AGENT_DIR` selects an alternate destination; `SPECPI_PI` selects a Pi CLI path. `specpi install --skip-package-install` installs only the first-party core for offline use and testing. A plain `pi install npm:specpi` loads only the packaged first-party resources; use the SpecPi installer above for the complete base, and avoid installing the same first-party resources both ways.

## Default packages

These are installed on every normal install and update. Exact versions live in [`templates/settings.json`](templates/settings.json); SpecPi merges only the package entries, preserving unrelated configuration and existing resource filters.

| Package | Pinned version | Purpose |
| --- | --- | --- |
| [pi-web-access](https://github.com/nicobailon/pi-web-access) | 0.29.0 | Web search and page retrieval |
| [betterwright](https://github.com/BetterWright/betterwright) | 2.8.1 | Browser automation |
| [pi-subagents](https://github.com/nicobailon/pi-subagents) | 0.67.0 | Subagents and delegation |
| [pi-lens](https://github.com/apmantza/pi-lens) | 4.1.6 | Language diagnostics, navigation, and structural tools |
| [pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks) | 2.5.0 | Durable background tasks |
| [pi-goal-x](https://github.com/tmonk/pi-goal-x) | 0.31.2 | Persistent goals and progress |
| [@sreetej510/pi-usage](https://github.com/Sreetej510/pi-extensions/tree/main/extensions/pi-usage) | 0.10.0 | Provider usage reporting |
| [@gotgenes/pi-permission-system](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system) | 32.0.2 | Tool permission policies |

The effective commands are `pi install npm:<package>@<version>` for each row, including the scoped names. These packages supply their own extensions, tools, skills, and prompts according to their upstream defaults. SpecPi does not add a second implementation or configure their policies.

SpecPi requests exact npm dependency saves for these installs and verifies installed versions before completing the transaction. This keeps later package installs from advancing an earlier pin through npm's default version ranges.

BetterWright's browser is a separate upstream setup step: install Bun 1.4+ and run `bunx betterwright@2.8.1 setup` before using browser tools. See [BetterWright setup](https://github.com/BetterWright/betterwright/blob/main/SETUP.md). The default package installation does not install Bun or download its browser. Provider credentials, web-service configuration, language servers, and permission rules remain governed by each package's documentation. Package installation and extension loading do not prove that every external service or tool is ready.

## VS Code

[SpecPi Chat](https://github.com/TannerMidd/SpecPi/blob/main/vscode/README.md) provides the chat sidebar, file and image attachments, conversation history, tool output, package commands, and approval dialogs. Version **0.7.1** adds the new package base's visible messages, a Permission System settings button, and pi-subagents activity and result cards. The VSIX remains separate from the npm harness package.

Download the [0.7.1 VSIX](https://github.com/TannerMidd/SpecPi/releases/download/v0.21.0/specpi-chat-0.7.1.vsix), then run **Extensions: Install from VSIX…** in VS Code. To build from source, run `npm --prefix vscode run package`; the file is written to `.specpi-test/vscode/specpi-chat-0.7.1.vsix`. See the [Chat guide](https://github.com/TannerMidd/SpecPi/blob/main/vscode/GUIDE.md) for package support and terminal-only controls. Install/update SpecPi separately, then restart Pi in Chat to reload its extensions.

## Scope

- `/scope set`: declare project-relative files or directories, one per line.
- `/scope status`: review declared paths, pending drift, and snapshot uncertainty.
- `/scope add <path>` or `/scope remove <path>`: change the declared scope.
- `/scope accept <path>`: acknowledge a finding without adding that path to scope.
- `/scope recheck`: deliberately refresh the baseline after an uncertain snapshot.
- `/scope clear`: turn monitoring off.
- `/scope task`: import the active improvement contract's paths explicitly.

Interactive writes and edits outside scope ask before proceeding. In headless mode they are recorded as pending. Other tools are checked afterward against bounded Git snapshots. Scope is a drift monitor, not a sandbox: shell commands and custom tools can already have changed files when drift is reported. State follows the current Pi session branch.

## Harness improvement loop

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

Install, update, and uninstall require confirmation; `--yes` supplies it for automation. Modified retained resources require `update --force`. Managed configuration and resources are backed up and checksum-tracked. `update --skip-package-install` preserves an existing base without invoking Pi's package installer. Normal updates reapply the reviewed pins.

Updating from the larger harness retires its recorded extra resources, restores legacy settings that still match ownership records, removes its shell marker block, and installs the new package base. Modified retired files and old runtime directories are preserved under `<agent-dir>/specpi/backups/`. Restart Pi to unload the old extensions. Unrelated configuration and local improvement evidence remain intact.

Uninstall restores package entries that still match SpecPi's recorded changes and preserves subsequent user edits. Downloaded packages, npm caches, upstream configuration, and private evidence remain on disk. A failed install rolls back SpecPi-managed files and configuration; package downloads and upstream install-script effects cannot be rolled back. `doctor` checks the core, package settings, and installed top-level package versions without activating upstream tools.

## Development

```sh
npm install --ignore-scripts --omit=peer --no-package-lock
node --test tests/workflow-controls.test.mjs tests/workflow-controls-extension.test.mjs
npm run check
npm run check:pi-package
npm run check:base
```

Installer tests use disposable Pi directories. `check:base` requires network access, installs the real eight packages in isolated state, loads them together through Pi 0.84.4, verifies Chat RPC startup and explicit permission replies, and checks removal. It does not send model requests or run browser tasks. Never test against a live Pi installation. Publication remains explicit and uses the [release procedure](NPM_RELEASE.md).

The website is static HTML and CSS in `site/`. After installing the pinned Playwright browser with `npx --no-install playwright install chromium`, run `npm run check:site` to check versions, links, and desktop, tablet, and mobile layouts. GitHub Pages deploys it from `main` after those checks pass.

[Security model](SECURITY_MODEL.md) · [Third-party components](THIRD_PARTY.md) · [Release notes](CHANGELOG.md) · [MIT License](LICENSE)
