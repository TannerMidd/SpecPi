# ZenPi minimal command guard

## Status

Implementation plan for simplifying the existing command guard into a low-friction catastrophe guard. This plan replaces the previous command-guard plan in full.

Nothing described here is complete until the acceptance criteria pass.

## Product decision

ZenPi will provide three user-selectable modes:

1. **Guard (Recommended)** — prevent host-wide corruption with the fewest possible prompts.
2. **Strict** — retain approval prompts for destructive, remote, dynamic, and unknown operations.
3. **Off for this session** — disable command-guard interception after explicit confirmation.

Guard is not a general risk-confirmation layer. A command that is completely analyzed and does not match an immutable catastrophic rule must run without approval, even when it can modify files, execute code, install packages, alter remote state, or lose project data.

Strict is the mode for users who want those broader confirmations.

## Goals

1. Permanently deny commands that can corrupt or disable the host as a whole.
2. Recursively analyze supported Bash, PowerShell, and cmd payloads before deciding that they are non-catastrophic.
3. Remove routine approval prompts from Guard.
4. Ask in Guard only when analysis cannot determine whether a catastrophic operation is present.
5. Add an in-memory **Allow exact call for session** action for repeat approvals.
6. Ensure no approval, including a session approval, can override a newly detected catastrophic rule.
7. Preserve native-child propagation, installer rollback, checksum verification, bounded parsing, redaction, and non-persistence guarantees.
8. Describe the actual boundary honestly: defense in depth, not a sandbox or comprehensive data-loss/confidentiality control.

## Non-goals

- Preventing every destructive project, repository, database, container, cloud, or remote operation in Guard.
- Preventing a user from deleting one reviewed file or directory outside the workspace.
- Providing comprehensive credential or private-file read protection through shell command classification.
- Proving arbitrary scripts or generated programs safe.
- Containing Pi, malicious extensions, approved scripts, custom tools, or external processes.
- Persisting mode choices or approvals between sessions.
- Supporting regex, executable-name, rule-wide, category-wide, project-wide, or permanent allowlists.
- Replacing least-privilege accounts, containers, VMs, ACLs, or other operating-system controls.

## Mode contract

| Decision class | Guard | Strict | Off |
| --- | --- | --- | --- |
| Immutable catastrophic match | Deny; lock session | Deny; lock session | Allow |
| Guard/policy integrity failure | Deny call; do not auto-approve | Deny call; do not auto-approve | Allow |
| Parser unavailable, failed, or indeterminate | Ask; deny without UI | Ask; deny without UI | Allow |
| Known high/medium non-catastrophic operation | Allow | Ask | Allow |
| Ordinary mutation or execution | Allow | Ask unless proven read-only | Allow |
| Known read-only operation | Allow | Allow | Allow |
| Unknown execution-capable tool | Allow with an explicit coverage warning in documentation | Ask | Allow |
| Protected native-child propagation failure | Deny launch | Deny launch | Allow according to existing Off behavior |

The policy engine must classify risk independently from the selected mode. Mode mapping happens only after every parsed leaf, redirect, nested payload, and integrity result has been aggregated. This prevents mode-specific shortcuts from hiding a catastrophic nested leaf.

### Off transition contract

Off is an explicit direct-user escape hatch, not an approval result:

- only an interactive top-level user may select Off at startup or invoke `/guard off`;
- both paths show the full consequence and require a second confirmation;
- model tool calls, approval choices, session approvals, extension bindings, and child processes cannot enter Off;
- Off lasts only until session start, session switch, shutdown, or an explicit mode change;
- entering or leaving Off clears session approvals and invalidates pending prompts/preflights;
- a Guard- or Strict-bound child cannot weaken to Off;
- Off is not inherited by native children; a child launched by an Off top-level session receives a fresh Guard binding.

## Guard behavior

### Immutable catastrophic denies

Guard and Strict permanently deny operations that can destroy, disable, or take control of the host broadly. The initial immutable set is:

- recursive or wildcard deletion of a filesystem root, Windows drive root, operating-system tree, boot tree, or whole user-profile/home root;
- raw-disk overwrite, filesystem formatting, partition-table destruction, volume clearing, and destructive RAID/LVM/pool/encryption operations;
- destructive bootloader, recovery, or boot-configuration mutation;
- broad shutdown or termination of critical host processes where the operation can destabilize the machine;
- fork bombs and equivalent unbounded process creation;
- broad disabling or removal of firewall, audit, endpoint protection, mandatory access controls, or equivalent host security controls;
- mutation or removal of the installed command guard, its managed policy, or Pi/ZenPi state required to enforce it;
- protected system-path writes whose direct effect can make the operating system unusable;
- a supported nested payload that contains any immutable operation above.

Matching must consider the executable, operation, flags, target scope, canonical path, shell semantics, and nested command graph. Command-name matching alone is insufficient.

A confirmed catastrophic match:

1. denies without an allow action;
2. records only bounded in-memory category/rule counters;
3. locks execution, mutation, and native-child launch tools;
4. identifies the matched rule in `/guard status`;
5. requires direct user confirmation through `/guard unlock`.

### Operations Guard must allow without prompting

Once analysis is determinate and no immutable rule matches, Guard allows the call. This includes:

- inline interpreter code and encoded PowerShell whose decoded payload is non-catastrophic;
- local scripts, project hooks, plugins, tests, builds, and package scripts;
- package installation, update, removal, publication, and registry operations;
- network transfer, remote execution, and downloads not piped unresolved into an interpreter;
- ordinary Git pushes, pulls, fetches, and history inspection (destructive Git operations — force push, remote ref deletion, hard reset, clean, branch/tag deletion, stash drop, discarding checkout/restore, and history rewrites — ask in Guard because they destroy work no undo restores);
- workspace and out-of-workspace file creation, overwrite, movement, and bounded deletion;
- recursive deletion that does not encompass a protected system/root/profile target;
- database drops, migration rollback, container prune, Kubernetes mutation, and cloud/IaC destruction;
- service, scheduled-task, account, ACL, permission, registry, environment, and PATH changes that do not match an immutable host-security/system rule;
- ordinary process termination;
- reads, searches, and text processing, including shell reads of credential-like paths;
- known non-catastrophic custom tools.

These operations may still cause severe data loss. Guard intentionally does not prompt for them. Documentation must direct users who want broader confirmation to Strict.

### Uncertainty in Guard

Guard asks only when the analyzer cannot establish that the command is free of immutable catastrophic behavior. Examples include:

- malformed or unsupported shell syntax;
- unresolved executable position;
- runtime expansion or generated code whose payload cannot be inspected;
- parser timeout, unavailable helper, invalid parser output, or safety-limit exhaustion;
- downloaded or decoded content connected directly to a shell/interpreter when its payload cannot be analyzed before execution;
- unsupported nested shell/host boundaries;
- unresolved canonicalization for a target that may be a protected system path.

With UI, parser and payload uncertainty asks; without UI, it denies the call. A policy-integrity failure that makes the decision engine itself untrustworthy denies the call without an approval path. Neither uncertainty nor an infrastructure failure locks the session. A lock is reserved for a confirmed catastrophic match or confirmed guard tampering.

## Strict behavior

Strict keeps the existing broader approval posture:

- immutable catastrophic matches remain unapprovable denies;
- determinate high/medium operations ask;
- ordinary mutation and execution that is not proven read-only asks;
- unknown execution-capable tools ask;
- indeterminate analysis asks;
- missing UI denies every decision that requires approval.

Strict approvals may use Allow once or Allow exact call for session. Strict must never weaken the immutable rule set.

## Session approvals

### Approval actions

An `ask` prompt offers:

1. **Deny (Recommended)**
2. **Allow once**
3. **Allow exact call for session**
4. **Lock session**

Escape and timeout mean Deny.

### Exact-call scope

A session approval is keyed by a cryptographic hash of the complete validated call identity:

- tool name;
- selected shell or execution adapter;
- effective working directory;
- complete tool input;
- active mode;
- policy version.

The guard stores only the hash and bounded metadata needed for counts and expiry. It does not store raw commands, arguments, paths, prompts, or approval text.

Session approvals:

- are bounded to at most 128 entries with deterministic oldest-entry eviction;
- reset on `session_start`, session switch, shutdown, mode change, Off, lock, and unlock;
- are process-local and are never persisted or inherited by native children;
- cannot be added by a model tool call or arbitrary pattern;
- cannot apply to a different cwd, changed input, changed mode, or changed policy version.

### Reanalysis and precedence

Every repeated call is parsed and classified again before consulting the session approval set.

Order of operations:

1. validate the current tool input;
2. parse and recursively analyze the current call;
3. aggregate all current findings;
4. deny and lock any current catastrophic match;
5. deny any current policy-integrity failure and map parser/payload uncertainty to `ask`;
6. only then consult the exact-call session hash for an `ask` decision;
7. allow when the hash matches; otherwise prompt.

A session approval never converts a `deny` into an `allow`. It only satisfies a current `ask` decision for the exact same call identity.

Add `/guard clear-approvals` to remove all session approvals. `/guard status` reports only their count, never command content or hashes. Do not add `/guard allow <pattern>` or any reusable rule/category allow command.

## Shell and nested-payload requirements

### Bash/POSIX

Retain bounded quote-aware parsing, redirects, pipelines, substitutions, wrappers, nested shells, heredocs, `find -exec`, command-string runners, and PowerShell-host detection.

A determinate non-catastrophic Bash command is allowed in Guard regardless of its high/medium classification. Dynamic or unsupported payloads ask because catastrophe could not be ruled out.

### PowerShell

Retain native `Parser.ParseInput` analysis, aliases, redirections, `-Command`, every unambiguous `-EncodedCommand` prefix, `Invoke-Expression`, `Start-Process`, and nested cmd handling.

Decoded payloads must be recursively classified:

- benign decoded payload in Guard: allow;
- catastrophic decoded payload: immutable deny;
- undecodable or unsupported payload: ask, or deny without UI.

### cmd.exe

The cmd analyzer must recursively dispatch literal nested hosts, not only nested cmd/call forms. At minimum it must recognize:

- `cmd`/`cmd.exe /c` and `/k`;
- `call` and supported literal batch forms;
- `powershell`/`powershell.exe`/`pwsh` with every accepted `-Command` or `-EncodedCommand` prefix;
- literal PowerShell `-File` forms under the existing local-script policy;
- PowerShell → cmd → PowerShell nesting;
- cmd → PowerShell → cmd nesting up to the shared depth bound.

Every recognized PowerShell host reached through cmd must do exactly one of the following: recursively analyze its literal inline/encoded payload, classify a supported literal file form, or mark the nested invocation indeterminate. An implicit, malformed, dynamic, or unsupported PowerShell invocation must never become a clean Guard allow merely because its flag form was not recognized.

Use a shared nested-host dispatcher or another structure that avoids an unsafe Bash/PowerShell/cmd import cycle.

Mandatory regressions include both `-Command` and `-EncodedCommand`: a `Remove-Item -Recurse -Force C:\Windows` payload routed through `cmd /c powershell.exe` must be an immutable deny, never `dynamic.inline-code` approval. Benign equivalents must allow in Guard and ask in Strict. Implicit or unsupported forms must be indeterminate.

## Paths and reads

Retain lexical and canonical path analysis for catastrophic mutation targets, including drive roots, UNC/device paths, ADS, symlinks/junctions, nearest existing ancestors, mixed separators, and case-insensitive Windows comparison.

Guard's protected-path set must be narrowed to paths whose mutation can damage host operation or enforcement. A path must not become catastrophic merely because it contains words such as `zenpi`, `session`, `auth`, or `command-guard` outside the installed agent directory.

Credential and private-state confidentiality is not a comprehensive command-guard guarantee. Existing direct `read`-tool blocks may remain as a narrow defense, but documentation must not claim that all shell readers are recognized or denied. Do not expand a fragile executable-name list in an attempt to classify every possible reader.

Credential content connected to a detected upload or execution graph may remain an immutable rule where the graph is fully established, but ordinary reads alone are not a Guard prompt or deny requirement.

## Native subagents

Preserve the existing mandatory propagation contract:

- managed native children load the command guard;
- the parent injects and validates the reserved mode/policy binding;
- children cannot weaken Guard or Strict;
- locked parents cannot launch children;
- missing, malformed, unsupported, or unverifiable propagation denies the launch;
- external subscription runners remain disabled;
- researcher and unrelated user extensions remain preserved.

Session approvals are never propagated. A noninteractive child in Guard allows determinate non-catastrophic calls and denies indeterminate calls that would require UI.

## Implementation changes

### Policy engine

1. Separate shell/path risk classification from mode-to-action mapping.
2. Review every current critical rule against the catastrophe definition above.
3. In Guard, map all determinate noncritical findings to allow.
4. Keep parser and payload uncertainty as ask, and reserve unapprovable denial for policy-integrity failures.
5. Reserve session locking for confirmed catastrophe or confirmed self-tampering.
6. Preserve strict action precedence: a lower finding never weakens a higher one.

### Extension state and UI

1. Add the bounded in-memory exact-call approval set.
2. Add the fourth approval choice.
3. Reanalyze before approval lookup and preserve deny precedence.
4. Clear approvals on every lifecycle/mode/lock boundary.
5. Add `/guard clear-approvals` and approval count to `/guard status`.
6. Ensure storage, logging, diagnostics, and network activity newly created by the command guard never persist or upload raw command/input data.

### Parser correction

1. Add PowerShell-host recursion to cmd analysis.
2. Cover direct cmd and PowerShell → cmd → PowerShell `-Command`, `-EncodedCommand`, literal-file, and unsupported host forms.
3. Ensure helper absence yields uncertainty, not a false clean parse.
4. Preserve input, token, depth, leaf, output, and timeout bounds.

### Documentation

Update together:

- `README.md` — Guard is catastrophe-only; Strict is approval-heavy; explain exact-call session approval.
- `SECURITY.md` — remove comprehensive protected-read claims and distinguish catastrophic protection from data-loss/confidentiality protection.
- `CHANGELOG.md` — record the behavior change and nested cmd/PowerShell correction.
- `site/wiki/index.html` — update mode comparison, prompt choices, and limitations.
- tests and smoke-validator descriptions — use the same policy language.

## Test plan

### Mode mapping

Verify representative operations in both modes:

- package install: Guard allow, Strict ask;
- network transfer: Guard allow, Strict ask;
- destructive Git (force push, remote deletion, reset --hard, clean, branch/tag deletion, stash drop, rebase): Guard ask, Strict ask;
- ordinary push, pull, fetch: Guard allow, Strict ask;
- bounded recursive workspace deletion: Guard allow, Strict ask;
- out-of-workspace write: Guard allow, Strict ask;
- inline interpreter code: Guard allow, Strict ask;
- unknown execution-capable tool: Guard allow, Strict ask;
- filesystem-root recursive deletion: deny in both;
- disk formatting and boot destruction: deny in both;
- unresolved dynamic payload: ask in both, deny without UI.

### Session approvals

Verify:

- Allow once prompts again on repetition;
- Allow exact call for session suppresses the repeat prompt;
- changed command, cwd, tool input, mode, or policy version misses the approval;
- session approval is cleared by lifecycle, mode, lock, unlock, and Off transitions;
- the set is bounded and evicts deterministically;
- only hashes and bounded counters are retained;
- a newly detected catastrophic result overrides an existing approval;
- concurrent prompts cannot share or race approvals;
- children do not inherit approvals.

### Off transitions

Verify:

- startup Off and `/guard off` each require an interactive top-level user and second confirmation;
- cancel, Escape, timeout, or missing UI leaves protection active;
- model calls, approval choices, session hashes, bindings, and children cannot select Off;
- Off resets at every session lifecycle boundary and is never persisted;
- entering or leaving Off clears approvals and invalidates pending prompts/preflights;
- a child launched from an Off top-level session starts in Guard.

### Nested payloads

Add Windows regressions for:

- direct benign and catastrophic `powershell -Command`;
- direct benign and catastrophic encoded PowerShell;
- Bash → PowerShell encoded payload;
- cmd → PowerShell `-Command` payload using full and abbreviated flags;
- cmd → PowerShell encoded payload using every accepted prefix;
- cmd → PowerShell literal `-File` form;
- PowerShell → cmd → PowerShell command and encoded payloads;
- implicit, malformed, dynamic, and unsupported PowerShell host forms becoming indeterminate;
- nested depth exhaustion;
- missing PowerShell parser helper;
- every accepted PowerShell command/encoded-command parameter prefix.

All destructive payloads remain inert strings. Executor harnesses must prove the executor was not called after a deny.

### Existing guarantees

Retain coverage for:

- root/system path normalization on Unix and Windows;
- disk, boot, security-disablement, fork-bomb, broad-kill, and guard-tamper rules;
- malformed input and parser integrity failures;
- native-child binding and real inert child propagation;
- installer install/update/doctor/uninstall and rollback injection;
- command redaction and absence of persistence sinks;
- deterministic fuzzing and analysis limits;
- `git diff --check` and managed checksum drift.

## Implementation sequence

### Phase 1 — Lock the contract

1. Encode the mode table as focused failing tests.
2. Add the cmd → PowerShell catastrophic and benign regressions.
3. Add session-approval lifecycle and precedence tests.
4. Update the policy vocabulary in test names and fixtures.

**Exit gate:** tests precisely describe the new behavior and fail for the expected current implementation reasons.

### Phase 2 — Simplify Guard and fix nested dispatch

1. Refactor classification away from mode mapping.
2. Make determinate noncritical results allow in Guard.
3. Narrow lock behavior to confirmed catastrophic/self-tamper findings.
4. Add cmd-to-PowerShell nested analysis without introducing parser cycles.
5. Keep Strict behavior and immutable denies intact.

**Exit gate:** mode and nested-payload suites pass on Linux and Windows PowerShell 5.1/7.

### Phase 3 — Add exact-call session approvals

1. Implement bounded hashed approval state.
2. Add prompt and clear/status UX.
3. Enforce reanalysis-before-lookup and deny precedence.
4. Verify lifecycle, concurrency, privacy, and child isolation.

**Exit gate:** session approval tests pass and no guard-created raw input persistence path exists.

### Phase 4 — Align docs and release evidence

1. Update README, SECURITY, Wiki, changelog, smoke checks, and help text.
2. Run focused command-guard, path, extension, installer, and child tests.
3. Run `npm run check` and `git diff --check`.
4. Exercise isolated install → doctor → update → doctor → uninstall on Linux and Windows.
5. Obtain a fresh read-only security review focused on catastrophic bypasses, accidental Guard prompts, approval precedence, and nested host recursion.

**Exit gate:** every acceptance criterion below has direct evidence.

## Acceptance criteria

1. Guard produces no prompt for a completely analyzed non-catastrophic command.
2. Strict retains approval prompts for determinate high/medium and unproven execution/mutation operations.
3. Root/system recursive deletion, destructive disk/boot operations, critical security disablement, guard tampering, and equivalent host-wide corruption remain immutable denies in both modes.
4. A catastrophic payload remains denied through every recognized Bash, PowerShell, and cmd host boundary; every unresolved or unsupported nested host form is indeterminate rather than a clean Guard allow.
5. Both `cmd /c powershell.exe -Command <system-delete>` and `cmd /c powershell.exe -EncodedCommand <system-delete>` are denied and cannot be approved.
6. Benign command and encoded equivalents are allowed without prompting in Guard and ask in Strict.
7. Parser/payload uncertainty asks in Guard and Strict; lack of UI denies the call without locking the session. Policy-integrity failure denies without an approval path.
8. Allow exact call for session is bounded, hash-only, mode-scoped, non-persistent, non-inherited, and cleared at every required boundary.
9. Every repeated call is reanalyzed, and current catastrophic or policy-integrity denial always overrides a session approval.
10. Off requires direct interactive top-level confirmation, is session-only, cannot be selected by models/approvals/bindings/children, and is not inherited by children.
11. Documentation no longer claims comprehensive credential/private-state shell-read protection.
12. Protected native children remain mandatory and cannot weaken the parent mode.
13. Storage, logging, diagnostics, and network behavior added by the command guard do not persist or upload raw commands, arguments, cwd values, paths, prompts, AST data, approval text, credentials, or Pi private state. Validation does not inspect unrelated Pi authentication, sessions, missions, history, or trust state.
14. Focused suites, deterministic fuzzing, Windows PowerShell 5.1/7 coverage, native-child coverage, installer lifecycle/rollback tests, `npm run check`, and `git diff --check` pass.
15. A fresh final review finds no merge-blocking catastrophic bypass or unintended Guard prompt class.

## Release boundary

This behavior is defense in depth, not a sandbox. Guard protects against a reviewed set of host-catastrophic model tool calls. It intentionally allows many commands capable of project, remote, or user-data loss. Users who want confirmation for those operations must select Strict or use an operating-system isolation boundary.
