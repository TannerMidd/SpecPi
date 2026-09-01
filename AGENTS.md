# ZenPi Repository Guide

## Purpose

ZenPi is a minimal, evidence-led harness for Pi. Preserve human control: changes should be the smallest sufficient intervention, testable, reversible, private by default, and supported by observed behavior rather than model claims.

Wishlist observations are leads, not authorization. Only an exact human selection through `/harness-improvement` authorizes a wishlist-sourced change.

## Repository map

- `scripts/zenpi.mjs` and `scripts/lib.mjs`: installer lifecycle, managed-state transactions, and CLI behavior.
- `templates/`, `extensions/`, `skills/`, `themes/`, and `shell/`: installable source-of-truth files. Edit these, not installed copies.
- `tests/`: installer, command-guard, provider, browser, and wishlist regressions.
- `SECURITY.md`: public support and vulnerability-reporting policy.
- `SECURITY_MODEL.md`: authoritative trust model and security boundaries.
- `templates/AGENTS.md`: the installed global working agreement; this root file governs ZenPi repository development.

## Setup and validation

Use Node.js 22.19 or later. From the repository root:

- Install development dependencies: `npm install --ignore-scripts --omit=peer --no-package-lock`
- Run a focused suite: `node --test tests/<suite>.test.mjs`
- Format JavaScript and TypeScript: `npm run format`
- Run full repository validation: `npm run check`

Run the narrowest relevant test first, then `npm run check` for material changes. Add or update regression tests when behavior changes.

Never run installer integration tests against the live Pi directory. Use a fresh temporary `PI_CODING_AGENT_DIR` and skip external package and tool installation. Installer and release work must exercise the plan/install/update/doctor/uninstall lifecycle in isolated state.

For rendered `site/` or browser changes, validate relevant desktop, tablet, and mobile viewports. Create or replace visual baselines only when explicitly requested, and treat browser artifacts as potentially sensitive.

## Invariants

- `plan` is non-mutating. `install`, `update`, and `uninstall` require confirmation unless `--yes` is supplied.
- Merge only documented settings paths and preserve unrelated configuration. Manage global AGENTS and shell integration only inside ZenPi marker blocks.
- Back up before mutation, write atomically, retain checksums, and roll configuration files back on failure.
- Never inspect, copy, log, or modify Pi authentication, provider credentials, trust decisions, sessions, missions, or history.
- Treat Command Guard denials as hard constraints. Never evade them through encoding, command splitting, indirection, or alternate tools.
- Do not edit dependencies under `node_modules/` or installed ZenPi resources.
- Do not add or upgrade executable dependencies unless required by the task. Pin reviewed versions and update `THIRD_PARTY.md`, `CHANGELOG.md`, and security documentation when their contracts change.
- Use four-space indentation, explicit braced control flow, one statement per line, and the project formatter.
- Do not commit, push, publish, deploy, create releases, or alter remotes unless explicitly requested.

## Completion

Inspect the final diff and report the checks run, their results, and residual risks. Security-sensitive installer, command-guard, provider-isolation, state-retention, or dependency changes require targeted regression coverage and fresh read-only review.
