<p align="center">
  <img src="site/logo.svg" width="104" alt="ZenPi logo">
</p>

<h1 align="center">ZenPi</h1>

<p align="center"><strong>Breathe. Then build.</strong></p>

<p align="center">
  A self-improving harness for the
  <a href="https://pi.dev/">Pi coding agent</a>.
</p>

<p align="center">
  <a href="https://tannermidd.github.io/ZenPi/"><strong>Showcase</strong></a>
  · <a href="#install">Install</a>
  · <a href="SECURITY.md">Security</a>
</p>

---

## Let friction teach the system

Most agent setups grow by accumulation. **ZenPi grows by evidence.**

When a real capability gap keeps getting in the way, ZenPi turns that friction into a privacy-minimized wishlist—so use becomes signal, and signal becomes deliberate improvement.

<p align="center">
  <code>notice → name → measure → improve → retire</code>
</p>

Attentive enough to notice. Explicit enough to trust. Human-directed by design.

## What it adds

- A distinct Tea House interface and optional shell profiles
- A focused `/zen` mode with live activity, collapsed output, and deliberate execution guidance
- Strict model inheritance for native subagents
- Isolated browser tools for rendered UI checks
- A measured capability wishlist built from recurring friction
- Review-first installation with backups, checksums, and rollback

## Zen mode

`/zen` enters an opt-in focused execution mode. It adds an unmistakable activity panel, collapses tool output, reports the current work phase, and guides the agent toward one deliberate, validated objective at a time. Run `/zen` again—or press `Ctrl+Alt+Z`—to restore the standard interface.

Use `/zen on`, `/zen off`, or `/zen status` when explicit control is preferable.

## Install

Requires Pi 0.80.0+, Node.js 22.19+, npm, and Git. On Linux, the default managed browser runtime also requires the host libraries needed by Playwright Chromium; use `--skip-browser-install` when those libraries are unavailable. Winget is optional and is used on Windows only when you choose automatic installation of `bat`, `git-delta`, or `glow`.

Clone the reviewed release tag, then open a terminal in the cloned directory:

```text
git clone --branch v0.2.0 --depth 1 https://github.com/TannerMidd/ZenPi.git
cd ZenPi
```

**Windows PowerShell or Command Prompt**

```powershell
.\zenpi.cmd plan      # inspect every proposed change
.\zenpi.cmd install   # review and confirm the installation
.\zenpi.cmd doctor
```

**Linux, macOS, or Git Bash**

```bash
./zenpi plan      # inspect every proposed change
./zenpi install   # review and confirm the installation
./zenpi doctor
```

Do not double-click the launchers: Windows may open extensionless scripts as code instead of executing them. Windows installs all core ZenPi resources; only the optional bash/zsh shell-profile integration is skipped.

A default install runs `pi install` for every pinned Pi package. Pi installs each package and its npm dependency tree under the Pi agent directory. ZenPi separately runs `npm ci` from its reviewed lockfile for Playwright and the managed Chromium runtime. Neither dependency install happens when `--skip-package-install` is supplied; `--skip-browser-install` skips only the browser runtime.

For optional command-line tools, the plan prints each pinned install source or command first. Interactive installs ask separately about `bat`, `git-delta`, `glow`, and DonSeTch. `--yes` confirms the core installation and attempts every missing optional tool; pass `--skip-tool-install` to opt out. An unavailable manager or failed optional-tool command is reported as a warning and does not roll back the core ZenPi install. ZenPi uses exact Winget versions on Windows, checksum-verified pinned release binaries in ZenPi state on Linux/macOS, and pinned `donsetch@3.4.0` through npm. Managed Linux/macOS binaries are removed by `zenpi uninstall`; Winget and global npm changes are external system state and remain installed. On `/reload`, ZenPi validates the managed-tool manifest and adds only matching checksummed binaries to Pi's process `PATH`, even when shell integration was skipped.

Run `/reload` in Pi after installation. Use the same platform launcher with `update` or `uninstall` later; both remain explicit and reversible.

## Improve through use

When existing tools cannot solve a material, reusable problem, ZenPi can record a sanitized capability-gap report. Collection is local-only and fail-closed: the first report asks for an explicit on/off decision, which can later be changed with `/wishlist on` or `/wishlist off`.

`/wishlist` ranks unique-task evidence by impact, project reach, session reach, recency, and stable ID. `/wishlist next` shows one qualified candidate and a minimal improvement card rather than a dashboard. Selection, decline, retirement, and reopening happen only through explicit commands; the reporting tool cannot change lifecycle state or modify ZenPi.

```text
/wishlist next
/wishlist select <gap-id>
/wishlist decline <gap-id>
/wishlist retire <gap-id> <validation note>
/wishlist reopen <gap-id>
```

The bundled `zenpi-improve` skill guides an approved selected gap through a smallest-change hypothesis, direct acceptance check, rollback, and review. Selection authorizes preparation of that card—not source edits. Implementation still requires explicit approval.

Implemented capabilities come from a reviewed registry linked to closed, deterministic `zenpi doctor` validators. Later friction is retained as a regression signal and marked `review-needed`; it never reopens work automatically. Exact `/wishlist merge` decisions can join fragmented names and `/wishlist unmerge <decision-id>` reverses them without rewriting observations. `/wishlist draft <gap-id>` renders a sanitized local issue draft but never uploads it.

Confirmed `/wishlist archive` and `/wishlist reset` prepare a private checksummed, recoverable snapshot before clearing the active queue. Collection preference and the private salt remain in place. The reporting contract forbids prompts, source code, commands, credentials, and raw project identities; bounded redaction removes recognizable paths, URLs, and credential patterns, but users should still review local output before sharing it.

```text
~/.pi/agent/zenpi/TOOL_WISHLIST.md
~/.pi/agent/zenpi/tool-wishlist-events.jsonl
~/.pi/agent/zenpi/tool-wishlist-decisions.jsonl
~/.pi/agent/zenpi/tool-wishlist-archives/
```

## Boundaries

ZenPi does not own or inspect your credentials, providers, models, sessions, history, or trust decisions. It changes only documented settings and its own marked blocks. Optional executables are installed only after an interactive per-tool choice or when `--yes` explicitly selects all missing tools. `--skip-tool-install` skips optional tools while leaving the normal Pi-package and browser-runtime installation enabled.

For the complete trust model, browser isolation details, installer flags, and update behavior, read [SECURITY.md](SECURITY.md).

## Development

```bash
npm run check
```

MIT licensed.
