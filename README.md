<p align="center">
  <img src="site/logo.svg" width="104" alt="ZenPi logo">
</p>

<h1 align="center">ZenPi</h1>

<p align="center"><strong>Breathe. Then build.</strong></p>

<p align="center">
  A self-improving harness for the
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

When a real capability gap keeps getting in the way, ZenPi turns that friction into a privacy-minimized wishlist—so use becomes signal, and signal becomes deliberate improvement.

<p align="center">
  <code>notice → name → measure → improve → retire</code>
</p>

Attentive enough to notice. Explicit enough to trust. Human-directed by design.

## What it adds

- A distinct Tea House interface and optional shell profiles
- A focused `/zen` mode with live activity, collapsed output, and deliberate execution guidance
- Strict model inheritance for native subagents
- Isolated browser tools for rendered UI checks
- A measured capability wishlist built from recurring friction
- Review-first installation with backups, checksums, and rollback

## Zen mode

`/zen` enters an opt-in focused execution mode. It adds an unmistakable activity panel, collapses tool output, reports the current work phase, and guides the agent toward one deliberate, validated objective at a time. Run `/zen` again—or press `Ctrl+Alt+Z`—to restore the standard interface.

Use `/zen on`, `/zen off`, or `/zen status` when explicit control is preferable.

## Install

Requires Pi 0.37.4+, Node.js 22.19+, npm, and Git. Clone a release tag you have reviewed, then:

```bash
./zenpi plan      # inspect every proposed change
./zenpi install   # confirm before anything is written
./zenpi doctor
```

Run `/reload` in Pi after installation. Use `./zenpi update` or `./zenpi uninstall` later; both remain explicit and reversible.

## Improve through use

When existing tools cannot solve a material, reusable problem, ZenPi can record a sanitized capability-gap report. `/wishlist` turns those reports into a ranked improvement queue based on recurrence, reach, impact, and recency.

Implemented capabilities leave the active list while their history remains. Reports are designed to exclude prompts, source code, commands, credentials, and raw project identities.

```text
~/.pi/agent/zenpi/TOOL_WISHLIST.md
```

## Boundaries

ZenPi does not own or inspect your credentials, providers, models, sessions, history, or trust decisions. It changes only documented settings and its own marked blocks, and it never installs global executables or operating-system packages.

For the complete trust model, browser isolation details, installer flags, and update behavior, read [SECURITY.md](SECURITY.md).

## Development

```bash
npm run check
```

MIT licensed.
