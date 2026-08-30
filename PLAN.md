# Durable proofs, improvement journal, and loop health

## Goal

Close the gap between "verified once" and "verified forever" in the self-improvement loop. Four changes ship together as one coherent release:

1. **Durable retirement proofs.** Every retired capability ships a cheap, deterministic, closed validator. `npm run check` and `zenpi doctor` continuously re-prove retired capabilities instead of only the browser runtime.
2. **Improvement journal.** Each retirement persists bounded, sanitized proof — acceptance evidence, gates, changed files, ZenPi version — and `/wishlist history` renders the harness's own changelog, giving every retirement an auditable revert path.
3. **Loop health metrics.** The report shows deterministic local metrics (retirements, reopen rate, open reviews, median time-to-retire, qualification rate) so the human can see whether improvements stick.
4. **Context-rich reopens.** When post-retirement friction reopens a retired item, the reopen links back to the original retirement and the `/harness-improvement` prompt carries the original proof and what changed since.

## Constraints

- Wishlist state remains local-only, salted-hash, append-only JSONL with existing size bounds, `0600` modes, symlink rejection, atomic writes, and archive/reset semantics. New fields ride the existing bounded append and archive paths.
- Decision schema stays `1`; this change only adds **optional, strictly validated** fields. Old decision and event logs must remain readable without migration.
- Validators are closed: no network, no provider calls, no live `PI_CODING_AGENT_DIR`, bounded runtime (default 2 minutes), deterministic on Windows and POSIX, and invoked through `process.execPath` without shell-specific syntax.
- ZenPi never commits, pushes, or reverts on its own. Git integration is a recorded context and a documented trailer convention, not automation.
- Never inspect or persist credentials, sessions, history, prompts, or trust decisions. Evidence and changed-file paths are sanitized with explicit allowlists before storage.
- `plan` stays non-mutating; `install`, `update`, and `uninstall` keep requiring confirmation; installer tests always use a temporary `PI_CODING_AGENT_DIR`.

## Current behavior

- `extensions/tool-wishlist/registry.mjs` allows exactly one validator name, `browser-runtime-smoke`.
- `finish_harness_improvement` (extensions/tool-wishlist/index.ts) runs `npm run check`, then executes only the `browser-runtime-smoke` branch and `continue`s past every other validator name. The agent-supplied `acceptanceEvidence` array is returned in tool details but never persisted.
- `zenpi doctor` (scripts/zenpi.mjs) prints `CAPABILITY <id> verified by <validator>` only for `browser-runtime-smoke`.
- Retirement decisions store `note` (sanitized, ≤240 chars) with the gates text folded in; there is no structured evidence, changed-file set, or version. Reopen decisions carry only a generic note; the menu's reopen path writes "Chosen for harness review".
- The report's `Retired` section lists `id — title` only. No history view, no metrics, no reopen lineage exist.

## Design decisions

### 1. Generic closed-validator registry and runtime

Add `extensions/tool-wishlist/validators.mjs`:

- Exports `VALIDATOR_CATALOG`: a frozen map of validator id → `{ description, timeoutMs }`. The catalog is the single source of truth; `registry.mjs` imports its key set so `VALIDATORS` and the catalog cannot drift.
- Ship two validators:
  - `browser-runtime-smoke` — delegates to the existing `extensions/browser/smoke.mjs` against the managed runtime directory.
  - `wishlist-state-smoke` — creates its own temporary state directory, drives the real core API (`setCollectionMode on` → record two gaps → refresh → select → retire with evidence → refresh → reopen → metrics), asserts report sections and invariants, cleans up, and exits 0. No arguments required; never touches the live agent dir.
- CLI entry: `node validators.mjs <validator> [--state-dir <dir>] [--cwd <dir>] [--browser-runtime <dir>]` prints bounded output and exits non-zero with a clear message for unknown validator names (fail closed).
- A shared `runValidator(validator, environment)` helper returns `{ code, stdout }` so both callers use identical semantics.

### 2. Continuous re-proof in check and doctor

- `finish_harness_improvement` dispatches **every** validator named by the selected capability's `validations` array through the validators CLI in the source checkout via `pi.exec`, with per-validator timeouts. This verifies the implementation under review rather than the older installed validator. An unknown or unregistered validator name fails the retirement attempt with an explicit error.
- `zenpi doctor` replaces the hard-coded branch with a loop over each capability's validators, running each through the validators CLI and printing `CAPABILITY <id> verified by <validator>`. A validator failure is a doctor error; a skipped prerequisite (for example, browser runtime installation was declined) remains a warning.
- `npm run check` gains a test that iterates `CAPABILITY_REGISTRY` and executes every linked validator CLI as a child process, skipping `browser-runtime-smoke` only when the manifest records the runtime as not installed (mirroring doctor's warning semantics). Retired capabilities are therefore re-proved on every check run.
- Add `node --check extensions/tool-wishlist/validators.mjs` to the `check` script.

### 3. Structured retirement journal in decision events

Extend the decision record with one optional `journal` object, validated by `isStoredDecision` whenever present:

```json
{
  "schema": 1,
  "journal": {
    "schema": 1,
    "evidence": ["…≤ 8 sanitized strings, ≤ 240 chars each"],
    "gates": ["npm run check", "wishlist-state-smoke"],
    "changedFiles": ["extensions/tool-wishlist/core.mjs"],
    "changedFilesTruncated": false,
    "version": "0.7.0"
  }
}
```

- `evidence` items pass through `sanitizeReportText(…, 240)`; count bounded at 8.
- `gates` are compacted and matched against `/^[A-Za-z0-9 ._-]{1,60}$/`; count bounded at 8.
- `changedFiles` are computed by `finish_harness_improvement` from `git status --porcelain` in the source checkout at retire time: repo-relative paths only, matched against `/^[A-Za-z0-9._/-]{1,200}$/`, `..` rejected, absolute paths and anything outside the checkout rejected; bounded at 40 entries with `changedFilesTruncated: true` beyond that. If git is unavailable or the checkout is not a repository, the field is omitted rather than guessed.
- `version` is the ZenPi manifest version captured by the existing `sourceCheckout` helper.
- `appendWishlistDecision` accepts an optional `journal` argument, validates and bounds every field, and rejects a `journal` on non-`retire` actions. Old logs without `journal` stay valid.
- The human-readable `note` keeps its existing role (summary + gate list); the journal carries structure so renderers never parse the note.

### 4. Git trailer convention (not automation)

- `skills/zenpi-improve/SKILL.md` gains one instruction: when the user chooses to commit the improvement, include a `ZenPi-Gap: <gap-id>` trailer. ZenPi itself never commits.
- The journal's changed-file set — not commit archaeology — is the durable link between a retirement and its diff, so the loop works even when nothing was ever committed.

### 5. `/wishlist history` view

- New subcommand `history [id]`:
  - Without an id: the last 20 `retire` and `reopen` decisions in chronological order — timestamp, action, gap id, note, gates, version, evidence count.
  - With an id: full detail for that gap — every retirement (evidence bullets, gates, changed files), every reopen with linked retirement and post-retirement signal count.
- Rendered as markdown through the existing `displayMarkdown` path; add `history` to command completions and usage text.
- The main report's `Retired` section is extended in place: `- \`id\` — title (verified YYYY-MM-DD via <gates>)` using the latest retire decision's journal; entries without journal keep the old shape.
- Archive/reset already moves the decisions file, so the journal is preserved by existing archive transactions; no new archive surface.

### 6. Loop health metrics

Add a pure `loopMetrics(events, decisions, registry)` in `core.mjs`, deterministic over current state:

- `retirements` — count of `retire` decisions.
- `reopenRate` — `reopen` decisions from retired state ÷ retirements, as a whole percentage (`0` when no retirements).
- `openReviews` — retired groups currently flagged `reviewNeeded`.
- `medianTimeToRetire` — median over retirements of (retire timestamp − first observation timestamp for that key), in days with one decimal; omitted when no data.
- `qualificationRate` — groups with at least one observation that are qualified or reached `selected`/`retired` ÷ all observed groups, as a whole percentage.

Render a bounded `# Loop health` section at the foot of the report, only when at least one observation exists. `refreshWishlist` returns `metrics` so `/wishlist status` can append one line (retirements, reopen rate, open reviews).

### 7. Context-rich reopens

- When the `/harness-improvement` menu reopens a retired item, the `reopen` decision records:
  - `targetKey` = the latest `retire` decision id for that gap (documented action-specific meaning, consistent with `unmerge` already storing the merge target there);
  - `evidence` = up to 5 sanitized lines summarizing post-retirement signals (count, date range, latest limitation);
  - note `Reopened for review: N post-retirement signal(s)` (sanitized).
- A pure resolver in `core.mjs` maps a reopen decision to its linked retirement journal, so renderers and the prompt can reconstruct lineage without new state.
- `improvementPrompt` gains bounded sections when context exists:
  - **Original proof** — up to 5 evidence bullets from the linked retirement journal;
  - **Files touched by the original change** — up to 10 `changedFiles`;
  - **Changed since retirement** — best-effort `git log --format=%h %s -8` since the retirement timestamp, extension-side, fail-open; each untrusted Git-metadata line is sanitized and bounded to 240 characters (skipped silently when git is unavailable or the checkout is not a repository; this content stays in the session prompt and is never persisted to wishlist state).
- The zenpi-improve skill's reopen guidance points to `/wishlist history <id>` as the first step: original proof and changed-file set in, explicit revert plan proposed to the human, never executed autonomously.

## Core API changes (core.mjs)

- `appendWishlistDecision(options)` — new optional `journal` (retire only) and `evidence` (retire/reopen) arguments, with validation and bounds as specified above.
- `isStoredDecision` — validates the optional `journal` object (shape, types, bounds) when present; tolerates its absence.
- `linkReopenToRetirement(decisions, canonicalKey)` — resolves the latest linked retirement for a reopen decision.
- `loopMetrics(events, decisions)` — as specified in Design decision 6.
- `renderWishlistHistory(events, decisions, requestedKey?)` — journal markdown for the history subcommand.
- `renderWishlist` — extended `Retired` lines and the `# Loop health` section; byte-for-byte stable for state without the new fields.

## Extension changes (index.ts)

- `finish_harness_improvement`: generic validator dispatch; compute bounded repo-relative `changedFiles` via `git status --porcelain`; pass `journal` (evidence, gates, changed files, version) into the retire decision; unknown validator names fail closed.
- `/harness-improvement` reopen path: link the reopen to the latest retirement, attach signal evidence, enrich the prompt with original proof and changed-since context (best-effort git log).
- `/wishlist`: new `history` subcommand with completion and usage updates; `status` line gains the metrics summary.

## Registry changes (capabilities.json)

Add reviewed entries for the capabilities this release ships. Each canonical gap phrase below must normalize to the exact registry id, and every id and alias must satisfy `normalizeCapability(value) === value` (verified by test; phrases checked against the shipped `normalizeCapability`):

| id | canonical gap phrase | title | validations |
| --- | --- | --- | --- |
| `durable-retirement-proof` | "Durable retirement proofs" | Durable re-runnable retirement proofs | `wishlist-state-smoke` |
| `improvement-journal` | "Improvement journal" | Improvement journal with evidence history | `wishlist-state-smoke` |
| `loop-health-metric` | "Loop health metrics" | Loop health metrics | `wishlist-state-smoke` |
| `context-rich-reopen` | "Context-rich reopens" | Context-rich reopens for retired gaps | `wishlist-state-smoke` |

Registry entries are added only when the corresponding capability actually ships in this release; `shippedVersion`/`shippedAt` reflect the release. If a feature is deferred, its entry is deferred with it — the registry never leads the implementation.

## Installer, doctor, and check

- `zenpi.mjs` `check` script: add the validators file to the `node --check` list.
- `doctor`: generic validator loop per capability as specified in Design decision 2; existing runtime/pi/donsetch checks unchanged.
- The installer explicitly manages `validators.mjs` beside the wishlist extension modules; plan/install/update/uninstall and required-source checks include it.

## Documentation

Update together, where the change requires it:

- `README.md` — mention durable proofs and `/wishlist history` under "What ZenPi adds".
- `SECURITY.md` — document the new local-only data classes (sanitized evidence, gates, changed-file names, version), retention, and manual deletion.
- `CHANGELOG.md` — release entry.
- `skills/zenpi-improve/SKILL.md` — evidence recording, journal-first reopen guidance, `ZenPi-Gap:` trailer convention.
- `templates/AGENTS.md` and the managed root block only if agent-facing guidance changes.
- Site showcase only if the loop story gains a stage (journal/metrics are refinements of existing stages; avoid inflating the walkthrough).

## Tests

Extend `tests/zenpi.test.mjs` (and add focused cases under `tests/` as needed):

### Journal

- retire with `journal` stores sanitized, bounded evidence, gates, changed files, and version; oversized or malformed items are rejected, not silently truncated past bounds;
- retire without `journal` (legacy shape) remains valid; pre-change decision fixtures still parse;
- `journal` on a non-retire action is rejected;
- changed-file validation rejects absolute paths, `..`, whitespace, and entries outside repo-relative form.

### Reopen lineage

- reopen from the menu records `targetKey` = latest retire id plus sanitized signal evidence;
- `linkReopenToRetirement` resolves the original journal and tolerates missing/unlinked reopens;
- report and history render correctly with zero, one, and multiple reopen cycles.

### Metrics

- deterministic fixtures produce exact retirement count, reopen rate, open reviews, median time-to-retire, and qualification rate;
- empty and single-event states omit or zero the section without crashing;
- `# Loop health` is absent from reports for state with no observations.

### Validators

- catalog key set equals the `VALIDATORS` set (no drift);
- `wishlist-state-smoke` passes on a clean temp dir, exercises record → select → retire → reopen → metrics, and fails when core assertions are broken (fault-injected fixture);
- unknown validator name exits non-zero with a clear message;
- every capability in `CAPABILITY_REGISTRY` links only to registered validators;
- the check-integration test deduplicates and executes every linked validator as a child process with isolated prerequisites, including a temporary fake browser runtime for `browser-runtime-smoke`.

### Extension harness

- `finish_harness_improvement` persists the journal and retires only after all named validators pass; a failing validator leaves the item selected;
- unknown validator names block retirement with an explicit error;
- reopen prompt contains original proof and changed-since sections when context exists and omits them cleanly when it does not;
- `history` renders through the markdown display path with truncation respected.

### Lifecycle

- `npm run check` passes with the new file list;
- install/update/doctor/uninstall round trip in a temporary `PI_CODING_AGENT_DIR`, with doctor exercising the generic validator loop;
- archive/reset preserves journal state and the salt, per existing transaction tests.

## Out of scope

- Automated commits, reverts, or scheduled self-fixing — the revert path is journal context plus an explicit human-approved plan.
- Uploading, syncing, or backing up wishlist state anywhere.
- Tunable qualification thresholds, suppression lists, and cadence nudges (Tier 2 leads).
- Migrating or rewriting existing decision logs.

## Implementation order

1. `validators.mjs` catalog + `wishlist-state-smoke`; wire `registry.mjs` `VALIDATORS` to the catalog; generic dispatch in `finish_harness_improvement` and doctor; add to the `check` script.
2. Journal in `core.mjs`: optional `journal` on retire decisions, validation, bounds; `appendWishlistDecision` argument; extension-side changed-file capture and evidence pass-through.
3. `/wishlist history` and the extended `Retired` report lines.
4. `loopMetrics`, the `# Loop health` section, and the `status` summary line.
5. Context-rich reopens: reopen linkage, signal evidence, prompt enrichment, skill guidance.
6. Registry entries with exact ids/aliases and validator links.
7. Documentation updates.
8. Full test pass, isolated lifecycle round trip, rendered QA for the history view, `git diff --check`, fresh read-only review.

## Acceptance criteria

- Every capability in the registry is re-proved by `npm run check` and `zenpi doctor` through its linked validators, offline and without touching live user state; unknown validator names fail closed at retirement time.
- Each retirement persists bounded sanitized proof (evidence, gates, changed files, version) locally; legacy decision logs remain readable; archive/reset preserve the journal.
- `/wishlist history` renders per-gap proof and reopen lineage; the report's retired list shows verification dates and gates.
- The report shows deterministic loop metrics only when observations exist, and `/wishlist status` summarizes them in one line.
- Reopening a retired gap records the linked retirement and post-retirement signals, and the improvement prompt carries the original proof and what changed since, without persisting git output to wishlist state.
- ZenPi still never commits, reverts, or uploads; all new writes stay bounded, atomic, `0600`, and symlink-rejected.
- All tests, `npm run check`, the isolated install/update/doctor/uninstall round trip, and a fresh read-only review pass.
