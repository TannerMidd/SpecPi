# Quality evaluation results

The September 13, 2026 expanded comparison covers **32 tasks and 384 selected trials**, using `gpt-6-astra` at medium reasoning through Codex CLI 0.153.1 and the user's ChatGPT subscription. Review remains explicitly selected and anchored editing remains an uninstalled experiment. These are behavioral results on supplied JavaScript fixtures, not a measure of general coding accuracy or of the installed verification/context features.

All four conditions passed 96/96 trials with no edit rejections. The expanded suite still saturates: it establishes no behavioral advantage for the review skill or anchored editing and does not establish general equivalence. Keep review optional and the anchored experiment uninstalled.

## Measured outcomes

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

## Correction, interruptions and exclusions

Model findings exposed a real bug in `lazy-iterator`, initially mislabeled a negative control: an exception from iterator cleanup replaced the original source exception. Local reproduction confirmed it. The grader and reference were corrected and the task reclassified. The model request, supplied files, tool implementations and fixture digest stayed unchanged. All final outputs were regraded under the corrected revision without additional model repair calls. The archive retains the original outcome beside the corrected outcome.

No final acceptance outcome changed after the corrected grader was applied.

The full batches had 2 invalid provider/protocol attempts:

- review: `122-repo-output-streams-baseline-r2`, Codex evaluation failed (1): Codex reported a failed turn or stream error. Retained separately and replaced by the first valid continuation attempt.
- editing: `181-browser-search-race-native-r3`, Codex evaluation failed (0): Codex reported a failed turn or stream error. Retained separately and replaced by the first valid continuation attempt.

Four pilot review trials were excluded before the full schedule. Continuations retained every valid pass and failure and ran only missing/invalid trials; none of the completed behavioral failures was retried. Parent manifests, all source epochs, retained result hashes and invalid-call metrics remain in the sanitized archive. The continuation counter records an operator intervention, not a blinded human review. All assessment reported here is agent inspection.

## Reproducibility and decisions

The [complete v2 archive](../evals/quality/results/2026-09-13-v2.json) contains all 384 selected outcomes, invalid attempts, prompt/source fingerprints, phase metrics, findings, per-case grades and 162 distinct final fixture variants as deduplicated text. Export reconstructed and graded every distinct variant in a fresh directory. It checked final-file hashes and refused duplicate valid trials or incomplete schedules. Portable source hashes tolerate Git's CRLF/LF checkout conversion while raw generation hashes remain preserved.

See the [protocol and replay commands](quality-evaluation.md) and the [evaluations page](https://tannermidd.github.io/SpecPi/evals/), which provides the catalog, tables, JSON and CSV. Raw provider traces, host paths and private state are excluded.

| Feature | Decision | Remaining evidence needed |
| --- | --- | --- |
| Explicit review skill | Keep manually selected | Human review burden and maintainability on real changes; this comparison does not justify an automatic review loop |
| Native Pi editor | Keep as the production editor | Realistic discovery and mutation workflows remain outside the adapter |
| Anchored editing | Keep uninstalled | Repeatable gains plus production Guard, scope, stale-file and transaction validation before promotion |
| Verification receipts and required checks | Keep observed-evidence gates and the reviewed fixes | Their overall model-quality effect was not measured by this supplied-context experiment |
| Selected editor context | Keep explicit previews and stale-buffer checks | Measure useful context and error reduction on real workspace tasks |
| Evaluation suite | Keep as a bounded regression screen | Broader real-repository tasks, blind holdouts and less prompt-explicit discovery; avoid interpreting saturated cases as equivalence |

## Earlier eight-task screen

The original [96-trial archive](../evals/quality/results/2026-09-13.json) and [original report at its recorded commit](https://github.com/TannerMidd/SpecPi/blob/00b952eefc6ebb40e884860cc1475d75cfe29ed0/docs/quality-results.md) remain separate. Both review conditions identified 21/21 seeded issues and left 3/3 intentional-interface controls unflagged; both editors passed 24/24 behavioral trials. Version 1 measured review findings, while version 2 measures review followed by repair. The results are not pooled.

This adapter supplies the complete task context and instructs native Codex tools off; it does not enforce adversarial read isolation or test full Pi conversations, long-running work, other languages, repository exploration or production editing safety. The independent runtime, installer, provider and editor regression suites remain release requirements, not evidence of a general accuracy gain.
