---
name: specpi-improve
description: Turns a selected SpecPi capability-gap wishlist item into a minimal, evidence-backed, reversible improvement. Use when the user asks to improve SpecPi from its wishlist, act on a selected gap, or complete the notice-to-retire loop.
---

# SpecPi Improve

Improve the harness through an explicit experiment, never through quiet self-modification.

## Preconditions

1. Begin through `/harness-improvement`. Its menu exposes qualified and review-needed items, records the chosen item as selected, and starts this workflow.
2. Treat that exact menu choice as approval for the smallest sufficient implementation of that item. Ask again only if scope expands or external/remote state would change.
3. Treat wishlist summaries as leads, not proof. Inspect the current repository, tools, docs, tests, and runtime behavior before designing a change.
4. Do not inspect Pi credentials, trust decisions, sessions, history, missions, or unrelated private state.

## Improvement card

Before editing, present one compact card:

- **Gap ID and evidence:** occurrences, reach, impact, and representative sanitized needs.
- **Smallest intervention:** choose among bug fix, config, prompt, skill, or tool; prefer the least powerful sufficient option.
- **Hypothesis:** what friction the change should remove.
- **Acceptance check:** direct behavior that proves the capability works.
- **Rollback:** how the change can be removed or reverted cleanly.
- **Privacy/security:** state what new data, permissions, dependencies, or external state would be introduced; prefer none.
- **Non-goals:** reject adjacent feature accumulation.

The `/harness-improvement` selection authorizes this exact smallest-sufficient card. Do not add another approval step unless the proposed work exceeds it.

## Implementation

1. Preserve a single writer for the active worktree.
2. Implement the smallest coherent intervention.
3. Add focused tests that reproduce the gap and prove the new behavior.
4. Update the reviewed capability registry only when the capability is actually shipped. Use exact aliases; do not hide adjacent unsupported cases.
5. Link deterministic capabilities to an existing or new `specpi doctor` check.
6. Update README, security documentation, changelog, third-party notices, and installer source lists only where the change requires it.
7. Keep installation explicit, reversible, backed up, atomic, and checksum-tracked.
8. If the user chooses to commit the improvement, include a `SpecPi-Gap: <gap-id>` trailer so the commit can be linked to its retirement in the journal. SpecPi itself never commits.

## Verification and retirement

1. Run the narrowest focused checks, then `npm run check`.
2. For installer changes, exercise plan/install/doctor/update/uninstall with a temporary `PI_CODING_AGENT_DIR`; never use the live Pi directory.
3. Inspect the final diff and obtain fresh read-only review when risk warrants it.
4. At the end, call `finish_harness_improvement` with the exact gap ID, concise direct acceptance evidence, and a sanitized validation note. The tool independently requires source-registry integration, runs `npm run check`, executes every capability validator through the closed validators catalog, persists that proof into the local improvement journal, and retires only if every gate passes.
5. If validation fails, fix or revert. Do not retire on plausibility; leave the item selected and report the blocker.
6. A later regression returns the retired item to the `/harness-improvement` menu. Choosing it there explicitly reopens and selects it for review.
7. When a retired item reopens, start from `/wishlist history <gap-id>`: the journal supplies the original proof and the changed-file set of the original change. Propose an explicit revert plan for human approval; never revert autonomously.

## Handoff

Report the gap ID, changed files, acceptance evidence, commands and exit codes, lifecycle action, rollback path, and residual risks. Never claim that silence or the absence of later reports proves success.
