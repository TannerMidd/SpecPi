# Background tasks implementation contract

Authorized by the human's instruction to implement PLAN.md fully, including narrow Guard integration, release preparation, and a PR. Preserve the existing AGENTS.md commit on `feat/background-tasks`.

## Requirements and acceptance

R1.1–R1.6 in PLAN.md remain the requirements: four validated tools; exact interactive approvals and Guard denial/lock enforcement; bounded concurrency/retention; observable best-effort cleanup; byte-cursor output; focused tests, isolated installer lifecycle, full checks and fresh security review. No MCP implementation.

## Design decisions

- Reuse `decideCommand` with a synchronous Guard admission event carrying mode/generation and decision. Missing Guard uses Guard-mode static policy; an installed but unready/old/ambiguous responder fails closed. Off disables Guard classification only, not background approval. Strict shares its decision through the feature prompt. Stop/list/logs are reviewed cleanup/observation tools and remain accessible under a lock.
- Explicit `/bin/sh -c` on POSIX and system `cmd.exe /d /s /c` on Windows, not Pi Bash configuration. Inherit process environment for normal developer commands; never resolve provider authentication or inject session paths. Same-user processes are trusted execution, not isolated secrets consumers.
- A bundled Node supervisor remains alive until cleanup so the owned root PID is not reused after a short-lived shell command exits. POSIX uses its process group; Windows uses fixed system taskkill argv. Detached descendants and descendants no longer discoverable after intermediate parent exit remain residual risks. Cleanup evidence covers the owned root/group, not all possible descendants.
- Limits: command 16 KiB UTF-8, cwd 4 KiB, label 128 bytes, four active tasks, 32 completed records, 128 approvals; 256 KiB/task ring and 64 KiB/read; 1–28,800 second timeout, default 1,800. Approval deadline 10 minutes, supervisor startup deadline 10 seconds, cleanup grace 5 seconds plus bounded escalation. Failed cleanup retains its slot.
- Shutdown handles quit/reload/new/resume/fork; tree navigation also revokes and cleans up. No factory-started processes or timers. No persistent grants or output journal.
- This is repository-native work, not wishlist retirement. Do not modify the closed validator policy or claim a capability retirement. Doctor runs the installed background smoke directly.

## Paths

`AGENTS.md`, `extensions/background-tasks/`, `extensions/command-guard/index.ts`, narrowly related tests and fixtures (including the existing Pi RPC suite), `scripts/specpi.mjs`, package-validation scripts if needed to verify registration, `PLAN.md`, `TASK.md`, `README.md`, `SECURITY_MODEL.md`, `CHANGELOG.md`, `package.json`, and release-version references in `site/`. No Chat version bump unless Chat changes.

## Validation evidence

- `npm run check`: passed (695 tests passed, seven existing optional/platform skips); package check passed.
- After review-driven test additions: eight focused background/RPC tests and syntax checks passed; packaged Pi 0.84.4 discovery/registration passed again.
- Linux background tests passed using an existing Node 24.15 image, network disabled, a read-only checkout, and an init reaper. Windows background/tree tests passed locally. macOS was not executed locally.
- Isolated installer plan/install/update/doctor/uninstall passed, including background checksum drift rejection and installed smoke execution.
- Fresh read-only review found no concrete release-blocking defects after targeted evidence was added. Cleanup uncertainty remains a documented limitation, not a guarantee of universal descendant death.
- npm publish/pack dry runs completed without publication. Windows npm reported a bin-path normalization warning; its normalization code retains the bin target, and packaged metadata/CLI validation passed.
- Release text was inspected in rendered desktop, tablet, and mobile views. No layout or browser behavior was changed.

## Rollback and non-goals

Stop owned tasks and disclose unconfirmed cleanup before reverting feature-specific changes. Never remove unrelated work. No publish, tag, merge, deployment, remote execution, sandbox claim, PTY, persistent tasks, or automatic follow-up model turns. Commit/push/PR are authorized; release target is SpecPi 0.19.0.
