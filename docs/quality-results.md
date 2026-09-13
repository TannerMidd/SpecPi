# Quality evaluation results

The September 13, 2026 expanded comparison covers **32 tasks and two separate 384-trial model cohorts**: `gpt-6-astra` through Codex and `z-ai/glm-5.3-flash` through OpenRouter using Pi's provider runtime. GLM did not help author the suite. Its failures make the feature comparisons more informative than the saturated Codex baseline. These are behavioral results on supplied JavaScript fixtures, not general coding accuracy or the quality effect of installed verification/context features.

**Keep review explicitly selected and anchored editing uninstalled.** GLM review tied at 82/96 passes, with seven gains and seven regressions in matched pairs. Anchored editing passed 80/96 versus native editing's 79/96, with eight gains, seven regressions and seven edit rejections. That one-trial net difference does not establish a dependable advantage. All Codex conditions passed 96/96; saturation does not establish general equivalence.

## Independent GLM comparison

| Condition | Passed / valid trials | First trial attempt passes | Tasks passing all 3 | Median model time | Edit rejections | Controls edited |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Generic review + repair | 82 / 96 | 81 / 96 | 24 / 32 | 7.29 s | 0 | 0 |
| SpecPi review + repair | 82 / 96 | 82 / 96 | 23 / 32 | 6.67 s | 1 | 2 |
| Pi native editing | 79 / 96 | 79 / 96 | 21 / 32 | 3.38 s | 0 | 1 |
| Anchored experiment | 80 / 96 | 78 / 96 | 23 / 32 | 4.24 s | 7 | 2 |

| Comparison | Difficulty | Candidate only passes | Baseline only passes | Both pass | Both fail |
| --- | --- | ---: | ---: | ---: | ---: |
| review | All | 7 | 7 | 75 | 7 |
| review | easy | 1 | 0 | 23 | 0 |
| review | medium | 3 | 2 | 29 | 2 |
| review | hard | 3 | 5 | 23 | 5 |
| editing | All | 8 | 7 | 72 | 9 |
| editing | easy | 0 | 3 | 21 | 0 |
| editing | medium | 4 | 2 | 28 | 2 |
| editing | hard | 4 | 2 | 23 | 7 |

The profile used Pi 0.84.4 ModelRuntime, medium reasoning, a 16,384-token response limit, two concurrent trials and an interleaved schedule. OpenRouter could fail over only among eight listed FP8 endpoints under fixed price ceilings. The 584 completed responses were served by Parasail (430), BaseTen (151), Morph (2) and Reka (1). Serving observations do not prove identical underlying implementations. Codex and GLM used different transports, system context and output budgets; compare interventions within a model, not scores or times as a controlled model ranking.

Four incomplete provider attempts are retained separately; three trials needed a restart, and one of those needed two. First-attempt passes include this availability effect. No valid behavioral failure was rerun. Completed malformed responses, refusals and output limits would count as failures; none occurred in this complete cohort. Negative-control edits are observations, not automatically regressions or false positives.

One of the 12 native-editing control trials failed: the model changed the correct TTL cache's expiration boundary from `>=` to `>`, keeping a value alive at its exact expiration time. All 12 controls passed in each other condition. Neither review condition reported findings on controls; the skill's two control edits happened in the repair stage.

OpenRouter reported **$0.259550** across setup pilots, the interrupted Morph cohort and the full failover cohort. The shared ledger conservatively counts **$1.440350 against the authorized $5 cap**, including 101 unresolved request reservations and 10% headroom. The reported amount excludes unknown charges and is not a final account invoice. Five setup pilot directories are excluded from the complete cohort, while their cost remains included.

### What the failures reveal

The suite now exposes missed cancellation contracts, nested event emissions, cache invalidation races and exception preservation. Several anchored repairs produced syntax errors; line/hash targeting does not guarantee semantically correct edits. Review helped some matched cases and harmed others. The requests supply most required context, so these observations still do not measure repository discovery or long-running work.

The review adapter supplies existing code and requested behavior without a proposed Git diff, while the skill is intended for reviewing changes. Some GLM reviews reported no findings because no changes were supplied. A future frozen review benchmark should include baseline/proposed patches and independently audited expectations before using these scores to estimate real pull-request review effectiveness. Using another model reduces author-model dependence; it does not establish training-data independence or replace human auditing of the test design.

### Preserved interruptions and grader correction

An earlier fixed Morph FP8 cohort stopped after **42 valid review trials, including 14 failures**, because of persistent upstream rate limits. Its [interrupted archive](../evals/quality/results/2026-09-13-glm-morph-interrupted.json) preserves those outcomes and generation sources. The later cohort changed routing and interleaved experiments. It is separate, not pooled with the earlier cohort or presented as one uninterrupted preregistered run.

A `bounded-map` candidate exposed an evaluator classification bug: a promise never settled, Node exited with status 13, and the missing final report was initially classified as infrastructure failure. The corrected replay/provider grader counts that state as behavioral failure. All 64 outcomes retained at the correction were checked: 63 stayed unchanged and that case became a failure. No replacement answer was generated. Original result, manifest and grader source remain alongside the correction. Requests, fixtures, hidden assertions and the model-call implementation did not change. Subsequent unresolved-promise candidates were graded under the corrected rule.

The [complete GLM archive](../evals/quality/results/2026-09-13-glm.json) retains all 384 outcomes, provider metadata, budget reservations, invalid attempts, source fingerprints and 251 distinct final fixture variants in 283 deduplicated file blobs. Export reconstructed and regraded every variant. The [protocol](quality-evaluation.md) documents export, replay and the limits of the adapter.

## Codex baseline

| Condition | Passed / valid trials | Tasks passing all 3 | Median model time | Edit rejections | Controls flagged | Controls edited |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Generic review + repair | 96 / 96 | 32 / 32 | 26.31 s | 0 | 0 | 0 |
| SpecPi review + repair | 96 / 96 | 32 / 32 | 28.37 s | 0 | 0 | 0 |
| Pi native editing | 96 / 96 | 32 / 32 | 13.23 s | 0 | 0 | 0 |
| Anchored experiment | 96 / 96 | 32 / 32 | 12.93 s | 0 | 0 | 0 |

Each condition has 96 trials, including 12 negative-control trials. Controls flagged/edited are observations, not automatically false positives or regressions. Findings and maintainability require human assessment. Model time sums response time within a trial, includes provider scheduling, and excludes grading. Subscription dollar cost is unavailable; token fields and missing-value counts are retained in the archive. Timing is descriptive, not a causal speed estimate.

| Comparison | Difficulty | Candidate only passes | Baseline only passes | Both pass | Both fail |
| --- | --- | ---: | ---: | ---: | ---: |
| review | All | 0 | 0 | 96 | 0 |
| review | easy | 0 | 0 | 24 | 0 |
| review | medium | 0 | 0 | 36 | 0 |
| review | hard | 0 | 0 | 36 | 0 |
| editing | All | 0 | 0 | 96 | 0 |
| editing | easy | 0 | 0 | 24 | 0 |
| editing | medium | 0 | 0 | 36 | 0 |
| editing | hard | 0 | 0 | 36 | 0 |

The candidate is the review skill or anchored editor. Three repetitions share a task, and some cases share public-module context; these are descriptive paired counts, not independent population samples or significance estimates. Difficulty labels describe task design rather than calibrated model difficulty.

## Coverage and qualification

The suite contains 8 easy, 12 medium and 12 hard tasks: text/byte boundaries, parsing, multi-file migration, cancellation, cache and worker races, rollback, streaming and public interfaces. Three tasks exercise actual Chromium flows. Four seed regressions into public MIT-licensed SpecPi modules frozen at commit `00b952eefc6ebb40e884860cc1475d75cfe29ed0`. They are not historical issue-resolution benchmarks or four independent repositories.

The corrected qualification rejects all 28 defective seeds and all 32 deliberately wrong repairs, accepts all four unchanged controls, and accepts all 32 reference outcomes (28 repairs and four unchanged controls). Passing those checks is evidence about the graders' selected cases, not exhaustive requirement coverage.

## Codex correction, interruptions and exclusions

Model findings exposed a real bug in `lazy-iterator`, initially mislabeled a negative control: an exception from iterator cleanup replaced the original source exception. Local reproduction confirmed it. The grader and reference were corrected and the task reclassified. The model request, supplied files, tool implementations and fixture digest stayed unchanged. All final outputs were regraded under the corrected revision without additional model repair calls. The archive retains the original outcome beside the corrected outcome.

No Codex acceptance outcome changed after the corrected grader was applied.

The Codex batches had 2 invalid provider/protocol attempts:

- review: `122-repo-output-streams-baseline-r2`, Codex evaluation failed (1): Codex reported a failed turn or stream error. Retained separately and replaced by the first valid continuation attempt.
- editing: `181-browser-search-race-native-r3`, Codex evaluation failed (0): Codex reported a failed turn or stream error. Retained separately and replaced by the first valid continuation attempt.

Four pilot review trials were excluded before the full schedule. Continuations retained every valid pass and failure and ran only missing/invalid trials; none of the completed behavioral failures was retried. Parent manifests, all source epochs, retained result hashes and invalid-call metrics remain in the sanitized archive. The continuation counter records an operator intervention, not a blinded human review. All assessment reported here is agent inspection.

## Reproducibility and decisions

The [complete v2 archive](../evals/quality/results/2026-09-13-v2.json) contains all 384 selected outcomes, invalid attempts, prompt/source fingerprints, phase metrics, findings, per-case grades and 162 distinct final fixture variants as deduplicated text. Export reconstructed and graded every distinct variant in a fresh directory. It checked final-file hashes and refused duplicate valid trials or incomplete schedules. Portable source hashes tolerate Git's CRLF/LF checkout conversion while raw generation hashes remain preserved.

See the [protocol and replay commands](quality-evaluation.md) and the [evaluations page](https://tannermidd.github.io/SpecPi/evals/), which provides the catalog, tables, JSON and CSV. Raw provider traces, host paths and private state are excluded.

| Feature | Decision | Remaining evidence needed |
| --- | --- | --- |
| Explicit review skill | Keep manually selected | GLM showed seven paired gains and seven regressions; evaluate actual proposed patches and human review burden before any automatic loop |
| Native Pi editor | Keep as the production editor | Realistic discovery and mutation workflows remain outside the adapter |
| Anchored editing | Keep uninstalled | GLM's eight paired gains, seven regressions and seven edit rejections do not justify replacement; require repeatable gains plus production Guard, scope, stale-file and transaction validation |
| Verification receipts and required checks | Keep observed-evidence gates and the reviewed fixes | Their overall model-quality effect was not measured by this supplied-context experiment |
| Selected editor context | Keep explicit previews and stale-buffer checks | Measure useful context and error reduction on real workspace tasks |
| Evaluation suite | Keep as a bounded regression screen | Retain both model cohorts and failures; add independently audited holdouts, real proposed patches and repository discovery before making broader claims |

## Earlier eight-task screen

The original [96-trial archive](../evals/quality/results/2026-09-13.json) and [original report at its recorded commit](https://github.com/TannerMidd/SpecPi/blob/00b952eefc6ebb40e884860cc1475d75cfe29ed0/docs/quality-results.md) remain separate. Both review conditions identified 21/21 seeded issues and left 3/3 intentional-interface controls unflagged; both editors passed 24/24 behavioral trials. Version 1 measured review findings, while version 2 measures review followed by repair. The results are not pooled.

This adapter supplies the complete task context and instructs native Codex tools off; it does not enforce adversarial read isolation or test full Pi conversations, long-running work, other languages, repository exploration or production editing safety. The independent runtime, installer, provider and editor regression suites remain release requirements, not evidence of a general accuracy gain.
