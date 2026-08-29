# Per-provider subagent profiles

## Goal

Extend ZenPi’s existing `/zen-subagents` wrapper so a user configures each exact Pi provider once and ZenPi automatically restores that provider’s builtin-role model and thinking choices whenever the parent switches back to it.

Example:

1. Configure `openai-codex` roles.
2. Configure `openrouter` roles.
3. Switch between providers in later sessions.
4. ZenPi restores the matching saved profile automatically; no repeated setup is required.

Capacity settings remain global. Provider isolation remains exact: `openai`, `openai-codex`, `openrouter`, and every other provider ID are separate boundaries.

## Constraints

- Keep `pi-subagents@0.58.0` unchanged.
- Do not fork, patch, vendor, deep-import, or recreate `pi-subagents`.
- Use only its documented settings surface:
  - `subagents.agentOverrides.<role>.model`
  - `subagents.agentOverrides.<role>.thinking`
  - `subagents.modelScope`
  - documented runtime capacity config
- Preserve strict scope as `{ enforce: true, strict: true, allow: ["<active-provider>/*"] }`.
- Never inspect or persist credentials, authentication, sessions, history, prompts, or trust decisions.
- Persist only exact provider IDs, model IDs, thinking levels, timestamps, and schema metadata.
- Preserve explicit preview, confirmation, shared locking, symlink rejection, atomic writes, rollback, bounded backups, and unrelated JSON.
- Keep trusted project settings and dynamically constructed workflow code documented as user-controlled boundaries.
- When `session_start` or `model_select` changes the active provider profile/settings mirror, prompt the user to run the documented `/reload` command and keep pre-launch guards fail-closed until a fresh `session_start` verifies alignment. Lifecycle handlers receive `ExtensionContext`; command-only `ctx.reload()` must not be called from them. Do not prompt for reload after no-op same-provider activation.

## Current behavior

ZenPi currently stores one set of builtin-role overrides directly in user `settings.json`. Those values persist across sessions, but configuring a second provider overwrites the first provider’s role choices.

The extension already:

- filters model choices to `ctx.model.provider`;
- synchronizes strict model scope on session start, model selection, and guarded launches;
- identifies stale role models after provider changes;
- edits only controlled role/model/thinking and capacity leaves;
- shares the installer lock and performs atomic writes with rollback.

The new work must retain those properties while adding a provider-indexed source of truth.

## Design decisions

### 1. ZenPi owns provider profiles

Add a private state file:

`~/.pi/agent/zenpi/subagent-provider-profiles.json`

Equivalent path under `PI_CODING_AGENT_DIR` must be supported.

Schema:

```json
{
  "schema": 1,
  "providers": {
    "openai-codex": {
      "updatedAt": "2026-08-29T00:00:00.000Z",
      "origin": "configured",
      "roles": {
        "scout": { "model": "openai-codex/model-id", "thinking": "low" },
        "researcher": { "model": "inherit", "thinking": "medium" },
        "worker": { "model": "openai-codex/model-id", "thinking": "medium" },
        "reviewer": { "model": "openai-codex/model-id", "thinking": "high" },
        "oracle": { "model": "inherit", "thinking": "high" }
      }
    }
  }
}
```

Requirements:

- provider keys must be non-empty exact IDs without wildcards;
- every explicit model must belong to its profile’s exact provider;
- every provider record has a bounded `origin` enum: `default`, `configured`, `migrated`, or `reset`; this durably distinguishes status across sessions without storing additional user data;
- only `SUPPORTED_ROLES` are stored;
- every role contains only `model` and `thinking`;
- unknown top-level/provider keys are rejected rather than silently interpreted;
- cap profiles at 64 providers and bound file size before parsing;
- write with mode `0600` where supported;
- reject symlinked targets and parent directories;
- never store complete Pi settings snapshots.

### 2. Pi settings remain the active compatibility mirror

`pi-subagents` documents one active `agentOverrides` map, not a provider-indexed map. ZenPi therefore keeps the selected provider profile mirrored into the existing controlled settings leaves.

The profile file is the durable source of truth. The active settings mirror exists only so the unchanged `pi-subagents` package can consume the selected provider’s role defaults.

Activation writes, in one transaction:

- strict `subagents.modelScope` for the active provider;
- the active provider’s builtin role model/thinking leaves;
- profile state when configuration or migration changes it;
- global capacity only when explicitly edited.

Do not modify unrelated `agentOverrides` fields such as prompts, tools, skills, extensions, context, or custom roles.

### 3. Profiles activate automatically

Attempt activation on:

- `session_start`;
- `model_select` when the exact provider changes;
- immediately before guarded native `subagent` launches;
- `/zen-subagents`, `/zen-subagents status`, and `/zen-subagents reset`.

Switching models within the same exact provider must not rewrite files when the active mirror already matches.

If a provider has a valid saved profile, restore it automatically. If it has no profile, create a default profile using `ROLE_DEFAULTS` and notify once that the provider is using inherited defaults until configured.

A saved model that is no longer available remains stored but is reported as stale. Do not silently choose a replacement. Launches using a stale default must fail with a clear `/zen-subagents` remediation message; `inherit` remains valid.

Explicit per-run `model` or `thinking` inputs retain `pi-subagents` precedence and are not overwritten by ZenPi. Strict model scope still rejects cross-provider overrides.

### 4. Capacity stays global

Keep these values in `extensions/subagent/config.json` as global settings:

- cumulative run child budget;
- cumulative session child budget;
- active top-level async capacity.

Do not duplicate capacity into every provider profile.

The configuration preview must label capacity as global and role model/thinking changes as applying only to the active provider.

### 5. Prevent cross-process provider races

User `settings.json` is shared by all Pi processes. A short write lock alone cannot make two simultaneous sessions on different providers safe because either process could replace the active mirror before the other process’s `pi-subagents` launch reads it.

Add an ephemeral provider-lease file:

`~/.pi/agent/zenpi/subagent-provider-leases.json`

Each live extension instance records:

- random lease token;
- PID;
- exact provider;
- last update timestamp.

Lease behavior:

- register on `session_start`;
- update on successful provider changes and guarded launches;
- remove the matching token on `session_shutdown`;
- reclaim an entry only when its recorded PID is positively absent;
- never reclaim malformed or unverifiable entries automatically;
- allow multiple live sessions using the same provider;
- fail closed when another live process holds a different-provider lease;
- report which provider conflicts, but do not expose unrelated process data;
- retry naturally on the next status/configuration/launch after the conflicting session exits.

The lease file is ephemeral, contains no model or prompt data, and is removed when empty. It is not included in persistent backups.

Do not hold the shared lock for the lifetime of a subagent run. The lease prevents conflicting provider activation; the existing lock serializes each bounded file transaction.

### 6. Lazy migration preserves existing configuration

The installer cannot know the active runtime provider, so migrate the current single-profile settings lazily in the extension.

On first activation when no profile file exists:

1. Read the controlled builtin role model/thinking leaves.
2. Collect provider IDs from non-`inherit` models.
3. If all explicit models use one provider, save the current roles under that provider.
4. If every role uses `inherit`, save them under the active provider.
5. If explicit roles contain mixed or invalid providers, do not guess; leave settings unchanged, report a migration diagnostic, and require `/zen-subagents` to repair.
6. If the inferred provider differs from the active provider, preserve the inferred profile and create/activate defaults for the active provider.
7. Record schema state only after profile and mirror writes verify successfully.

Migration must be idempotent and covered for:

- existing Codex configuration while starting Codex;
- existing Codex configuration while starting OpenRouter;
- all-`inherit` configuration;
- malformed and mixed-provider legacy values;
- interrupted first migration and rollback.

## `/zen-subagents` behavior

### Default command

The existing interactive flow edits the active provider profile.

Header example:

`ZenPi subagents · openai-codex · saved profile`

Review text must show:

- active exact provider;
- provider-specific role changes;
- global capacity changes;
- strict provider scope;
- stale/unavailable model diagnostics;
- project-scope warnings;
- whether this is a new or existing profile.

One confirmation applies profile, mirror, and capacity changes atomically.

### Status

`/zen-subagents status` must show:

- active provider;
- active profile state: saved, default, stale, migration-needed, or blocked by a live provider lease;
- strict scope status;
- each active role’s model and thinking;
- global capacity values;
- saved provider IDs, without dumping the complete profile file;
- stale roles and unavailable models;
- project precedence warnings.

Status remains non-mutating except for safe lazy migration/activation required to establish the active profile. If that distinction is confusing in implementation, split pure inspection from activation and ensure the UI states when activation occurred.

### Reset

`/zen-subagents reset` resets only the active provider profile to `ROLE_DEFAULTS` and keeps other provider profiles intact.

The confirmation must say:

- which exact provider will be reset;
- that global capacity is unchanged;
- that other provider profiles are unchanged.

Do not add a reset-all operation in this change.

### Completion and notifications

Keep `status` and `reset` completions. No provider name argument is required; configuration always targets the active provider.

Notify on provider changes only when:

- a different saved profile was restored;
- a new default profile was created;
- saved roles are stale;
- activation is blocked by a conflicting live provider lease;
- migration needs user action.

Avoid notifications for no-op same-provider model changes.

## Core API changes

Refactor `extensions/subagents/core.mjs` around lock-aware internal operations so public functions do not acquire the same lock recursively.

Add or equivalent:

- `readProviderProfiles(agentDir)`
- `validateProviderProfiles(value)`
- `profileForProvider(profiles, provider)`
- `migrateLegacyProfile(state, activeProvider)`
- `activateProviderProfile({ agentDir, provider, leaseToken, reason })`
- `applyProviderConfiguration({ agentDir, provider, roles, capacity, leaseToken, reset, reason })`
- `readProviderLeases(agentDir)`
- `registerOrRefreshProviderLease(...)`
- `releaseProviderLease(...)`
- `staleProfileRoles(profile, provider, availableValues)`
- `formatSubagentStatus(...)`

Transaction requirements:

- snapshot only exact bytes needed for same-process rollback;
- persist only controlled leaf backups;
- write profile state, settings mirror, and capacity atomically as one logical operation;
- on any failure, restore every file changed by that operation;
- verify each written JSON file before returning success;
- preserve original file modes;
- reject target and parent symlinks before locking and again at write boundaries where practical;
- keep at most five bounded leaf-only backups;
- include provider ID and reason in backup metadata;
- never include leases or unrelated settings fields in backups.

Extend `configurationPaths()` with profile and lease paths.

## Extension changes

Update `extensions/subagents/index.ts` to:

- generate one random lease token per extension runtime;
- register/refresh/release leases through lifecycle hooks;
- replace scope-only synchronization with profile activation;
- build command drafts from the active profile rather than the current global mirror;
- retain exact-provider model filtering;
- retain nearest/git-root project resolution and launch-`cwd` checks;
- retain file-authored/literal-child-`cwd` workflow guards and the documented dynamic-workflow trust boundary;
- fail closed before a launch when activation, lease validation, migration, scope validation, or stale-role validation fails;
- avoid rewriting settings for no-op activation.

Do not parse or rewrite workflow JavaScript to inject role models. The active mirror plus same-provider lease is the supported wrapper mechanism.

## Installer, update, doctor, and uninstall

Update `scripts/zenpi.mjs` without changing the pinned `pi-subagents` package.

### Install

- Do not seed provider names because no active provider is known.
- Leave profile creation to lazy runtime migration.
- Ensure the ZenPi state directory remains private.
- Include profile/lease policy in the printed plan.

### Update

- Preserve valid provider profiles byte-for-byte unless schema migration is required.
- Never replace user profiles with defaults.
- Continue preserving global capacity customization.
- Do not interpret a missing profile file as damage before first runtime activation.

### Doctor

Validate separately:

- profile file schema and size bounds;
- exact provider/model affinity for every saved role;
- supported roles and thinking levels;
- active settings mirror consistency when an active provider can be inferred;
- malformed or conflicting lease data;
- policy-owned strict scope;
- existing global capacity bounds.

Doctor must not require provider authentication or enumerate private provider state. It may report provider/model IDs already present in ZenPi’s profile file.

### Uninstall

Provider profiles are user-tunable ZenPi state. Preserve them on uninstall, alongside existing retained local state, and report the retained path. Remove an empty lease file and the current process’s lease; never delete another active process’s lease.

Restore settings/runtime-config leaves using existing manifest ownership rules. Do not copy complete settings into the profile store during uninstall.

Document manual profile removal for users who want a complete state purge.

## README self-improvement loop graphic

Replace the ASCII/text flow under README’s **“Let friction teach the system”** section with a purpose-built visual diagram. Do not replace the numbered explanatory content under **“How the loop works”**; the graphic should summarize it rather than become the only explanation.

Create a checked-in, hand-reviewable SVG asset:

`site/self-improvement-loop.svg`

The diagram must communicate the complete control loop:

1. real friction is observed locally;
2. privacy-minimized evidence accumulates and qualifies;
3. a human explicitly chooses `/harness-improvement`;
4. ZenPi implements the smallest sufficient change;
5. verification gates the result;
6. a passing change is retired;
7. a failed verification returns to selected work without pretending completion;
8. later evidence against a retired capability returns to human review rather than reopening automatically.

Visual requirements:

- use a circular or clearly cyclical composition rather than a left-to-right text imitation;
- make the human-choice and verification gates visually distinct from ordinary stages;
- show both the failed-verification return path and later-evidence review path without crossing labels or ambiguous arrows;
- use the existing Tea House visual language and palette while remaining readable on GitHub light and dark themes;
- use a transparent or intentionally framed background with sufficient text/line contrast;
- include a descriptive `<title>` and `<desc>` inside the SVG;
- provide meaningful README `alt` text that describes the loop and its two return paths;
- remain legible when rendered at approximately 320px mobile width and crisp at large desktop widths;
- use a stable `viewBox`, vector text/shapes, and no raster screenshots;
- contain no scripts, animation, externally loaded `href`/CSS resources, embedded HTML, tracking, or external fonts;
- respect reduced-motion expectations by being fully static;
- keep important labels as real SVG text where practical.

Embed it in `README.md` with a relative repository path so tagged releases and forks render independently. Center it and cap the displayed width without using GitHub-unsupported styling. Add a short text link below the image to the existing interactive showcase walkthrough for users who want the stage-by-stage example.

The existing ASCII block beginning with `notice → qualify` must be removed. Do not use Mermaid as the final artifact; the intent is a branded, deterministic graphic that renders consistently without a diagram runtime.

The website already has an interactive loop walkthrough. Keep that interaction, but make the new SVG visually consistent with it. Reuse the SVG on the website only if it adds value without duplicating the interactive story.

## Documentation

Update together:

- `README.md`
- `SECURITY.md`
- `THIRD_PARTY.md` only if dependency policy changes (none expected)
- `CHANGELOG.md`
- `AGENTS.md`
- `templates/AGENTS.md`
- `site/index.html`
- `site/styles.css` only if needed

Documentation must explain:

- configure each exact provider once;
- profiles restore automatically in future sessions;
- capacity is global;
- `inherit` remains portable;
- unavailable models become stale and are not silently replaced;
- exact-provider isolation is unchanged;
- simultaneous different-provider Pi processes fail closed rather than racing the shared mirror;
- project settings and trusted dynamic workflow code remain explicit boundaries;
- profile contents, location, retention, and manual deletion;
- no credentials or authentication data are stored;
- the README’s ASCII self-improvement flow is replaced by an accessible static SVG that accurately shows human choice, verification failure, retirement, and later-evidence review.

Update the showcase delegation console to depict at least two saved provider profiles and automatic restoration without implying cross-provider child execution.

## Tests

### Core profile tests

- profile schema accepts exact valid providers and rejects malformed, wildcard, oversized, unknown-role, and cross-provider values;
- model IDs containing additional `/` characters remain valid under the exact first-segment provider rule;
- profiles for `openai` and `openai-codex` remain distinct;
- capacity is not duplicated into profiles;
- unrelated settings and role fields survive activation;
- active mirror switches Codex → OpenRouter → Codex and restores original Codex choices;
- same-provider model changes are no-op writes;
- stale unavailable models are reported without replacement;
- reset affects only the active provider;
- at most five leaf-only backups remain;
- profile, settings, and capacity transaction failures roll every changed file back;
- target and parent symlinks fail closed.

### Lease tests

Use child processes where needed:

- multiple leases for the same provider are allowed;
- a live different-provider PID blocks activation and launch;
- positively absent PIDs are reclaimed;
- malformed, permission-unknown, changed-during-recovery, and PID-reuse-ambiguous records fail closed;
- release removes only the matching token;
- substituted lease files survive release;
- empty lease files are removed;
- session shutdown cleanup is idempotent.

### Migration tests

- single-provider legacy settings migrate once;
- starting on another provider preserves the inferred legacy profile and activates defaults for the current provider;
- all-`inherit` settings seed the current provider;
- mixed-provider legacy values require explicit repair;
- interrupted migration rolls back and retries safely;
- no complete settings snapshot is persisted.

### Extension harness

Extend the deterministic TypeScript harness to cover:

- configure Codex profile;
- switch to OpenRouter and configure it;
- switch back and observe automatic Codex restoration;
- status lists both saved provider IDs;
- reset preserves the other profile and global capacity;
- stale-role notification;
- no-op same-provider selection;
- conflicting live-provider lease blocks the tool call;
- unsafe project scope still blocks;
- command cancellation remains non-mutating;
- exactly one confirmation per apply/reset.

### Installer lifecycle

Use temporary `PI_CODING_AGENT_DIR` values and no live user Pi state.

Verify:

- fresh install before first profile;
- lazy first activation;
- update preserves profiles and global capacity;
- doctor accepts valid profiles and diagnoses invalid profiles/leases;
- uninstall restores managed leaves while preserving provider profiles;
- reinstall reuses preserved profiles;
- rollback and lock release.

### Graphic, site, and release checks

- parse `site/self-improvement-loop.svg` as XML and verify a stable `viewBox`, `<title>`, `<desc>`, expected stage labels, and both return paths;
- assert the SVG contains no `<script>`, `<foreignObject>`, externally loaded `href`/CSS resource, animation element, or embedded raster data;
- assert README embeds the relative SVG with meaningful alt text and no longer contains the `notice → qualify` ASCII flow;
- render the standalone SVG and the README section at desktop and mobile widths, checking text legibility, arrow clarity, contrast, clipping, and overflow;
- update static site contract tests;
- run `npm run check`;
- run isolated install/update/doctor/uninstall round trips;
- run `git diff --check`;
- load the extension through the deterministic harness and an isolated Pi smoke;
- validate the showcase at desktop, tablet, and mobile viewports;
- use a fresh read-only reviewer before release.

## Implementation order

1. Add profile schema, validation, bounded reads, and paths in `core.mjs`.
2. Add migration and provider activation transactions.
3. Add provider leases and conflict handling.
4. Refactor configuration apply/reset around provider profiles and global capacity.
5. Update extension lifecycle hooks, status, dialogs, and launch guards.
6. Add core, lease, migration, and extension harness tests.
7. Integrate installer/update/doctor/uninstall behavior.
8. Design and validate the self-improvement loop SVG, then replace the README ASCII flow.
9. Update remaining documentation and showcase content.
10. Run full lifecycle, graphic/UI, and review validation.

## Acceptance criteria

The change is complete when:

- a user configures Codex and OpenRouter once each;
- later provider switches automatically restore the correct saved role models and thinking levels;
- switching back does not require `/zen-subagents` again unless a saved model became unavailable;
- exact-provider scope is re-established before every native launch;
- simultaneous live sessions on different providers fail closed instead of racing shared settings;
- profiles, current settings mirror, and global capacity remain atomic and recoverable;
- valid profiles survive update, uninstall, reinstall, and future sessions;
- no credentials, prompts, sessions, history, complete settings, or unrelated JSON are persisted in profile state or backups;
- `pi-subagents@0.58.0` remains unchanged;
- the README uses the accessible branded SVG instead of the ASCII flow and the diagram remains legible on GitHub-sized desktop/mobile renders;
- all tests, lifecycle checks, rendered QA, and fresh review pass.
