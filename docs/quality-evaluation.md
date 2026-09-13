# Quality evaluation

SpecPi's version 2 suite compares review-and-repair behavior and editing reliability on **32 JavaScript tasks: 8 easy, 12 medium and 12 hard**. It includes 4 unchanged negative controls, 3 Chromium browser flows and 4 mutations of frozen public SpecPi modules. These are curated tasks with explicit contracts, not a general coding-accuracy benchmark.

The earlier eight-task, 96-trial screen remains in `evals/quality/results/2026-09-13.json`. Its review-only findings metric differs from version 2's repaired-program outcome. Do not pool the two versions.

## What is compared

| Experiment | Baseline | Candidate | Primary outcome |
| --- | --- | --- | --- |
| Review then repair | Generic review, followed by a native-edit repair phase | Complete explicitly selected `specpi-review` skill, followed by the same repair phase | Hidden behavioral acceptance of the final files |
| Editing | Actual Pi 0.84.4 `edit` tool | Uninstalled snapshot-anchored edit prototype | Hidden behavioral acceptance of the final files |

Each experiment schedules 32 tasks × 3 repetitions × 2 conditions = 192 trials; both together schedule 384. Condition order alternates across task/repetition pairs. Each experiment admits at most two simultaneous trials. A review trial receives one review response and up to three edit responses. An editing trial receives up to three edit responses. Additional edit responses are allowed only after an edit rejection, not after hidden grading failure. The oracle never supplies repair feedback.

Findings are advisory inputs to the repair phase. A model can identify a problem yet produce a broken repair, or emit unnecessary findings about a correct control. Functional acceptance, controls changed/flagged, edit rejection/recovery counts, repeated-task consistency, latency and observed tokens are reported separately. Maintainability and finding precision require human assessment; finding count alone is not a quality score.

## Coverage and qualification

| Area | Examples |
| --- | --- |
| Boundaries and compatibility | Final pagination boundary, explicit zero, stable nonmutating sort, external formatter and hook interfaces |
| Text and parsing | CSV quoting and malformed input, UTF-8 byte tails, incremental CR/LF decoding, collision-free canonical keys |
| Concurrent state | In-flight cache invalidation, stale rejection after replacement, independent tenant/query identity, bounded worker dispatch |
| Cancellation and persistence | Cancellation around retry boundaries, drain-on-failure, mutate-then-throw writes, rollback error aggregation |
| Multi-file changes | Secondary caller migration, schema migration preserving unrelated data, paginated revision merging |
| Browser behavior | Reload persistence, stale search success/rejection, blank-query invalidation, failed storage writes and retry |
| Public SpecPi modules | Output stream decoding, slot admission with uncertain cleanup, live receipt freshness, command preview redaction |

`catalog.mjs` defines membership and difficulty. `tasks.mjs` retains the original fixtures; `challenge-tasks.mjs` adds authored cases; `repository-sources.json` freezes MIT-licensed source at commit `00b952eefc6ebb40e884860cc1475d75cfe29ed0`. Public-module cases inject specific regressions into those sources. They are not historical GitHub issue resolutions or independent repositories. Four tasks share some module context; repetitions and related tasks must not be treated as independent population samples.

The current qualification requires:

- All 28 defective seeds fail their grader.
- All 4 correct controls pass without repair.
- All 32 reference outcomes pass: 28 repairs and four unchanged controls.
- One deliberately incomplete repair or compatibility regression per task fails.
- The three browser graders exercise actual Chromium pages, including keyboard submission, reload, asynchronous response ordering and storage faults.

References, mutations and graders live outside the candidate workspace. Each fixture is materialized exclusively into a fresh directory. The qualification record binds the evaluator, tasks, references, graders, tests, pinned dependency declaration and review skill by SHA-256. The runner refuses an unqualified or changed source set. Qualification improves confidence in the graders; one wrong alternative per task does not prove exhaustive coverage. Reuse and broader maintainability judgments still need human review.

## Run with a Codex subscription

The selected provider is the user's Codex/ChatGPT subscription. The driver uses the supported CLI with `--ephemeral --ignore-user-config --sandbox read-only`, structured output, `gpt-6-astra` and medium reasoning. It strips API-key environment overrides. It does not read, copy or log authentication files. Sign in through Codex's supported login flow before running it; subscription availability and limits remain provider-controlled. No API price is inferred from subscription usage.

From the repository root, with the pinned development dependencies and locked Chromium runtime installed:

```text
node evals/quality/qualify.mjs .specpi-test/quality-v2-qualification.json
node evals/quality/run.mjs review .specpi-test/quality-v2-review
node evals/quality/run.mjs editing .specpi-test/quality-v2-editing
node scripts/export-quality-results.mjs evals/quality/results/new-v2.json .specpi-test/quality-v2-qualification.json .specpi-test/quality-v2-review .specpi-test/quality-v2-editing
node scripts/build-evals-page.mjs evals/quality/results/new-v2.json
```

Every destination must be new. `SPECPI_EVAL_CODEX` can select the reviewed CLI executable; `SPECPI_EVAL_QUALIFICATION` can select a fresh qualification record. Keep the model's `TEMP` directory outside the repository so its empty cwd does not inherit repository instructions. A positive optional third argument to `run.mjs` limits the schedule for a pilot. Pilots are labeled and cannot be exported as full results. The full comparisons can run alongside one another; together they admit four provider calls at most.

Raw results stay in ignored `.specpi-test/` directories. Each trial retains structured responses, phase labels, source/prompt hashes, usage, elapsed time, edit results, grader results and final fixture hashes. A native external tool event invalidates a controlled trial and stops further scheduling; reasoning and plan items are not misclassified as external tools. JSONL is parsed incrementally so a long final response cannot erase an earlier tool event. Malformed/incomplete streams and provider errors are infrastructure failures, not behavioral failures.

A missing browser runtime fails preflight. A candidate that starts grading but exceeds its 30-second execution budget fails behavioral acceptance. Model-response deadlines and missing structured grader results are reported separately. Do not silently retry invalid trials, discard failures or select the best repetition. Preserve an interrupted batch, resolve the cause and declare any replacement run and exclusions.

## Recorded correction and continuation

The first full batches stopped on provider stream errors. Their directories remain unchanged. A continuation runs only missing or invalid trials, retaining every completed pass and failure. It checks task digests, generation source compatibility, CLI/runtime versions and budgets, and records parent manifest hashes, retained result hashes and exclusions. Pass previous continuation directories as additional arguments if another infrastructure interruption occurs. Never rerun a valid failure to obtain a better score.

During review of the first outputs, both review conditions identified an actual exception-preservation defect in `lazy-iterator`: a failing cleanup masked a source failure. A local reproduction confirmed it. The original grader missed that case and mislabeled the task a negative control. The corrected suite has 28 repair tasks and 4 controls. Its requests, supplied files and fixture hashes are unchanged. Reference and grader checks now cover source/cleanup errors, getters and falsy thrown values. All final outputs are regraded equally under revision 2, with original outcomes preserved; this correction was made after observing findings and is disclosed rather than described as fully preregistered.

`scripts/resume-quality-evaluation.mjs <original-batch> <new-directory> <current-qualification.json> [prior-continuation ...]` requires a fresh qualification after the correction. Include both originals and every continuation directory in the exporter arguments. The exporter rejects duplicate valid attempts and an incomplete final schedule. It reconstructs and grades each distinct final fixture in a new temporary directory, without additional model calls. Pilot trials and invalid attempts remain separate from the 384 selected behavioral outcomes.

## Results and GitHub Pages

The public archive stores sanitized metrics and findings, per-case grader outcomes, complete configuration/source fingerprints, and deduplicated final fixture text keyed by SHA-256. The exporter checks the declared schedule, fixture digests and final file hashes against retained evidence and rejects incomplete combined schedules or pilot batches. Host paths, raw provider traces and credentials are excluded. Raw source hashes preserve the run-time bytes; normalized text hashes permit replay across Git CRLF/LF checkout settings. Correction and maintainability assessments are agent inspection, not a blinded human review. The Pages builder produces a static, filterable task catalog, aggregate and difficulty-stratified paired results, JSON evidence and CSV trial metrics. Without JavaScript, the entire table is still visible.

Verify generated output with:

```text
node scripts/build-evals-page.mjs evals/quality/results/2026-09-13-v2.json --check
node scripts/replay-quality-results.mjs evals/quality/results/2026-09-13-v2.json
```

Report candidate-only passes, baseline-only passes, both-pass and both-fail pairs. Also report tasks passing all three repetitions, invalid/missing pairs, edit recovery, latency, and the availability of token fields. Missing token fields remain null. No population confidence interval is claimed: these tasks are curated, repetitions are correlated, and difficulty labels may still saturate on a strong model.

See the [results and adoption decisions](quality-results.md) and the [public evaluations page](https://tannermidd.github.io/SpecPi/evals/). Deterministic installer, command-guard, verification, workflow and editor-context tests remain a separate release requirement; they do not demonstrate a model-quality improvement.

## Interpretation limits

This is a supplied-context Codex adapter, not a complete Pi conversation or repository exploration benchmark. A fresh empty cwd reduces accidental exposure but does not confine all filesystem reads. Native tools are instructed off and detected use is rejected; this is not an adversarial isolation claim. Codex's system context, provider scheduling and hosted model behavior remain outside the fixture.

The suite does not measure long-running missions, all languages, native installed verification gates, language-server attachments, or real production mutation safety. The anchored buffer experiment has no demonstrated Command Guard or filesystem-transaction equivalence and remains uninstalled. Promotion requires relevant gains, no material regressions, manageable execution cost, human review and production-boundary validation.

The methodology draws on [Anthropic's guidance on outcomes, repeated trials and grader calibration](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), [SWE-bench's reproducible harness](https://www.swebench.com/SWE-bench/guides/quickstart/), and [Codex's documented JSONL and structured-output interfaces](https://learn.chatgpt.com/docs/non-interactive-mode). The reported scores belong only to this SpecPi suite.
