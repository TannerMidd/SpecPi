import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tasks, suiteVersion } from "../evals/quality/catalog.mjs";
import { aggregateQuality } from "./quality-results.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = path.join(root, "site/evals");
const escape = (value) =>
    String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const names = {
    baseline: "Generic review + repair",
    skill: "SpecPi review + repair",
    native: "Pi native editing",
    anchored: "Anchored experiment",
};
const title = (id) =>
    id
        .replace(/^repo-/u, "SpecPi: ")
        .replaceAll("-", " ")
        .replace(/^./u, (letter) => letter.toUpperCase());
const csv = (value) => '"' + String(value ?? "").replaceAll('"', '""') + '"';

function trialCsv(data) {
    const providerColumns = ["openrouter-glm", "openrouter-deepseek"].includes(data.providerExperiment);
    const fields = [
        "task",
        "difficulty",
        "negativeControl",
        "experiment",
        "condition",
        "repetition",
        "acceptance",
        "editRounds",
        "editRejections",
        "modelMs",
        "inputTokens",
        "outputTokens",
        ...(providerColumns ? ["trialAttempt", "servingProviders", "modelFailure"] : []),
    ];
    const catalog = Object.fromEntries(data.catalog.map((task) => [task.id, task]));

    return (
        [
            fields.join(","),
            ...data.runs.map((run) => {
                const total = (key) =>
                    run.calls.every((call) => Number.isFinite(call.usage?.[key]))
                        ? run.calls.reduce((sum, call) => sum + call.usage[key], 0)
                        : "";

                return [
                    run.task,
                    catalog[run.task].difficulty,
                    catalog[run.task].negativeControl,
                    run.experiment,
                    run.condition,
                    run.repetition,
                    run.acceptance,
                    run.editRounds,
                    run.editRejections,
                    run.calls.reduce((sum, call) => sum + call.elapsedMs, 0),
                    total("input_tokens"),
                    total("output_tokens"),
                    ...(providerColumns
                        ? [
                              run.attempt,
                              [...new Set(run.calls.map((call) => call.metadata?.provider).filter(Boolean))].join("; "),
                              Boolean(run.modelFailure),
                          ]
                        : []),
                ]
                    .map(csv)
                    .join(",");
            }),
        ].join("\n") + "\n"
    );
}

export function renderIndependentResults(data) {
    if (!data) {
        return "";
    }

    const deepseek = data.providerExperiment === "openrouter-deepseek";
    const family = deepseek ? "DeepSeek" : "GLM";
    const modelName = deepseek ? "DeepSeek V4.1 Flash" : "GLM 5.3 Flash";
    const sectionId = deepseek ? "deepseek" : "independent";
    const slug = deepseek ? "deepseek" : "glm";
    const summary = aggregateQuality(data.runs, data.catalog);
    const firstPass = (condition) =>
        data.runs.filter((run) => run.condition === condition && run.attempt === 1 && run.acceptance === "passed")
            .length;
    const providers = [
        ...new Set(data.runs.flatMap((run) => run.calls.map((call) => call.metadata?.provider)).filter(Boolean)),
    ].sort();
    const scores = Object.entries(summary)
        .flatMap(([experiment, result]) =>
            Object.entries(result.conditions).map(
                ([condition, value]) =>
                    `<tr><th scope="row">${names[condition]}<small>${experiment === "review" ? "Review then repair" : "Editing comparison"}</small></th><td>${value.passed} / ${value.valid}</td><td>${firstPass(condition)} / ${value.valid}</td><td>${value.tasksPassedEveryRepeat} / ${data.catalog.length}</td><td>${(value.medianModelMs / 1000).toFixed(1)} s</td><td>${value.editRejections}</td></tr>`,
            ),
        )
        .join("");
    const pairs = Object.entries(summary)
        .flatMap(([experiment, result]) =>
            [["All tasks", result.paired], ...Object.entries(result.difficulty)].map(
                ([difficulty, value]) =>
                    `<tr><th scope="row">${experiment === "review" ? "Review skill" : "Anchored editing"}<small>${escape(difficulty)}</small></th><td>${value.candidateOnly}</td><td>${value.baselineOnly}</td><td>${value.bothPassed}</td><td>${value.bothFailed}</td></tr>`,
            ),
        )
        .join("");
    const rows = data.catalog
        .map((task) => {
            const score = (condition) => {
                const runs = data.runs.filter((run) => run.task === task.id && run.condition === condition);

                return `${runs.filter((run) => run.acceptance === "passed").length} / ${runs.length}`;
            };

            return `<tr><th scope="row">${escape(title(task.id))}</th><td>${escape(task.difficulty)}</td>${["baseline", "skill", "native", "anchored"].map((condition) => `<td>${score(condition)}</td>`).join("")}</tr>`;
        })
        .join("");
    const retries = data.runs.reduce(
        (sum, run) => sum + run.calls.reduce((n, call) => n + (call.priorAttempts?.length ?? 0), 0),
        0,
    );
    const responseFailures = (condition) =>
        data.runs.filter((run) => run.condition === condition && run.modelFailure).length;
    const mixedReviewPairs = data.runs.filter((run) => {
        if (run.condition !== "baseline") {
            return false;
        }

        const candidate = data.runs.find(
            (other) => other.condition === "skill" && other.task === run.task && other.repetition === run.repetition,
        );

        return candidate && new Set([...run.calls, ...candidate.calls].map((call) => call.metadata?.provider)).size > 1;
    }).length;

    return `<section id="${sectionId}" class="eval-section" aria-labelledby="${sectionId}-title"><p class="eval-eyebrow">INDEPENDENT MODEL / SAME TASKS</p><h2 id="${sectionId}-title">${modelName}</h2>
<p><strong>Provider:</strong> OpenRouter. <strong>Routing:</strong> ${escape(data.manifest.settings.providerName)}. <strong>Adapter:</strong> Pi ${escape(data.manifest.piVersion)} ModelRuntime. <strong>Reasoning:</strong> ${escape(data.manifest.settings.reasoning)}, with a 16,384-token response limit.</p>
<p>This model family did not help author the suite. These 384 trials use the same frozen 32 task requests and source fixtures, with documented grading corrections. Each ${family} condition uses the same provider adapter; the earlier Codex baseline uses different system context and transport. Compare the paired interventions within each model, rather than treating separate cohorts as a controlled model ranking.</p>
${deepseek ? '<p class="eval-note">DeepSeek requested high reasoning; GLM requested medium. Model cohorts keep their own settings and results. This is a feature comparison within each model, not an equal-compute model ranking.</p>' : ""}
${data.manifest.budgetAmendment ? `<p class="eval-note"><strong>Budget amendment:</strong> After ${data.manifest.budgetAmendment.validTrialsRetained} valid trials, the user confirmed $${data.manifest.budgetAmendment.authorizedRemainingUsd.toFixed(2)} remaining. The shared cap became $${data.manifest.budgetAmendment.newCapUsd.toFixed(6)}. The JSON retains the prior ledger, manifest, generation sources and result hashes. Tasks, model settings and grading stayed fixed.</p>` : ""}
${data.manifest.gradingCorrection ? '<p class="eval-note"><strong>Grading correction:</strong> A candidate promise that never resolved exposed an early-exit classification bug. Node exit 13 after grading starts now counts as a behavioral failure. All 64 retained outcomes were checked: 63 stayed unchanged and that one case became a failure. Its original record and manifest remain in the JSON; no new model response was generated for the correction.</p>' : ""}
<div class="eval-table-scroll" role="region" aria-label="${family} condition results" tabindex="0"><table><caption>${family} behavioral acceptance and first-attempt reliability</caption><thead><tr><th scope="col">Condition</th><th scope="col">Passes / valid trials</th><th scope="col">First trial attempt passes</th><th scope="col">Tasks passing all 3</th><th scope="col">Median model time</th><th scope="col">Edit rejections</th></tr></thead><tbody>${scores}</tbody></table></div>
<p class="eval-note">First-attempt counts include service availability: a trial that required a restart does not count as a first-attempt pass. Bounded request retries remain part of each attempt. Observed serving providers: ${providers.map(escape).join(", ")}.</p>
<div class="eval-table-scroll" role="region" aria-label="${family} paired changes" tabindex="0"><table><caption>Matched ${family} task/repetition pairs</caption><thead><tr><th scope="col">Comparison / difficulty</th><th scope="col">Candidate only passes</th><th scope="col">Baseline only passes</th><th scope="col">Both pass</th><th scope="col">Both fail</th></tr></thead><tbody>${pairs}</tbody></table></div>
<p class="eval-note">${retries} recovered transport attempts and ${data.invalidAttempts.length} excluded trial attempts are retained. ${data.runs.filter((run) => run.modelFailure).length} trials failed because of a refusal, malformed response or output limit; these count in the scores. Incomplete provider responses remain separate. Median time covers valid trials, including their backoff and provider scheduling; no valid behavioral failure was rerun.</p>
${deepseek ? `<p class="eval-note"><strong>Review interpretation:</strong> Generic review had ${responseFailures("baseline")} response-contract failures and ${summary.review.conditions.baseline.failed - responseFailures("baseline")} code failures; the review skill had ${responseFailures("skill")} and ${summary.review.conditions.skill.failed - responseFailures("skill")}, respectively. ${mixedReviewPairs} of 96 review pairs involved multiple serving providers. The score difference does not isolate a semantic improvement from the skill. Review remains explicitly selected; a follow-up should control the provider and supply actual proposed patches.</p>` : ""}
<p><strong>${deepseek ? "Shared GLM + DeepSeek spending" : "Spending"}:</strong> $${data.budget.reportedCostUsd.toFixed(4)} reported by OpenRouter; $${data.budget.conservativeChargeUsd.toFixed(4)} conservatively counted against the $${data.budget.capMicros / 1e6} cap, including ${deepseek ? "the earlier GLM experiments, DeepSeek pilots and" : "setup pilots, the interrupted fixed-endpoint cohort and"} unresolved request reservations.</p>
<details class="eval-history"><summary>${family} scores for all 32 tasks</summary><div class="eval-table-scroll" role="region" aria-label="${family} task scores" tabindex="0"><table><caption>${family} passes / valid trials by task</caption><thead><tr><th scope="col">Task</th><th scope="col">Difficulty</th><th scope="col">Generic + repair</th><th scope="col">Skill + repair</th><th scope="col">Native</th><th scope="col">Anchored</th></tr></thead><tbody>${rows}</tbody></table></div></details>
<div class="eval-downloads"><a href="./${slug}-results.json" download>Download ${family} evidence (JSON)</a><a href="./${slug}-trials.csv" download>Download ${family} trial metrics (CSV)</a></div>
<p class="eval-note">The review stage receives an implementation and requested behavior without a proposed Git diff, while the review skill is intended for reviewing changes. This limits what the review comparison establishes about real pull requests. A future frozen evaluation should supply proposed patches and independently audited expectations.</p>
<p class="eval-note">Using another model reduces author-model dependence. It does not prove the tasks are absent from training data or replace independent human review of the graders.</p></section>`;
}

export function renderInterruptedResults(data) {
    if (!data) {
        return "";
    }

    const summary = aggregateQuality(data.runs, data.catalog);
    const rows = Object.values(summary)
        .flatMap((result) =>
            Object.entries(result.conditions)
                .filter(([, value]) => value.valid > 0)
                .map(
                    ([condition, value]) =>
                        `<tr><th scope="row">${names[condition]}</th><td>${value.passed} / ${value.valid}</td><td>${value.failed}</td></tr>`,
                ),
        )
        .join("");

    return `<section id="glm-interrupted" class="eval-section" aria-labelledby="glm-interrupted-title"><h2 id="glm-interrupted-title">Earlier fixed-endpoint cohort</h2><p>The fixed Morph FP8 cohort stopped after ${data.runs.length} valid trials out of 384 planned because of persistent upstream rate limits. It contains ${data.runs.filter((run) => run.acceptance === "failed").length} behavioral failures and ${data.invalidAttempts.length} excluded trial attempts. Its observed outcomes are preserved separately from the later failover cohort; it did not reach the editing comparison.</p><details class="eval-history"><summary>Inspect the interrupted Morph cohort</summary><div class="eval-table-scroll" role="region" aria-label="Interrupted Morph outcomes" tabindex="0"><table><caption>Observed outcomes from the incomplete schedule</caption><thead><tr><th scope="col">Condition</th><th scope="col">Passes / valid trials</th><th scope="col">Failed trials</th></tr></thead><tbody>${rows}</tbody></table></div><p>No valid behavioral failure was retried within this cohort. The later cohort changed the routing policy and interleaved experiments; it is a separate experiment, and the two cohorts are not pooled.</p><a href="./glm-morph-interrupted.json" download>Download interrupted Morph evidence (JSON)</a></details></section>`;
}

export function renderEvalsPage(data, independent = null, interrupted = null, deepseek = null) {
    const catalog =
        data?.catalog ??
        tasks.map((task) => ({
            ...task,
            files: Object.keys(task.files),
            negativeControl: task.category === "negative-control",
        }));
    const summary = data ? aggregateQuality(data.runs, catalog) : null;
    const score = (task, experiment, condition) => {
        if (!data) {
            return "Pending";
        }

        const runs = data.runs.filter(
            (run) =>
                run.task === task.id &&
                run.experiment === experiment &&
                run.condition === condition &&
                !run.error &&
                ["passed", "failed"].includes(run.acceptance),
        );

        return `${runs.filter((run) => run.acceptance === "passed").length} / ${runs.length}`;
    };

    const results = summary
        ? `<div class="eval-table-scroll" role="region" aria-label="Condition results" tabindex="0"><table><caption>Behavioral acceptance and execution cost</caption><thead><tr><th scope="col">Condition</th><th scope="col">Passes / valid trials</th><th scope="col">Tasks passing all 3</th><th scope="col">Median model time</th><th scope="col">Edit rejections</th></tr></thead><tbody>${Object.entries(
              summary,
          )
              .flatMap(([experiment, result]) =>
                  Object.entries(result.conditions).map(
                      ([condition, value]) =>
                          `<tr><th scope="row">${names[condition]}<small>${experiment === "review" ? "Review then repair" : "Editing comparison"}</small></th><td>${value.passed} / ${value.valid}</td><td>${value.tasksPassedEveryRepeat} / ${catalog.length}</td><td>${(value.medianModelMs / 1000).toFixed(1)} s</td><td>${value.editRejections}</td></tr>`,
                  ),
              )
              .join("")}</tbody></table></div>
<p class="eval-note">Model time sums response time within a trial; it includes provider scheduling and excludes grading. Two trials run concurrently per experiment. Dollar cost is unavailable for subscription runs.</p>
<div class="eval-table-scroll" role="region" aria-label="Paired changes" tabindex="0"><table><caption>What changed within matched task/repetition pairs</caption><thead><tr><th scope="col">Comparison / difficulty</th><th scope="col">Candidate only passes</th><th scope="col">Baseline only passes</th><th scope="col">Both pass</th><th scope="col">Both fail</th></tr></thead><tbody>${Object.entries(
              summary,
          )
              .flatMap(([experiment, result]) =>
                  [["All tasks", result.paired], ...Object.entries(result.difficulty)].map(
                      ([difficulty, pair]) =>
                          `<tr><th scope="row">${experiment === "review" ? "Review skill" : "Anchored editing"}<small>${escape(difficulty)}</small></th><td>${pair.candidateOnly}</td><td>${pair.baselineOnly}</td><td>${pair.bothPassed}</td><td>${pair.bothFailed}</td></tr>`,
                  ),
              )
              .join("")}</tbody></table></div>
<p class="eval-note">The candidate is the review skill or anchored editor. A candidate-only pass is a measured gain; a baseline-only pass is a regression in that pair. These are descriptive counts on a curated suite, with three correlated trials per task.</p>
<p>${data.invalidAttempts.length} excluded infrastructure/protocol attempts and ${Object.values(summary).reduce((sum, result) => sum + Object.values(result.conditions).reduce((n, value) => n + value.nativeToolEvents, 0), 0)} native external tool events across the selected trials. Invalid attempts retain separate metrics in the JSON; four pilot trials are also excluded. No completed behavioral failure was rerun.</p>`
        : `<p class="eval-callout">The expanded suite is qualified and its model runs are in progress. No version 2 outcome is published yet. The task catalog below describes coverage, not model performance.</p>`;
    const rows = catalog
        .map(
            (task) =>
                `<tr data-eval-task="${escape(task.id)}" data-difficulty="${task.difficulty}" data-control="${task.negativeControl ? "yes" : "no"}" data-search="${escape(`${task.id} ${task.category} ${task.domain ?? ""}`)}"><th scope="row"><a href="https://github.com/TannerMidd/SpecPi/tree/main/evals/quality">${escape(title(task.id))}</a><small>${escape(task.category)}${task.negativeControl ? " · negative control" : ""}</small></th><td>${task.difficulty}</td><td>${task.files.length} file${task.files.length === 1 ? "" : "s"}${task.provenance?.kind === "public-module-mutation" ? "<small>Public SpecPi module</small>" : "<small>Authored fixture</small>"}</td><td>${score(task, "review", "baseline")}</td><td>${score(task, "review", "skill")}</td><td>${score(task, "editing", "native")}</td><td>${score(task, "editing", "anchored")}</td></tr>`,
        )
        .join("\n");

    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><script src="../theme.js"></script><meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#fafbfc" /><meta name="description" content="SpecPi quality evaluations: a mixed-difficulty task catalog, paired comparisons, reproducible evidence and explicit limitations." />
<meta property="og:title" content="Evaluations · SpecPi" /><meta property="og:description" content="Behavioral results, paired comparisons and the evidence behind quality decisions." /><meta property="og:type" content="article" /><meta property="og:url" content="https://tannermidd.github.io/SpecPi/evals/" />
<meta name="twitter:card" content="summary" /><link rel="canonical" href="https://tannermidd.github.io/SpecPi/evals/" /><link rel="icon" href="../logo.svg" type="image/svg+xml" />
<link rel="stylesheet" href="../styles.css" /><link rel="stylesheet" href="./evals.css" /><script type="module" src="./evals.js"></script><title>Evaluations · SpecPi</title>
</head><body class="evals-page">
<a class="skip-link" href="#evaluations">Skip to evaluations</a>
<header class="site-header wrap"><a class="brand" href="../" aria-label="SpecPi home"><img src="../logo.svg" width="32" height="32" alt="" /><strong>SpecPi</strong></a>
<nav class="header-nav" aria-label="Primary navigation"><a href="../why-pi/">Why Pi?</a><a href="../#install">Install</a><a href="../#vscode-chat">VS Code</a><a href="../single-agent/">Research</a><a href="./" aria-current="page">Evals</a><a href="../wiki/">Docs</a><a href="https://github.com/TannerMidd/SpecPi">GitHub</a></nav>
<button class="theme-toggle" type="button" aria-label="Dark mode" aria-pressed="false" hidden>Dark mode</button></header>
<main id="evaluations" class="wrap">
<header class="eval-heading"><p class="eval-eyebrow">QUALITY EVIDENCE / SUITE ${suiteVersion}</p><h1>Evaluations</h1><p class="eval-deck">Test whether a change improves the work. Keep the result, the method, and the limits visible.</p><p>Paired comparisons on JavaScript tasks, from boundary fixes to concurrent state changes and browser flows. These results measure the tested behaviors; they are not a general coding-accuracy score.</p></header>
<dl class="eval-stats"><div><dt>Distinct tasks</dt><dd>${catalog.length}</dd></div><div><dt>${independent ? "Trials per model" : data ? "Completed trials" : "Scheduled trials"}</dt><dd>${data?.runs.length ?? catalog.length * 12}</dd></div><div><dt>Negative controls</dt><dd>${catalog.filter((task) => task.negativeControl).length}</dd></div><div><dt>Trials per condition/task</dt><dd>3</dd></div></dl>
<nav class="eval-jump" aria-label="Evaluation sections"><a href="#results">Codex baseline</a>${independent ? '<a href="#independent">GLM comparison</a>' : ""}${deepseek ? '<a href="#deepseek">DeepSeek comparison</a>' : ""}<a href="#coverage">Task catalog</a><a href="#method">Method</a><a href="#limits">Limits</a><a href="#evidence">Evidence</a></nav>
<section id="results" class="eval-section" aria-labelledby="results-title"><p class="eval-eyebrow">01 / OUTCOMES</p><h2 id="results-title">Codex baseline</h2><p><strong>Model:</strong> gpt-6-astra, medium reasoning. <strong>Provider:</strong> Codex CLI / ChatGPT subscription. <strong>Editor:</strong> Pi 0.84.4 or the uninstalled anchored experiment.</p>${results}
<aside class="eval-callout"><strong>Promotion is a separate decision.</strong> Anchored editing remains uninstalled. This adapter does not establish production editing safety or Command Guard equivalence. The review skill remains explicitly selected; successful tests do not replace human review.</aside></section>
${renderIndependentResults(independent)}
${renderIndependentResults(deepseek)}
${renderInterruptedResults(interrupted)}
<section id="coverage" class="eval-section" aria-labelledby="coverage-title"><p class="eval-eyebrow">02 / COVERAGE</p><h2 id="coverage-title">A mix of easy and difficult work</h2>
<div class="eval-tiers">${["easy", "medium", "hard"].map((difficulty) => `<div><strong>${catalog.filter((task) => task.difficulty === difficulty).length}</strong><span>${difficulty}</span><p>${difficulty === "easy" ? "Boundaries, values, byte limits and compatibility." : difficulty === "medium" ? "Parsing, migrations, state transitions and browser persistence." : "Concurrency, cancellation, rollback, stream boundaries and public modules."}</p></div>`).join("")}</div>
<p>Difficulty is a design label, not a calibrated model ranking. Four controls start correct: changing them requires a concrete reason. Four cases use frozen public SpecPi modules with seeded regressions; they are not historical issue-resolution benchmarks.</p>
<form class="eval-filters" data-eval-filters hidden><label><span id="eval-difficulty-label">Difficulty</span><select name="difficulty" aria-labelledby="eval-difficulty-label"><option value="all">All difficulties</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></label><label><span id="eval-type-label">Task type</span><select name="control" aria-labelledby="eval-type-label"><option value="all">All tasks</option><option value="yes">Negative controls</option><option value="no">Repair tasks</option></select></label><label>Find a task<input name="search" type="search" placeholder="e.g. cache or browser" /></label><button type="reset">Reset filters</button></form>
<p data-eval-count class="eval-note" role="status">Showing ${catalog.length} of ${catalog.length} tasks.</p>
<div class="eval-table-scroll" role="region" aria-label="Task catalog and condition scores" tabindex="0"><table class="eval-catalog"><caption>Passes / valid trials for each task and condition${data ? "" : " — results pending"}</caption><thead><tr><th scope="col">Task / category</th><th scope="col">Difficulty</th><th scope="col">Context</th><th scope="col">Generic + repair</th><th scope="col">Skill + repair</th><th scope="col">Native</th><th scope="col">Anchored</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="eval-note">These catalog scores describe the Codex baseline. All rows remain readable with JavaScript disabled. Source files, requirements and per-trial evidence are available below.</p></section>
<section id="method" class="eval-section" aria-labelledby="method-title"><p class="eval-eyebrow">03 / METHOD</p><h2 id="method-title">Compare one intervention at a time</h2>
<div class="eval-method-grid"><div><h3>Review, then repair</h3><p>Generic review and the complete SpecPi review skill each receive the same request and files. Each review feeds a matched repair phase using Pi's native edit tool. The primary outcome is the repaired program's behavior, not how many findings a model claims.</p></div><div><h3>Native versus anchored edits</h3><p>Both editing conditions receive the same task and file content. The anchored condition also receives line numbers and content digests. Each gets up to three edit responses; retries receive edit rejection details, never hidden acceptance feedback.</p></div><div><h3>Qualify and audit the graders</h3><p>All 28 seeded failures must fail, all 4 unchanged controls must pass, and all 32 reference outcomes must pass (28 repairs and four unchanged controls). A deliberately incomplete repair or compatibility regression must fail for every task. Three browser tasks run in Chromium.</p></div><div><h3>Keep the comparison traceable</h3><p>Every task runs three times per condition. Pair order is counterbalanced. Fresh fixtures, source and prompt hashes, CLI/model versions, token observations, edit outcomes and final file digests are retained. Invalid runs stop a batch and are not counted as behavioral failures.</p></div></div>
<p class="eval-note"><strong>Grader correction:</strong> Model findings exposed an exception-preservation defect in a task initially labeled a correct control. The request and source stayed unchanged; the task was reclassified and missing checks were added. Every final output was graded with the corrected oracle. The archive retains original outcomes, correction details and interrupted-batch provenance.</p>
<p>This method uses final-state checks, repeat trials and explicit grading limits, informed by <a href="https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents">Anthropic's agent-evaluation guidance</a> and <a href="https://www.swebench.com/SWE-bench/guides/quickstart/">SWE-bench's reproducible evaluation harness</a>. SpecPi's suite is its own bounded evaluation, not a result on either project's benchmark.</p></section>
<section id="limits" class="eval-section" aria-labelledby="limits-title"><p class="eval-eyebrow">04 / INTERPRETATION</p><h2 id="limits-title">What this evidence can establish</h2>
<ul class="eval-limits"><li><strong>Behavioral acceptance has a defined scope.</strong> Hidden checks cover selected requirements and regressions. Maintainability, review-finding precision and broader requirement coverage still need human assessment.</li><li><strong>Context is supplied.</strong> These are supplied-context response adapters. They do not measure full Pi sessions, repository exploration, long-running work, installed verification gates, VS Code context attachments, or other programming languages.</li><li><strong>Fresh directories reduce accidental exposure.</strong> They do not restrict all reads. Native external tools are instructed off and detected use invalidates the controlled protocol; this is not an adversarial isolation benchmark.</li><li><strong>Repeated trials share a task.</strong> Three attempts are not three independent tasks. Paired counts and consistency describe this curated suite; no population confidence interval or general accuracy claim is made.</li><li><strong>Runtime regressions are another layer.</strong> SpecPi separately tests installer transactions, command admission, receipt freshness, workflow gates and editor attachments. Those deterministic tests do not demonstrate a model-quality gain.</li></ul></section>
<section id="evidence" class="eval-section" aria-labelledby="evidence-title"><p class="eval-eyebrow">05 / REPRODUCIBILITY</p><h2 id="evidence-title">Inspect the evidence</h2>
${data ? `<div class="eval-downloads"><a href="./results.json" download>Download complete v2 evidence (JSON)</a><a href="./trials.csv" download>Download trial metrics (CSV)</a></div><p>The JSON contains sanitized run metrics, findings, graders' outcomes, source/prompt hashes and deduplicated final fixture text. It excludes host paths, credentials and raw provider traces. All source fixtures are authored or public repository material.</p>` : `<p>The complete version 2 evidence will be added after the fixed run schedule completes.</p>`}
<p><a href="https://github.com/TannerMidd/SpecPi/tree/main/evals/quality">Suite source and independent graders</a> · <a href="https://github.com/TannerMidd/SpecPi/blob/main/docs/quality-evaluation.md">Run and interpret the evaluation</a> · <a href="https://github.com/TannerMidd/SpecPi/blob/main/docs/quality-results.md">Results and adoption decisions</a></p>
<details class="eval-history"><summary>Earlier evidence: the initial eight-task screen</summary><p>The September 13, 2026 screen contained 96 trials: 48 review-only and 48 editing trials. Each review condition found all 21 seeded issue cases and left three intentional-interface controls unflagged. Each editor passed 24 of 24 behavioral checks. That small suite was saturated. Its review-only metric differs from version 2's review-and-repair outcome, so the results are not pooled.</p><a href="https://github.com/TannerMidd/SpecPi/blob/00b952eefc6ebb40e884860cc1475d75cfe29ed0/evals/quality/results/2026-09-13.json">Original 96-trial result archive at its recorded commit</a></details>
</section></main>
<footer class="site-footer wrap"><a class="brand" href="../"><img src="../logo.svg" width="28" height="28" alt="" /><strong>SpecPi</strong></a><p>Evidence before adoption.</p><nav aria-label="Footer navigation"><a href="../wiki/">Documentation</a><a href="https://github.com/TannerMidd/SpecPi/blob/main/SECURITY.md">Security</a><a href="https://github.com/TannerMidd/SpecPi/blob/main/LICENSE">MIT</a></nav></footer>
</body></html>\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [input, option] = process.argv.slice(2);
    if (!input || (option && option !== "--check")) {
        throw new Error("Usage: node scripts/build-evals-page.mjs <public-results.json|--draft> [--check]");
    }

    const data = input === "--draft" ? null : JSON.parse(fs.readFileSync(input, "utf8"));
    if (data && (data.schema !== 2 || data.suiteVersion !== suiteVersion || data.runs.length !== 384)) {
        throw new Error("Evals page requires the complete version 2 archive.");
    }

    const independentPath = path.join(root, "evals/quality/results/2026-09-13-glm.json");
    const independent =
        data && fs.existsSync(independentPath) ? JSON.parse(fs.readFileSync(independentPath, "utf8")) : null;
    if (
        independent &&
        (independent.providerExperiment !== "openrouter-glm" ||
            independent.suiteVersion !== suiteVersion ||
            independent.runs.length !== 384 ||
            independent.runs.some((run) => run.error))
    ) {
        throw new Error("Independent results require a complete GLM archive.");
    }

    const interruptedPath = path.join(root, "evals/quality/results/2026-09-13-glm-morph-interrupted.json");
    const interrupted =
        data && fs.existsSync(interruptedPath) ? JSON.parse(fs.readFileSync(interruptedPath, "utf8")) : null;
    if (interrupted && interrupted.cohortStatus !== "interrupted") {
        throw new Error("Expected the explicitly interrupted Morph archive.");
    }

    const deepseekPath = path.join(root, "evals/quality/results/2026-09-13-deepseek.json");
    const deepseek = data && fs.existsSync(deepseekPath) ? JSON.parse(fs.readFileSync(deepseekPath, "utf8")) : null;
    if (
        deepseek &&
        (deepseek.providerExperiment !== "openrouter-deepseek" ||
            deepseek.suiteVersion !== suiteVersion ||
            deepseek.cohortStatus !== "complete" ||
            deepseek.runs.length !== 384 ||
            deepseek.runs.some((run) => run.error))
    ) {
        throw new Error("DeepSeek results require a complete archive.");
    }

    const html = renderEvalsPage(data, independent, interrupted, deepseek);
    const artifacts = { "index.html": html };
    if (interrupted) {
        artifacts["glm-morph-interrupted.json"] = JSON.stringify(interrupted, null, 2) + "\n";
    }

    if (independent) {
        artifacts["glm-results.json"] = JSON.stringify(independent, null, 2) + "\n";
        artifacts["glm-trials.csv"] = trialCsv(independent);
    }

    if (deepseek) {
        artifacts["deepseek-results.json"] = JSON.stringify(deepseek, null, 2) + "\n";
        artifacts["deepseek-trials.csv"] = trialCsv(deepseek);
    }

    if (data) {
        artifacts["results.json"] = JSON.stringify(data, null, 2) + "\n";
        artifacts["trials.csv"] = trialCsv(data);
    }

    if (option === "--check") {
        for (const [name, value] of Object.entries(artifacts)) {
            if (fs.readFileSync(path.join(target, name), "utf8").replaceAll("\r\n", "\n") !== value) {
                throw new Error(`Stale generated evals artifact: ${name}`);
            }
        }
    } else {
        fs.mkdirSync(target, { recursive: true });
        for (const [name, value] of Object.entries(artifacts)) {
            fs.writeFileSync(path.join(target, name), value);
        }
    }
}
