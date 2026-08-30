# ZenPi command guard

## Status

Implementation plan for a first-party, cross-platform command-protection extension. This plan replaces the previous completed-release plan in this file. No implementation work described below is complete until its acceptance evidence passes.

## Goal

Add an in-house ZenPi extension that lets a user select command protection at session start and blocks dangerous model-initiated operations before Pi executes them.

The feature must:

1. Intercept supported execution and file-mutation tools before execution.
2. Cover Pi's Unix-like `bash` path and native Windows `powershell` path, including nested `cmd.exe` calls.
3. Permanently deny catastrophic operations while protection is active.
4. Ask the user before lower-severity destructive or indeterminate operations.
5. Fail closed when parsing, policy loading, prompting, or child-agent propagation is unavailable or uncertain.
6. Apply the active policy to native ZenPi subagents, not only the parent session.
7. Avoid reading or persisting credentials, prompts, sessions, history, trust decisions, or raw command text.
8. Be explicit that this is defense in depth, not an operating-system sandbox.

## Non-goals

- Proving arbitrary shell programs safe.
- Containing a compromised Pi process, malicious extension, or process already running with the user's permissions.
- Replacing least-privilege accounts, containers, VMs, ACLs, AppContainer, or other OS security boundaries.
- Protecting direct human `!command`/`!!command` execution in the first release; those are explicit user actions and must be documented as outside the model-tool boundary.
- Silently inspecting downloaded or local script contents of arbitrary languages.
- Supporting user-authored regular-expression rules or persistent broad whitelists in the first release.
- Sending command reports, audit data, or policy information off the machine.

## Security statement

The command guard is a pre-execution policy layer over Pi tool calls. It can block a command only when every route capable of executing that command passes through an intercepted and verified tool path. It cannot guarantee containment when execution occurs through an unguarded custom/MCP tool, another extension, a direct user command, an approved script, or an external process.

Documentation and UI must use “command guard,” “protection,” or “defense in depth,” never “sandbox,” “complete containment,” or an equivalent guarantee.

## Threat model

### In scope

- An agent accidentally or intentionally requests a destructive shell command.
- An agent disguises a command with quoting, chaining, substitutions, wrappers, nested shells, aliases, encoded PowerShell, or redirects.
- An agent uses `write` or `edit` to mutate protected system, credential, or guard files.
- A native ZenPi subagent attempts the same operations.
- A malformed command, parser disagreement, missing parser, missing UI, or internal error would otherwise bypass policy.
- Repeated critical attempts indicate a potentially rogue or badly misaligned agent.

### Outside the hard boundary

- The human explicitly selects Off for the session.
- The human directly executes a shell escape.
- A trusted extension performs work without a Pi `tool_call` event.
- A custom tool can execute arbitrary processes but has not been classified by the guard.
- The user or another process modifies/disables the installed extension or Pi itself.
- A previously approved executable or script changes between analysis and execution.
- A command exploits the kernel, shell, parser, or another program.

### Required response to uncertainty

- **Guard mode:** indeterminate execution or mutation requires approval; without UI it is denied.
- **Strict mode:** indeterminate or unknown-capability tools are denied unless a bounded approval prompt can be shown.
- **Critical match, parser failure, invalid configuration, child propagation failure, or guard self-tampering:** deny without an “allow anyway” action.

## Product behavior

### Session-start selection

On an interactive top-level `session_start`, show one selector:

1. **Guard (Recommended)** — deny critical operations; ask for high-risk or indeterminate operations; allow low-risk operations.
2. **Strict** — Guard behavior plus approval for ordinary mutation, interpreters with inline code, process control, and unknown execution-capable tools.
3. **Off for this session** — show a second explicit warning and require confirmation.

Selection is process/session scoped and is not persisted in the first release. One-shot approvals, lock state, counters, and parser caches reset at session start and session switch.

A native child session must not show the selector. It receives a supervisor-injected policy binding. A noninteractive top-level session with no binding defaults to Guard; every decision requiring UI resolves to deny.

If startup initialization fails, set a fail-closed latch. Do not assume returning or throwing from `session_start` prevents the session from continuing; subsequent guarded tool calls must check the latch.

### Commands and status

Register `/guard` with subcommands or an equivalent interactive menu:

- `/guard status` — mode, policy version, lock state, and session-only block/approval counts.
- `/guard guard` — switch to Guard after confirmation when weakening from Strict.
- `/guard strict` — switch to Strict.
- `/guard off` — two-step explicit confirmation; valid only for the current top-level session.
- `/guard unlock` — clear a critical-attempt lock after displaying the triggering rule category and receiving confirmation.

Do not expose a slash command that adds arbitrary patterns or persistent whitelists. Slash commands are direct user actions; model tool calls cannot invoke them.

### Persistent visibility

Use a bounded status badge or footer item while the extension is active:

- `🛡 Guard`
- `🛡 Strict`
- `🛡 Locked`
- `Guard Off`

If no compatible status API is available, use startup and mode-change notifications and document the limitation. Do not implement a custom TUI component solely for the first release.

### Decisions

The pure policy engine returns:

```js
{
  action: "allow" | "ask" | "deny",
  severity: "low" | "medium" | "high" | "critical",
  category: "filesystem" | "disk" | "system" | "security" | "process" |
            "network" | "git" | "database" | "container" | "cloud" |
            "package" | "protected-path" | "dynamic" | "unknown",
  ruleIds: ["..."],
  leaves: [{ executable, operation, redactedTarget }],
  reason: "bounded user-facing explanation",
  saferAlternative: "optional bounded suggestion",
  indeterminate: false
}
```

Every parsed leaf contributes a decision. The final decision is the maximum severity/action; an allow match never cancels a deny or ask match elsewhere in a chain.

### Approval UI

For `ask`, show:

- severity and category;
- the redacted, bounded command leaf rather than the entire raw command;
- working directory and affected paths when known;
- why it matched;
- a safer alternative when one is reliable.

Actions:

1. **Deny (Recommended)**
2. **Allow once**
3. **Lock session**

Escape and timeout mean Deny. No timeout-based auto-approval is permitted. Approval applies only to that already-analyzed tool call; it is not a reusable regex or base-command whitelist.

### Critical-attempt lock

An immutable critical match:

1. blocks the call;
2. records only in-memory rule/category counters;
3. sets the session guard to Locked;
4. prevents subsequent execution, mutation, and subagent-launch tools;
5. notifies the user how to inspect and explicitly unlock it.

Use `terminate: true` only if the pinned Pi API confirms that it safely stops the current agent turn without ending the user's session. Otherwise return a normal block and rely on the lock latch. Test the selected behavior against the supported Pi baseline.

## Enforcement surface

### Guarded tool names

First release:

- `bash`
- `powershell`
- `write`
- `edit`
- `subagent`

Inspect Pi's supported tool input schemas at implementation time and narrow each handler by both tool name and validated input shape. Missing or malformed input for a guarded tool is a deny.

`read` protection is limited to known credential and ZenPi private-state paths. Ordinary source reads remain allowed. Any expansion beyond these names requires an explicit capability review and tests.

### Unknown/custom tools

Maintain a small, reviewed capability catalog:

- known read-only tools: allow in Guard and Strict;
- known bounded non-shell tools: apply declared policy;
- known execution-capable tools: require guard-specific handling;
- unknown tools: allow in Guard only when they are not declared or heuristically identified as process/file mutation tools; ask or deny in Strict.

Do not claim unknown tools are covered. Documentation must list the exact guarded tools. If a new installed ZenPi package introduces another process launcher, release checks must flag the catalog mismatch for review.

## Parsing and normalization architecture

Regex may match normalized parsed tokens but must not be the shell parser or command-boundary detector.

All parsers implement a common bounded interface:

```js
analyze(input, {
  platform,
  cwd,
  maxDepth,
  maxTokens,
  maxLeaves,
  timeoutMs
}) => {
  shell,
  leaves,
  redirects,
  dynamicConstructs,
  parseErrors,
  indeterminate
}
```

Limits for the initial implementation:

- maximum command input: 128 KiB;
- maximum tokens: 4,096;
- maximum command leaves: 128;
- maximum nested-shell recursion: 8;
- PowerShell parser helper timeout: 3 seconds;
- bounded in-memory LRU cache: at most 256 analyses, keyed by a hash of shell, command, cwd, parser version, and policy version.

Exceeding any limit is indeterminate and therefore ask/deny according to mode; it is never truncated and treated as safe.

### Bash/POSIX analyzer

Implement a no-execution, quote-aware scanner that recognizes:

- single and double quotes;
- backslash escaping and line continuations;
- comments and CRLF/newline separators;
- `;`, `&&`, `||`, `|`, `&`, and parentheses;
- redirects, including overwrite and device targets;
- command substitution, process substitution, and subshells;
- heredoc delimiters and bodies;
- assignments preceding commands;
- literal glob and path tokens.

Recursively inspect literal payloads for:

- `bash -c`, `sh -c`, `zsh -c`, and equivalent shells;
- `sudo`, `doas`, `env`, `command`, `nohup`, and `time` wrappers;
- `eval`;
- `xargs`;
- `find -exec`, `find -execdir`, and `find -delete`;
- interpreter inline-code flags when their language is supported by a rule.

Dynamic executable position, unresolved substitution, malformed quotes, unknown heredoc semantics, or generated code is indeterminate. A later hardened phase may replace the scanner adapter with a reviewed AST dependency, but no new dependency may be added until its version, license, install resolution, and supply-chain impact are reviewed and recorded in `THIRD_PARTY.md`.

### Native PowerShell analyzer

Bundle a fixed helper script that uses:

`System.Management.Automation.Language.Parser.ParseInput`

The Node extension invokes the helper directly without a shell, sends command text through stdin, and expects bounded JSON on stdout. The helper must parse only; it must never evaluate or invoke the supplied command.

Walk and report:

- every `CommandAst` and pipeline;
- redirections;
- script blocks and subexpressions;
- invocation operators;
- aliases for dangerous built-in cmdlets;
- nested `powershell`/`pwsh -Command` payloads;
- `-EncodedCommand`, decoded only under strict size/encoding bounds and recursively parsed;
- `Invoke-Expression`, `Start-Process`, `Invoke-Command`, and download-then-execute flows;
- provider paths such as Registry and Certificate stores.

Any PowerShell parse error, helper timeout, unavailable parser, unexpected output, dynamic `GetCommandName() === null`, or unsupported stop-parsing construct is indeterminate and fails closed.

The helper must work with Windows PowerShell 5.1 and PowerShell 7. Where AST behavior differs, return the parser edition/version and cover both in CI.

### cmd.exe analyzer

Analyze cmd syntax only when reached through a literal `cmd`/`cmd.exe /c` or `/k` leaf. Implement a separate conservative lexer for:

- `&`, `&&`, `||`, `|`, parentheses, and redirects;
- caret escaping;
- `/s` quote rewriting;
- `%VAR%` and delayed `!VAR!` expansion;
- `call`, `for /f`, nested `cmd`, and batch-file execution;
- malformed quoting and executable-position expansion.

Because cmd exposes no public AST comparable to PowerShell's, unsupported/dynamic constructs remain indeterminate. Never execute or reparse the supplied string through an extra `cmd.exe /c` during analysis.

### Paths

For path-sensitive rules:

1. resolve against the tool working directory;
2. normalize separators and dot segments;
3. use case-insensitive comparison on Windows;
4. identify UNC, drive-root, device, ADS, and extended-length paths;
5. resolve symlinks/junctions/reparse points for existing targets;
6. for nonexistent targets, resolve the nearest existing ancestor;
7. classify the lexical and canonical paths and take the stricter result.

Canonicalization failure on a potentially protected path is indeterminate, not safe. Document the remaining check/use race.

## Policy and rule packs

Rules are bundled code/data with stable IDs. Project files cannot weaken them. The first release accepts no arbitrary regex from user or project configuration.

### Immutable critical denies

At minimum:

- recursive or wildcard deletion of Unix root, a Windows drive root, system directories, home/profile roots, or broad parent paths;
- raw disk overwrite, filesystem formatting, partition-table destruction, volume clearing, or destructive RAID/LVM operations;
- guard implementation/configuration removal or modification through guarded tools;
- disabling Defender, firewall, endpoint/security policy, audit controls, or equivalent host protections broadly;
- destructive boot configuration changes;
- credential/private-key reads followed by an upload or shell execution path when detected in one command graph;
- downloaded or decoded content piped directly to a shell/interpreter;
- fork bombs or broad process-kill operations capable of taking down the host;
- parser/policy integrity failure.

Representative command families include, but are not limited to:

- Unix: `rm`, `find -delete`, `shred`, `truncate`, `dd`, `mkfs`, `wipefs`, `fdisk`, `parted`, `shutdown`, `reboot`, broad `kill`, and critical `systemctl` operations.
- Windows: `Remove-Item`, `Clear-Disk`, `Initialize-Disk`, `Format-Volume`, `Remove-Partition`, `format`, `diskpart`, `vssadmin`, `bcdedit`, broad `taskkill`, `Stop-Computer`, `Restart-Computer`, `Set-MpPreference`, and firewall-disabling commands.

The match must include operation, flags, target classification, and shell semantics. Command-name matching alone is insufficient.

### High-risk approval categories

- recursive deletion within a bounded workspace;
- `git reset --hard`, `git clean`, branch/tag deletion, history rewrite, and force push;
- database `DROP`, `TRUNCATE`, broad `DELETE`, migration rollback, or destructive administration;
- Docker/Podman prune, image/volume deletion, Kubernetes delete/drain, and cloud/IaC destroy operations;
- package publish/unpublish and destructive registry operations;
- service, scheduled-task, registry, account/group, ACL, ownership, or permission mutation;
- broad process termination;
- writes outside the workspace;
- inline interpreter code and local scripts that are not statically inspected;
- redirects that overwrite files;
- network upload or remote execution with local data.

### Medium-risk operations

Guard may ask and Strict must ask for:

- package install/update/remove;
- ordinary process termination;
- profile, environment, shell-init, or PATH mutation;
- ordinary service restarts;
- mutation through tools with plugins/hooks/config execution;
- commands whose affected target is only partially resolved.

### Low-risk operations

Allow only after parsing confirms no higher-severity leaf or redirect. Examples include bounded listing/search, `git status/diff/log`, and compiler/test invocations without known mutation flags. Low-risk lists are convenience rules, not proof that a binary is intrinsically read-only.

## Protected paths

At minimum protect mutations to:

- filesystem roots and critical OS directories;
- boot, device, system service, security policy, registry, and package-manager configuration;
- the user's SSH, cloud, package, and signing credential locations;
- Pi/ZenPi authentication, sessions, history, missions, trust decisions, private state, and installed guard files;
- shell profiles and startup files, at least as medium/high risk;
- parent directories whose recursive mutation would encompass a protected path.

For `read`, deny only recognized credential/private-key and forbidden Pi/ZenPi private-state paths. Never enumerate or inspect those directories to decide whether a secret exists; make the decision from the requested path.

## Subagent propagation

This is a release blocker, not a follow-up enhancement.

Current ZenPi settings use `subagents.defaultExtensions: []`, and a parent extension cannot observe commands executed inside a child process. The implementation must establish and test all of the following:

1. Add the installed command-guard extension to the native subagent `defaultExtensions` set without removing unrelated user extensions.
2. Before a guarded parent permits a `subagent` tool call, inject a reserved binding such as:

```json
{
  "zenpi.command-guard/1": {
    "mode": "guard",
    "policyVersion": 1,
    "parentLocked": false,
    "nonce": "bounded-random-session-value"
  }
}
```

3. Reject agent-supplied attempts to remove, replace, or weaken the reserved binding.
4. Child startup accepts only a valid supervisor-injected binding; it may strengthen but never weaken the parent mode.
5. Locked parents cannot launch children.
6. External subscription runners remain disabled under existing ZenPi policy.
7. If the current Pi/pi-subagents API cannot inject and verify the binding, Guard and Strict must block subagent launches rather than claim child protection.

The implementation spike must verify the exact extension identifier/path and binding API against ZenPi's supported Pi and `pi-subagents` versions. Add a real child-process acceptance test; a configuration assertion alone is insufficient.

## State, privacy, and configuration

### Session state

Keep in memory only:

- active mode;
- ready/fail-closed/locked latch;
- policy/parser versions;
- bounded approval/block counters by category and rule ID;
- bounded parser cache keyed by hashes;
- a random session nonce used only for child binding.

Never persist raw commands, command arguments, prompts, cwd values, affected paths, parser ASTs, or approval history.

### Persistent configuration

No persistent mode, whitelist, custom pattern, or project policy in the first release. Bundled critical rules cannot be disabled by settings. This keeps installation ownership and concurrency small and ensures every interactive top-level session makes an explicit choice.

The only persistent integration is the required child-extension entry in the documented subagent settings leaf. Preserve unrelated array entries and user configuration. Uninstall removes only ZenPi's managed entry or restores the pre-install value according to the existing backup/checksum transaction.

### Redaction

Before displaying a command excerpt, redact values associated with common secret-bearing flags, authorization headers, URL userinfo, known token environment assignments, and private-key content markers. Limit excerpts and reasons to documented byte counts. Redaction is display-only; classification uses the in-memory original.

No command content is written to logs, custom session entries, wishlist records, diagnostics, crash artifacts, or the improvement journal.

## Proposed source layout

```text
extensions/command-guard/
  index.ts                 # Pi hooks, UI, latches, tool routing, subagent binding
  core.mjs                 # Pure policy aggregation and mode behavior
  rules.mjs                # Stable built-in rule catalog
  bash.mjs                 # POSIX/Bash scanner and wrapper recursion
  powershell.mjs           # Node adapter for the native parser helper
  powershell-parser.ps1    # ParseInput AST walker; no evaluation
  cmd.mjs                  # Conservative cmd lexer
  paths.mjs                # Lexical/canonical protected-path classification
  redact.mjs               # Bounded display redaction
  smoke.mjs                # Offline closed validator, if registry-backed

tests/
  command-guard.test.mjs
  command-guard-paths.test.mjs
  command-guard-extension.test.mjs
  fixtures/
    command-guard-harness.ts
    command-guard-child-harness.ts
    command-guard-powershell.ps1
```

Keep rule matching and parsing pure where possible. `index.ts` should contain no command-pattern logic.

## Pi API compatibility spike

Before the main implementation, pin and prove the contract against the minimum supported Pi version and current compatible version:

- exact `bash`, `powershell`, `write`, `edit`, and `subagent` tool input shapes;
- `tool_call` blocking and input-mutation return shapes;
- handler ordering when multiple extensions intercept the same call;
- behavior when a handler throws;
- prompt availability and cancellation in TUI, RPC, print, and JSON modes;
- `session_start`/`session_switch` lifecycle behavior;
- `terminate` semantics;
- status API availability;
- native child extension resolution and `extensionBindings` delivery.

Record these assumptions in focused harness tests. If the peer dependency remains `>=0.84.4`, fail closed on unknown future input shapes rather than assuming compatibility.

## Installer and package integration

Treat `extensions/`, templates, scripts, and shell files as source of truth.

Update:

- `scripts/zenpi.mjs`
  - required-source assertions for every command-guard file;
  - explicit source-to-agent managed-file mappings;
  - checksum manifest and retirement behavior through the existing transaction;
  - settings merge for the required subagent extension entry;
  - doctor checks and optional closed validator dispatch.
- `package.json`
  - syntax checks for each `.mjs` and `.ts` source;
  - package file coverage remains through `extensions`, plus any deliberately added root documentation;
  - add a pinned dependency only after review.
- `templates/settings.json`
  - add the required native child extension entry while preserving unrelated installed entries at merge time.
- installer tests
  - plan is non-mutating;
  - install/update/uninstall require confirmation unless `--yes`;
  - all tests use a temporary `PI_CODING_AGENT_DIR`;
  - installed files exist with checksums;
  - update retires removed files;
  - uninstall preserves user-modified files with warnings and restores managed settings safely.

Do not use lifecycle scripts, global parser installations, or network access at guard runtime.

## Doctor and validation integration

Add a deterministic offline validator only if this capability is entered in the ZenPi capability registry. The validator must:

- run in temporary state;
- import the real pure policy/parsers;
- classify representative safe, critical, and malformed inputs;
- verify fail-closed aggregation;
- verify no raw command persistence;
- perform no network/provider calls;
- avoid executing destructive commands;
- complete within the existing bounded validator timeout.

`zenpi doctor` should verify:

- all managed guard files are installed and checksummed;
- the child-extension setting is present;
- the parser helper is readable;
- the offline smoke validator passes;
- PowerShell availability is reported accurately on Windows without executing supplied command text.

Doctor cannot prove complete bypass resistance and must not claim that it does.

## Test plan

### Pure policy tests

- exact severity/action precedence;
- mode layering for Guard, Strict, Off, Locked, and fail-closed startup;
- immutable denies cannot be weakened by lower-severity matches;
- indeterminate analysis asks with UI and denies without UI;
- stable unique rule IDs and bounded explanations;
- malformed rule/catalog data fails closed;
- redaction does not affect classification;
- no persistent/raw-command write path exists.

### Bash corpus

Include safe and dangerous pairs for:

- quoted and escaped separators;
- comments, CRLF, and continuations;
- pipelines, substitutions, subshells, process substitutions, and redirects;
- heredocs;
- `sudo`/`env`/`nohup` wrappers;
- `bash -c`, nested shells, `eval`, `xargs`, and `find -exec/-delete`;
- root versus workspace deletion;
- device and system targets;
- malformed and dynamically generated executable names;
- known pi-defender regression classes without copying its implementation.

### PowerShell corpus

Run on Windows PowerShell 5.1 and PowerShell 7:

- AST command/pipeline extraction;
- aliases and case insensitivity;
- script blocks, subexpressions, and invocation operators;
- `-Command`, `-EncodedCommand`, and nested PowerShell;
- `Invoke-Expression`, `Start-Process`, and download-execute;
- Registry/Certificate providers;
- `--%` and native argument-passing differences;
- malformed syntax and helper timeout/failure;
- command-name-null/dynamic AST cases.

### cmd corpus

- `/c`, `/k`, and `/s` handling;
- quote stripping, carets, metacharacters, parentheses, and redirects;
- `%VAR%`/`!VAR!` executable expansion;
- `call`, `for /f`, nested cmd, and batch execution;
- malformed/unsupported constructs resolving to indeterminate;
- harmless differential fixtures confirming extracted command boundaries.

### Path tests

- Unix root, home, system, device, and workspace paths;
- Windows drive roots, mixed separators/case, UNC, device, extended-length, and ADS paths;
- `.`/`..`, repeated separators, and nonexistent targets;
- Unix symlinks and Windows junctions/reparse points where CI supports them;
- nearest-existing-ancestor behavior;
- parent recursive operations encompassing protected descendants;
- canonicalization permission errors and race simulations.

### Extension harness

Emit synthetic tool events and assert:

- initialization latch behavior;
- exact block result before executor invocation;
- startup selection, mode changes, and Off confirmation;
- prompt cancellation/timeout/no-UI denial;
- critical lock and explicit unlock;
- tool input validation;
- `write`/`edit` protected paths;
- unknown/custom tool behavior by mode;
- parser exception and timeout fail closed;
- bounded concurrent preflights do not share approvals or race lock state;
- command text is absent from persisted custom entries and test logs.

### Subagent tests

- installed default extension reaches a real native child;
- parent mode and policy version arrive through the reserved binding;
- child cannot weaken Strict to Guard or Off;
- spoofed/missing binding is denied;
- a dangerous child command is blocked before execution;
- locked parent cannot dispatch;
- unsupported propagation blocks dispatch;
- researcher-specific extensions continue to work alongside the guard.

### Fuzz and properties

Use deterministic seeds and bounded runs:

- arbitrary Unicode, quotes, escapes, separators, and newlines never crash;
- adding a dangerous leaf cannot reduce severity;
- parser uncertainty never changes from ask/deny to allow;
- redaction always removes seeded sentinel secrets from UI output;
- analyses respect token, depth, leaf, input-size, and timeout limits;
- regexes, if any remain in token-level rules, meet a safe-regex review and runtime budget.

### End-to-end matrix

- Ubuntu current LTS with Bash;
- Windows Server current with Windows PowerShell 5.1, PowerShell 7, and cmd;
- configured Pi `powershell` tool and default Windows `bash`/Git Bash path where available;
- TUI-compatible harness plus print/JSON no-UI behavior;
- isolated install → doctor → update → doctor → uninstall round trip on Linux and Windows.

Never execute a destructive payload in tests. Policy tests classify strings; execution-boundary tests use inert marker commands or temporary fixtures and assert the guarded executor was not called.

## CI changes

Current Windows CI covers launch/installer smoke but not extension execution. Add:

- cross-platform pure policy and path tests;
- a Windows extension harness;
- PowerShell 5.1 and 7 parser runs;
- cmd differential fixtures;
- native child propagation coverage where the installed Pi fixture supports it;
- deterministic fuzz seeds within a bounded CI budget.

Keep the normal Linux `npm run check`. Add explicit per-file syntax checks and `git diff --check` to release validation. Do not run installer integration against the live Pi directory.

## Documentation

Update together:

- `README.md`
  - feature summary;
  - startup choices and `/guard` usage;
  - exact tools/platforms covered;
  - concise defense-in-depth warning.
- `SECURITY.md`
  - threat model and trust boundaries;
  - guarded and unguarded execution paths;
  - fail-closed behavior;
  - subagent inheritance;
  - local in-memory data and explicit non-persistence;
  - direct-user-command, custom-tool, script, TOCTOU, parser, and sandbox limitations.
- `CHANGELOG.md`
  - command guard, Windows coverage, and policy-boundary entry under the target release.
- `THIRD_PARTY.md`
  - only if code or a parser dependency is reused; preserve upstream license notices.
- `site/wiki/index.html`
  - startup UX, commands, protected categories, and security boundary.
- managed `AGENTS.md` guidance
  - only if agents need a concise instruction for responding to a guard denial; do not imply that prompt guidance is an enforcement layer.

Do not create or replace visual baselines unless explicitly requested. If the Wiki UI changes materially, validate it with the browser tools at desktop, tablet, and mobile viewports.

## Implementation phases

### Phase 0 — API and propagation spike

1. Build temporary harnesses for all guarded tool schemas and lifecycle events.
2. Prove input mutation/block/error semantics against the supported Pi baseline.
3. Prove child extension loading and binding delivery.
4. Decide the exact extension identifier used in `defaultExtensions`.
5. If propagation cannot be verified, implement and test the mandatory “block subagents while protected” fallback before continuing.

**Exit gate:** checked-in tests encode the contracts; no production rule claims yet.

### Phase 1 — Pure core and Unix protection

1. Add decision types, mode aggregation, limits, redaction, and rule catalog.
2. Implement protected-path normalization/classification.
3. Implement the Bash scanner and recursive wrapper extraction.
4. Add the Unix rule corpus and pure tests.
5. Verify no raw command persistence/logging.

**Exit gate:** deterministic corpus, path tests, fuzz invariants, and syntax checks pass.

### Phase 2 — Windows protection

1. Implement the ParseInput helper and Node adapter.
2. Implement the conservative cmd lexer.
3. Add Windows filesystem and command rules.
4. Add PowerShell 5.1/7 and cmd CI fixtures.
5. Validate parser timeout/error fail-closed behavior.

**Exit gate:** Windows CI proves representative safe, destructive, nested, dynamic, and malformed cases.

### Phase 3 — Pi extension UX and latches

1. Register session lifecycle, startup selector, commands, and status indicator.
2. Route guarded tool calls through the pure engine.
3. Add approval UI, no-UI policy, critical lock, and concurrency control.
4. Gate `write`, `edit`, protected `read`, and unknown tools as specified.
5. Add extension harness tests.

**Exit gate:** no guarded executor is called after deny; prompts and locks behave exactly as documented.

### Phase 4 — Native subagent enforcement

1. Install/load the guard in native children.
2. Inject and validate the reserved parent-policy binding.
3. Enforce no-weaker child modes and locked-parent behavior.
4. Test a real child dangerous-command block.
5. Verify existing provider/model enforcement and researcher extensions remain intact.

**Exit gate:** protected parent sessions cannot launch an unprotected native child.

### Phase 5 — Installer, doctor, and lifecycle

1. Add every managed source and target mapping.
2. Merge the required child extension entry without discarding user entries.
3. Add checksums, doctor checks, validator, and package syntax checks.
4. Add isolated install/update/doctor/uninstall tests on Linux and Windows.
5. Verify rollback after injected installation failure.

**Exit gate:** complete isolated lifecycle and rollback evidence passes.

### Phase 6 — Documentation, adversarial review, and release readiness

1. Update README, SECURITY, Wiki, changelog, and third-party notices as applicable.
2. Run deterministic fuzz and bypass corpus.
3. Run `npm run check`, platform lifecycle tests, and `git diff --check`.
4. Inspect the final diff for unrelated changes and raw-command leakage.
5. Obtain a fresh read-only security review focused on bypasses, false assurances, Windows behavior, and subagent propagation.
6. Fix every critical/high finding or explicitly defer release.

**Exit gate:** all acceptance criteria below have direct evidence.

## Rollout and rollback

- Ship as a minor-version feature because startup behavior and tool execution semantics change.
- Interactive top-level sessions always ask; do not silently persist an old choice.
- Noninteractive sessions default to Guard and may therefore block workflows that previously ran unattended; document this as intentional and provide a future separately reviewed noninteractive policy mechanism rather than an environment-variable bypass to Off.
- Installer update uses existing backups, atomic writes, checksums, and rollback.
- Uninstall removes only managed guard files and the managed child-extension entry, preserving user-modified files/configuration according to existing policy.
- If post-release false positives are severe, update rule/path classification; do not weaken fail-closed parser or child-propagation behavior as an emergency workaround.

## Risks and mitigations

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Users interpret the guard as a sandbox | Critical | Explicit UI/docs boundary; recommend least privilege/container/VM |
| Child agents bypass the parent hook | Critical | Verified default extension + binding; block launch on uncertainty |
| Regex/token splitting misses shell semantics | Critical | Shell-specific parsers, recursive analysis, uncertainty fails closed |
| PowerShell/cmd version differences | High | Native AST, separate cmd lexer, PS 5.1/7 Windows CI |
| Unknown custom tool launches processes | High | Exact coverage list; Strict ask/deny; catalog and review gate |
| False positives make Guard unusable | High | Path/flag-aware rules, safer explanations, allow once, corpus testing |
| Approval becomes a broad bypass | High | Per-call approval only; no persistent regex/base-command whitelist |
| Guard or config is modified by the agent | High | Self-protected paths, immutable rules, checksums, critical lock |
| Commands leak secrets through logs/prompts | High | In-memory only, bounded redaction, sentinel tests, no raw persistence |
| Parser denial of service | Medium | Input/token/depth/time limits, direct process invocation, bounded cache |
| Check/use race changes target after approval | Medium | Canonical path checks and documentation; OS sandbox for hard boundary |
| Installer overwrites user extension settings | Medium | Union/leaf merge, backup, atomic rollback, lifecycle tests |

## Estimated effort

Assuming one engineer familiar with the repository and access to Windows CI:

- Phase 0: 1–2 days.
- Phases 1–3, shippable parent-session cross-platform MVP: 7–12 days.
- Phase 4 subagent enforcement: 3–5 days, longer if upstream binding changes are required.
- Phases 5–6 integration, fuzzing, review, and docs: 5–10 days.

Expected total for a production-quality first release: roughly 3–5 engineering weeks. A 1–2 day regex-only proof of concept is possible but is not acceptable for release under this plan.

## Acceptance criteria

The feature is complete only when all of the following are verified:

1. Every supported `bash` and `powershell` call is analyzed before execution; nested supported Bash, PowerShell, and cmd payloads are recursively considered.
2. Critical filesystem, disk, boot, system, security-control, guard-tampering, and download-execute operations are immutable denies while Guard or Strict is active.
3. High-risk and indeterminate calls require explicit bounded approval; timeout, Escape, malformed input, parser failure, and no UI deny.
4. A critical attempt locks subsequent execution/mutation/subagent tools until direct user confirmation unlocks the session.
5. `write` and `edit` cannot mutate protected paths; recognized credential/private-state `read` paths are denied without enumerating them.
6. Off requires explicit per-session confirmation and is never inherited by a protected child.
7. A protected parent cannot start an unprotected native subagent; a real child dangerous-command test proves pre-execution blocking.
8. Unknown/custom execution paths are handled and documented exactly as the selected mode specifies; no broader coverage is claimed.
9. No raw command, prompt, cwd, affected path, AST, credential, session/history data, or approval content is persisted or uploaded.
10. Unix and Windows parser/path corpora, extension harnesses, deterministic fuzz tests, and isolated lifecycle tests pass.
11. `npm run check`, Windows CI, `git diff --check`, install/update/doctor/uninstall round trips, rollback injection, and a fresh read-only security review pass.
12. README, SECURITY, Wiki, changelog, and applicable third-party notices accurately describe behavior and limitations.
13. The final diff contains no unrelated cleanup, no global dependency installation, and no mutation of live Pi credentials, settings outside documented leaves, sessions, missions, history, or trust state.

## Primary references

- Pi extension API and `tool_call` fail-safe behavior: <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md>
- Pi security boundary: <https://pi.dev/docs/latest/security>
- Pi containerization guidance: <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/containerization.md>
- Microsoft PowerShell parser: <https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.language.parser.parseinput>
- Microsoft CommandAst: <https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.language.commandast>
- Microsoft cmd reference: <https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd>
- UX/comparator reference, not an implementation dependency: <https://github.com/Serhioromano/pi-defender>
- AST-oriented comparator: <https://github.com/jdiamond/pi-guard>
