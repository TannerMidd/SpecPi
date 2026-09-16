<p align="center">
  <img src="https://tannermidd.github.io/SpecPi/logo.svg" width="88" alt="SpecPi logo">
</p>

<h1 align="center">SpecPi</h1>

<p align="center">A Pi harness setup, built to specification.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/specpi"><img src="https://img.shields.io/npm/v/specpi?style=flat-square&amp;color=084bdb" alt="npm version"></a>
  <a href="https://github.com/TannerMidd/SpecPi/actions/workflows/ci.yml"><img src="https://github.com/TannerMidd/SpecPi/actions/workflows/ci.yml/badge.svg?branch=main" alt="Build status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-084bdb?style=flat-square" alt="MIT license"></a>
</p>

<p align="center">
  <a href="https://tannermidd.github.io/SpecPi/">Website</a> · <a href="https://tannermidd.github.io/SpecPi/wiki/">Documentation</a> · <a href="https://github.com/TannerMidd/SpecPi/releases">Releases</a>
</p>

<p align="center">
  <a href="https://tannermidd.github.io/SpecPi/#vscode-chat">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://tannermidd.github.io/SpecPi/media/specpi-chat-showcase-dark.png">
      <img src="https://tannermidd.github.io/SpecPi/media/specpi-chat-showcase-light.png" width="1100" alt="SpecPi Chat in VS Code: an open file beside the chat panel discussing a focused change.">
    </picture>
  </a>
</p>
<p align="center"><sub>SpecPi Chat · Example workspace</sub></p>

---

SpecPi is a small base for the [Pi coding agent](https://pi.dev/), assembled from deliberate choices about how the agent should work — not a curated marketplace.

Two first-party extensions set the terms: **scope control**, which holds each task to the files it declared, and an **improvement loop**, which turns recurring friction into tested, evidence-backed harness changes instead of accumulated prompts and workarounds. Around them sit six hand-picked packages, each pinned to an exact version and verified before any transaction completes, and **SpecPi Chat**, a VS Code frontend for working beside the agent.

The setup optimizes for four things:

- **Control** — declared scope, tool permissions, and confirmation-gated lifecycle commands
- **Accuracy** — exact pins, checksum-tracked state, rollback on failure, and evidence over claims
- **Improvement** — local observations become bounded, verified changes through `/harness-improvement`
- **Efficiency** — subagent delegation, persistent goals, and browser QA handled by the right tools

Everything it manages is declared, versioned, and reversible.

## Install

Requires Node.js 22.19+, Git, npm, and an existing Pi installation on PATH.

```sh
npm install --global specpi@latest
specpi plan
specpi install
specpi doctor
```

`plan` shows what will change without modifying anything. Restart Pi after install.

Full setup options, package details, and requirements: [website](https://tannermidd.github.io/SpecPi/#install).

## Where things live

| | |
| --- | --- |
| [Packages](https://tannermidd.github.io/SpecPi/#packages) | The six pinned packages and what each provides |
| [Scope control](https://tannermidd.github.io/SpecPi/wiki/#scope) | `/scope` commands and drift monitoring |
| [Improvement loop](https://tannermidd.github.io/SpecPi/#loop) | Local wishlist, `/harness-improvement`, and retirement with evidence |
| [SpecPi Chat](https://tannermidd.github.io/SpecPi/#vscode-chat) | VS Code frontend and VSIX install · [Chat guide](https://github.com/TannerMidd/SpecPi/blob/main/vscode/README.md) |
| [Updating](https://tannermidd.github.io/SpecPi/#updating) | Update, uninstall, and migration notes |

## Development

```sh
npm install --ignore-scripts --omit=peer --no-package-lock
node --test tests/workflow-controls.test.mjs tests/workflow-controls-extension.test.mjs
npm run check
```

Installer tests use disposable Pi directories — never test against a live Pi installation. Publication follows the [release procedure](NPM_RELEASE.md).

[Security model](SECURITY_MODEL.md) · [Third-party components](THIRD_PARTY.md) · [Release notes](CHANGELOG.md) · [MIT License](LICENSE)
