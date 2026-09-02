<p align="center">
  <img src="site/logo.svg" width="104" alt="SpecPi logo">
</p>

<h1 align="center">SpecPi</h1>

<p align="center">
  A local, human-directed improvement harness for the
  <a href="https://pi.dev/">Pi coding agent</a>.
</p>

<p align="center">
  <a href="https://tannermidd.github.io/SpecPi/"><strong>Overview</strong></a>
  · <a href="https://tannermidd.github.io/SpecPi/wiki/">Wiki</a>
  · <a href="#install">Install</a>
  · <a href="SECURITY.md">Security</a>
</p>

## Purpose

SpecPi records recurring capability gaps in local state and presents qualified items for review. Selecting an item with `/harness-improvement` authorizes one bounded change. Repository checks and capability-specific validators must pass before the item can retire.

Collection is disabled until explicitly enabled. Reports are sanitized, bounded, deduplicated by task, and never uploaded.

<p align="center">
  <img src="site/self-improvement-loop-v2.svg" width="760" alt="SpecPi improvement loop: local friction becomes qualified evidence; a person chooses one change; verification failure keeps it selected; later evidence returns it to human review.">
</p>

## Improvement loop

1. **Record:** A reusable capability gap is stored as a sanitized local report.
2. **Qualify:** Recurrence, project reach, impact, and recency determine whether the item enters the review menu.
3. **Select:** `/harness-improvement` authorizes one exact item.
4. **Implement:** The `specpi-improve` skill makes the narrowest sufficient change and adds direct checks.
5. **Verify:** The completion gate checks registry integration, runs `npm run check`, and runs the item's closed validator.
6. **Retire:** A passing item leaves the queue. Its evidence, gates, changed files, and version remain in the local journal.
7. **Review again:** Later evidence returns the item as `review-needed`. Implementation does not restart automatically.

Use `/wishlist status` for queue and loop-health totals. Use `/wishlist history [gap-id]` for retirement evidence, validators, changed files, reopen signals, and rollback context. `/wishlist` also supports duplicate cleanup, local issue drafts, archive, and reset operations.

## Included capabilities

| Capability | Interface | Behavior |
| --- | --- | --- |
| Spec execution | `/spec` | Replaces normal chrome with a technical run panel, seals live reasoning, holds streaming prose until complete, and keeps tools collapsed. |
| File review | `/files` | Browses source, rendered Markdown, Git diffs, and bounded review comments. |
| Scope monitoring | `/scope` | Declares expected paths and reports unacknowledged drift. |
| Worktree experiments | `/experiment` | Creates detached worktrees with keep, binary patch export, and confirmed discard outcomes. |
| Completion review | `/challenge` | Produces a structured readiness review with evidence, gaps, contradictions, and residual risk. |
| Capability wishlist | `/wishlist` | Stores and curates privacy-minimized local gap reports. |
| Improvement selection | `/harness-improvement` | Authorizes one qualified or review-needed item. |
| Command guard | `/guard` | Denies confirmed host-wide destructive calls and requests approval for bounded risk classes. |
| Browser QA | Browser tools | Opens an isolated Chromium context for rendered inspection and screenshots. |
| Specification theme | `specpi-spec` | Applies the GitHub Pages design’s blueprint blue, technical greys, layered surfaces, and restrained semantic states across Pi. |
| Installer lifecycle | `specpi` | Plans, installs, updates, verifies, and uninstalls managed state with backups and rollback. |

`specpi-spec` is the default Pi theme. It carries the site’s clean specification direction through message surfaces, tools, Markdown, diffs, syntax highlighting, search, and the full thinking-level scale. The original `tea-house` theme remains bundled and selectable from `/settings`.

Capability registry entries include closed offline validators. Completion, `npm run check`, and `specpi doctor` run those validators.

## Install

Requirements:

- Node.js 22.19 or newer
- npm
- Git
- Pi 0.84.4 or newer. If Pi is absent, the confirmed install adds the reviewed pinned package.

Install the CLI, inspect its non-mutating plan, and then confirm the managed installation:

```bash
npm install --global specpi@latest
specpi plan
specpi install
specpi doctor
```

Pin the reusable CLI when installing a reviewed release, or inspect its plan without retaining a global CLI installation:

```bash
npm install --global specpi@0.10.0
npx --package specpi@0.10.0 specpi plan
```

For a source-audited installation, clone the exact release instead:

```bash
git clone --branch v0.10.0 --depth 1 https://github.com/TannerMidd/SpecPi.git
cd SpecPi
./specpi plan
./specpi install
./specpi doctor
```

On Windows source checkouts, use `.\specpi.cmd` in place of `./specpi`. The npm installation provides the `specpi` command on every supported platform.

`plan` does not mutate the system. Install, update, and uninstall require confirmation unless `--yes` is supplied. After installation, run `/reload` in Pi.

Update the npm CLI and its managed installation as two explicit steps:

```bash
npm install --global specpi@latest
specpi update
specpi doctor
```

Uninstall managed SpecPi resources before removing the CLI. Private wishlist, journal, experiment, and patch state remains local unless explicitly removed:

```bash
specpi uninstall
npm uninstall --global specpi
```

Direct `pi install npm:specpi` loads the package's extensions, skills, and themes only. It does not run the full installer or provide managed instructions, browser runtime dependencies, supporting Pi packages, optional tools, shell integration, backups, or ownership records.

## Command guard

Every supported model-initiated Pi tool call is classified before execution. Select one mode at session start:

- **Guard:** Denies confirmed host-wide catastrophe and guard tampering, asks before Git destroys work, and otherwise remains quiet.
- **Strict:** Adds approval requests for mutation, execution, sensitive reads, and network activity.
- **Off:** Requires confirmation and applies only to the current session.

Approvals apply to one exact call and one session. Only a structurally proven critical mutation locks the session. Parser uncertainty and invalid cleanup syntax are denied without locking later work.

The guard covers the documented `bash`, `powershell`, `read`, `write`, and `edit` seams. Direct shell escapes, malicious extensions, unclassified custom tools, approved scripts, TOCTOU changes, and external processes remain outside its scope.

## Work ownership

SpecPi does not install subagent orchestration. Keep one writer per working directory. A parent agent determines what context a child receives and summarizes what returns, so either handoff can omit a material constraint. Parallel writers also introduce conflicting assumptions and increase review work.

Use `/experiment start` when an independent review or trial justifies a separate worktree. Open the reported path in another Pi session. SpecPi does not launch an agent, copy dirty base changes, commit, merge, or touch remotes.

`/scope set` declares expected paths. `/scope accept <path>` acknowledges one finding without widening the contract. `/scope add <path>` widens it. `/scope recheck` replaces an uncertain baseline.

`/challenge` requires structured requirement evidence and checks for contradictions, false-positive validation, scope drift, missing runtime or visual checks, and residual risk. Its result supports human review and does not replace direct proof.

## Data and security boundaries

SpecPi does not persist command text or read Pi credentials, unrelated sessions, or history. Scope and challenge records are bounded entries in the current Pi session. Wishlist reports, improvement journals, experiment metadata, and exported patches remain in private local SpecPi state and can survive uninstall. Review local artifacts before sharing.

Pi extensions run with the current user's permissions. Use OS permissions, a least-privilege account, a container, or a VM for hostile code or data. See [SECURITY_MODEL.md](SECURITY_MODEL.md) for the complete trust model and [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Development

```bash
npm install --ignore-scripts --omit=peer --no-package-lock
npm run format
npm run check
```

JavaScript and TypeScript use four-space indentation, explicit braced control flow, and one statement per line. The repository check enforces formatting, validates syntax, runs the Node test suite, executes registry-linked validators, and installs the exact npm tarball through an isolated lifecycle. Maintainers should follow [NPM_RELEASE.md](NPM_RELEASE.md) for release preparation and protected publication.

MIT licensed.
