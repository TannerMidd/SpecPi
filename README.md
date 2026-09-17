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

Two first-party extensions set the terms: **scope control**, which holds each task to the files it declared, and an **improvement loop**, which turns recurring friction into tested, evidence-backed harness changes instead of accumulated prompts and workarounds. Around them sit seven hand-picked packages, each pinned to an exact version and verified before any transaction completes, and **SpecPi Chat**, a VS Code frontend for working beside the agent.

The setup optimizes for four things:

- **Control** — declared scope, tool permissions, and confirmation-gated lifecycle commands
- **Accuracy** — exact pins, checksum-tracked state, rollback on failure, and evidence over claims
- **Improvement** — local observations become bounded, verified changes through `/harness-improvement`
- **Efficiency** — subagent delegation, persistent goals, and browser QA handled by the right tools
- **Lean default** — web access, browser QA, and delegation ship hidden; `/webaccess on`, `/browser on`, and `/delegate on` offer them per session

Everything it manages is declared, versioned, and reversible.

## Measured context

The chart measures first-call context from a clean installation: all seven pinned packages, the installed working agreement, and discovered skills. “Enabled” means browser QA, delegation, and web access are switched on; no goal, scope, or improvement selection is active. The solid rows — including Oh My Pi, a Bun-based fork of Pi measured as installed — are ours, taken from the request each harness actually sends through one local synthetic provider. The dimmed Codex CLI and Claude Code rows are HarnessTax's published figures, taken under the study's configuration: a reference, not a matched comparison. These are character counts, not tokens, spending, or task-quality scores. The research page [breaks the enabled profile down by capability](https://tannermidd.github.io/SpecPi/research/#specpi), so the cost of each switch is visible on its own.

<p align="center">
  <a href="https://tannermidd.github.io/SpecPi/research/#specpi">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://tannermidd.github.io/SpecPi/media/context-chart-dark.svg">
      <img src="https://tannermidd.github.io/SpecPi/media/context-chart-light.svg" width="880" alt="Bar chart of characters sent on the first model call: Pi stock 5,521, SpecPi default 15,069, SpecPi enabled 40,203, Codex CLI 41,616, Oh My Pi 65,816, Claude Code 90,460.">
    </picture>
  </a>
</p>
<p align="center"><sub>Measured tool schemas + system/developer instructions · <code>node scripts/measure-context.mjs --chart --omp=&lt;path to its cli.js&gt;</code> · <a href="site/research/context-measurement.json">Recorded measurements and package pins</a> · <a href="https://tannermidd.github.io/SpecPi/research/#specpi">Method and caveats</a></sub></p>

The gap between the two SpecPi bars is not one decision, so the enabled profile's tool schema is also measured group by group. Browser QA's fourteen tools cost less together than web access's four:

<p align="center">
  <a href="https://tannermidd.github.io/SpecPi/research/#specpi">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://tannermidd.github.io/SpecPi/media/capability-chart-dark.svg">
      <img src="https://tannermidd.github.io/SpecPi/media/capability-chart-light.svg" width="880" alt="Bar chart of tool-schema characters each capability adds: Pi built-ins 2,896, Improvement loop 4,214, Goals 1,315, Browser QA 8,046, Delegation 4,453, Web access 11,298. Browser QA, Delegation, Web access are hidden until switched on.">
    </picture>
  </a>
</p>
<p align="center"><sub>Every tool in the measured request belongs to exactly one group · Leaving all three opt-in groups hidden keeps 23,797 characters of tool schema out of every request</sub></p>

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
| [Packages](https://tannermidd.github.io/SpecPi/#packages) | The seven pinned packages and what each provides |
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
