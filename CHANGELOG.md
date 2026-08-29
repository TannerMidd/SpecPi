# Changelog

## Unreleased

## 0.6.1 - 2026-08-29

- Flush a prompt frame when extension dialogs mount so chained menus such as `/zen-subagents` do not remain invisible until the next keypress in regular TUI sessions, notably through Windows SSH terminals; require and bootstrap the reviewed Pi 0.84.4 baseline that provides prompt lifecycle events.
- Fix provider-profile activation on model changes by prompting the user to run the documented `/reload` flow instead of calling command-only `ctx.reload()` from a lifecycle event context.
- Redesign the README self-improvement diagram as a compact Tea House graphic and version its asset URL so GitHub and browser caches cannot retain the previous rendering.

## 0.6.0 - 2026-08-29

- Add exact-provider subagent profiles that restore automatically with a single bounded runtime reload, while keeping capacity global and unavailable saved models stale without replacement.
- Add ephemeral provider leases so simultaneous different-provider Pi processes fail closed instead of racing the shared active settings mirror.
- Preserve private provider profiles across update and uninstall; store no credentials, authentication data, prompts, sessions, history, or complete settings snapshots.
- Replace the README's text loop with an accessible static Tea House SVG and update the showcase to explain saved provider restoration.

## 0.5.0 - 2026-08-29

- Automatically install pinned `@earendil-works/pi-coding-agent@0.84.3` through npm after confirmation when `pi` is absent; preserve the external installation on rollback and uninstall, with `--skip-package-install` as the opt-out.
- Add `/zen-subagents` with confirmed capacity, builtin-role model, and thinking configuration using only the documented `pi-subagents` config surface.
- Synchronize strict native subagent scope to the parent's exact Pi provider, filter model choices accordingly, flag stale role models after provider changes, and block unsafe project-scope tool launches.
- Preserve user-tunable role and capacity leaves across update/uninstall while continuing to enforce security-owned settings; add bounded leaf backups, shared locking, atomic writes, rollback, doctor validation, and legacy whole-file config migration.
- Add provider-safe delegation guidance to the working agreement, README, security documentation, and static showcase.

## 0.4.0 - 2026-08-29

- Replace the abstract cycle charts with an accessible interactive walkthrough that shows one gap moving through evidence, human choice, proof, retirement, and later review.
- Replace `@tmustier/pi-files-widget` with an in-house, Tea House-native `/files` browser using Pi's built-in syntax and Markdown renderers; remove the bat, git-delta, and glow prerequisites and retire their legacy managed binaries on update.

## 0.3.0 - 2026-08-29

- Complete the local improvement loop with explicit collection consent, deterministic evidence ranking, lifecycle decisions, and regression-aware retirement.
- Replace hard-coded implemented capability keys with a reviewed registry linked to closed `zenpi doctor` validators; the browser smoke now verifies both exact and changed pixel comparisons.
- Add reversible exact alias decisions, local sanitized issue drafts, and recoverable checksummed archive/reset operations.
- Add the one-command `/harness-improvement` menu and `zenpi-improve` workflow, with session-bound implementation authorization, repository and capability verification gates, and automatic retirement only after success.
- Refresh the minimal README and showcase with explicit retired/review semantics plus accessible cycle and verification-outcome charts.

## 0.2.0 - 2026-08-29

- Add a native Windows command launcher and Windows-safe executable discovery for `pi.cmd`, `npm.cmd`, and access-restricted Windows App Execution Aliases such as `winget.exe`.
- Invoke `.cmd`/`.bat` shims as a single quoted `ComSpec` command, avoiding Node's deprecated shell-plus-arguments path.
- Make the npm binary entry invoke Node directly instead of requiring a POSIX shell.
- Document platform-specific install commands and automatic dependency installation, and preflight the Pi 0.80.0 package API baseline.
- Add Windows installation smoke coverage.
- Offer missing bat, git-delta, glow, and DonSeTch tools individually during interactive installs; `--yes` attempts all and `--skip-tool-install` opts out.
- Pin bat 0.26.1, git-delta 0.19.2 (0.18.2 on Intel macOS), glow 3.0.0, and DonSeTch 3.4.0; use exact Winget installs on Windows and checksum-verified managed archives on Linux/macOS.
- Roll managed optional binaries back with failed installs and remove them on uninstall while documenting that Winget/global npm changes remain external.

## 0.1.0 - 2026-08-28

- Add explicit plan/install/update/doctor/uninstall workflow.
- Add managed AGENTS and shell blocks with backups and checksums.
- Add provider-safe strict native-subagent inheritance.
- Disable external Codex subscription runners.
- Bundle the Zen extension, Tea House theme, and DonSeTch skill.
- Make `/zen` a focused execution mode with persistent activity UI, collapsed tool output, per-turn guidance, session persistence, and full toggle restoration.
- Add a privacy-minimized, task-deduplicated capability-gap collector and generated tool wishlist, with `/wishlist` rendering the refreshed Markdown report directly in the conversation and retiring capabilities implemented by ZenPi.
- Add managed isolated browser QA on hosts satisfying Playwright Chromium system requirements, with a pinned runtime, responsive viewport tools, bounded inline screenshots, explicit baselines, and pixel-diff artifacts.
- Add browser runtime staging, rollback, doctor smoke validation, and uninstall cleanup while preserving browser artifacts.
- Add a zero-dependency ZenPi showcase site with GitHub Pages publishing.
- Pin the reviewed Pi package baseline.
