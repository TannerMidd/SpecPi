# ZenPi Security Model

This document describes ZenPi's architecture-level security assumptions, enforcement boundaries, and residual risks. It complements the public vulnerability-reporting policy in [SECURITY.md](SECURITY.md). Exact third-party versions and licenses are maintained in [THIRD_PARTY.md](THIRD_PARTY.md).

## Threat model

### Assets

ZenPi aims to preserve:

- user files, Git work, and host stability;
- Pi configuration, credentials, sessions, history, and trust decisions;
- ZenPi-managed files, backups, manifests, checksums, and enforcement code;
- local wishlist evidence and browser artifacts;
- the confidentiality and integrity of reports, prompts, commands, and paths that ZenPi does not need to persist.

### Untrusted inputs and actors

ZenPi expects model-generated tool calls, repository content, web content, downloaded package metadata, and browser page output to be potentially hostile or malformed. A dependency, extension, project configuration, approved script, or direct user command is more powerful than ordinary model output and may cross boundaries ZenPi cannot enforce.

### Trusted components

ZenPi ultimately trusts the invoking user and operating-system account, the Pi runtime, explicitly installed packages and extensions, project and user configuration treated by Pi as trusted, package registries and upstream publishers used during installation, and commands or scripts the user approves. These are trust assumptions, not claims that every component is independently verified.

### Security goals

ZenPi seeks to make installation explicit and reversible, avoid private Pi state it does not need, preserve unrelated configuration, prevent exact-provider policy from silently weakening, block confirmed catastrophic model operations at supported tool seams, keep local improvement evidence local, and isolate browser QA from the user's personal browser profile.

### Non-goals

ZenPi is not an operating-system sandbox and does not claim to contain a compromised host, user account, Pi runtime, trusted extension, approved script, dependency, custom tool, or already-running process. It cannot prevent every credential read, data transfer, destructive operation, prompt-injection effect, time-of-check/time-of-use race, or action outside its documented interception points. Use operating-system permissions, least privilege, protected credentials, containers, or virtual machines when stronger isolation is required.

## Installer and managed state

ZenPi is configuration and executable extension code for Pi and runs with the invoking user's permissions. The installer prints a plan and requires confirmation unless `--yes` is supplied. `plan` is non-mutating. Installation and update merge documented settings leaves, preserve unrelated packages and configuration, and modify AGENTS and shell files only inside ZenPi marker blocks.

Before replacing managed resources, ZenPi creates bounded backups, stages writes, promotes files atomically where supported, records checksums and ownership in a private manifest, and rolls configuration files back when a core installation step fails. It does not persistently copy complete Pi settings or shell startup files. Symlink, lock, ownership, and malformed-state checks fail closed where the installer cannot prove a supported mutation.

ZenPi never reads Pi authentication files, provider credentials, sessions, history, missions, or trust decisions as part of installation or local improvement reporting. It does not commit, push, publish, or create remote resources.

When Pi is missing, a confirmed bootstrap can install the pinned Pi package globally with lifecycle scripts disabled. Existing compatible Pi installations are preserved. Pi packages are installed through Pi's package mechanism, and the browser runtime is installed from ZenPi's reviewed lockfile before atomic promotion and launch smoke testing. ZenPi does not install Playwright operating-system dependencies.

Global package installations, upstream package-manager effects, downloaded caches, and optional tools are external system state. A later ZenPi failure does not necessarily remove them, and uninstall preserves them. The optional DonSeTch package performs its own binary acquisition and remains outside ZenPi's rollback boundary. The canonical inventory is in [THIRD_PARTY.md](THIRD_PARTY.md).

## Command Guard

Command Guard is a pre-execution policy layer for model-initiated Pi tool calls. It covers Pi's documented `bash`, `powershell`, `read`, `write`, and `edit` tools. Other extensions, custom or MCP tools, direct user `!command` and `!!command` escapes, approved scripts, and process execution outside these seams are not contained.

Interactive top-level sessions choose one session-only mode:

- **Guard** denies confirmed host-wide catastrophe and enforcement tampering, asks before destructive Git operations, and stays quiet for determinate non-catastrophic work.
- **Strict** additionally asks about mutation, execution, recognized sensitive reads, elevation, network activity, and uncatalogued tools.
- **Off** is a twice-confirmed direct-user escape hatch limited to the current session.

Guard is not general change control. Determinate calls may delete project or user data, publish, deploy, install software, transfer data, change services, or reach outside the workspace. Git work destruction is the deliberate broader approval boundary because it can discard or rewrite work that local rollback cannot recover.

The guard analyzes Bash/POSIX and cmd command structure conservatively and uses installed PowerShell parser APIs without evaluating the command. It resolves protected paths using lexical and canonical information where available and carries working-directory changes through supported command sequences. Confirmed catastrophic payloads remain immutable denials. Analysis, parser, payload, or path uncertainty asks for approval when interactive UI is available and denies without UI; uncertainty cannot silently approve a call.

Approvals are exact-call and session-scoped. Every call is reanalyzed before an approval can satisfy it, and approval never overrides a critical denial. Only a structurally proven lock-worthy critical mutation locks subsequent execution; parser uncertainty, syntax mismatch, fallback classification, and refused reads deny the current call without permanently stranding the session. Session lifecycle changes and guard-mode changes clear transient approval state.

The guard keeps mode, lock, counters, parser cache, and approval hashes only in memory. It does not persist or upload raw commands, arguments, paths, working directories, parser output, prompts, or approvals. Display excerpts are bounded and redact common secret-bearing forms.

Static analysis cannot resolve every alias, generated command, script body, plugin, encoding, runtime expansion, symlink race, or interpreter behavior. Recognized private-path reads receive narrow protection, but arbitrary scripts or shell syntax can still read credentials. An allowed or approved command runs with the user's full permissions. `zenpi doctor` verifies installed checksums and deterministic policy smoke behavior, not universal command safety.

## Local improvement state

Capability-gap collection is disabled until the user makes an explicit local on/off choice. When enabled, ZenPi stores bounded sanitized summaries and salted hashes used to measure distinct tasks, sessions, and projects. It does not read prompts, source files, sessions, history, credentials, provider authentication, or trust decisions to construct reports, and it never uploads wishlist state.

Improvement journals may contain sanitized acceptance evidence, verification gates, repository-relative changed-file names, version data, and bounded reopen context. Raw source content and complete settings snapshots are not part of those records.

Sanitization is defense in depth, not a guarantee that every plain-language identity or sensitive fact can be detected. Users should keep summaries general and inspect reports and local issue drafts before sharing them.

Wishlist evidence does not authorize implementation. `/harness-improvement` requires one explicit human selection, and retirement requires the repository check plus supported closed validators. Failed verification leaves the item selected. Validator identifiers resolve through a closed allowlist rather than being interpreted as commands.

Wishlist state, archives, and browser artifacts can survive uninstall so uninstall does not silently destroy user evidence. Stop Pi and review retained state before manual removal. Archive and reset operations use checksummed snapshots and recoverable transactions; unverified abandoned locks are not reclaimed automatically.

## Browser isolation

ZenPi launches managed Chromium in a fresh Playwright context. It does not attach to a personal browser profile or load the user's cookies, saved passwords, or extensions. Browser pages still execute untrusted content and can reach URLs available to the host.

Snapshots, screenshots, page text, downloads, console output, and visual baselines may contain sensitive information. Default artifacts remain in ZenPi's private state directory. Explicit output publication is bounded and atomic, and existing artifacts or baselines are not replaced without explicit overwrite authorization.

The browser is not an operating-system or network sandbox. Use a container or VM for hostile applications and dedicated test accounts instead of personal authenticated sessions.

## Website and automation

The GitHub Pages workflow publishes the checked-in `site/` directory. Its deploy job uses read-only repository contents access plus the Pages and identity-token permissions required for deployment. The local installer does not invoke that workflow or upload local configuration or state.

Repository checks, smoke tests, checksums, closed capability validators, and browser comparisons provide evidence for documented behavior. They reduce regression risk but do not prove the absence of vulnerabilities or establish cryptographic provenance for dependencies and releases.

## Supply-chain assumptions

ZenPi pins reviewed executable package versions and the browser dependency graph. These controls improve repeatability and make version changes reviewable. They do not prove that a registry, publisher account, package artifact, downloaded browser, GitHub Action tag, or invoking host is uncompromised. Releases are not described as reproducible or cryptographically signed unless a future release adds and documents those mechanisms.

Users should review tagged source, installation plans, dependency changes, and security advisories; use protected branches and least-privilege automation when maintaining a fork; and upgrade promptly when ZenPi or an upstream project publishes relevant security guidance.
