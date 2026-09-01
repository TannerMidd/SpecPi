# Changelog

## 0.8.2 - Unreleased

- Keep command-guard denials fail-closed without making every uncertain or wrong-shell cleanup attempt strand the session: only structurally proven lock-worthy critical mutations latch `locked`, while parser fallback, shell-syntax mismatches, and refused reads remain non-latching denials.
- Protect installed command-guard files as managed enforcement nodes rather than treating the whole command-guard directory as protected, allowing unrelated temporary descendants while preserving ancestor and canonical-path protection. Share the managed-file inventory with installer resources and checksums.
- Classify cmd-style `rd`/`rmdir /s /q` sent directly to the Windows Bash tool as a corrective non-latching denial, and keep parser-fallback protected-path matching local to the destructive statement so unrelated scratch cleanup cannot inherit a critical result.

## 0.8.1 - 2026-08-30

- Ask for Guard approval before Git destroys work. Force pushes (`--force`, `-f`, `--force-with-lease`, `--force-if-includes`) and the wider destructive Git family — remote ref deletion, hard resets, cleans, branch and tag deletion, stash drops, discarding checkouts and restores, rebases, and history rewrites — now surface an approval in Guard instead of running silently, because they discard or rewrite work no local undo restores. Ordinary pushes, pulls, and fetches stay quiet in Guard; all of it still asks in Strict.

## 0.8.0 - 2026-08-31

- Parse Bash and cmd at the statement level instead of treating every word in command position as a program. Shell reserved words (`if`/`then`/`while`/`until`/`for`/`do`), the `!` negation prefix, and the `builtin`/`command`/`coproc`/`time` prefixes were taken as leaf executables, so in `if true; then rm -rf /; fi` the real command survived only as an argument list on a leaf named `then` and matched no rule at all. `trap 'rm -rf /' EXIT` now analyzes its handler string, and cmd `if` conditionals are unwrapped the way `for` already was.
- Resolve the heredoc consumer instead of assuming `-c` makes the body inert. `bash -c 'sh' <<EOF … EOF` runs the body through the `sh` that `-c` launches, and `su root <<EOF` runs it as root, so both are code rather than data.
- Thread the working directory through a command sequence. Relative targets always resolved against the session cwd regardless of what ran before them, so `cd / && rm -rf usr`, `Set-Location C:\ ; Remove-Item -Recurse -Force Windows`, `cd /d C:\ && rmdir /s /q Windows` and `env --chdir=/ rm -rf usr` were each reported as a determinate, clean delete inside the workspace. A directory change the analyzer cannot resolve now makes later targets uncertain instead of clean.
- Protect the ancestors that contain enforcement state, not only the subtree itself. Deleting `<agent-dir>/extensions/command-guard` was denied while deleting `<agent-dir>/extensions` or the whole agent directory — a superset of the same tampering — was allowed. Destructive Git operations run inside protected or enforcement trees are classified with them.
- Canonicalize the path spellings that reach the same target: Win32 trailing dots and spaces (`C:\Windows.`), `~` under PowerShell as well as Bash, the macOS firmlinked `/private/etc` and `/private/var` trees, and the Windows `EFI`/`Recovery` boot partitions.
- Complete the decode-to-interpreter set (`base32`, `basenc`, `xxd`, `hexdump`, `od`) and the critical-process list (`svchost`, `services`, `smss`, `winlogon`, `launchd`), which previously closed only the base64 and `lsass`/`csrss` spellings of the same operation.
- Stop an unavailable parser from downgrading a catastrophe into an approvable prompt. A helper timeout, a missing interpreter or a blown limit produced `ask`, so the case where the guard knows least was the case where it yielded most. The raw command text is now scanned for confirmed catastrophic operations before any approval is offered, including the payload of an inline-code flag such as `-Command` or `-c`, which is program text rather than data. The scan reads only what the shell would execute as syntax — quoted arguments stay inert and backslash is treated as an escape only where the shell treats it as one — so a command that merely prints a destructive-looking string is not mistaken for one.
- Give the PowerShell parser helper the environment it needs to start. Spawned with only `SystemRoot`, `PATH` and `TEMP`, Windows PowerShell 5.1 hung indefinitely on a current Windows Server 2025 image — measured at five of five spawns killed at a 20-second bound with no output and no error — while the same spawn with `PSModulePath`, `APPDATA`, `LOCALAPPDATA` and `USERPROFILE` present completed in about 380 ms. PowerShell 7 was unaffected. Every 5.1 analysis in a session therefore waited out its full bound before falling back. The helper still runs on an allowlist that withholds tokens, keys and other credential-bearing variables.
- Match endpoint-protection services as complete tokens rather than substrings. `security`, `firewall` and `sentinel` matched anywhere in the arguments, so ordinary units — `redis-sentinel`, `security-scanner.service`, an in-house `firewall-ui` — were critical denials that locked the session.
- Identify credential paths by shape rather than by bare words that ordinary source trees use as directories. `credentials`, `token`, `secret` and `passwd` matched as standalone path segments, so every file under a monorepo's `packages/token/`, `src/secret/` or `app/credentials/` was a critical read denial.
- Resolve the agent directory with the analyzed platform's path semantics rather than the host's, so cross-platform classification is deterministic instead of depending on how the host resolves a foreign path spelling.
- Reformat all tracked JavaScript and TypeScript for readability with four-space indentation, explicit braced control flow, one statement per line, and consistent spacing around blocks and returns. Add pinned project-local Prettier and ESLint checks so future changes preserve the style.
- Guide agents to prefer simple, explicit commands while Command Guard is active, reducing avoidable parser-uncertainty approvals without weakening or bypassing protection.
- Add a first-party, session-scoped command guard with Guard, Strict, Off, and Locked states. Guard is a narrow catastrophe backstop: confirmed host-wide destruction and enforcement tampering are immutable denials, analysis uncertainty asks with UI and denies headlessly, and determinate non-catastrophic work runs without routine prompts. Strict retains broad approval behavior.
- Add bounded shell-specific analyzers, native PowerShell AST parsing without evaluation, protected-path canonicalization, display redaction, deterministic policy smoke validation, and Linux/Windows regression coverage across PowerShell 5.1, PowerShell 7, cmd, and inert adversarial corpora.
- Propagate protected modes to supported native subagents through the pinned public preflight contract, a managed child extension, and a reserved binding; preserve unrelated child extensions, block unverifiable launch forms, and exercise a real inert native-child process in CI.
- Parse PowerShell with whichever installed host accepts the command text: PowerShell 7 grammar (`&&`, `??`, `?:`) is no longer denied as malformed when only Windows PowerShell 5.1 parses it, and either host alone is now sufficient. A rejection is authoritative only when every installed host rejects it, and a spawn failure can never escalate a syntax error into a critical denial.
- Classify argv-prefix runners (`setsid`, `stdbuf`, `ionice`, `taskset`, `flock`, `systemd-run`, `unbuffer`, `runuser`, `setarch`, `xvfb-run`, `proxychains`), command-string runners (`su`, `runuser`, `script`, `watch`), awk shell escapes, and `osascript`/`tclsh`/`expect` inline code, so a critical payload cannot be laundered through an unlisted wrapper.
- Treat a whitespace-bearing command token as unresolved rather than reducing it to its trailing path segment, and propagate an unresolved nested child up to the whole analysis so wrapped command strings cannot be reported as a clean parse.
- Match every PowerShell parameter prefix, not only full spellings: `-enc` runs the same code as `-EncodedCommand`, so an abbreviated flag used to carry a base64 payload past the guard with no approval when the invocation arrived through the Bash or cmd parser. Bash- and cmd-hosted `powershell`/`pwsh` invocations now decode and classify their `-Command`/`-EncodedCommand` payload instead of seeing one opaque argument, including recursive `cmd /c powershell.exe` dispatch, and an absent PowerShell parser downgrades to an approval rather than locking the session over an interpreter the command could not have used.
- Remove routine Guard approvals for determinate non-catastrophic work, including project or user-data deletion, force push, publication, installation, network transfer, process termination, service and registry changes, and out-of-workspace targets. Keep those broader prompts in Strict. Narrow Guard's protected mutation boundary to host-root/key system targets and, inside the installed agent, command-guard enforcement sources, `settings.json`, and `zenpi/manifest.json`.
- Identify Pi and ZenPi private state by location rather than by name. `zenpi/manifest.json`, `zenpi/backups`, `zenpi/wishlist` and `extensions/command-guard` were matched as bare relative segments, so reviewing ZenPi's own repository denied a file read critically and locked the session, and `guard.self-tamper` fired on any mutation whose arguments merely contained "zenpi" or "command-guard" — `mkdir zenpi-experiment` was a critical denial. On POSIX the rule was an unanchored `/(?:zenpi|pi).*(?:auth|session|…)/`, so everyday files such as `src/api/session.ts` and `lib/api/auth.py` ("pi" inside "api") were denied critically too. These now key on the resolved `PI_CODING_AGENT_DIR`; Guard protects only enforcement-critical installed state while Strict retains the wider private-path policy.
- Stop latching the session lock when a *read* is refused. Blocking the read is the protection; locking additionally refused every later call — including read-only ones — until `/guard unlock`, so one blocked file ended the session. Critical mutation attempts still lock.
- Stop treating a plain `find` as a deletion. `find` sits in the delete family for `-delete`/`-exec`, but `hasRecursiveFlag` matches any predicate containing an "r", so `find src -type f -print` was reported as "Recursive deletion needs approval", `find /etc -name '*.conf'` denied critically, and `find . -name zenpi` tripped guard self-tamper. Mutating `find` now reaches `filesystem.find-mutation`, which was unreachable behind the delete-family branch, and `clearlyReadOnly` shares the same predicate list.
- Classify complete environment enumeration however it is spelled (`printenv`, `declare -x`, `export -p`, `compgen -v`, bare `declare`) and recognize `/proc/<pid>/environ` and `/proc/<pid>/mem` shell reads. Strict asks about those findings; Guard does not claim comprehensive credential-read protection.
- Protect macOS system roots (`/System`, `/Library`, `/Applications`, `/Users/<name>`, `/Volumes/<name>`, `/private/etc`, `/cores`) and `.bash_profile`/`.zshenv`/`.zlogin`, without capturing the firmlinked `/System/Volumes/Data` user tree.
- Give approval prompts a human-scale bound and add **Allow exact call for session**. Reuse is limited to 128 in-memory SHA-256 fingerprints over complete tool input, cwd, mode, and policy version; calls are always reanalyzed first, critical denials cannot be overridden, and `/guard clear-approvals` clears the set.
- Fail doctor on installed command-guard checksum drift, on a `pi-subagents` version that no longer matches the pinned native-child contract, and when no PowerShell parser host is available; add byte-for-byte installer/update rollback injection coverage.
- Document the defense-in-depth boundary, including direct user commands, custom tools, approved scripts, trusted extensions/configuration, TOCTOU behavior, and the need for OS-level isolation with hostile code.

## 0.7.0 - 2026-08-29

- Make retirement durable: every capability now ships a closed validator from a reviewed catalog, `finish_harness_improvement` dispatches all linked validators generically and fails closed on unknown names, and `npm run check` plus `zenpi doctor` continuously re-prove retired capabilities in temporary state.
- Add the improvement journal: retirements persist bounded sanitized proof (acceptance evidence, gates, repo-relative changed files, ZenPi version) in the local decision log, `/wishlist history [id]` renders the harness's own changelog with rollback context, and the report's retired list shows verification dates and gates.
- Add loop health metrics: deterministic retirements, reopen rate, open reviews, median time-to-retire, and qualification rate rendered in the report footer and summarized by `/wishlist status`.
- Make reopens context-rich: reopen decisions link to the retirement they review, carry up to five sanitized post-retirement signals, and the `/harness-improvement` prompt includes the original proof and what changed since.
- Extend repository checks to the wishlist extension and validator sources, ship the validator module through install/update/uninstall, and run completion validators from the source checkout under review; document the new local-only journal data classes in SECURITY.md and the `ZenPi-Gap:` commit trailer convention in the improvement skill.

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
