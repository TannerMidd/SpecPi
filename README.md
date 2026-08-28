# ZenPi

> **Breathe. Then build.**

ZenPi is a calm, explicit, provider-safe harness for the [Pi coding agent](https://pi.dev/). It combines a quiet Tea House interface with conservative automation, bounded delegation, and evidence-driven improvements—without taking ownership of the parts of Pi that should remain yours.

Visit the [ZenPi showcase](https://tannermidd.github.io/ZenPi/) for the ideas, features, and ethos behind the setup.

Installation is review-first. ZenPi does not silently replace authentication, providers, models, trust decisions, sessions, or history.

### Design principles

- **Calm by default.** The interface stays quiet so the work remains visible.
- **Explicit by design.** Plans do not mutate; install, update, and uninstall require confirmation.
- **Provider-safe delegation.** Native children inherit the exact parent model.
- **Improve from evidence.** Repeated capability gaps become a measured wishlist rather than prompt folklore.

## What it installs

- Tea House theme and the `/zen` ambience extension.
- A privacy-minimized capability-gap collector and generated tool wishlist.
- Managed isolated Chromium tools for rendered web QA and visual regression on hosts satisfying Playwright's Chromium system requirements.
- Pinned, reviewed Pi packages.
- A DonSeTch on-demand skill (the external CLI remains optional).
- Bounded `pi-subagents` runtime configuration.
- Strict native-subagent model inheritance.
- Disabled `codex-exec` and `codex-exec-writer` external subscription runners.
- A marked ZenPi section in global `AGENTS.md`.
- Optional `pi-core`, `pi-plan`, and `pi-full` shell profiles.
- A manifest, checksums, and timestamped backups of overwritten ZenPi resource files.

On Pi 0.37.4 or newer, interactive sessions open with a grand, centered Pi glyph:

```text
      ░░      ░░
  ██████████████████
     ████    ████
     ████    ████
     ████    ████
     ████    ████

       Z e n P i
  breathe · then build
```

The banner collapses to one centered line in narrow terminals. `/zen` toggles the banner, breathing work indicator, and quiet clock together; disabling it restores Pi's default interface.

## Safety invariant

ZenPi configures native children with:

```json
{
  "modelScope": {
    "enforce": true,
    "strict": true,
    "allow": ["inherit"]
  }
}
```

Every native child must use the exact parent-session model. An OpenRouter parent therefore cannot silently route native work through an OpenAI Codex subscription. The explicit external Codex CLI runners are disabled as a second guard.

Pi project settings override user settings. A trusted repository can replace `subagents.modelScope` or agent overrides in its own `.pi/settings.json`; inspect such files when this invariant matters. ZenPi does not change `defaultProjectTrust`.

## Requirements

- Pi (0.37.4 or newer for the custom startup wordmark; older versions keep Pi's default header)
- Node.js 22.19 or newer
- Git

ZenPi installs its pinned Playwright 1.62.1 runtime and matching Chromium build inside the Pi agent directory. It does not use a globally installed browser, the user's Chrome profile, cookies, or authenticated sessions. Browser support works out of the box on hosts satisfying [Playwright's Chromium system requirements](https://playwright.dev/docs/intro#system-requirements). On Linux, ZenPi does not run `sudo`, `apt`, or Playwright `install-deps`; install and `./zenpi doctor` report an actionable error when required host libraries are absent.

The files widget additionally expects:

- `bat` (Ubuntu's `batcat` is accepted)
- `delta`
- `glow`

The DonSeTch skill expects a `donsetch` executable. ZenPi does not install it by default.

## Quick start

Clone and inspect the repository before installation:

```bash
git clone https://github.com/TannerMidd/ZenPi.git
cd ZenPi
./zenpi plan
./zenpi install
./zenpi doctor
```

Then run `/reload` in an active Pi session. Open a new shell or source your shell rc file to activate shell profiles.

The installer shows its complete plan and asks for confirmation. For automation after review:

```bash
./zenpi install --yes
```

Optional flags:

```text
--skip-package-install  Write package settings but skip external package installs, including the browser runtime
--skip-browser-install  Install browser tools but skip the managed Playwright/Chromium runtime
--skip-shell            Do not install or source shell profiles
```

ZenPi never installs global external executables. The browser runtime is installed privately under `~/.pi/agent/zenpi/browser-runtime/` after confirmation. Install DonSeTch separately after reviewing its distribution if you want to use the optional skill.

## Browser and visual regression

ZenPi registers native browser tools for opening HTTP(S) pages, setting desktop/tablet/mobile viewports, inspecting rendered DOM content, clicking and filling controls, capturing screenshots, and closing the isolated browser. Screenshots are stored outside the repository by default under:

```text
~/.pi/agent/zenpi/browser-artifacts/<session>/
```

`browser_screenshot` returns conservatively sized PNGs directly to image-capable models as well as their artifact paths; oversized images return only the path. Explicit screenshot, current, and diff outputs are never replaced unless `overwrite=true`. `browser_save_baseline` creates a baseline only at an explicit path and refuses to replace an existing file unless `overwrite=true`. `browser_compare_screenshot` rejects aliased baseline/current/diff paths and never changes the baseline; it reports pixel counts and ratio and writes bounded current and diff artifacts. Set the same viewport before baseline and comparison. ZenPi reduces motion and disables CSS animation/transition timing during captures, but applications should still control clocks, random data, fonts, and asynchronous content for stable regression tests.

Browser contexts are fresh and ephemeral. They do not import the user's normal browser profile or authentication state, and service workers are blocked. Use a dedicated test account only when an application itself requires login.

## Evidence-driven tool wishlist

ZenPi exposes `report_capability_gap` to the agent for material, generalizable friction that remains after reasonable use of existing tools. Tool-specific prompt guidance excludes transient errors, model mistakes, missing credentials or permissions, ordinary project work, and speculative nice-to-haves. Reports are deduplicated per user task.

The collector stores an append-only event log and generates:

```text
~/.pi/agent/zenpi/tool-wishlist-events.jsonl
~/.pi/agent/zenpi/TOOL_WISHLIST.md
```

Run `/wishlist` to regenerate and automatically render the Markdown report in the conversation without sending it to the model; on older compatible Pi versions it opens in a viewer whose edits are ignored. The generated file path remains visible below the report. Very large reports are display-truncated while the complete file is preserved. The report ranks gaps using unique-task occurrences and impact, and includes distinct-session and distinct-project counts. Session and project identities are stored only as salted hashes. Reports are length-limited summaries; the extension instructs the agent never to include prompts, source code, commands, paths, credentials, or other secrets, and applies additional best-effort redaction for common URL, path, token, authorization-header, and private-key formats.

Collection favors precision over recall: repeated reports within one user task do not increase metrics, and tool failures are not recorded automatically. Wishlist data is user-generated state and is preserved on update and uninstall. The event log is capped at 5 MiB; if it reaches that limit, archive or remove the JSONL file after reviewing it. `/wishlist` remains able to refresh the existing report while the log is at capacity.

## Commands

```bash
./zenpi plan
./zenpi install
./zenpi update
./zenpi doctor
./zenpi uninstall
```

### Updates

From a reviewed newer checkout or release tag:

```bash
./zenpi plan
./zenpi update
./zenpi doctor
```

ZenPi refuses to overwrite locally modified managed files during updates unless `--force` is supplied. Marked AGENTS and shell blocks are explicitly ZenPi-owned and are updated in place.

### Uninstall

```bash
./zenpi uninstall
```

Uninstall restores pre-install setting values and files when their installed checksums still match. Modified files and settings are preserved with warnings. Downloaded npm caches are left inert rather than deleted unexpectedly.

## Configuration ownership

ZenPi owns only documented paths:

- `theme`
- its pinned entries in `packages`
- selected `subagents` defaults, policy, and role overrides
- `~/.pi/agent/extensions/zen.ts`
- `~/.pi/agent/extensions/browser/index.ts`
- `~/.pi/agent/extensions/browser/core.mjs`
- `~/.pi/agent/extensions/browser/smoke.mjs`
- `~/.pi/agent/zenpi/browser-runtime/`
- `~/.pi/agent/extensions/tool-wishlist/index.ts`
- `~/.pi/agent/extensions/tool-wishlist/core.mjs`
- `~/.pi/agent/extensions/subagent/config.json`
- `~/.pi/agent/skills/donsetch/SKILL.md`
- `~/.pi/agent/themes/tea-house.json`
- a marked block in `~/.pi/agent/AGENTS.md`
- a marked shell source block when shell profiles are enabled

It does **not** own or inspect credentials, provider configuration, default models, trust decisions, sessions, or history.

State, wishlist data, and backups of replaced ZenPi-managed resource files are stored under:

```text
~/.pi/agent/zenpi/
```

Set `PI_CODING_AGENT_DIR` to use a different Pi agent directory. Uninstall removes the managed browser runtime and extensions but preserves browser artifacts, wishlist events, and the generated report.

## Pi package mode

The repository also contains a standard `pi` package manifest. Installing it with `pi install` loads only the declared extension, skill, and theme resources; it does not provision the managed Chromium runtime or apply the complete harness policy. Use the explicit ZenPi installer for managed browser support on a host satisfying Playwright's Chromium system requirements and for the full setup.

## Development

```bash
npm test
npm run check
```

Integration tests use temporary Pi agent directories. Most skip external installation; a fake pinned browser runtime exercises successful install/reuse/doctor/uninstall and rollback without network access. Release validation additionally exercises the real managed browser smoke probe in a temporary directory.

The zero-dependency showcase site lives in `site/`. Its GitHub Pages workflow publishes that directory directly, with no generated files or package installation.

## Security

Pi packages and extensions execute with user permissions. Review ZenPi and every pinned third-party package before installation. See [SECURITY.md](SECURITY.md) and [THIRD_PARTY.md](THIRD_PARTY.md).

## License

MIT. Third-party components retain their own licenses.
