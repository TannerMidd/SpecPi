---
name: zenpi-improve
description: Turns a selected ZenPi capability-gap wishlist item into a minimal, evidence-backed, reversible improvement. Use when the user asks to improve ZenPi from its wishlist, act on a selected gap, or complete the notice-to-retire loop.
---

# ZenPi Improve

Improve the harness through an explicit experiment, never through quiet self-modification.

## Preconditions

1. Ask the user to run `/wishlist next` when no gap ID or evidence card is available.
2. Require a persisted selected gap. If it is still open, ask the user to run `/wishlist select <id>`; conversational confirmation does not replace the explicit lifecycle decision.
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

Ask for approval before modifying source unless the user already explicitly authorized implementation of this exact card.

## Implementation

1. Preserve a single writer for the active worktree.
2. Implement the smallest coherent intervention.
3. Add focused tests that reproduce the gap and prove the new behavior.
4. Update the reviewed capability registry only when the capability is actually shipped. Use exact aliases; do not hide adjacent unsupported cases.
5. Link deterministic capabilities to an existing or new `zenpi doctor` check.
6. Update README, security documentation, changelog, third-party notices, and installer source lists only where the change requires it.
7. Keep installation explicit, reversible, backed up, atomic, and checksum-tracked.

## Verification and retirement

1. Run the narrowest focused checks, then `npm run check`.
2. For installer changes, exercise plan/install/doctor/update/uninstall with a temporary `PI_CODING_AGENT_DIR`; never use the live Pi directory.
3. Inspect the final diff and obtain fresh read-only review when risk warrants it.
4. Retire only after direct acceptance evidence passes. Record retirement explicitly with `/wishlist retire <id>` when the local lifecycle is selected and the shipped registry/validation evidence is correct.
5. If validation fails, fix or revert. Do not retire on plausibility.
6. If a retired capability later produces a regression signal, investigate and require an explicit `/wishlist reopen <id>` before treating it as open work.

## Handoff

Report the gap ID, changed files, acceptance evidence, commands and exit codes, lifecycle action, rollback path, and residual risks. Never claim that silence or the absence of later reports proves success.
