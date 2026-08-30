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

The goal is not autonomous self-modification. It is to make the next justified change obvious, testable, reversible, and explicitly approved.

## How the loop works

1. **Observe locally.** Collection is off until explicitly enabled. Reports are sanitized, bounded, deduplicated by task, and never uploaded.
2. **Choose once.** Run `/harness-improvement`. One menu shows qualified and review-needed items; choosing one explicitly authorizes that exact smallest-sufficient improvement and starts the agent workflow.
3. **Change minimally.** The `zenpi-improve` skill inspects the evidence, implements the narrowest intervention, and runs direct acceptance checks.
4. **Verify and retire.** The completion gate verifies registry integration, runs `npm run check` and supported closed validators, then retires the item only when everything passes. Every retirement keeps its proof — evidence, gates, changed files — and every check and `zenpi doctor` run re-proves retired capabilities through their validators. Failed checks leave it selected. Later friction returns it to the same review menu.

```text
/harness-improvement
```

`retired` means the fix is done and verified. `review-needed` means new friction showed up later; picking it from the menu reopens it automatically.

`/wishlist` is where you can inspect and curate the private list yourself. Use `/wishlist status` for queue and loop-health totals, or `/wishlist history [gap-id]` to review retirement evidence, validators, changed files, reopen signals, and rollback context. You can also tidy duplicates, draft a local issue, or archive or reset the state. Everything stays on your machine, and nothing changes without your confirmation.

## What ZenPi adds

- **`/zen`** — a focused execution mode
- **`/files`** — browse files, view diffs, and leave review comments
- **Wishlist** — a private log of friction, ready to act on
- **Durable capability proofs** — closed offline validators run during completion, `npm run check`, and `zenpi doctor`
- **Improvement journal** — every retirement keeps its evidence, gates, changed files, and version; `/wishlist history [gap-id]` shows it
- **Loop health** — `/wishlist status` and the report show retirements, reopen rate, open reviews, time-to-retire, and qualification rate
- **`/harness-improvement`** — pick one item and let ZenPi fix and verify it
- **`/zen-subagents`** — remember how you like your subagents set up
- **Command guard** — choose Guard, Strict, or Off at session start; known catastrophic commands are blocked before execution
- **Isolated browser** — check your web UI with screenshots in a fresh browser context
- **Careful installs** — everything is backed up and can be rolled back

Details live in the [Wiki](https://tannermidd.github.io/ZenPi/wiki/).

## Install

You need Node.js 22.19+, npm, and Git. If Pi (0.84.4+) isn't installed yet, the installer sets it up for you.

```bash
git clone --branch v0.7.0 --depth 1 https://github.com/TannerMidd/ZenPi.git
cd ZenPi
./zenpi plan      # preview what will change (changes nothing)
./zenpi install   # asks for confirmation first
./zenpi doctor    # verify managed state and re-run capability validators
```

On Windows, use `.\zenpi.cmd` instead of `./zenpi`. After installing, run `/reload` in Pi. Everything is backed up and reversible — see [SECURITY.md](SECURITY.md) for details.

At each interactive top-level session start, choose **Guard** (recommended), **Strict**, or **Off for this session**. For command and mutation calls, Guard is deliberately narrow: it permanently blocks confirmed host-wide catastrophe and command-guard tampering, asks only when analysis cannot rule out that outcome, and otherwise stays out of the way. Determinate project deletion, force push, publication, installation, network, process, service, and other non-catastrophic work therefore runs without routine Guard prompts. Strict retains broad approval prompts for mutation, execution, sensitive reads, elevated/network activity, and uncatalogued tools. Approval prompts can allow once or allow the exact full tool call for this session; use `/guard clear-approvals` to clear those bounded in-memory approvals. Confirmed critical calls are never approvable. Use `/guard status`, `/guard guard`, `/guard strict`, `/guard off`, or `/guard unlock` to inspect or change state. Off requires direct user confirmation, applies only to the top-level session, and is never inherited by children. Print/JSON sessions default to Guard and deny decisions that need a prompt.

## Boundaries

ZenPi never persists command text and does not read Pi credentials, sessions, or history. Wishlist reports are stored locally only — skim them before sharing. Nothing happens without your say-so: improving ZenPi, installing, or publishing all need your explicit approval.

The command guard protects model tool calls routed through its documented `bash`, `powershell`, `read`, `write`, `edit`, and native-subagent seams. It is defense in depth, not an OS sandbox: direct human shell escapes, malicious extensions, unclassified custom tools, approved scripts, TOCTOU changes, and external processes remain outside its hard boundary. Direct recognized private-path reads receive narrow protection, but the guard does not comprehensively detect credentials read through arbitrary shell syntax or scripts. Use OS permissions, a least-privilege account, container, or VM when code or data is hostile.

See [SECURITY.md](SECURITY.md) for the full picture.

## Development

```bash
npm run check
```

The repository check validates syntax, runs the complete Node test suite, and executes every validator linked from the capability registry with isolated prerequisites.

MIT licensed.
