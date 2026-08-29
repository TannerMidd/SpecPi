# `/zen-subagents` Implementation Plan

## Objective

Add one ZenPi-owned configuration wrapper for the existing pinned `pi-subagents` package. The wrapper must make documented capacity, builtin-role model, and thinking settings easy to change without recreating, forking, patching, vendoring, or deep-importing `pi-subagents`.

The command surface is:

```text
/zen-subagents
/zen-subagents status
/zen-subagents reset
```

## Policy

Native role models may differ from the parent model only when their exact Pi provider id matches the active parent provider.

```text
openai-codex/gpt-5.6-sol → openai-codex/gpt-5.6-luna  allowed
openai-codex/*           → openai/*                   blocked
openai-codex/*           → anthropic/*                blocked
```

`openai`, `openai-codex`, OpenRouter, and other routes remain distinct provider boundaries.

ZenPi implements this policy through the public configuration already supported by `pi-subagents`:

```json
{
  "subagents": {
    "modelScope": {
      "enforce": true,
      "strict": true,
      "allow": ["<active-provider>/*"]
    }
  }
}
```

The ZenPi extension synchronizes this scope on session start, model selection, and guarded native `subagent` tool launches. `pi-subagents` remains responsible for applying strict scope checks to resolved primary and fallback models.

This is a configuration boundary, not a new package security kernel. Trusted project `.pi/settings.json` has higher Pi precedence. ZenPi mirrors package project-root resolution for the effective launch `cwd`, detects an unsafe project `modelScope`, and blocks native `subagent` tool launches with a clear diagnostic. File-authored workflows and inline scripts containing literal child `cwd` values fail closed because the wrapper cannot verify those child projects before evaluation. Inline workflow JavaScript can dynamically construct child options; that executable user-authored code, direct user slash-command administration, manually edited package configuration, and other trusted extensions remain user-controlled boundaries the wrapper does not claim to sandbox.

External `codex-exec` and `codex-exec-writer` runners remain disabled.

## Supported controls

### Capacity

Expose only settings with accurate current semantics:

- `maxSubagentSpawnsPerRun`: cumulative child admissions in one run tree.
- `maxSubagentSpawnsPerSession`: cumulative child launches in one parent session; `0` means unlimited.
- `maxActiveAsyncRunsPerSession`: active top-level async runs; `0` means unlimited.

Keep `maxSubagentDepth = 1` policy-owned. Do not present legacy `parallel.concurrency`, `parallel.maxTasks`, or `globalConcurrencyLimit` as modern `runs.all` concurrency controls.

Defaults:

```json
{
  "maxSubagentSpawnsPerRun": 8,
  "maxSubagentSpawnsPerSession": 24,
  "maxActiveAsyncRunsPerSession": 2
}
```

### Builtin roles

Configure only:

- `scout`
- `researcher`
- `worker`
- `reviewer`
- `oracle`

Do not modify custom, project, package-added, or runtime-registered agent definitions.

Model selection rules:

- Read the active model from `ctx.model`.
- Use `ctx.scopedModels` when non-empty; otherwise use `ctx.modelRegistry.getAvailable()`.
- Filter with exact `model.provider === ctx.model.provider`.
- Offer `inherit parent model` first.
- Store fully qualified `provider/id` values.
- Mark models from a prior provider or missing catalogue entry as stale and require explicit reconfiguration.
- Never resolve provider authentication or read credentials.

Thinking rules:

- Offer Pi thinking levels supported by the selected model.
- Enforce ZenPi's `high` ceiling.
- Preserve model and thinking as separate role choices.

Defaults:

```text
scout      inherit · low
researcher inherit · medium
worker     inherit · medium
reviewer   inherit · high
oracle     inherit · high
```

## User experience

With no arguments, present a simple portable dialog flow using public `ctx.ui.select`, `ctx.ui.input`, and `ctx.ui.confirm` APIs:

```text
ZenPi subagents · <provider>
  Configure capacity
  Configure role models
  Configure role thinking
  Review and apply
  Cancel
```

The final review must show only supported changed leaves, the exact provider scope, and accurate capacity terminology. Require one explicit confirmation.

`status` is non-mutating and reports:

- active provider and synchronized scope;
- all supported role model/thinking values;
- capacity values;
- stale role models;
- unsafe project-scope warnings.

`reset` restores supported user-tunable defaults, preserves unrelated JSON, previews changes, and requires confirmation.

After changing runtime capacity, instruct the user to run `/reload` after active subagent work settles. Do not reload automatically.

## Extension architecture

Add:

```text
extensions/subagents/index.ts
extensions/subagents/core.mjs
```

`index.ts` owns:

- command registration and completions;
- session/model lifecycle synchronization;
- exact-provider model catalogue filtering;
- interactive dialogs;
- stale-role notifications;
- unsafe project-scope launch guard;
- status, reset, preview, and deferred reload guidance.

`core.mjs` owns directly testable behavior:

- role/capacity defaults and validation;
- provider scope generation and validation;
- model-reference parsing and exact-provider filtering;
- supported thinking calculation;
- JSON parsing and unrelated-key preservation;
- shared installer/command lock handling;
- symlink rejection;
- sibling-temp atomic writes;
- two-file same-process rollback;
- bounded private leaf-only backups;
- status formatting.

The extension must not import `pi-subagents/src/**` or require package source changes.

## Configuration ownership

Global files:

```text
$PI_CODING_AGENT_DIR/settings.json
$PI_CODING_AGENT_DIR/extensions/subagent/config.json
```

Policy-owned settings:

- `subagents.defaultExtensions = []`
- `subagents.maxThinking = "high"`
- strict `subagents.modelScope`, dynamically synchronized to the active provider
- disabled external Codex CLI agents
- researcher web-access extension allowlist

User-tunable settings:

- `subagents.defaultThinking`
- supported role `model`
- supported role `thinking`

Policy-owned runtime config:

- compact display defaults
- `defaultSubagentContext = "fresh"`
- `maxSubagentDepth = 1`
- missions disabled
- scheduled runs disabled
- session artifact directory

User-tunable runtime config:

- cumulative run child budget
- cumulative session child budget
- active top-level async capacity
- existing legacy parallel object is preserved but not exposed as a modern control

## Installer and migration

Update `scripts/zenpi.mjs` so:

1. The new extension files are installer-managed source files.
2. Role model/thinking and capacity leaves are seed-once/user-tunable.
3. Valid user-tunable values survive update.
4. Policy-owned leaves are repaired deliberately.
5. Runtime config is merged by documented paths rather than copied as one immutable file.
6. Unrelated keys survive install, update, command use, doctor, and uninstall.
7. Uninstall restores unchanged seeded values and original policy values while preserving later user modifications.
8. The old whole-file runtime-config manifest record migrates to path-level records without requiring `--force` solely for valid user customization.
9. `doctor` validates policy drift separately from invalid user-tunable values.
10. Installer and command share a fail-closed lock. A stale lock is reclaimed only when a well-formed recorded PID is positively absent; release does not remove a substituted lock.
11. When `pi` is absent and package installation is enabled, the confirmed installer globally installs reviewed `@earendil-works/pi-coding-agent@0.84.3` through npm with lifecycle scripts disabled. The external Pi installation is not rolled back or removed by ZenPi; `--skip-package-install` opts out. If npm's global executable directory is absent from persistent `PATH`, installation fails with that exact directory instead of relying on a process-only path change.

The command keeps at most five private backups containing only controlled leaves, model ids, thinking values, and capacity values. It never persistently copies complete Pi settings or provider authentication.

## Documentation

Update together:

- `AGENTS.md`
- `templates/AGENTS.md`
- `README.md`
- `SECURITY.md`
- `THIRD_PARTY.md`
- `CHANGELOG.md`

Documentation must:

- replace strict exact-model inheritance wording with exact-provider configuration;
- explain `openai` versus `openai-codex` provider identity;
- document command/status/reset behavior and defaults;
- distinguish cumulative budgets from active async capacity and modern child concurrency;
- document project precedence and the guarded-tool limitation accurately;
- state that only public model/provider metadata is read;
- explain update preservation, bounded leaf backups, atomic writes, rollback, and uninstall behavior;
- state explicitly that ZenPi wraps the pinned package without patching or recreating it.

## GitHub Pages

Update `site/index.html` and `site/styles.css` with a static “Provider-safe delegation” section showing:

- the parent provider/model;
- allowed different same-provider role models;
- an explicitly labelled blocked cross-provider model;
- cumulative run/session budgets;
- active top-level async capacity;
- `/zen-subagents` as the human-controlled entry point;
- `/reload` guidance and the modern concurrency caveat.

Keep the site framework-free, self-contained, keyboard-readable without JavaScript, responsive on desktop/tablet/mobile, and compatible with reduced motion. Keep `.github/workflows/pages.yml` unchanged.

## Validation

### Core and command tests

- exact-provider filtering keeps `openai` and `openai-codex` separate;
- stale role detection covers provider changes and unavailable models;
- same-provider role/model and thinking changes persist;
- cross-provider role models are rejected;
- supported capacities validate bounds;
- unrelated JSON survives;
- symlinks fail closed;
- second-file failure rolls back both files;
- malformed/active locks fail closed and substituted locks survive release;
- command requires one confirmation;
- cancellation is non-mutating;
- nearest-ancestor, git-root, and explicit launch-`cwd` project scopes are checked;
- unsafe project scope blocks native `subagent` tool launches;
- file-authored and literal custom-child-`cwd` workflows fail closed, while dynamically constructed workflow code is documented as trusted input;
- no automatic reload occurs.

### Installer lifecycle tests

Use only temporary `PI_CODING_AGENT_DIR` values. Skip external package installation except where a fake npm/Pi fixture verifies bootstrap behavior without network or host mutation.

Verify:

- missing Pi bootstrap uses the exact pinned npm command after confirmation and survives uninstall;
- missing Pi plus missing npm fails before managed configuration mutation;
- an npm global bin outside `PATH` produces an actionable failure, and a fresh process succeeds after the persistent path is corrected;
- missing-Pi update and later rollback disclosure are covered;
- fresh seed;
- command customization;
- update preservation;
- policy repair;
- legacy whole-file migration;
- doctor success and invalid-value diagnostics;
- uninstall restoration plus modified-tunable preservation;
- rollback and lock release.

### Site and release checks

- extend static site contract tests;
- run `npm run check`;
- inspect install/update/doctor/uninstall round trips;
- load the extension in an isolated Pi process;
- render the site at desktop, tablet, and mobile viewports;
- inspect the final diff;
- run a fresh read-only blocker review.

Do not commit, push, publish Pages, tag, or release without separate explicit approval.

## Acceptance criteria

- `/zen-subagents` provides one confirmed configuration flow.
- Same-provider alternate role models are selectable and cross-provider choices are absent/rejected.
- Provider changes synchronize strict package scope and surface stale roles.
- Capacity labels are semantically accurate.
- User-tunable values survive update and uninstall.
- Policy-owned values remain enforced.
- Writes are locked, atomic, rollback-safe, and symlink-safe.
- Backups are bounded and leaf-only.
- Documentation, templates, tests, and Pages describe the implemented wrapper consistently.
- `npm run check`, isolated lifecycle tests, rendered viewport QA, and fresh review pass.
