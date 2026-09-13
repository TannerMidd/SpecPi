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

### Independent model run through Pi

`scripts/openrouter-quality.mjs` adds a separate GLM 5.3 Flash experiment through Pi 0.84.4's provider runtime. It reuses the frozen version 2 task requests, fixtures, prompt builder, Pi native edit implementation, anchored buffer implementation and executable graders. It does not change the historical Codex archive or its fingerprints. GLM is from a different model family than the suite's author; this reduces author-model dependence but does not establish training-data independence or independently authored graders.

The profile is OpenRouter `z-ai/glm-5.3-flash`, a fixed allowlist of eight FP8 endpoints with provider failover, medium reasoning, a 16,384-token response limit, at most three edit responses, three repetitions and two concurrent trials. Review and editing conditions are interleaved for each task/repetition. Every response records its resolved provider. No native tools are registered. There is no Pi agent session, extension/resource discovery, local model configuration, settings load or session persistence. Pi's supported `ReadOnlyAuthStorage` supplies the existing login directly to its provider runtime; the adapter never extracts, copies or logs a credential. Synthetic credential fixtures cover the adapter tests.

The shared spending ledger reserves before each HTTP dispatch, includes pilots and retries, and refuses requests that could exceed $5 at the configured price limits. Routing allows provider failover within the FP8 allowlist and caps prices at $0.15 per million input tokens and $0.50 per million output tokens, with no per-request fee. Reservations use a conservative input bound and the full output limit, with 10% headroom. Successful responses settle against observed token counts and reported cost; interrupted requests retain their full reservation. A process lock prevents concurrent ledger writers. Do not remove reservations to make a run fit a budget.

An earlier cohort fixed routing to Morph FP8 and scheduled review before editing. Persistent upstream rate limits stopped it at 42 valid review trials, including 14 failures. Its complete observed evidence and generation sources are archived in `2026-09-13-glm-morph-interrupted.json`; the failures are preserved. The later failover profile is a separate cohort, with a new frozen schedule and source fingerprints. The cohorts are not pooled or used to claim a causal provider ranking. Changing routing after observing service failures is disclosed rather than presented as one uninterrupted preregistered experiment.

Only HTTP 429 and selected transient server failures receive up to three request attempts with backoff. Attempts remain in the evidence and ledger. Malformed JSON, completed refusals and output-limit responses count as model failures, including on correct controls. Incomplete provider streams remain separate; the first-trial-attempt pass counts include this service-availability limitation instead of hiding it behind a later successful restart. Hidden acceptance results never feed back into repair. A transport/evaluator error stops dispatch; `resume` preserves every valid pass and failure and allocates a new attempt directory for interrupted trials. It rejects changes to the source fingerprints, profile, runtime and schedule.

After explicitly authorizing provider spending, run:

```text
node scripts/openrouter-quality.mjs pilot .specpi-test/glm-routing-pilot .specpi-test/glm-budget.json .specpi-test/quality-v2-revised-qualification.json
node scripts/openrouter-quality.mjs full .specpi-test/glm-routing-full .specpi-test/glm-budget.json .specpi-test/quality-v2-revised-qualification.json
node scripts/openrouter-quality.mjs resume .specpi-test/glm-routing-full .specpi-test/glm-budget.json .specpi-test/quality-v2-revised-qualification.json
```

Use the same ledger for the complete experiment, including every pilot. `pilot` and `full` require new output directories; `resume` requires the existing full directory. The exporter requires all 384 valid outcomes, validates the retained final bytes and replays every distinct final variant before publication:

```text
node scripts/export-openrouter-quality.mjs .specpi-test/glm-routing-full .specpi-test/glm-budget.json evals/quality/results/2026-09-13-glm.json .specpi-test/glm-routing-pilot
node scripts/replay-openrouter-quality.mjs evals/quality/results/2026-09-13-glm.json
node scripts/build-evals-page.mjs evals/quality/results/2026-09-13-v2.json
```

Pass every excluded pilot directory to the exporter. An explicit `--partial` before the exporter arguments preserves an interrupted cohort and labels it incomplete; it cannot become the page's complete GLM comparison. The page builder adds the separate GLM archive when it exists. GLM and Codex use different provider adapters, system context and output budgets; compare the paired feature conditions within each model. A between-model score or timing difference is not a controlled model ranking. Provider routing can also affect outcomes, and resolved-provider observations do not attest to identical underlying serving implementations. These experiments do not make the grader an adversarial execution sandbox.

The review screen supplies the current defective implementation and requested behavior, without an original/proposed Git diff. This differs from the skill's intended use reviewing completed changes. Some GLM reviews interpreted the absent diff as a reason to report no findings. The recorded outcome still measures the subsequent repair, but this adapter should not be used alone to estimate the skill's effectiveness on real pull requests. A future frozen review benchmark should supply baseline and proposed changes and include plausible incomplete patches, with human-audited expectations.

A GLM `bounded-map` candidate returned a promise that never resolved. Node exited with status 13 after `oracle.started`; the replay driver initially called the missing final report an infrastructure error. The corrected classifier treats this drained-event-loop state as a behavioral failure. A targeted regression reproduces it. All 64 retained outcomes were regraded: 63 were unchanged and this one became a failure, without another model call. The original result, manifest and grader source remain in the archive alongside the correction and revised grader fingerprint. Task requests, supplied files, hidden assertions, prompts, model settings and the model-call implementation did not change. The historical Codex driver remains the frozen source for that earlier cohort; this correction applies to the replay/provider evaluation path.

Routing and error handling follow OpenRouter's [provider-selection](https://openrouter.ai/docs/guides/routing/provider-selection) and [rate-limit](https://openrouter.ai/docs/api/reference/limits) contracts. Prices and availability can change; the frozen request limits remain binding for this experiment.

### DeepSeek V4.1 Flash cohort

The additional `deepseek` profile selects `deepseek/deepseek-v4.1-flash`, the latest Flash release listed in OpenRouter's public catalog when checked on September 13, 2026 (released September 10). It uses the same 32 requests, fixtures, schemas, grading assertions, interleaved schedule and three repetitions per condition. High reasoning is explicitly requested, with the same 16,384-token response limit, three edit-response limit, two concurrent trials and 180-second request timeout. Reasoning settings are not calibrated across model families; GLM requested medium. This is another within-model feature comparison, not an equal-compute model ranking.

Only the DeepInfra, Morph and Parasail FP8 endpoints are eligible. Their public endpoint metadata lists structured-output support. Routing requires supported parameters, denies provider data collection and caps input at $0.30/M tokens and output at $1.20/M tokens. The adapter records the resolved serving provider. These route and price choices are frozen in the run manifest.

The user authorized the remainder of the original $5 cap. Reuse `.specpi-test/glm-budget.json`; do not create a fresh allowance. It already counted $1.440350 before DeepSeek, leaving $3.559650. New reservations record per-request rates, and previous GLM charges/reservations retain their original rates. All DeepSeek pilots and retries count toward the same cap.

```text
node scripts/openrouter-quality.mjs pilot .specpi-test/deepseek-pilot-3 .specpi-test/glm-budget.json .specpi-test/quality-v2-revised-qualification.json deepseek
node scripts/openrouter-quality.mjs full .specpi-test/deepseek-full .specpi-test/glm-budget.json .specpi-test/quality-v2-revised-qualification.json deepseek
node scripts/openrouter-quality.mjs resume .specpi-test/deepseek-full .specpi-test/glm-budget.json .specpi-test/quality-v2-revised-qualification.json deepseek
node scripts/export-openrouter-quality.mjs .specpi-test/deepseek-full .specpi-test/glm-budget.json evals/quality/results/2026-09-13-deepseek.json .specpi-test/deepseek-pilot .specpi-test/deepseek-pilot-2 .specpi-test/deepseek-pilot-3
node scripts/replay-openrouter-quality.mjs evals/quality/results/2026-09-13-deepseek.json
node scripts/build-evals-page.mjs evals/quality/results/2026-09-13-v2.json
```

The first two pilots stopped during usage accounting; both retain full reservations for their incomplete accounting records. The second exposed a completed 16,384-token response whose SSE metadata read failed. Setup changes recognize the SSE completion marker, raise the bounded framing allowance from 4 MiB to 32 MiB, and preserve numeric usage if billing metadata is missing. Synthetic regressions cover terminal markers, large framing and missing costs. The third pilot completed four valid trials: three passes and one output-limit failure. All pilots are excluded from the full cohort, with their manifests and costs retained. These setup changes do not alter the task prompts or graders, and a completed output-limit response counts as a behavioral failure.

During the full run, the user confirmed **$5 remaining**. At the next pause, 78 valid trials and six incomplete provider attempts were retained, and the shared ledger conservatively counted $2.474697. Its cumulative cap was explicitly amended to **$7.474697**, preserving every prior request charge. The manifest's `budgetAmendment` retains the original ledger, manifest, generation sources and all 84 result hashes. Only the adapter's CLI cap argument and manifest cap changed; task requests, schemas, model/routing/reasoning settings, response limits and graders stayed fixed. The runner still refuses a cap argument that differs from the existing ledger; it cannot silently increase the allowance.

After that recorded amendment, continuation uses the explicit cumulative cap:

```text
node scripts/openrouter-quality.mjs resume .specpi-test/deepseek-full .specpi-test/glm-budget.json .specpi-test/quality-v2-revised-qualification.json deepseek 7.474697
```

Primary references: [OpenRouter model details](https://openrouter.ai/deepseek/deepseek-v4.1-flash), [public endpoint metadata](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints), and [DeepSeek's documented reasoning controls](https://api-docs.deepseek.com/guides/thinking_mode/). The native DeepSeek documentation describes its earlier V4 models; the actual OpenRouter request and returned provider are recorded for this V4.1 experiment rather than assuming an undocumented cross-provider reasoning equivalence.

### Scope of the original Codex baseline

This is a supplied-context Codex adapter, not a complete Pi conversation or repository exploration benchmark. A fresh empty cwd reduces accidental exposure but does not confine all filesystem reads. Native tools are instructed off and detected use is rejected; this is not an adversarial isolation claim. Codex's system context, provider scheduling and hosted model behavior remain outside the fixture.

The suite does not measure long-running missions, all languages, native installed verification gates, language-server attachments, or real production mutation safety. The anchored buffer experiment has no demonstrated Command Guard or filesystem-transaction equivalence and remains uninstalled. Promotion requires relevant gains, no material regressions, manageable execution cost, human review and production-boundary validation.

The methodology draws on [Anthropic's guidance on outcomes, repeated trials and grader calibration](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), [SWE-bench's reproducible harness](https://www.swebench.com/SWE-bench/guides/quickstart/), and [Codex's documented JSONL and structured-output interfaces](https://learn.chatgpt.com/docs/non-interactive-mode). The reported scores belong only to this SpecPi suite.
