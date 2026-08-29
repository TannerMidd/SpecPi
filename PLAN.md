# ZenPi Self-Improvement Loop Plan

## Objective

Turn ZenPi's privacy-minimized capability-gap collector into a complete, explicit, reversible improvement loop while preserving its minimal ethos: evidence-led growth, human authority, local-only state, deterministic behavior, and no autonomous self-modification.

The target loop is:

```text
observe → qualify → select → experiment → verify → retire
                                  ↘ revert/reopen
```

## Completion status

All three phases are implemented. Validation evidence:

- `npm run check`: 38/38 tests pass, including the one-command menu, session-bound completion gate, failed-gate retention, and isolated plan/install/update/doctor/uninstall round trips.
- Explicit isolated Pi extension load: passed.
- Rendered showcase QA: passed at desktop, tablet, and mobile viewports.
- Fresh final blocker review: no findings; merge verdict `OK`.

## Invariants

- Capability observations remain sanitized, local, bounded, and append-only.
- No command uploads data, installs packages, opens issues, or changes lifecycle state without an exact user choice. `/harness-improvement` authorizes only the chosen smallest-sufficient source change; remote or external state still requires separate approval.
- Existing event history remains readable.
- Lifecycle and alias changes are append-only and reversible.
- Ranking is deterministic and documents every factor it uses.
- Implemented capabilities can produce regression signals instead of silently suppressing future friction.
- Installer mutations remain planned, confirmed, backed up, atomic, checksummed, and reversible.

## Phase 1 — Close the evidence loop

1. Correct measurement so ranking transparently uses impact-weighted unique tasks, project reach, session reach, and recency as deterministic sort keys.
2. Add a private append-only decision ledger. Stable states are `open`, `selected`, `declined`, and `retired`; `reopen` is an action that returns a declined or retired gap to `open`. Registry entries provide the shipped `retired` baseline, while later explicit local decisions override that baseline.
3. Enforce the transition table: `open|declined → selected`, `open|selected → declined`, `selected → retired` only with a sanitized validation note, and `declined|retired → open` through `reopen`.
4. Keep `/wishlist` as the evidence, consent, and advanced curation surface. Route implementation through one `/harness-improvement` menu that presents qualified and review-needed items.
5. Preserve reports against retired capabilities as bounded regression signals and derive a `review-needed` flag; this flag never changes lifecycle state or reopens work automatically.
6. Add explicit local collection controls (`status`, `on`, `off`). Missing preference is fail-closed: no observation or salt is written until the user decides. Existing logs do not imply consent, and archive/reset preserves the global preference.
7. Store each new observation's immutable normalized `observedKey`; resolve exact registry aliases and user merge decisions only during projection. Legacy `canonicalKey` remains readable as its observed key.
8. Rank by impact-weighted unique tasks, distinct projects, distinct sessions, valid last-seen time, then ID. After alias projection, reports from the same task count once at their maximum impact. Two unique tasks or one blocked-equivalent priority qualifies a candidate.
9. Document retention and control behavior.

## Phase 2 — Make improvement repeatable and verifiable

1. Replace the hard-coded implemented-key set with a reviewed capability registry containing canonical IDs, aliases, shipped version/time, and validation identifiers.
2. Resolve registry validation identifiers through a closed code-reviewed allowlist; never interpret registry content as commands. Link registered capabilities to `zenpi doctor` checks where deterministic validation exists.
3. Add a `zenpi-improve` skill that turns a selected gap into a minimal improvement card: evidence, smallest intervention, hypothesis, acceptance check, rollback, and privacy/security implications. Cards may use only sanitized stored aggregates, registry metadata, and explicitly inspected project files—never Pi sessions, prompts, history, credentials, or trust state.
4. Keep implementation approval explicit but frictionless: choosing one exact item in `/harness-improvement` authorizes its smallest-sufficient implementation and starts the agent turn. A session-bound completion tool requires reviewed registry integration, runs the fixed repository check and supported closed validators, and retires only after every gate passes. Failed gates leave the item selected.
5. Ensure installer/update/uninstall manages the registry and skill as source-of-truth resources.

## Phase 3 — Add reversible curation and portability

1. Add exact, append-only alias merge decisions and ID-addressed unmerge decisions so users can correct fragmented names without rewriting observations or using an AI classifier. Reject cycles and prevent local aliases from replacing reviewed canonical registry IDs.
2. Add an explicit sanitized issue-draft view for a chosen gap; render locally and never upload automatically.
3. Add confirmed archive/reset behavior that prepares and checksums a private snapshot before publishing a recovery transaction. If the operation fails after preparation and releases its verified lock, the next locked operation completes the reset from that snapshot; an abandoned unverified lock remains fail-closed and requires explicit operator review. Global collection preference and private salt remain outside the reset boundary.
4. Keep all new output Markdown-based and bounded; do not add dashboards or telemetry.

## Validation

- Unit tests for deterministic ranking, lifecycle transition validation, regression capture/reopen, collection controls, alias merge/unmerge, issue drafts, and archive/reset behavior.
- Installer round trips in a temporary `PI_CODING_AGENT_DIR`: plan, install, doctor, update, uninstall.
- `npm run check` passes.
- Final diff is inspected and independently reviewed for correctness, privacy/security, simplicity, tests, and documentation accuracy.
- A pull request is created from a pushed feature branch with the plan, implementation summary, validation evidence, and residual risks.

## Anti-goals

- Unprompted edits, PRs, uploads, installs, or unverified lifecycle transitions.
- Cross-user telemetry or behavioral profiling.
- AI-generated identity clustering or opaque scoring.
- Background schedulers, dashboards, or feature accumulation unrelated to the loop.
