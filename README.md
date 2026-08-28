# ZenPi

> **Breathe. Then build.**

ZenPi is a small, opinionated layer for the [Pi coding agent](https://pi.dev/).
It makes Pi calmer to use, safer to delegate through, and ready for browser QA—without taking ownership of your providers, credentials, models, sessions, or trust decisions.

[Visit the showcase](https://tannermidd.github.io/ZenPi/)

## The idea

- **Calm.** Keep the interface quiet and the work visible.
- **Explicit.** Show the plan before changing anything.
- **Inherited.** Native subagents use the parent session's exact model.
- **Evidenced.** Turn repeated capability gaps into a measured wishlist.

No hidden setup. No provider switching. No silent system installs.

## Install

Requires Pi 0.37.4 or newer, Node.js 22.19 or newer, npm, and Git. The default install also needs network access to download pinned Pi packages and Chromium.

Install from a release tag you have reviewed:

```bash
git clone https://github.com/TannerMidd/ZenPi.git
cd ZenPi
git checkout <release-tag>
./zenpi plan
# Review the plan and source, then:
./zenpi install
./zenpi doctor
```

For unreleased development, pin and review a specific commit instead of trusting a moving branch. Then run `/reload` in Pi. Open a new shell, or source your shell rc file, if you enabled the shell profiles.

`plan` never mutates. `install`, `update`, and `uninstall` ask for confirmation unless `--yes` is supplied.

Useful flags:

```text
--yes                   Skip confirmation after review
--force                 Replace locally modified managed files during update
--skip-package-install  Write pinned package settings without downloading them; also skip the browser runtime
--skip-browser-install  Install browser tools without the managed Playwright/Chromium runtime
--skip-shell            Skip shell profiles
```

## What you get

### A quieter Pi

Tea House colors, a restrained startup mark, a soft working rhythm, and optional `pi-core`, `pi-plan`, and `pi-full` shell profiles.

Use `/zen` to toggle the ambience without touching Pi's core.

### Delegation that stays put

Native subagents inherit the exact parent model. An OpenRouter session cannot silently become a Codex subscription run. The external `codex-exec` runners are disabled.

Trusted project settings can override user settings, so review a repository's `.pi/settings.json` when this boundary matters.

### Browser QA included

ZenPi installs a pinned Playwright runtime and matching Chromium build in its private state directory. Browser tools can open pages, inspect rendered content, interact with controls, switch responsive viewports, capture screenshots, and compare explicit visual baselines.

Each browser context is fresh. It does not use your personal browser profile, cookies, passwords, extensions, or sessions. Baselines are never created or replaced implicitly, and output files are not overwritten without `overwrite=true`.

Default artifacts live under:

```text
~/.pi/agent/zenpi/browser-artifacts/
```

Tools with an explicit output path can write screenshots, baselines, and diffs elsewhere. Treat every artifact as potentially sensitive.

The host must satisfy [Playwright's Chromium system requirements](https://playwright.dev/docs/intro#system-requirements). ZenPi never runs `sudo`, `apt`, or `playwright install-deps`.

### A wishlist earned through use

When a real, reusable capability gap remains, the agent can record a privacy-minimized report. Reports are deduplicated by task and aggregated by impact.

Run `/wishlist` to regenerate and display the Markdown report without adding it to model context. Capabilities implemented by ZenPi are retired from the active report while their append-only history is preserved. The complete report remains at:

```text
~/.pi/agent/zenpi/TOOL_WISHLIST.md
```

Very large reports are truncated only in the display. The stored file remains complete.

## Boundaries

ZenPi:

- prints its plan before installation;
- merges only documented settings;
- changes AGENTS and shell files only inside marked blocks;
- backs up files it replaces during installation and records checksums;
- rolls configuration back when installation fails;
- never reads Pi authentication, provider credentials, sessions, history, or trust decisions;
- never installs global executables or operating-system packages;
- refuses to overwrite modified managed files during update unless `--force` is supplied;
- preserves modified managed files during uninstall with warnings.

`defaultProjectTrust` is left unchanged.

See [SECURITY.md](SECURITY.md) for the full trust model and [THIRD_PARTY.md](THIRD_PARTY.md) for pinned dependencies.

## Commands

```bash
./zenpi plan
./zenpi install
./zenpi update
./zenpi doctor
./zenpi uninstall
```

For an update, review the new release tag, then run `plan`, `update`, and `doctor`. A forced update replaces local changes to managed files; save anything you need first.

State, backups, default browser artifacts, and wishlist data live under `~/.pi/agent/zenpi/`. Set `PI_CODING_AGENT_DIR` to move the Pi agent directory. Uninstall removes managed extensions and the browser runtime while preserving browser artifacts and wishlist data.

## Optional pieces

The files widget uses `bat` (or Ubuntu's `batcat`), `delta`, and `glow`.

The bundled DonSeTch skill expects a separately installed `donsetch` executable. ZenPi does not install it for you.

Installing this repository with `pi install` loads its extensions, skill, and theme, but does not provision Chromium or apply the complete harness policy. Use `./zenpi install` for the full setup.

When package or browser downloads are skipped, their settings and tools may still be present, but the corresponding capabilities remain unavailable until their runtimes are installed.

## Development

```bash
npm run check
```

Tests use temporary Pi agent directories and do not install into the live Pi configuration.

## License

MIT. Third-party components retain their own licenses.
