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
  · <a href="#install">Install</a>
  · <a href="SECURITY.md">Security</a>
</p>

---

## Let friction teach the system

Most agent setups grow by accumulation. **ZenPi grows by evidence.**

When a real, reusable capability gap gets in the way, ZenPi records a privacy-minimized local signal, measures recurrence and reach, and gives the human one clear next improvement.

```text
notice → name → measure → select → improve → verify → retire
                                  ↘ reopen when evidence returns
```

The goal is not autonomous self-modification. It is to make the next justified change obvious, testable, reversible, and explicitly approved.

## How the loop works

1. **Observe locally.** Collection is off until explicitly enabled. Reports are sanitized, bounded, deduplicated by task, and never uploaded.
2. **Choose deliberately.** `/wishlist next` presents only qualified evidence. Selection creates an improvement card; it does not authorize source edits.
3. **Change minimally.** The `zenpi-improve` skill frames the smallest intervention, acceptance check, privacy impact, and rollback before implementation.
4. **Verify and retire.** Retirement requires validation evidence. Later friction becomes `review-needed` without silently reopening or changing anything.

```text
/wishlist next
/wishlist select <gap-id>
/wishlist retire <gap-id> <validation note>
/wishlist reopen <gap-id>
```

Exact merge/unmerge decisions correct fragmented gap names without rewriting history. Local issue drafts and checksummed archive/reset operations remain explicit and offline.

## What ZenPi adds

- Focused `/zen` execution mode
- Evidence-led capability wishlist
- Approval-gated `zenpi-improve` workflow
- Strict native-subagent model inheritance
- Isolated browser interaction and visual regression checks
- Review-first installation with backups, checksums, and rollback

## Install

Requires Pi 0.80.0+, Node.js 22.19+, npm, and Git. Clone a reviewed release tag rather than piping remote code into a shell.

```bash
git clone --branch v0.2.0 --depth 1 https://github.com/TannerMidd/ZenPi.git
cd ZenPi
```

**Windows**

```powershell
.\zenpi.cmd plan
.\zenpi.cmd install
.\zenpi.cmd doctor
```

**Linux, macOS, or Git Bash**

```bash
./zenpi plan
./zenpi install
./zenpi doctor
```

Installation remains explicit and reversible. Use `--skip-browser-install`, `--skip-package-install`, or `--skip-tool-install` when needed, then run `/reload` in Pi. See [SECURITY.md](SECURITY.md) for dependency, platform, state-retention, and trust details.

## Boundaries

ZenPi does not own or inspect credentials, providers, models, session content, history, or trust decisions. It never turns wishlist evidence into permission to edit, install, upload, publish, or alter remote state.

Sanitization is bounded defense in depth. Review local wishlist output before sharing it.

## Development

```bash
npm run check
```

MIT licensed.
