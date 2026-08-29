# Changelog

## Unreleased

- Add a native Windows command launcher and Windows-safe executable discovery for `pi.cmd`, `npm.cmd`, and access-restricted Windows App Execution Aliases such as `winget.exe`.
- Invoke `.cmd`/`.bat` shims through `ComSpec` without Node's deprecated `shell: true` argument handling.
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
