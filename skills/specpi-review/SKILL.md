---
name: specpi-review
description: Review a selected change for correctness, missed reuse, and unnecessary complexity when the user requests a quality review. Reports findings without editing; supports correctness, simplicity, or both.
disable-model-invocation: true
---

# SpecPi Review

Review the change the user selected. Default to both correctness and simplicity; honor a narrower requested mode. If no change is selected, use the current task's diff when unambiguous. Ask for a target only when the available context cannot identify it.

## Establish the evidence

- Read the relevant changed files in full, then the callers, tests, contracts, and existing implementations needed to judge them. A changed-line snippet alone rarely establishes a finding.
- Compare the intended behavior with the actual call chain. Search for existing code before recommending another helper or abstraction. Identify which relevant paths you could not inspect.
- Inspect the diff and available verification evidence. Treat passing checks as evidence of the behavior they exercise, not proof of every requirement. A model-written summary of a test run is a claim; a current runtime receipt is evidence of that bounded check.
- Keep this review read-only. Do not edit files, update baselines, run mutating commands, install tools, or publish findings. Use existing evidence and non-mutating inspection; propose any missing execution check to the parent or user.

## What to look for

For **correctness**, trace concrete inputs through changed behavior, including relevant callers and error paths. Prioritize regressions, violated invariants, wrong boundaries, and acceptance criteria the checks do not exercise. Distinguish an existing failure from a regression without relabeling a failing check as a pass.

For **simplicity**, look for duplicated responsibility, needless state or indirection, and flexibility without a current consumer. Explain the actual maintenance cost and a coherent replacement. Preserve intentional public APIs, extension points, compatibility and trust-boundary checks. Fewer lines alone do not establish a better design; absence of a local caller does not prove an exported interface is unused.

## Report

Lead with actionable findings, ordered by impact. Each finding needs a source location, a concrete trigger or trace, the consequence, and the smallest reasonable remedy. Separate observed defects from hypotheses that need more evidence. Do not invent findings to fill a quota or assign a numeric quality grade.

If no actionable issue is supported, say so. Finish with the inspected scope, checks actually observed, and unresolved coverage gaps. A missing caller or unavailable provider is a limitation, not evidence of correctness.

Use the current session unless the user requests a separate reviewer. A requested delegate uses SpecPi's existing bounded read-only delegation, with its current model/provider and selected-source limits. Do not spawn additional workers, poll continuously, or ask a delegate to exceed those limits. The parent validates findings and the human retains the final review decision.
