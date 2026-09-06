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

Delegation is enabled at startup. Use `/delegate off` to turn it off.

[Setup, updates & removal](https://tannermidd.github.io/SpecPi/wiki/#getting-started) · [Delegation settings](docs/delegation/README.md)

## SpecPi Chat for VS Code

Chat beside your code, attach files, and switch conversations.

[**Install from Marketplace**](https://marketplace.visualstudio.com/items?itemName=tannermidd.specpi-chat) · Requires the setup above and VS Code 1.96+.

In VS Code, find **SpecPi Chat** by **tannermidd** in Extensions and install it. Open **SpecPi** in the Activity Bar, then **Connect Pi**.

## Go further

[Commands](https://tannermidd.github.io/SpecPi/wiki/#reference) · [Chat help](https://github.com/TannerMidd/SpecPi/blob/main/vscode/README.md) · [Development](https://tannermidd.github.io/SpecPi/wiki/#development) · [Security](SECURITY_MODEL.md) · [Release notes](CHANGELOG.md)

[MIT License](LICENSE)
