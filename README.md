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
- **Structural search.** Opt into bounded ast-grep patterns over selected code with `specpi update --structural-search=on`. [Usage and limits](docs/structural-search.md)
- **Accessibility checks.** Scan the current browser state for automated WCAG and optional best-practice findings. [Browser verification](docs/browser-testing.md)
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

To pin this release, use `npm install --global specpi@0.20.0`.

Delegation is enabled at startup. Use `/delegate off` to turn it off.

[Setup, updates & removal](https://tannermidd.github.io/SpecPi/wiki/#getting-started) · [Delegation settings](docs/delegation/README.md)

## SpecPi Chat for VS Code

Chat beside your code, attach files, and switch conversations.

[**Install from Marketplace**](https://marketplace.visualstudio.com/items?itemName=tannermidd.specpi-chat) · Requires VS Code 1.96+, Node.js 22.19+, and Pi 0.84.4+. SpecPi is optional.

In VS Code, find **SpecPi Chat** by **tannermidd** in Extensions and install it. Open **SpecPi** in the Activity Bar, then **Connect Pi**.

Chat 0.4.4 shows a compact delegation strip only while workers run or settle, and opens workspace image links in the image viewer. SpecPi 0.19.1 fixes delegation when switching GitHub Copilot models in the same chat, including Luna → Opus → Luna. Update the harness and use **Restart Pi** to load the fix; this patch does not require a Chat update. Later model switches do not require a restart. New Chat sessions start with Guard off; use `/guard guard` or `/guard strict` to enable it.

## Go further

[Commands](https://tannermidd.github.io/SpecPi/wiki/#reference) · [Chat help](https://github.com/TannerMidd/SpecPi/blob/main/vscode/README.md) · [Development](https://tannermidd.github.io/SpecPi/wiki/#development) · [Security](SECURITY_MODEL.md) · [Release notes](CHANGELOG.md)

[MIT License](LICENSE)
