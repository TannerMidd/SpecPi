<p align="center">
  <img src="site/logo.svg" width="104" alt="SpecPi logo">
</p>

<h1 align="center">SpecPi</h1>

<p align="center">
  A small toolkit for the <a href="https://pi.dev/">Pi coding agent</a>.
</p>

<p align="center">
  <a href="#install">Install</a>
  · <a href="https://tannermidd.github.io/SpecPi/">Website</a>
  · <a href="https://tannermidd.github.io/SpecPi/wiki/">Documentation</a>
</p>

SpecPi extends Pi with chat, review tools, and focused delegation. Its principles are simple: you choose the improvements, changes stay small and reversible, improvement records stay local, and checks matter more than an agent's claims.

<details>
<summary>Watch the showcase · 51 seconds</summary>

<p>
  <a href="https://tannermidd.github.io/SpecPi/#showcase">
    <img src="https://tannermidd.github.io/SpecPi/media/showcase-poster.jpg" width="560" alt="Play the SpecPi showcase">
  </a>
</p>

</details>

## What it adds

- **Focused delegation.** One agent makes changes. Up to two read-only subagents help investigate and review. [Research and design](https://tannermidd.github.io/SpecPi/single-agent/)
- **Background tasks.** Start an approved dev server, test suite, or watch build, inspect bounded output, and stop it without blocking other work.
- **Review as you work.** Track changed files, inspect diffs, check pages in a browser, and review risky commands.
- **Improvements you choose.** Record recurring problems, select one with `/harness-improvement`, and test the change before calling it done.

Problem collection is off by default. Its records stay on your machine. Pi connects to your chosen model provider.

## Install

Requires **Node.js 22.19+**, **npm**, and **Git**. SpecPi needs **Pi 0.84.4+**; the installer can add it if missing.

```sh
npm install --global specpi@latest
specpi plan
specpi install
specpi doctor
```

Preview the changes, confirm the install, then check the setup. Restart Pi when finished.

To pin this release, use `npm install --global specpi@0.19.0`.

Delegation is enabled at startup. Use `/delegate off` to turn it off.

[Setup, updates & removal](https://tannermidd.github.io/SpecPi/wiki/#getting-started) · [Delegation settings](docs/delegation/README.md)

## Background tasks

Ask Pi to start a long-running command with `background_start`, then use `background_list`, `background_logs`, and `background_stop` to observe and clean up tasks. `background_start` accepts `command`, optional `cwd`/`label`, and `timeoutSeconds` (1–28,800; default 1,800). It requires interactive approval even with Guard off; Guard denials and locks still apply. Headless starts are denied.

Commands use `/bin/sh` on POSIX or system `cmd.exe` on Windows, not Pi's configured Bash. They inherit the process environment except `NODE_OPTIONS` and `NODE_PATH`, which are cleared to keep the supervisor's startup predictable. No PTY or interactive stdin is provided. Four active tasks are allowed; output is capped at 256 KiB per task, reads at 64 KiB, and completed records at 32. Log offsets are absolute bytes in the UTF-8 stream including stdout/stderr markers, before terminal-control escaping; responses report the next cursor and lost bytes.

Stop tasks when finished. Session replacement, reload, tree navigation, and shutdown attempt bounded cleanup. `cleanup: confirmed` means the owned root/group termination was observed, not that escaped descendants are contained; unconfirmed cleanup retains its slot and may need manual process inspection. Spawn success is not service readiness. Output is memory-only in the extension, but returned text may enter Pi conversation/provider retention. See the [security boundary](SECURITY_MODEL.md#background-task-execution).

## SpecPi Chat for VS Code

Chat beside your code, attach files, and switch conversations.

[**Install from Marketplace**](https://marketplace.visualstudio.com/items?itemName=tannermidd.specpi-chat) · Requires VS Code 1.96+, Node.js 22.19+, and Pi 0.84.4+. SpecPi is optional.

In VS Code, find **SpecPi Chat** by **tannermidd** in Extensions and install it. Open **SpecPi** in the Activity Bar, then **Connect Pi**.

Chat 0.4.1 shows a compact delegation strip only while workers run or settle, and opens workspace image links in the image viewer. SpecPi 0.19.0 includes the delegation fix for switching models in the same chat. Update both packages, reload VS Code for the Chat update, and use **Restart Pi** to load the harness update. Later model switches do not require a restart. New Chat sessions start with Guard off; use `/guard guard` or `/guard strict` to enable it.

## Go further

[Commands](https://tannermidd.github.io/SpecPi/wiki/#reference) · [Chat help](https://github.com/TannerMidd/SpecPi/blob/main/vscode/README.md) · [Development](https://tannermidd.github.io/SpecPi/wiki/#development) · [Security](SECURITY_MODEL.md) · [Release notes](CHANGELOG.md)

[MIT License](LICENSE)
