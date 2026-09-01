<p align="center">
  <img src="site/logo.svg" width="104" alt="ZenPi logo">
</p>

<h1 align="center">ZenPi</h1>

<p align="center"><strong>Breathe. Then build.</strong></p>

<p align="center">
  A minimal, self-improving harness for the
  <a href="https://pi.dev/">Pi coding agent</a>.
</p>

<p align="center">
  <a href="https://tannermidd.github.io/ZenPi/"><strong>Showcase</strong></a>
  · <a href="https://tannermidd.github.io/ZenPi/wiki/">Wiki</a>
  · <a href="#install">Install</a>
  · <a href="SECURITY.md">Security</a>
</p>

---

## Let friction teach the system

Most agent setups grow by accumulation. **ZenPi grows by evidence.**

When a real, reusable capability gap gets in the way, ZenPi records a privacy-minimized local signal, measures recurrence and reach, and gives the human one clear next improvement.

<p align="center">
  <img src="site/self-improvement-loop-v2.svg" width="760" alt="ZenPi improvement loop: local friction becomes qualified evidence; a person chooses one exact change; proof retires it, while failure leaves it selected and later evidence returns to human review.">
</p>
<p align="center"><a href="https://tannermidd.github.io/ZenPi/#wishlist">Walk one example through the loop</a></p>

The goal is to make each justified change obvious, testable, reversible, and explicitly approved while keeping self-modification under human control.

## How the loop works

1. **Observe locally.** Collection is off until explicitly enabled. Reports are sanitized, bounded, deduplicated by task, and never uploaded.
2. **Choose once.** Run `/harness-improvement`. One menu shows qualified and review-needed items; choosing one explicitly authorizes that exact smallest-sufficient improvement and starts the agent workflow.
3. **Change minimally.** The `zenpi-improve` skill inspects the evidence, implements the narrowest intervention, and runs direct acceptance checks.
4. **Verify and retire.** The completion gate verifies registry integration, runs `npm run check` and supported closed validators, then retires the item only when everything passes. Every retirement keeps its evidence, gates, and changed files. Each check and `zenpi doctor` run re-proves retired capabilities through their validators. Failed checks leave the item selected. Later friction returns it to the same review menu.

```text
/harness-improvement
```

`retired` means the fix is done and verified. `review-needed` means new friction showed up later; picking it from the menu reopens it automatically.

`/wishlist` is where you can inspect and curate the private list yourself. Use `/wishlist status` for queue and loop-health totals, or `/wishlist history [gap-id]` to review retirement evidence, validators, changed files, reopen signals, and rollback context. You can also tidy duplicates, draft a local issue, or archive or reset the state. Everything stays on your machine, and nothing changes without your confirmation.

## What ZenPi adds

- **`/zen`:** a focused execution mode
- **`/files`:** browse files, view diffs, and leave review comments
- **`/scope`:** declare expected paths and surface unacknowledged scope drift
- **`/experiment`:** create detached worktree experiments with keep, patch-export, and explicit discard outcomes
- **`/challenge`:** run a structured adversarial completion-readiness review
- **Wishlist:** a private log of friction, ready to act on
- **Durable capability proofs:** closed offline validators run during completion, `npm run check`, and `zenpi doctor`
- **Improvement journal:** every retirement keeps its evidence, gates, changed files, and version; `/wishlist history [gap-id]` shows it
- **Loop health:** `/wishlist status` and the report show retirements, reopen rate, open reviews, time-to-retire, and qualification rate
- **`/harness-improvement`:** pick one item and let ZenPi fix and verify it
- **Command guard:** blocks catastrophic model commands before execution and asks before Git destroys work
- **Isolated browser:** check your web UI with screenshots in a fresh browser context
- **Careful installs:** everything is backed up and can be rolled back

Details live in the [Wiki](https://tannermidd.github.io/ZenPi/wiki/).

## Why ZenPi does not install subagents

ZenPi keeps implementation inside one accountable working context instead of installing an orchestration layer. A parent agent must choose what context a child receives and compress what comes back; either handoff can silently omit the constraint that mattered and make a bad result difficult to reconstruct. Parallel agents writing the same codebase also trade apparent speed for fragmented decisions, conflicting assumptions, and a larger review burden.

Gather context deliberately, leave a reviewable artifact, and begin implementation with that shared record. Keep one writer per working directory; use an isolated worktree and an explicit separate session when an independent review or experiment is worth the coordination cost. This is not a claim that independent agents are never useful. It is a choice to keep context ownership, authorship, and verification visible.

## Install

You need Node.js 22.19+, npm, and Git. If Pi (0.84.4+) isn't installed yet, the installer sets it up for you.

```bash
git clone --branch v0.8.3 --depth 1 https://github.com/TannerMidd/ZenPi.git
cd ZenPi
./zenpi plan      # preview what will change (changes nothing)
./zenpi install   # asks for confirmation first
./zenpi doctor    # verify managed state and re-run capability validators
```

On Windows, use `.\zenpi.cmd` instead of `./zenpi`. After installing, run `/reload` in Pi. Everything is backed up and reversible. See the [security model](SECURITY_MODEL.md) for details.

## Command guard

Every supported model-initiated Pi tool call is analyzed before it runs. Choose one mode at session start:

- **Guard** (recommended): denies confirmed host-wide catastrophe outright, asks before Git destroys work, and stays quiet otherwise
- **Strict:** also asks for mutation, execution, sensitive reads, and network activity
- **Off:** confirmed and session-only

Approvals are exact-call and session-scoped. Only a structurally proven, lock-worthy critical mutation locks the session; parser uncertainty and wrong-shell cleanup syntax are denied without stranding later work. Inspect or change the mode any time with `/guard`. For temporary cleanup in the Bash tool, use `rm -rf -- F:/Temp/case`; use `Remove-Item -LiteralPath ... -Recurse -Force` with the PowerShell tool.

## Workflow controls

Use `/scope set` to declare the files or directories expected to change. Direct edits outside that contract require an interactive choice; headless and shell-detected drift stays advisory and pending until you acknowledge it. `/scope accept <path>` acknowledges one finding and leaves the declared contract alone, so a later change there is reported again; `/scope add <path>` is the separate verb that widens scope. `/scope recheck` re-baselines the worktree when a snapshot has become uncertain. Scope state belongs to the active Pi session branch and stores paths, not source or raw commands.

Use `/experiment start` for an intentional trial. ZenPi creates a detached worktree from `HEAD` under private local state and never copies dirty base changes, launches another agent, commits, merges, or touches remotes. `/experiment close` can keep it, export tracked and untracked changes as a byte-exact binary patch, or explicitly discard it. Ignored files cannot travel in a patch, so they are counted and named before an export or a discard. Open the reported directory yourself in a separate Pi session so each worktree has one accountable writer.

Use `/challenge` when a material task appears ready. The challenge requires structured requirement evidence, checks for contradictions, possible false-positive validation, pending scope drift, missing runtime or visual checks, and residual risk. `ready-for-human-review` is rejected while recorded gaps remain, but it is still a model-authored review—not independent proof or completion authority. A challenge the agent turn ends without answering expires instead of carrying into later turns.

## Boundaries

ZenPi never persists command text and does not read Pi credentials or unrelated sessions or history. Scope and challenge records are bounded entries in the current Pi session. Experiment metadata and exported patches remain in private local ZenPi state and can survive uninstall. Wishlist reports are stored locally only. Review all local artifacts before sharing. Improving ZenPi, installing, and publishing all require your explicit approval.

The command guard protects model tool calls routed through its documented `bash`, `powershell`, `read`, `write`, and `edit` seams. It provides defense in depth within that boundary. Direct human shell escapes, malicious extensions, unclassified custom tools, approved scripts, TOCTOU changes, and external processes remain outside its scope. Direct recognized private-path reads receive narrow protection. The guard does not comprehensively detect credentials read through arbitrary shell syntax or scripts. Use OS permissions, a least-privilege account, container, or VM when code or data is hostile.

See the [security policy](SECURITY.md) for vulnerability reporting and the [security model](SECURITY_MODEL.md) for the full boundary.

## Development

```bash
npm install --ignore-scripts --omit=peer --no-package-lock
npm run format
npm run check
```

JavaScript and TypeScript use four-space indentation, explicit braced control-flow blocks, one statement per line, and breathing room after blocks and before returns. `npm run format` applies the project-local Prettier and ESLint rules. The repository check enforces that formatting before validating syntax and running the complete Node test suite. It also executes every validator linked from the capability registry with isolated prerequisites.

MIT licensed.
