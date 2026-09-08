# SpecPi Repository Guide

## Purpose

SpecPi is a minimal, evidence-led harness for Pi. Preserve human control: changes should be the smallest sufficient intervention, testable, reversible, private by default, and supported by observed behavior rather than model claims.

Wishlist observations are leads, not authorization. Only an exact human selection through `/harness-improvement` authorizes a wishlist-sourced change.

## Repository map

- `scripts/specpi.mjs` and `scripts/lib.mjs`: installer lifecycle, managed-state transactions, and CLI behavior.
- `templates/`, `extensions/`, `skills/`, `themes/`, and `shell/`: installable source-of-truth files. Edit these, not installed copies.
- `tests/`: installer, command-guard, provider, browser, and wishlist regressions.
- `SECURITY.md`: public support and vulnerability-reporting policy.
- `SECURITY_MODEL.md`: authoritative trust model and security boundaries.
- `templates/AGENTS.md`: the installed global working agreement; this root file governs SpecPi repository development.

## Setup and validation

Use Node.js 22.19 or later. From the repository root:

- Install development dependencies: `npm install --ignore-scripts --omit=peer --no-package-lock`
- Run a focused suite: `node --test tests/<suite>.test.mjs`
- Format JavaScript and TypeScript: `npm run format`
- Run full repository validation: `npm run check`

Run the narrowest relevant tests while iterating, then `npm run check` once the material change is ready for final validation. Rerun broader checks only when subsequent changes invalidate their evidence or a release gate requires them. Add or update tests only for changed behavior, meaningful failure modes, and required security boundaries; prefer existing fixtures and suites over duplicate coverage, speculative cases, or new test scaffolding without a concrete need. Documentation-only changes need content/diff review, not unrelated runtime suites. Preserve required security, installer, and release checks.

Pi fixtures use the repository's pinned development dependency by default; `SPECPI_TEST_PI` explicitly selects another CLI. Package validation creates its own temporary npm cache. Neither requires changing the user's global PATH, cache, or live Pi installation.

Never run installer integration tests against the live Pi directory. Use a fresh temporary `PI_CODING_AGENT_DIR` and skip external package and tool installation. Installer and release work must exercise the plan/install/update/doctor/uninstall lifecycle in isolated state.

For rendered `site/` or browser changes, validate relevant desktop, tablet, and mobile viewports. Create or replace visual baselines only when explicitly requested, and treat browser artifacts as potentially sensitive.

## Invariants

- `plan` is non-mutating. `install`, `update`, and `uninstall` require confirmation unless `--yes` is supplied.
- Merge only documented settings paths and preserve unrelated configuration. Manage global AGENTS and shell integration only inside SpecPi marker blocks.
- Back up before mutation, write atomically, retain checksums, and roll configuration files back on failure.
- Never inspect, copy, log, or modify Pi authentication, provider credentials, trust decisions, sessions, missions, or history.
- Treat Command Guard denials as hard constraints. Never evade them through encoding, command splitting, indirection, or alternate tools.
- Do not edit dependencies under `node_modules/` or installed SpecPi resources.
- Do not add or upgrade executable dependencies unless required by the task. Pin reviewed versions and update `THIRD_PARTY.md`, `CHANGELOG.md`, and security documentation when their contracts change.
- Use four-space indentation, explicit braced control flow, one statement per line, and the project formatter.
- Do not commit, push, publish, deploy, create releases, or alter remotes unless explicitly requested.
- When git commits or pull requests are requested, write them to read like a person wrote them: concise, purpose-first messages, a brief body only where it adds context, and no attribution footers, emoji decoration, co-author trailers, or change-statistics dumps.

## Completion

Inspect the final diff and report the checks run, their results, and residual risks. Keep implementation, tests, documentation, progress updates, and final reports focused on the request: no unrelated cleanup, redundant summaries, decorative workflow artifacts, or extra scaffolding without a concrete benefit. Security-sensitive installer, command-guard, provider-isolation, state-retention, or dependency changes require targeted regression coverage and fresh read-only review.
