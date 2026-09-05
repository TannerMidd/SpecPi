# SpecPi Security Model

This document describes SpecPi's architecture-level security assumptions, enforcement boundaries, and residual risks. It complements the public vulnerability-reporting policy in [SECURITY.md](SECURITY.md). Exact third-party versions and licenses are maintained in [THIRD_PARTY.md](THIRD_PARTY.md).

## Threat model

### Assets

SpecPi aims to preserve:

- user files, Git work, and host stability;
- Pi configuration, credentials, sessions, history, and trust decisions;
- SpecPi-managed files, backups, manifests, checksums, and enforcement code;
- local wishlist evidence, experiment metadata and patches, session-branch workflow records, and browser artifacts;
- the confidentiality and integrity of reports, prompts, commands, and paths that SpecPi does not need to persist.

### Untrusted inputs and actors

SpecPi expects model-generated tool calls, repository content, web content, downloaded package metadata, and browser page output to be potentially hostile or malformed. A dependency, extension, project configuration, approved script, or direct user command is more powerful than ordinary model output and may cross boundaries SpecPi cannot enforce.

### Trusted components

SpecPi ultimately trusts the invoking user and operating-system account, the Pi runtime, explicitly installed packages and extensions, project and user configuration treated by Pi as trusted, package registries and upstream publishers used during installation, and commands or scripts the user approves. These are trust assumptions, not claims that every component is independently verified.

### Security goals

SpecPi seeks to make installation explicit and reversible, avoid private Pi state it does not need, preserve unrelated configuration, prevent exact-provider policy from silently weakening, block confirmed catastrophic model operations at supported tool seams, keep local improvement evidence local, and isolate browser QA from the user's personal browser profile.

### Non-goals

SpecPi is not an operating-system sandbox and does not claim to contain a compromised host, user account, Pi runtime, trusted extension, approved script, dependency, custom tool, or already-running process. It cannot prevent every credential read, data transfer, destructive operation, prompt-injection effect, time-of-check/time-of-use race, or action outside its documented interception points. Use operating-system permissions, least privilege, protected credentials, containers, or virtual machines when stronger isolation is required.

## Installer and managed state

SpecPi is configuration and executable extension code for Pi and runs with the invoking user's permissions. Installing the public npm package adds the `specpi` CLI to npm-managed state but does not run SpecPi installation, download external tools, or mutate Pi state; the package defines no npm install lifecycle script. The installer prints a plan and requires confirmation unless `--yes` is supplied. `plan` is non-mutating. Installation and update merge documented settings leaves, preserve unrelated packages and configuration, and modify AGENTS and shell files only inside SpecPi marker blocks.

The canonical npm route is an installer-CLI distribution. Direct `pi install npm:specpi` loads packaged extensions, skills, and themes but bypasses the managed installer, so it does not provide managed instructions, supporting packages, browser runtime acquisition, optional tools, shell integration, backups, or ownership records. Pi-bundled runtime modules are optional peers and are not copied into the tarball. Release automation validates the packed artifact, requires a matching immutable version and release tag, publishes only from a protected environment, and requests npm provenance through short-lived GitHub OIDC credentials.

Before replacing managed resources, SpecPi creates bounded backups, stages writes, promotes files atomically where supported, records checksums and ownership in a private manifest, and rolls configuration files back when a core installation step fails. It does not persistently copy complete Pi settings or shell startup files. Symlink, lock, ownership, and malformed-state checks fail closed where the installer cannot prove a supported mutation.

SpecPi never reads Pi authentication files, provider credentials, sessions, history, missions, or trust decisions as part of installation or local improvement reporting. It does not commit, push, publish, or create remote resources.

When Pi is missing, a confirmed bootstrap can install the pinned Pi package globally with lifecycle scripts disabled. Existing compatible Pi installations are preserved. Pi packages are installed through Pi's package mechanism, and the browser runtime is installed from SpecPi's reviewed lockfile before atomic promotion and launch smoke testing. SpecPi does not install Playwright operating-system dependencies.

Global package installations, upstream package-manager effects, downloaded caches, and optional tools are external system state. A later SpecPi failure does not necessarily remove them, and uninstall preserves them. The optional DonSeTch package performs its own binary acquisition and remains outside SpecPi's rollback boundary. The canonical inventory is in [THIRD_PARTY.md](THIRD_PARTY.md).

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

Static analysis cannot resolve every alias, generated command, script body, plugin, encoding, runtime expansion, symlink race, or interpreter behavior. Recognized private-path reads receive narrow protection, but arbitrary scripts or shell syntax can still read credentials. An allowed or approved command runs with the user's full permissions. `specpi doctor` verifies installed checksums and deterministic policy smoke behavior, not universal command safety.

## Local improvement state

Capability-gap collection is disabled until the user makes an explicit local on/off choice. When enabled, SpecPi stores bounded sanitized summaries and salted hashes used to measure distinct tasks, sessions, and projects. It does not read prompts, source files, sessions, history, credentials, provider authentication, or trust decisions to construct reports, and it never uploads wishlist state.

Improvement journals may contain sanitized acceptance evidence, verification gates, repository-relative changed-file names, version data, and bounded reopen context. Raw source content and complete settings snapshots are not part of those records.

Sanitization is defense in depth, not a guarantee that every plain-language identity or sensitive fact can be detected. Users should keep summaries general and inspect reports and local issue drafts before sharing them.

Wishlist evidence does not authorize implementation. `/harness-improvement` requires one explicit human selection, and retirement requires the repository check plus supported closed validators. Failed verification leaves the item selected. Validator identifiers resolve through a closed allowlist rather than being interpreted as commands.

An improvement selection binds a unique generation, canonical source checkout, and bounded source baseline to the current session branch. `record_harness_contract` records planning data only for that selected improvement; the extension supplies its authority metadata. The model cannot replace an existing card with a different one. A human card revision preserves its selection binding, and a new menu selection creates a fresh baseline. Branch navigation restores that branch's selection and invalidates pending selection, recording, and verification operations. Historical entries without the new binding remain readable but require a fresh selection before new verification.

Verification records are extension-generated observations under the trusted Pi runtime, repository scripts, and dependencies. They are not signatures, independent attestations, or protection against a compromised extension. Completion compares supported source inputs before and after each executable gate and checks selection, card, scope, and source again before retirement. Source fingerprints cover the documented inventory rather than arbitrary files on the host. Incomplete or unsafe inventories block retirement. The journal retains hashes, gate outcomes, runtime metadata, and the card digest separately from sanitized model explanations; raw source and command output are not retained. The decision log is bounded and ownership-locked; archive snapshots have checksums.

The selection preserves the npm scripts map, package-check and formatting policy, task-contract and scope rules, wishlist lifecycle rules, existing validator policy, and existing capability definitions. An ordinary new capability can add its own registry entry using the preserved validator catalog. Changes to these verification-policy modules require human review and a new selection before they can support retirement; ordinary feature implementations and tests remain editable within the task contract. Tests are discovered only from `tests/*.test.mjs`, and formatting commands name the reviewed configuration explicitly. Verification rejects a checkout-level `.npmrc` without reading it because it can alter script execution and may contain credentials. Snapshot comparison cannot detect every transient modification followed by restoration, filesystem race, or effect outside the supported inputs.

User and global npm configuration, including a user-level `script-shell` override, remains part of the trusted execution environment outside the source snapshot.

The exact source inventory and size limits are defined in [verification.mjs](extensions/tool-wishlist/verification.mjs). It covers the known source, test, documentation, and configuration inputs, with at most 2,048 files, 8 MiB per file, and 64 MiB total. Dependency trees, generated output, and private runtime state are excluded. Unsupported, ignored, symlinked, or oversized inputs within that inventory block verification rather than producing a partial receipt.

Outcome feedback is an explicit human action with collection enabled. It links to an exact latest local retirement with a verification receipt, and is stored as a non-lifecycle decision. Deliberate corrections append history; concurrent stale answers are rejected. Negative feedback can surface a review need but never authorizes implementation or performs a revert. Older retirements without receipts and shipped baseline capabilities have no inferred outcome. Reopen metrics distinguish local retirement cycles from reviews of shipped baseline capabilities.

Wishlist state, archives, and browser artifacts can survive uninstall so uninstall does not silently destroy user evidence. Stop Pi and review retained state before manual removal. Archive and reset operations use checksummed snapshots and recoverable transactions; unverified abandoned locks are not reclaimed automatically.

## Workflow controls

Optional task cards contain human-authored or selected-improvement planning text, stable requirement IDs, acceptance checks, expected relative paths, rollback, and non-goals. They are bounded records on the active Pi session branch. A card does not authorize another task or widen scope. `/scope task` explicitly imports its paths while preserving pending findings, and imported scope is marked stale after a card revision. Card-backed completion reviews must cover the exact original requirement IDs and match the active card digest; a changed card invalidates earlier review evidence. Branch navigation restores task, scope, and review state and cancels pending task edits, handoffs, and completion challenges from the previous branch. This strengthens consistency checks without turning model-authored evidence into independent proof.

`/task handoff` renders a bounded review packet in the current conversation from the active card, observed change information, matching model review, and unresolved facts. It does not launch an agent, export a file, trigger another turn, or transmit information. Task text and path information may be sensitive; the human controls any later sharing.

The Scope Drift Monitor is task-scope governance, not a filesystem sandbox. It preflights direct `write` and `edit` paths and compares bounded Git worktree snapshots around tools. Shell commands, scripts, custom tools, concurrent processes, very large dirty sets, changes made and reverted within one call, filesystem timestamp behavior on oversized files, and non-Git sessions can reduce or bypass its observations. The snapshot a tool finishes on becomes the baseline for the next tool, so a change made outside any tool call is attributed to whichever tool runs next rather than going unseen; only `read`, which cannot mutate the worktree, is skipped. Interactive users choose deny, allow-once, or scope expansion for direct out-of-scope calls. Headless and post-hoc findings remain advisory and pending rather than fabricating human consent. `/scope accept` acknowledges a finding without widening the contract, `/scope add` widens it, `/scope task` explicitly imports the active task card while preserving pending findings, and `/scope recheck` clears snapshot uncertainty only as a deliberate human act. Git reports paths verbatim under `-z`, so a filename may contain newlines or other control characters; every path SpecPi reports back through the system prompt, tool results, or the UI is percent-escaped first so a hostile filename cannot forge a line of guidance. Scope entries, changed relative paths, and pending findings are copied into the active Pi session branch so an appended record cannot be rewritten later; raw tool input, command text, output, and source are not copied into workflow state.

Guided Experiment Worktrees use explicit extension commands and fixed Git argv, so their internal `pi.exec` calls are outside Command Guard's model-tool interception. SpecPi therefore requires its own confirmations before creation, overwrite, and removal, revalidates the registered worktree and common Git directory before destructive removal, and never automatically reclaims an abandoned registry lock or missing worktree. A directory Git no longer tracks as a worktree can only have its registry record released; SpecPi leaves those files in place for the human rather than deleting them. Recovery re-reads `git worktree list` and revalidates the record's repository inside the registry lock immediately before it mutates state, so an external Git operation performed while a recovery prompt is open cannot cause a stale answer to drop a live record or adopt a replaced directory. Experiments are detached from a recorded `HEAD`; dirty base changes stay in place and are excluded. Patch export uses a temporary Git index and can invoke repository-configured Git clean filters through `git add -A`; trusted repository configuration remains part of the trust boundary. Status and export measure from the recorded base commit rather than the worktree's current HEAD, so work the human commits inside an experiment stays visible to status, reaches the patch, and triggers the discard confirmation. Git writes the patch file itself so its bytes are preserved exactly, including text that is not valid UTF-8. A patch output that appears after the existence check is claimed exclusively rather than overwritten, so an unapproved replacement fails closed. Ignored files are outside both Git status and `git add -A`, so they never appear in a patch; SpecPi counts and names them before an export or a discard, but a discarded ignored file is not recoverable. SpecPi does not launch a writer, create a branch or commit, merge, apply a patch, or alter remotes.

The private experiment registry stores canonical repository and worktree paths, base commit IDs, bounded user-authored hypotheses, acceptance checks, non-goals, lifecycle state, and timestamps under `<agent-dir>/specpi/experiments`. Exported patches contain source changes by design and may be sensitive. SpecPi requests `0700` directories and `0600` files, but Windows ignores POSIX modes, so on that platform these artifacts are protected by the user profile's own access control rather than by the requested mode. Experiment metadata and patches are user evidence and survive uninstall unless explicitly removed. Registry writes are atomic and ownership-locked, but a crash, filesystem failure, external `git worktree` operation, malicious Git configuration, symlink race, or manual state edit can require `/experiment recover` or direct human repair.

Completion Challenge activation and structured results are bounded to the current Pi session branch. An activation that the agent turn ends without answering expires with that turn, so its instruction never carries into later work. An expiry is recorded distinctly from `/challenge clear`, so an unanswered challenge never retires the last completed card. The extension records changed relative paths, active scope summaries, matching experiment acceptance metadata, and tool failure counts observed during the task; it does not scan unrelated historical sessions, prompts, source, or raw tool output. A deterministic gate rejects a ready verdict when its own submission reports unresolved requirements, contradictions, validation gaps, or pending scope drift. When the change snapshot was indeterminate the facts the review received may be incomplete, so a ready verdict must disclose that residual risk; the condition is permanent outside a Git worktree, so it is required disclosure rather than an unreachable verdict. The underlying analysis is still produced by the same model and context, so it can omit a requirement, misunderstand evidence, or rationalize a false positive. The card is a review aid, not independent validation, authorization, or a completion lock.

## Browser isolation

SpecPi launches managed Chromium in a fresh Playwright context. It does not attach to a personal browser profile or load the user's cookies, saved passwords, or extensions. Browser pages still execute untrusted content and can reach URLs available to the host.

Snapshots, screenshots, page text, downloads, console output, and visual baselines may contain sensitive information. Default artifacts remain in SpecPi's private state directory. Explicit output publication is bounded and atomic, and existing artifacts or baselines are not replaced without explicit overwrite authorization.

The browser is not an operating-system or network sandbox. Use a container or VM for hostile applications and dedicated test accounts instead of personal authenticated sessions.

## Website and automation

The GitHub Pages workflow publishes the checked-in `site/` directory. Its deploy job uses read-only repository contents access plus the Pages and identity-token permissions required for deployment. The local installer does not invoke that workflow or upload local configuration or state.

Repository checks, smoke tests, checksums, closed capability validators, and browser comparisons provide evidence for documented behavior. They reduce regression risk but do not prove the absence of vulnerabilities or establish cryptographic provenance for dependencies and releases.

## Supply-chain assumptions

SpecPi pins reviewed executable package versions and the browser dependency graph. These controls improve repeatability and make version changes reviewable. They do not prove that a registry, publisher account, package artifact, downloaded browser, GitHub Action tag, or invoking host is uncompromised. Releases are not described as reproducible or cryptographically signed unless a future release adds and documents those mechanisms.

Users should review tagged source, installation plans, dependency changes, and security advisories; use protected branches and least-privilege automation when maintaining a fork; and upgrade promptly when SpecPi or an upstream project publishes relevant security guidance.
