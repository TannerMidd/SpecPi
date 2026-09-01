# Command Guard Temporary-Cleanup and Session-Lock Remediation Plan

## Status

Implementation completed in the working tree; independent review and release acceptance remain pending.

## Problem statement

Command Guard currently turns every structured `critical` mutation denial, except policy-integrity failures and reads, into a session-wide lock. That is appropriate for proven host destruction or enforcement tampering, but it makes classification false positives disproportionately disruptive: the command is blocked before execution and then every later protected tool call is also blocked until an interactive `/guard unlock`.

Three concrete false-positive paths must be addressed:

1. On Windows, cmd-style cleanup syntax sent to Pi's Bash tool, such as `rmdir /s /q F:\Temp\case`, is parsed as Bash. `/s` is simultaneously treated as a recursive switch and a Windows/MSYS root-like path, producing `fs.root-recursive-delete`. The command would not perform the intended cleanup under Git Bash, but the critical decision locks the session first.
2. `PI_CODING_AGENT_DIR/extensions/command-guard` is protected as one entire subtree. An unrelated test directory created beneath it is therefore treated exactly like a managed guard source file, so deleting `.test-tmp-*` is classified as enforcement tampering.
3. When structural parsing fails, the raw catastrophic fallback finds a destructive verb anywhere in the input and a protected path anywhere else in the input. It can therefore attach an inert protected path from one statement to an unrelated scratch deletion in another statement and emit `parser.unanalyzed-catastrophe`.

The implementation must preserve fail-closed execution while preventing uncertain or non-executable cleanup attempts from stranding the session.

## Goals

- Keep proven catastrophic commands and proven guard-enforcement tampering as immutable denials.
- Keep session latching for structurally proven, lock-worthy critical mutations.
- Deny parser uncertainty and shell-syntax mismatches without latching the session.
- Allow Guard-mode deletion of unrelated temporary descendants near installed guard files without allowing deletion of managed guard files or any ancestor containing them.
- Make raw fallback path association local to the destructive statement or payload.
- Preserve Strict-mode approvals for ordinary recursive deletion and other broad mutations.
- Preserve headless fail-closed behavior.
- Add deterministic unit, extension-lifecycle, smoke, installer, and Windows runtime coverage.
- Update the documented lock contract and policy version.

## Non-goals

- Do not add a blanket exemption for `os.tmpdir()`, `/tmp`, `%TEMP%`, or names containing `tmp`/`test`.
- Do not track temporary-directory provenance across processes or trust a path merely because the model claims it created it.
- Do not allow cmd syntax to execute through the Bash tool; report a bounded corrective denial instead.
- Do not weaken protection for actual host roots, profile roots, devices, boot state, security controls, managed settings, `zenpi/manifest.json`, or managed command-guard files.
- Do not auto-unlock a session after a proven critical attempt.
- Do not persist commands, paths, decisions, or lock history.
- Do not change native-subagent provider policy or the pinned subagent preflight contract.

## Policy decisions

### 1. Denial severity and session latching are separate properties

Add bounded decision metadata named `lockSession`.

- `action: "deny"` controls whether the current tool call executes.
- `severity: "critical"` communicates impact and keeps the decision immutable.
- `lockSession: true` is an explicit assertion that the analysis structurally proved a lock-worthy attempt.
- Missing or false `lockSession` never latches.

Structured critical rule matches and direct protected mutation decisions set `lockSession: true`. The following do not:

- parser failure or raw fallback decisions;
- malformed-policy fail-closed decisions;
- shell-syntax mismatch decisions;
- reads, regardless of path severity;
- ordinary high-severity denials or approvals.

This keeps uncertain commands blocked, especially headlessly, without converting uncertainty into persistent session state.

### 2. Installed enforcement protection is node-based, not directory-name-based

Protect a closed list of managed enforcement nodes:

- `settings.json`;
- `zenpi/manifest.json`;
- each installed command-guard runtime file.

For every managed node, protect:

- the node itself;
- canonical aliases resolving to it;
- any ancestor whose deletion or replacement would contain the node.

Do not protect an unrelated descendant merely because it shares `extensions/command-guard` as a parent. This allows `.test-tmp-*`, generated fixtures, or scratch reports beneath the directory while still denying deletion of `extensions/command-guard`, `extensions`, or the agent root because those targets contain managed nodes.

### 3. Shell mismatch is a non-latching denial

On Windows, detect cmd delete switches supplied directly to a non-cmd Bash-family leaf. Return a high-severity `shell.syntax-mismatch` denial with a safer alternative. Do this before ordinary target classification so `/s` and `/q` cannot become false root targets for that command shape.

A nested `cmd /c ...` remains recursively parsed as cmd. A real protected target inside the nested cmd command remains critical and lock-worthy.

### 4. Raw catastrophic fallback is statement-local and never latch-worthy

The fallback remains capable of issuing a critical immutable denial when a destructive statement itself names a protected target. It must not borrow paths from another statement, inert output argument, or unrelated payload.

Because fallback runs only when structural analysis is unusable, its critical result sets `lockSession: false`. When no command-local catastrophe can be proven, the existing `parser.indeterminate` decision controls behavior: ask with UI and deny without UI.

## Implementation phases

## Phase 1 — Centralize the managed command-guard file inventory

### Files

- Add `extensions/command-guard/managed-files.mjs`.
- Update `scripts/zenpi.mjs`.
- Update installer/resource tests in `tests/zenpi.test.mjs`.
- Update syntax-check coverage in `package.json`.

### Changes

1. Export an immutable, basename-only `COMMAND_GUARD_MANAGED_FILES` list containing:
   - `index.ts`
   - `core.mjs`
   - `rules.mjs`
   - `bash.mjs`
   - `powershell.mjs`
   - `powershell-parser.ps1`
   - `cmd.mjs`
   - `paths.mjs`
   - `redact.mjs`
   - `smoke.mjs`
   - `managed-files.mjs`
2. Validate the exported entries at module initialization or through tests:
   - non-empty;
   - unique;
   - basename-only, with no separators or dot segments;
   - bounded length.
3. Import the list in `scripts/zenpi.mjs` and generate command-guard install resources from it instead of maintaining a second inline array.
4. Ensure install, update, rollback, doctor checksum verification, and uninstall automatically include `managed-files.mjs`.
5. Add `node --check extensions/command-guard/managed-files.mjs` to `npm run check`.
6. Add an installer test proving the exported list and installed/checksummed resource set cannot drift.

### Rationale

The protection policy and installer must share one source of truth. Duplicated lists could allow a newly imported runtime file to be installed but not protected, or protected but not installed.

## Phase 2 — Narrow enforcement path reachability

### Files

- `extensions/command-guard/paths.mjs`
- `tests/command-guard-paths.test.mjs`
- `tests/command-guard.test.mjs`

### Changes

1. Import `COMMAND_GUARD_MANAGED_FILES` into `paths.mjs`.
2. Replace the broad `['extensions', 'command-guard']` enforcement subtree with one node per managed file.
3. Retain the existing bidirectional containment check for each managed node:
   - target equals node;
   - target is an ancestor of node;
   - canonical target equals or contains node.
4. Ensure arbitrary sibling or descendant paths that do not contain a managed node return false from `reachesEnforcementState()` and `isAgentPath()`.
5. Preserve platform-aware case folding and lexical/canonical checks.
6. Keep `settings.json` and `zenpi/manifest.json` as managed nodes.

### Required tests

- Every managed guard file is protected in Guard and Strict.
- `settings.json` and `zenpi/manifest.json` remain protected.
- The following remain critical:
  - `<agent>`;
  - `<agent>/extensions`;
  - `<agent>/extensions/command-guard`;
  - a managed guard file;
  - `<agent>/zenpi`.
- The following become ordinary:
  - `<agent>/extensions/command-guard/.test-tmp-123`;
  - `<agent>/extensions/command-guard/generated-fixtures/case-1`;
  - `<agent>/extensions/browser`;
  - `<agent>-scratch`.
- Canonical aliases or symlinks resolving to managed files remain protected.
- A scratch path must not become safe if its canonical target reaches a managed file.
- Bash `rm -rf`, PowerShell `Remove-Item`, cmd `rmdir`, and mutating `find` forms receive equivalent path outcomes.

## Phase 3 — Add explicit lock metadata to policy decisions

### Files

- `extensions/command-guard/core.mjs`
- `extensions/command-guard/rules.mjs`
- `extensions/command-guard/paths.mjs`
- `extensions/command-guard/index.ts`
- `tests/command-guard.test.mjs`
- `tests/command-guard-extension.test.mjs`
- relevant fixtures under `tests/fixtures/`

### Changes

1. Extend decision validation to accept only a boolean `lockSession` when present.
2. Make all normal decision constructors return an explicit boolean to avoid accidental truthiness:
   - empty/allow: false;
   - ask: false;
   - malformed policy: false;
   - structured critical rule match: true;
   - direct protected path mutation: true;
   - raw catastrophic fallback: false;
   - `session.locked`: false because it reports existing state rather than a new latch.
3. In `aggregateDecisions()`:
   - reject malformed lock metadata;
   - preserve `lockSession: true` only when at least one valid critical deny in the aggregate explicitly carries it;
   - never infer locking from severity alone;
   - return false for approvals, allows, malformed output, and policy-integrity failures.
4. In `index.ts`, replace both severity-derived lock checks with `decision.lockSession === true`.
5. Keep the read-specific non-latching safeguard even if a future path decision accidentally carries lock metadata.
6. Record the decisive rule for `/guard status` and `/guard unlock` only when a latch actually occurs. Ordinary denials may still increment rule/category counters but must not overwrite the last lock reason.
7. Keep approval generation, nonce changes, and approval clearing unchanged when a real lock occurs.

### Required tests

- Structured `rm -rf /` is critical, denied, and lock-worthy.
- Structured guard-file deletion is critical, denied, and lock-worthy.
- A protected `write` mutation remains lock-worthy.
- A protected `read` is denied but not lock-worthy at the extension lifecycle level.
- Parser fallback can be critical and denied while `lockSession` remains false.
- A non-latching denial is followed by a successful safe command in the same extension session.
- A proven lock-worthy denial is followed by `session.locked` for a safe command until `/guard unlock`.
- Malformed decision data never gains lock eligibility.
- Aggregation cannot drop a proven lock-worthy critical finding because of finding order.

## Phase 4 — Classify Windows cmd cleanup syntax used through Bash

### Files

- `extensions/command-guard/rules.mjs`
- `tests/command-guard.test.mjs`
- `tests/fixtures/command-guard-windows-runtime.mjs`
- `extensions/command-guard/smoke.mjs`

### Changes

1. Add a bounded helper that recognizes cmd-style delete syntax only when:
   - analyzed platform is Windows;
   - the semantic leaf shell is Bash/POSIX;
   - the executable is a cmd delete-family spelling such as `rd`, `rmdir`, `del`, or `erase`;
   - cmd slash switches such as `/s` or `/q` are present in a cmd-shaped argument sequence.
2. Evaluate this helper before `targetState()` and recursive/root delete classification.
3. Return:
   - `action: "deny"`;
   - `severity: "high"`;
   - `category: "filesystem"`;
   - `ruleIds: ["shell.syntax-mismatch"]`;
   - `lockSession: false`;
   - a bounded safer alternative using `rm -rf -- <forward-slash-path>` or the PowerShell tool.
4. Do not globally discard `/s` or `/q` from Bash path analysis. Outside the recognized mismatch, slash-prefixed paths retain their existing Windows/MSYS meaning.
5. Do not apply this rule to nested cmd leaves. `cmd /c rmdir /s /q C:\Windows` must still be parsed by `cmd.mjs` and denied critically.
6. Add `shell.syntax-mismatch` to the stable rule catalog and update catalog-size/uniqueness expectations.

### Required matrix

| Command | Expected outcome |
| --- | --- |
| Bash `rmdir /s /q F:\Temp\case` | high deny, no latch |
| Bash `rd /s /q F:\Temp\case` | high deny, no latch |
| Bash `rm -rf -- F:/Temp/case` in Guard | allow |
| Bash `rm -rf -- F:/Temp/case` in Strict | ask |
| Bash `cmd /c rmdir /s /q F:\Temp\case` | allow in Guard for ordinary target |
| Bash `cmd /c rmdir /s /q C:\Windows` | critical deny, latch-worthy |
| cmd `rmdir /s /q F:\Temp\case` | allow in Guard |
| cmd `rmdir /s /q C:\Windows` | critical deny, latch-worthy |

The extension harness must additionally prove that the first mismatch denial does not block a later safe command.

## Phase 5 — Make catastrophic fallback association statement-local

### Files

- `extensions/command-guard/rules.mjs`
- `extensions/command-guard/core.mjs`
- `tests/command-guard.test.mjs`
- `extensions/command-guard/smoke.mjs`

### Changes

1. Refactor the fallback projection into bounded executable statement spans while retaining quote blanking and inline-code payload handling.
2. Split only on separators the fallback can identify safely after projection, including newlines, `;`, `&&`, `||`, and command boundaries already recognized by the raw scanner.
3. For each destructive statement:
   - identify the destructive verb in command position;
   - extract path-shaped tokens only from that statement or inline payload;
   - classify only those tokens for the catastrophic result.
4. Keep standalone catastrophes such as shutdown/reboot and fork bombs independent of path association.
5. If statement ownership cannot be established, return no catastrophic fallback finding and allow `parser.indeterminate` to ask/deny normally.
6. Set every fallback result to `lockSession: false`, including a same-statement protected target.
7. Keep all input, token, payload, and output bounds; do not introduce shell evaluation or external parsing.

### Required tests

- With the PowerShell helper unavailable:
  - `Write-Output <agent>/settings.json; Remove-Item -Recurse -Force C:/Temp/scratch` is not `parser.unanalyzed-catastrophe`; it is indeterminate/ask with UI and deny without UI.
  - `Remove-Item -Recurse -Force <agent>/settings.json` remains a critical immutable denial, but is not lock-worthy.
- Equivalent Bash parser-limit cases cannot borrow an inert path from a separate statement.
- Protected paths inside quoted output remain inert.
- A protected target inside an inline `-Command` or `-c` payload remains denied.
- Existing leaf/token/input-limit catastrophe tests stay closed.
- A fallback critical denial followed by a safe call does not leave the extension locked.

## Phase 6 — Bump policy version and update bindings

### Files

- `extensions/command-guard/rules.mjs`
- command-guard binding tests and fixtures
- smoke and native-child tests

### Changes

1. Increment `POLICY_VERSION` because classification, lock semantics, and exact-call approval behavior have materially changed.
2. Update all hard-coded binding fixtures and expected child bindings.
3. Confirm old policy-version child bindings fail closed.
4. Confirm parent injection uses the new version and cannot be overridden by child input.
5. Do not change `SUPPORTED_SUBAGENT_CONTRACT`; this work changes guard policy, not the pi-subagents protocol.

## Phase 7 — Documentation and release notes

### Files

- `CHANGELOG.md`
- `README.md`
- `SECURITY.md`
- `site/wiki/index.html`
- any tests asserting the affected wording

### Changes

1. Add an Unreleased changelog entry describing:
   - non-latching uncertain denials;
   - shell-mismatch handling;
   - managed-node enforcement protection;
   - statement-local fallback association.
2. Replace statements that every critical attempt locks the session with the precise contract: only structurally proven, lock-worthy critical mutations latch.
3. Document that parser uncertainty and wrong-shell cleanup syntax remain denied but do not lock.
4. Document the immediate safe cleanup forms:
   - Bash: `rm -rf -- F:/Temp/case`;
   - PowerShell tool: `Remove-Item -LiteralPath ... -Recurse -Force`;
   - cmd syntax only through an explicit `cmd /c` invocation.
5. Preserve the defense-in-depth and non-sandbox warnings.
6. Update static-site text tests without changing unrelated site content.

## Verification strategy

### Focused checks during implementation

Run after each relevant phase:

```text
node --test tests/command-guard-paths.test.mjs
node --test tests/command-guard.test.mjs
node --test tests/command-guard-extension.test.mjs
node extensions/command-guard/smoke.mjs
```

### Windows-specific checks

Run both supported parser-host configurations where available:

```text
ZENPI_REQUIRE_WINDOWS_PARSER=powershell node tests/fixtures/command-guard-windows-runtime.mjs
ZENPI_REQUIRE_WINDOWS_PARSER=pwsh node tests/fixtures/command-guard-windows-runtime.mjs
```

If one host is unavailable locally, CI must run the complete Windows matrix before release.

### Installer lifecycle checks

Use a temporary `PI_CODING_AGENT_DIR`; never use the live Pi directory. Exercise:

1. plan, confirming no mutation;
2. install with confirmation/`--yes` and external package installation skipped;
3. doctor, including command-guard checksum and smoke verification;
4. update;
5. deliberate managed-file drift and doctor failure;
6. rollback injection around the new managed file;
7. uninstall, including preservation behavior for modified managed files.

### Final repository gates

```text
npm run format
npm run check
```

Inspect the final diff after formatting and confirm no unrelated files changed.

## Acceptance criteria

The work is complete only when all of the following are proven:

1. Guard allows ordinary literal temporary cleanup with the correct shell syntax.
2. Strict still asks before ordinary recursive deletion.
3. Bash-received cmd cleanup syntax is denied with corrective guidance and does not latch.
4. Unrelated temporary descendants beneath the guard directory can be removed.
5. Every installed managed guard file, its canonical aliases, and every ancestor containing it remain critically protected.
6. A structured host-root deletion or managed-file mutation still denies and latches.
7. Parser fallback cannot associate a protected path from one statement with deletion in another.
8. Parser uncertainty remains denied without UI.
9. Fallback critical decisions remain immutable denials but do not latch.
10. A non-latching denial is followed successfully by an independently safe tool call.
11. `/guard status`, `/guard unlock`, approval clearing, generation checks, and child nonce behavior still work.
12. The policy-version bump invalidates stale child bindings and approval fingerprints.
13. Command-guard smoke, targeted tests, full `npm run check`, Windows runtime tests, and temporary installer round trips pass.
14. Documentation accurately distinguishes denial, critical severity, and session latching.
15. No command, path, prompt, approval, or parser output is newly persisted.

## Security review checklist

- Verify no rule can set `lockSession` through unvalidated truthy data.
- Verify aggregation cannot suppress a proven lock-worthy finding based on rule order.
- Verify the managed-file inventory is the installer source of truth and includes itself.
- Verify deleting `<agent>`, `<agent>/extensions`, or the guard directory still reaches managed nodes.
- Verify unknown descendants are allowed only when their lexical and canonical targets do not reach managed nodes.
- Verify shell mismatch detection cannot downgrade an explicit nested cmd catastrophe.
- Verify statement splitting cannot move quoted or inline executable text into an inert span.
- Verify every parser-failure path remains either an immutable denial or an approval that becomes a denial headlessly.
- Verify direct human shell escapes and unknown custom tools remain documented outside the guard boundary.

## Rollback plan

If the change causes a safety regression:

1. Revert the policy-version, decision metadata, path-node, shell-mismatch, and fallback changes as one release unit rather than partially restoring old semantics.
2. Restore the prior managed resource list only together with removal of `managed-files.mjs` from installer manifests/checksums.
3. Run formatter, targeted command-guard tests, smoke, full check, and temporary install/update/doctor/uninstall again.
4. Do not migrate or repair user state: guard mode, locks, approvals, and bindings are session-memory-only, and stale child bindings already fail closed.

## Suggested implementation order

1. Add the shared managed-file inventory and installer synchronization tests.
2. Narrow enforcement reachability and add path regressions.
3. Add `lockSession` metadata and lifecycle tests.
4. Add shell-syntax mismatch classification and Windows matrix cases.
5. Refactor fallback association and add parser-failure regressions.
6. Bump policy version and update child-binding fixtures.
7. Update smoke checks and documentation.
8. Run format, focused tests, Windows runtime checks, full check, and temporary installer round trips.
9. Perform a fresh read-only security review of the final diff before release.
