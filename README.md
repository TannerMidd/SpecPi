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

SpecPi is a small starting point for the [Pi coding agent](https://pi.dev/). It is one opinionated setup for how the agent should work, not a marketplace of plugins.

At the center are two built-in extensions. **Scope control** keeps each task to the files it said it would touch. The **improvement loop** turns repeated friction into small, tested changes to the setup, instead of letting prompts and workarounds pile up. Around those are seven hand-picked packages, each locked to an exact version and checked before anything installs, plus **SpecPi Chat**, a VS Code panel for working alongside the agent.

It focuses on five things:

- **Control:** clear scope, tool permissions, and lifecycle commands that ask before they change anything
- **Accuracy:** exact version pins, checksums on state, rollback on failure, and proof over promises
- **Improvement:** local notes become small, checked changes through `/harness-improvement`
- **Efficiency:** delegation, persistent goals, and browser QA handled by the right tool for the job
- **Lean default:** web access, browser QA, and delegation stay off until you need them. Turn them on for a session with `/webaccess on`, `/browser on`, and `/delegate on` — or let the agent ask when it hits the need, and answer the prompt

Everything it touches is written down, versioned, and easy to undo.

## Measured context

This chart shows first-call context from a clean install: all seven pinned packages, the working agreement, and the skills Pi finds. "Enabled" means browser QA, delegation, and web access are switched on, with no goal, scope, or improvement selection active.

The solid rows are measured by us, from the request each setup actually sends through one local test provider. That includes OpenCode and Oh My Pi, both measured as installed. The faded Codex CLI and Claude Code rows come from HarnessTax's published numbers, measured under their own setup. Treat those as a rough reference, not a head-to-head test. These are character counts. They say nothing about tokens, cost, or how well each tool does the job. The research page [breaks down the enabled setup by feature](https://tannermidd.github.io/SpecPi/research/#specpi), so you can see what each switch costs on its own.

<p align="center">
  <a href="https://tannermidd.github.io/SpecPi/research/#specpi">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://tannermidd.github.io/SpecPi/media/context-chart-dark.svg">
      <img src="https://tannermidd.github.io/SpecPi/media/context-chart-light.svg" width="880" alt="Bar chart of characters sent on the first model call: Pi stock 5,521, SpecPi default 15,069, OpenCode 31,043, SpecPi enabled 40,203, Codex CLI 41,616, Oh My Pi 65,816, Claude Code 90,460.">
    </picture>
  </a>
</p>
<p align="center"><sub>Measured tool schemas + system/developer instructions · <code>node scripts/measure-context.mjs --chart --omp=&lt;path to Oh My Pi's cli.js&gt; --oc=&lt;path to OpenCode's binary&gt;</code> · <a href="site/research/context-measurement.json">Recorded measurements and package pins</a> · <a href="https://tannermidd.github.io/SpecPi/research/#specpi">Method and caveats</a></sub></p>

The gap between the two SpecPi bars comes from a few separate switches, so the enabled tools are also measured group by group. For example, the fourteen browser QA tools add up to less than the four web access tools:

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
