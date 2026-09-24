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
  <a href="https://tannermidd.github.io/SpecPi/">Website</a> · <a href="https://tannermidd.github.io/SpecPi/wiki/">Documentation</a> · <a href="https://tannermidd.github.io/SpecPi/evaluations/">Evaluations</a> · <a href="https://github.com/TannerMidd/SpecPi/releases">Releases</a>
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

SpecPi 0.34.0 is a small starting point for the [Pi coding agent](https://pi.dev/). It is one opinionated setup for how the agent should work, not a marketplace of plugins.

At the center are two built-in extensions. **Scope control** keeps each task to the files it said it would touch. The **improvement loop** turns repeated friction into small, tested changes to the setup, instead of letting prompts and workarounds pile up. Around those are eight hand-picked packages, each locked to an exact version and checked before anything installs, plus **SpecPi Chat**, a VS Code panel for working alongside the agent.

It focuses on five things:

- **Control:** clear scope, tool permissions, and lifecycle commands that ask before they change anything
- **Accuracy:** exact version pins, checksums on state, rollback on failure, and proof over promises
- **Improvement:** local notes become small, checked changes through `/harness-improvement`
- **Efficiency:** delegation, persistent goals, and browser QA handled by the right tool for the job
- **Keep talking:** long evals, builds and servers can run as background jobs, so the conversation is not stuck until they finish. The agent hears back when each one ends, and `/jobs` lists or stops them
- **Lean default:** web access, browser QA, and delegation stay off until you need them. Turn them on for a session with `/webaccess on`, `/browser on`, and `/delegate on` — or let the agent ask when it hits the need, and answer the prompt

Everything it touches is written down, versioned, and easy to undo.

## Measured context

This chart shows first-call context from a clean install: all eight pinned packages, the working agreement, and the skills Pi finds, in an interactive session with wishlist collection undecided. A headless session, or one with collection off, also leaves out the gap report and capability request tools. "Enabled" means browser QA, delegation, and web access are switched on, with no goal, scope, or improvement selection active.

The solid rows are measured by us, from the request each setup actually sends through one local test provider. That includes OpenCode, the DeepSeek Harness, and Oh My Pi, all measured as installed. The faded Codex CLI and Claude Code rows come from HarnessTax's published numbers, measured under their own setup. Treat those as a rough reference, not a head-to-head test. These are character counts. They say nothing about tokens, cost, or how well each tool does the job. The research page [breaks down the enabled setup by feature](https://tannermidd.github.io/SpecPi/research/#specpi), so you can see what each switch costs on its own.

<p align="center">
  <a href="https://tannermidd.github.io/SpecPi/research/#specpi">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://tannermidd.github.io/SpecPi/media/context-chart-dark.svg">
      <img src="https://tannermidd.github.io/SpecPi/media/context-chart-light.svg" width="880" alt="Bar chart of characters sent on the first model call: Pi stock 5,521, SpecPi default 12,287, OpenCode 31,043, DeepSeek Harness 31,743, SpecPi enabled 36,935, Codex CLI 41,616, Oh My Pi 66,708, Claude Code 90,460.">
    </picture>
  </a>
</p>
<p align="center"><sub>Measured tool schemas + system/developer instructions · <code>node scripts/measure-context.mjs --chart --omp=&lt;path to Oh My Pi's cli.js&gt; --oc=&lt;path to OpenCode's binary&gt; --dsh=&lt;path to the DeepSeek Harness bin&gt;</code> · <a href="site/research/context-measurement.json">Recorded measurements and package pins</a> · <a href="https://tannermidd.github.io/SpecPi/research/#specpi">Method and caveats</a></sub></p>

The gap between the two SpecPi bars comes from a few separate switches, so the enabled tools are also measured group by group. For example, the fourteen browser QA tools add up to less than the four web access tools:

<p align="center">
  <a href="https://tannermidd.github.io/SpecPi/research/#specpi">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://tannermidd.github.io/SpecPi/media/capability-chart-dark.svg">
      <img src="https://tannermidd.github.io/SpecPi/media/capability-chart-light.svg" width="880" alt="Bar chart of tool-schema characters each capability adds: Pi built-ins 2,896, Improvement loop 1,601, Capability request 995, Background jobs 728, Goals 1,315, Browser QA 8,234, Delegation 4,453, Web access 11,298. Browser QA, Delegation, Web access are hidden until switched on.">
    </picture>
  </a>
</p>
<p align="center"><sub>Every tool in the measured request belongs to exactly one group · Leaving all three opt-in groups hidden keeps 23,797 characters of tool schema out of every request</sub></p>

## Harness evaluations

The chart above counts characters. It says nothing about what a harness costs to
actually use, or whether it finishes the job. That is what the evals are for:
[Terminal-Bench 2.0](https://www.tbench.ai/), the same model and the same frozen
price list, with only the harness changing.

<!-- eval-summary -->

**675 scored attempts across 20 tasks and 6 harnesses**,
all on `deepseek-v4.1-flash`. SpecPi is the published 0.33.0 release, with the experimental Jev layer off.

| Harness | Solved | Rate | Cost/attempt | Prompt tokens | Cache hit |
| --- | --- | --- | --- | --- | --- |
| OpenCode | 29/39 | 0.744 | $0.0124 | 494,173 | 96.5% |
| SpecPi | 62/77 | 0.805 | $0.0144 | 407,416 | 92.4% |
| Pi (base) | 164/230 | 0.713 | $0.0155 | 436,214 | 92.9% |
| DeepSeek Harness | 21/38 | 0.553 | $0.0226 | 1,126,586 | 95.4% |
| Oh My Pi | 115/151 | 0.762 | $0.0237 | 1,108,076 | 96.5% |
| Claude Code | 81/112 | 0.723 | $0.0273 | 670,828 | 95.4% |

SpecPi and Pi ran side by side in the 24 Sep · a sitting. SpecPi solved 30/38
against Pi's 25/39 (Fisher p = 0.21), sending 16% fewer prompt tokens and costing
22% less per attempt. On `sanitize-git-repo`, with that sitting's extra attempts, SpecPi solved
10/10 against 3/10 (p = 0.003); `fix-git` was 10/10 for both.

Overall solve rate is a different matter: one sitting cannot rank harnesses here. Bare Pi, on
unchanged software and the same thirteen tasks, spans 56-77% across 5 sittings, a wider gap than any
measured between two harnesses. Pooled across sittings, SpecPi leads DeepSeek Harness (p = 0.007) and Oh My Pi leads DeepSeek Harness (p = 0.015), but pooling sets one harness's sittings against another's. Cost is recomputed from recorded tokens against a dated
price file, never taken from a harness's self-report.

<!-- /eval-summary -->

This run is still in progress. See the results and brief method on the
[evaluations page](https://tannermidd.github.io/SpecPi/evaluations/). The table above is regenerated
from the run data by `node scripts/tb2-site.mjs`, so it cannot drift from the
published figures.

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
| [Packages](https://tannermidd.github.io/SpecPi/#packages) | The eight pinned packages and what each provides |
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
