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
4. **Verify and retire.** The completion gate verifies registry integration, runs `npm run check` and supported closed validators, then retires the item only when everything passes. Failed checks leave it selected. Later friction returns it to the same review menu.

```text
/harness-improvement
```

`retired` means the fix is done and verified. `review-needed` means new friction showed up later; picking it from the menu reopens it automatically.

`/wishlist` is where you can look through the private list yourself — tidy up duplicates, draft an issue, or archive or reset it. Everything stays on your machine, and nothing changes without your confirmation.

## What ZenPi adds

- **`/zen`** — a focused execution mode
- **`/files`** — browse files, view diffs, and leave review comments
- **Wishlist** — a private log of friction, ready to act on
- **`/harness-improvement`** — pick one item and let ZenPi fix and verify it
- **`/zen-subagents`** — remember how you like your subagents set up
- **Isolated browser** — check your web UI with screenshots, safely sandboxed
- **Careful installs** — everything is backed up and can be rolled back

Details live in the [Wiki](https://tannermidd.github.io/ZenPi/wiki/).

## Install

You need Node.js 22.19+, npm, and Git. If Pi (0.84.4+) isn't installed yet, the installer sets it up for you.

```bash
git clone --branch v0.6.1 --depth 1 https://github.com/TannerMidd/ZenPi.git
cd ZenPi
./zenpi plan      # preview what will change (changes nothing)
./zenpi install   # asks for confirmation first
./zenpi doctor    # verify everything works
```

On Windows, use `.\zenpi.cmd` instead of `./zenpi`. After installing, run `/reload` in Pi. Everything is backed up and reversible — see [SECURITY.md](SECURITY.md) for details.

## Boundaries

ZenPi never touches your credentials, sessions, or history, and nothing is ever uploaded. Wishlist reports are stored locally only — skim them before sharing. Nothing happens without your say-so: improving ZenPi, installing, or publishing all need your explicit approval.

See [SECURITY.md](SECURITY.md) for the full picture.

## Development

```bash
npm run check
```

MIT licensed.
