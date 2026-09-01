# ZenPi Workflow Controls Plan

## Objective

Implement three first-party harness features as one coherent, optional workflow-controls extension:

1. **Scope Drift Monitor** — declare expected project paths, visibly flag mutations outside them, and require explicit acknowledgement before the declared scope expands.
2. **Guided Experiment Worktrees** — create bounded detached Git worktrees for intentional experiments, preserve one writer per worktree, and offer explicit keep, patch-export, or discard outcomes.
3. **Completion Challenge** — run an explicit adversarial completion review that identifies unproven requirements, contradictory evidence, scope expansion, missing validation, and residual risk before presenting a readiness verdict.

The features should strengthen focus, experimentation, and verification without adding subagents, automatic commits, remote operations, raw command logging, or mandatory ceremony for small tasks.

## Product principles

- All three features are opt-in and quiet when inactive.
- Human choices authorize scope expansion, worktree destruction, patch replacement, and completion disposition.
- A warning is not proof, and a model-authored challenge result is not independent verification.
- Keep state local, bounded, private, and reconstructable without reading Pi credentials, provider state, unrelated sessions, or history.
- Use one writer per worktree. ZenPi creates experiment space but never launches a child agent or parallel writer.
- Use Git through fixed argv arrays with `pi.exec`; never construct shell command strings from user input.
- Preserve unrelated tools and UI state, compose with `/zen` and Command Guard, and fail closed only where an operation would otherwise become destructive or ambiguous.
- Do not commit, merge, apply patches, push, publish, or change remotes.

## User-facing contract

### Scope Drift Monitor

Commands:

```text
/scope
/scope set
/scope add <project-relative-path>
/scope remove <project-relative-path>
/scope accept <project-relative-path>
/scope recheck
/scope status
/scope clear
```

Behavior:

- `/scope set` opens a bounded editor with one project-relative file or directory per line.
- An empty `/scope` shows status when active and starts the editor when inactive.
- Scope entries are exact files or directory prefixes; do not introduce glob syntax in the first version.
- Resolve entries against the current Git root when available, otherwise against `ctx.cwd`. Reject absolute paths, traversal outside the root, control characters, symlink escapes, duplicates, and more than 40 entries.
- Show a compact persistent status/widget while active: entry count, observed changed-file count, and pending outside-scope paths.
- For direct `write` and `edit` calls outside scope, show an interactive choice before execution:
  - `Deny this call (Recommended)`
  - `Allow once without expanding scope`
  - `Add this path to scope and allow`
- In non-interactive modes, remain advisory rather than pretending an acknowledgement occurred: allow the call, record a pending violation, and inject a bounded warning into the next model context.
- Detect mutations performed through shell or other tools by comparing bounded Git worktree snapshots before and after tool execution. Record only changed project-relative paths, not command text or file content.
- Do not classify pre-existing dirty files as new drift until their observed fingerprint changes after scope activation.
- Post-hoc detections remain pending until `/scope accept`, `/scope add`, `/scope remove`, or `/scope clear`; never expand scope automatically. `/scope accept` acknowledges one finding and leaves the declared contract untouched; only `/scope add` widens it. `/scope recheck` re-baselines the worktree and is the only way to clear snapshot uncertainty.
- Scope state is session-branch state persisted with `pi.appendEntry`, not a project file. Restore only from the active branch.
- Emit bounded internal events so `/zen` can display `scope: clean` or `scope: review` without taking ownership of scope state.

### Guided Experiment Worktrees

Commands:

```text
/experiment start [short-name]
/experiment status [id]
/experiment close [id]
/experiment recover
```

Start flow:

1. Require a trusted Git worktree and resolve its canonical repository/common directory.
2. Read a compact experiment card through the UI:
   - short name;
   - hypothesis;
   - direct acceptance check;
   - non-goals.
3. Inspect repository status. If the base worktree is dirty, explain that the experiment starts from `HEAD` and excludes uncommitted changes; require explicit confirmation or cancel. Never stash or commit those changes.
4. Preview the detached-worktree path, base commit, and all state to be written.
5. After confirmation, create a detached worktree with `git worktree add --detach <path> <commit>` under ZenPi's private experiment root.
6. Record a bounded private registry entry and print exact instructions for opening a separate human-controlled Pi session in that path. Do not launch Pi or another process automatically.

Registry contract:

- Store under `<agent-dir>/zenpi/experiments/` with mode `0700` directories and `0600` files.
- Use a schema-validated, atomic registry plus a dedicated ownership-checked lock.
- Store only: random ID, sanitized name, canonical repository/worktree paths, base commit, bounded hypothesis/acceptance/non-goals, lifecycle state, and timestamps.
- Use prepared/active/closing transaction states so interrupted creation or removal can be diagnosed.
- `/experiment recover` reconciles registry records with `git worktree list --porcelain`; it may repair metadata after confirmation but must never delete a worktree automatically.
- Bound the registry to 32 active/retained experiments and provide an actionable refusal when full.

Close flow:

1. Refuse ambiguous IDs and default only when the current cwd maps to exactly one active experiment.
2. Show base commit, changed-file counts, untracked-file counts, acceptance check, and current worktree path.
3. Offer:
   - `Keep worktree` — no mutation; leave it active.
   - `Export patch` — create a binary Git patch in private state or an explicit path without overwriting by default; keep the worktree.
   - `Discard worktree` — require a second confirmation when dirty, then remove only that registered worktree and prune its registry entry.
4. Generate complete patches, including untracked files, with a temporary Git index (`GIT_INDEX_FILE`, `git read-tree`, `git add -A`, `git diff --cached --binary HEAD`) so the real index is untouched. Remove the temporary index in `finally`.
5. Publish patch bytes atomically. Existing outputs require explicit overwrite confirmation.
6. Never apply the patch, merge it into the base worktree, create a branch, commit, or alter remotes.
7. On discard, verify the registered path, Git common directory, and worktree identity again immediately before `git worktree remove --force`.

### Completion Challenge

Commands and tool:

```text
/challenge
/challenge status
/challenge clear
submit_completion_challenge
```

Behavior:

- `/challenge` is explicit and requires an idle agent. It snapshots only bounded observable facts: current Git changed paths, active scope entries and pending violations, current experiment metadata when cwd matches one, and tool failure counts observed by this extension during the active task.
- It starts a challenge generation, persists a small activation entry, and triggers one agent turn with a deterministic checklist:
  1. Which requirement remains unproven?
  2. What evidence contradicts the proposed result?
  3. Could any check have passed for the wrong reason?
  4. Did scope expand or remain pending?
  5. Was runtime, visual, or platform validation required but omitted?
  6. What residual risk must be disclosed?
- While active, inject concise challenge guidance through `before_agent_start`. Do not rewrite or inspect unrelated historical session content.
- The agent must finish with `submit_completion_challenge`; reject calls when no challenge is active or the generation/session does not match.
- Tool input is bounded and structured:
  - verdict: `ready-for-human-review`, `incomplete`, or `blocked`;
  - requirement assessments with `proven`, `partial`, or `unproven` status and concise evidence;
  - contradictions;
  - possible false-positive checks;
  - scope findings;
  - validation gaps;
  - residual risks;
  - next action.
- Deterministically reject `ready-for-human-review` when any requirement is partial/unproven, contradictions or validation gaps remain, or the Scope Drift Monitor has pending violations.
- A ready verdict may still contain residual risks; render them prominently.
- Return `terminate: true` so the structured challenge card is the final output of that turn.
- Persist only the bounded structured result in the current session branch and render it with a custom entry renderer. Do not write a global completion log.
- `/challenge status` renders the latest active-branch challenge. `/challenge clear` clears active challenge state but does not delete prior session entries.
- Never intercept ordinary final answers or force a challenge on every task. Future `/zen finish` integration is explicitly out of scope for this change.

## Architecture

Add one extension with small testable modules:

```text
extensions/workflow-controls/
  index.ts                 # Pi registration, commands, hooks, UI, event composition
  scope.mjs                # path normalization, matching, snapshots, drift calculations
  experiments.mjs          # registry, locks, Git argv operations, recovery, patch export
  challenge.mjs            # bounded schemas, consistency gate, challenge rendering data
  smoke.mjs                # deterministic temporary-state feature probes used by closed validators
```

Implementation boundaries:

- Keep parsing, path matching, registry validation, state transitions, and challenge consistency checks in pure exported functions.
- Keep Pi APIs and UI orchestration in `index.ts`.
- Serialize extension commands that mutate experiment state; reject overlapping start/close/recover operations.
- Correlate before/after tool snapshots by `toolCallId` because sibling tools may execute concurrently.
- Do not retain raw tool inputs. Direct mutation paths may be normalized transiently, then only project-relative path findings are persisted.
- Bound Git calls by timeout and output size. Treat malformed or truncated porcelain output as indeterminate and warn rather than claiming the scope is clean.
- Use `ctx.hasUI` and `ctx.mode` correctly; custom TUI rendering is optional, while RPC-compatible selects/confirms and plain notifications remain supported.
- On `session_shutdown`, clear timers, transient tool snapshots, challenge generations, and pending command operations; reconstruct durable branch state on `session_start`.

## Composition rules

### With Command Guard

- Scope Drift Monitor is narrower task-scope governance, not a replacement security parser.
- Command Guard remains authoritative for catastrophic or uncertain commands.
- A scope denial must never latch Command Guard or create a reusable Command Guard approval.
- If either extension blocks a call, the call does not execute.
- Do not copy Command Guard's shell parser into workflow-controls. Shell/custom-tool drift is detected from before/after Git evidence.
- Worktree lifecycle Git commands originate from explicit extension commands and must have their own exact human confirmations because extension-internal `pi.exec` calls are outside model tool-call interception.

### With `/zen`

- Workflow-controls owns scope/challenge state.
- Publish only summarized status through `pi.events`; `/zen` may display it but must not duplicate or persist it.
- Do not replace `/zen`'s header, working indicator, or tool-collapse restoration.

### Between the three features

- Completion Challenge includes pending scope findings and experiment acceptance metadata automatically.
- Starting an experiment does not automatically copy the original session's scope; the separate session must set its own scope.
- When cwd matches a registered experiment worktree, `/experiment status` and `/challenge` use that exact registry record.
- A completion challenge never closes or discards an experiment.

## Implementation phases

### Phase 1 — Pure contracts and state models

- [x] Define bounded schemas and sanitizers for scope state, experiment cards/registry, and challenge results.
- [x] Implement canonical root/path resolution and exact-file/directory-prefix scope matching.
- [x] Implement NUL-delimited Git status parsing and bounded changed-path fingerprints.
- [x] Implement scope drift comparison that distinguishes baseline dirt from post-activation changes.
- [x] Implement experiment lifecycle state transitions and strict registry/path validation.
- [x] Implement challenge consistency rules and ready-verdict rejection conditions.
- [x] Add unit tests for malformed input, path escape, symlink alias, bounds, duplicate entries, invalid state transitions, and contradictory challenge verdicts.

### Phase 2 — Scope Drift Monitor

- [x] Register `/scope` commands, completions, branch persistence, status, and widget.
- [x] Add direct `write`/`edit` preflight choices without interfering with Command Guard decisions.
- [x] Add concurrent-safe before/after Git snapshots around tool execution.
- [x] Surface post-hoc shell/custom-tool drift in UI and next-turn context without raw command persistence.
- [x] Add active-branch restoration, `/scope accept`, clear behavior, and Zen status events.
- [x] Build an extension harness covering TUI, headless advisory behavior, parallel tool IDs, session resume, and Command Guard composition.

### Phase 3 — Guided Experiment Worktrees

- [x] Implement the private experiment registry, lock, atomic writes, and transaction recovery.
- [x] Implement start preflight, dirty-base disclosure, card collection, preview, and detached worktree creation.
- [x] Implement status discovery from both registry and `git worktree list --porcelain`.
- [x] Implement complete temporary-index patch export with no real-index changes and no overwrite by default.
- [x] Implement keep and twice-confirmed dirty discard paths with final identity revalidation.
- [x] Implement recover behavior for prepared, missing, moved, and externally removed worktrees without automatic deletion.
- [x] Add temporary-repository integration tests proving the base worktree, base index, branches, commits, and remotes are unchanged.

### Phase 4 — Completion Challenge

- [x] Register `/challenge`, status, clear, the structured terminating tool, and entry renderer.
- [x] Track only bounded task-local facts needed by the challenge; exclude raw commands, outputs, prompts, and file content.
- [x] Inject the deterministic six-question checklist only while a generation is active.
- [x] Enforce session/generation binding and structured consistency at tool execution.
- [x] Include scope and experiment facts without granting the model authority to clear or mutate them.
- [x] Restore challenge state from the active branch and invalidate stale active generations after session replacement.
- [x] Add a harness proving ready, incomplete, blocked, stale-generation, pending-scope, and terminating-result behavior.

### Phase 5 — Shipping integration

- [x] Add every workflow-controls source to installer managed files, source assertions, uninstall/update retirement, syntax checks, and package contents.
- [x] Add capability registry entries for `scope-drift-monitor`, `guided-experiment-worktrees`, and `completion-challenge`.
- [x] Add separate closed validators for each capability; each validator must use a temporary repository/state directory and exercise the feature's direct contract.
- [x] Update the Working Agreement with concise guidance for using scope, experiments, and completion challenges without making them mandatory.
- [x] Update README/wiki command references, security/privacy data classes, `THIRD_PARTY.md` only if dependencies change (none are planned), and CHANGELOG.
- [x] Add an isolated installer lifecycle assertion that all new files install, update, doctor-validate, and uninstall cleanly while experiment data is preserved unless explicitly discarded.

## Test matrix

### Scope

- Exact file and directory-prefix matching on Windows, Linux, and macOS path semantics.
- Absolute path, `..`, symlink escape, case behavior, control character, duplicate, and capacity rejection.
- Pre-existing dirty files do not create false drift; subsequent changes do.
- Direct edit/write choices: deny, allow once, and add-to-scope.
- Headless mode records a warning without inventing consent.
- Shell-created, deleted, renamed, and untracked files are detected post hoc.
- Parallel tool calls retain separate before/after snapshots.
- Session branching restores only active-branch scope state.

### Experiments

- Reject non-Git directories and ambiguous/malformed worktree state.
- Clean and explicitly confirmed dirty-base starts use the exact recorded `HEAD` commit.
- Creation never creates a branch or changes the base index/worktree.
- Registry lock ownership, atomic writes, stale/malformed transaction refusal, and bounded capacity.
- Patch export includes tracked, deleted, renamed, binary, and untracked changes while leaving both indexes unchanged.
- Existing patch output is preserved without overwrite approval.
- Keep is non-mutating; dirty discard requires two confirmations; clean discard requires one explicit confirmation.
- Identity revalidation prevents deletion after registry/path substitution.
- Recovery reports orphaned registry and worktree states without deleting either.

### Completion Challenge

- No active generation, wrong session, stale generation, malformed input, and oversized input fail closed.
- Ready verdict is rejected with partial/unproven requirements, contradictions, validation gaps, or pending scope findings.
- Incomplete and blocked verdicts require a concrete next action.
- Residual risks remain visible on ready results.
- The result terminates the turn and persists only bounded structured session data.
- Ordinary tasks remain unaffected when challenge mode is inactive.
- Resume restores the latest completed card but does not silently restart an interrupted challenge.

### Composition

- Scope prompting and Command Guard approval do not grant each other approvals or alter lock state.
- `/zen` UI restoration remains intact with workflow status active.
- Completion Challenge reads scope/experiment summaries but cannot mutate them.
- Experiment commands cannot run concurrently against the same registry record.

## Validation sequence

1. Run pure module tests for the feature currently being implemented.
2. Run the workflow-controls extension harness.
3. Run the temporary Git worktree integration suite.
4. Run focused Command Guard composition tests.
5. Run focused installer lifecycle tests with a temporary `PI_CODING_AGENT_DIR`.
6. Run every new closed capability validator independently.
7. Run `npm run format` and `npm run check`.
8. Inspect the final diff and obtain fresh read-only review because worktree deletion, path boundaries, state recovery, and tool interception are safety-sensitive.
9. Exercise the commands manually in a disposable repository in TUI mode, including a separate human-opened experiment session.

## Definition of done

- Scope Drift Monitor makes scope and drift visible, never expands scope silently, and remains advisory in headless operation.
- Guided Experiment Worktrees can create, inspect, export, recover, keep, and explicitly discard an experiment without changing the base worktree, index, branch set, commits, or remotes.
- Completion Challenge produces a bounded structured readiness card and cannot report ready while its own recorded evidence contains unresolved requirements, validation gaps, contradictions, or pending scope drift.
- All features are inactive by default, add no executable dependency, persist no raw commands/prompts/source, and perform no remote operation.
- Installed files, docs, capability registry, closed validators, lifecycle behavior, and rollback paths are synchronized.
- Focused tests and the full repository check pass, and remaining limitations are documented.

## Post-review corrections

Read-only review after implementation found and fixed the following before release:

- `/scope accept` had become an alias for `/scope add` and silently widened the declared contract; acknowledging a finding and widening scope are now distinct.
- Patch export decoded Git's bytes into a JavaScript string, so a text file that is not valid UTF-8 exported to a patch that no longer applied. Git now writes the patch file itself.
- Ignored files are invisible to Git status and `git add -A`, so a worktree holding only ignored work reported as clean, exported nothing, and was discarded without the dirty-experiment confirmation. Ignored paths are now counted and named.
- A completion challenge the agent turn ended without answering stayed armed and kept injecting its instruction into every later turn; it now expires with the turn.
- `/experiment recover` offered "Forget missing record" for a directory Git no longer tracks, which always failed. That case now offers releasing the record while leaving the files in place.
- Every tool, including read-only ones, paid for two full worktree snapshots. The previous result is now reused as the next baseline and `read` is skipped.
- Branch entries held live references to the scope arrays, so a later mutation could rewrite an already appended record. Entries are copied both on append and on restore.
- An expired challenge was recorded as `cleared`, so restoring a session discarded the last completed readiness card. Expiry is now a distinct entry kind.
- `/experiment status` with no ID reported only changed paths, hiding ignored work in exactly the form used from inside an experiment.
- Recovery acted on a presence answer captured before its interactive prompt. Presence is now re-derived inside the registry lock immediately before mutation.

## Explicit non-goals

- Full focus-contract implementation or `/zen finish` integration.
- Autonomous task completion detection or interception of every final answer.
- Automatic scope expansion, automatic reversion of outside-scope changes, or a general filesystem sandbox.
- Launching agents, terminals, or background workers inside experiment worktrees.
- Automatic commits, branches, merges, rebases, patch application, pushes, or remote changes.
- Container or VM isolation.
- Persisting raw shell commands, prompts, tool output, source content, or session history in ZenPi state.
- Replacing Command Guard's security policy with the Scope Drift Monitor.
