#!/usr/bin/env node
// Derive site/evaluations/terminal-bench-2.json from the Terminal-Bench 2.0 runs.
//
// This reads Harbor's own result.json per trial rather than each agent's native trajectory. The
// tier suite this page used to carry read trajectories, because it wanted tool calls and the
// harnesses spell those four different ways; Harbor already reports reward and token counts
// uniformly, and reward and tokens are the whole of what this section claims.
//
// The runs are deliberately not in this repository. Terminal-Bench task content carries canary
// strings that are not meant to enter a training corpus, so only aggregates and public task names
// cross into the data file.
//
// Two numbers are not taken at face value:
//
//   Claude Code's cache count is zero in every trial, and that is a gap in the measurement rather
//   than a finding. It reaches the provider through this repository's Messages/chat-completions
//   translation, which at the time of these runs emitted input_tokens and output_tokens and never
//   mapped the provider's cached share back to cache_read_input_tokens. The provider did cache --
//   Pi and SpecPi see 94% on the same endpoint in the same sitting -- so the figure is published as
//   null. A zero would read as "Claude Code destroys cache efficiency", which the run does not show.
//
//   Claude Code's own cost_usd is computed at Anthropic's prices for a model that was DeepSeek, so
//   it overstates by about two orders of magnitude. Every arm's cost here is recomputed from logged
//   tokens at the frozen rate instead, and Claude Code's is an upper bound because the cached share
//   that would discount it is the number above.
//
// Usage: node scripts/tb2-metrics.mjs [runs-root]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFile = path.join(root, "site", "evaluations", "terminal-bench-2.json");
const pricesFile = path.join(root, "evals", "prices.json");

const MODEL = "deepseek-v4.1-flash";
const DEFAULT_RUNS = "F:/Development/tb-bench/runs";

// Named explicitly rather than globbed, for the reason the tier suite learned the hard way: the
// runs directory also holds earlier sittings on other models and other task sets, and a pattern
// wide enough to catch this experiment catches those too.
const SOURCES = [
    { slice: "slice1", arm: "pi", dir: "tb2-pair-20260921-131712/pi" },
    { slice: "slice1", arm: "jev", dir: "tb2-pair-20260921-131712/jev" },
    { slice: "slice1", arm: "omp", dir: "tb2-omp-slice1-20260921-180429" },
    { slice: "slice1", arm: "claude-code", dir: "tb2-cc-slice1-20260921-150054" },
    { slice: "widen", arm: "pi", dir: "tb2-widen-20260921-142615/pi" },
    { slice: "widen", arm: "jev", dir: "tb2-widen-20260921-142615/jev" },
    { slice: "widen", arm: "omp", dir: "tb2-omp-widen-20260921-184339" },
    { slice: "widen", arm: "claude-code", dir: "tb2-cc-widen-20260921-165619" },
];

const SLICES = [
    {
        id: "slice1",
        label: "Calibration",
        note: "Seven tasks at five attempts, chosen to find out whether the set could separate anything. Six of the seven went the same way for every arm, which is what the widened slice exists to fix.",
    },
    {
        id: "widen",
        label: "Widened",
        note: "Thirteen tasks at three attempts, picked for spread rather than for difficulty. This is the slice the comparison rests on.",
    },
];

// Same tokens as every other figure on the site, so a colour means one harness throughout.
const HARNESSES = [
    { id: "pi", label: "Pi (base)", colour: "var(--ct-pi)" },
    { id: "jev", label: "SpecPi + Jev", colour: "var(--ct-specpi-jev)" },
    { id: "omp", label: "Oh My Pi", colour: "var(--ct-omp)" },
    { id: "claude-code", label: "Claude Code", colour: "var(--ct-claudecode)" },
];

// Every arm's trials on this task produce zero tokens in about two seconds, which is the task's
// environment failing to build rather than four harnesses failing to solve it. Counting them would
// put unmeasured cells in the denominator as though the agents had tried and lost.
const DROP_TASKS = new Set(["pytorch-model-recovery"]);

// Oh My Pi's widened slice holds 78 trials rather than 39, because two launches of the same script
// raced: the output directory name is computed after the OpenCode session is minted, so both
// launches computed the same name and wrote into it. They ran the same thirteen tasks at the same
// settings against the same model and key, so the trials are independent and all of them count --
// six attempts per task instead of three. Harbor's own result.json for that directory reports only
// the 39 belonging to whichever launch finished last, which is why its mean and this one differ.
// One caveat travels with them: the two launches were in flight together at concurrency six each,
// so that slice was measured at twelve-way concurrency, and its timeouts may owe something to that.
const CACHE_UNMEASURED = new Set(["claude-code"]);

function trials(runsRoot, dir) {
    const found = [];
    const base = path.join(runsRoot, dir);
    if (!fs.existsSync(base)) {
        return found;
    }

    for (const stamp of fs.readdirSync(base)) {
        const stampDir = path.join(base, stamp);
        if (!fs.statSync(stampDir).isDirectory()) {
            continue;
        }

        for (const trial of fs.readdirSync(stampDir)) {
            const file = path.join(stampDir, trial, "result.json");
            if (fs.existsSync(file)) {
                found.push(file);
            }
        }
    }

    return found;
}

function costOf(rate, inputTokens, cacheTokens, outputTokens) {
    const fresh = Math.max(0, inputTokens - cacheTokens);

    return (fresh * rate.inputPerMTok + cacheTokens * rate.cacheReadPerMTok + outputTokens * rate.outputPerMTok) / 1e6;
}

function readTrials(runsRoot, rate) {
    const rows = [];
    const errors = [];
    for (const source of SOURCES) {
        for (const file of trials(runsRoot, source.dir)) {
            let trial;
            try {
                trial = JSON.parse(fs.readFileSync(file, "utf8"));
            } catch {
                continue;
            }

            const task = trial.task_name;
            if (!task || DROP_TASKS.has(task)) {
                continue;
            }

            const reward = trial.verifier_result?.rewards?.reward;
            if (typeof reward !== "number") {
                errors.push({
                    slice: source.slice,
                    arm: source.arm,
                    task,
                    kind: trial.exception_info?.exception_type ?? "unscored",
                });
                continue;
            }

            const agent = trial.agent_result ?? {};
            const inputTokens = agent.n_input_tokens ?? 0;
            const outputTokens = agent.n_output_tokens ?? 0;
            const cacheTokens = CACHE_UNMEASURED.has(source.arm) ? null : (agent.n_cache_tokens ?? 0);
            rows.push({
                slice: source.slice,
                arm: source.arm,
                task,
                reward,
                inputTokens,
                outputTokens,
                cacheTokens,
                cost: costOf(rate, inputTokens, cacheTokens ?? 0, outputTokens),
                costIsUpperBound: cacheTokens === null,
            });
        }
    }

    return { rows, errors };
}

function summarize(rows) {
    if (rows.length === 0) {
        return null;
    }

    const attempts = rows.length;
    const solved = rows.filter((row) => row.reward >= 1).length;
    const inputTokens = rows.reduce((total, row) => total + row.inputTokens, 0);
    const outputTokens = rows.reduce((total, row) => total + row.outputTokens, 0);
    const cached = rows.filter((row) => row.cacheTokens !== null);
    const cacheTokens = cached.reduce((total, row) => total + row.cacheTokens, 0);
    const cachedInput = cached.reduce((total, row) => total + row.inputTokens, 0);

    return {
        attempts,
        solved,
        rate: solved / attempts,
        tasks: new Set(rows.map((row) => row.task)).size,
        inputTokens: Math.round(inputTokens / attempts),
        outputTokens: Math.round(outputTokens / attempts),
        // Null rather than zero: see the header. A cached share of nothing and a cached share
        // nobody recorded are different claims, and only one of them is supported.
        cacheHitRate: cachedInput > 0 ? cacheTokens / cachedInput : null,
        cost: rows.reduce((total, row) => total + row.cost, 0) / attempts,
        costIsUpperBound: rows.some((row) => row.costIsUpperBound),
    };
}

function main() {
    const runsRoot = process.argv[2] ?? DEFAULT_RUNS;
    const prices = JSON.parse(fs.readFileSync(pricesFile, "utf8"));
    const rate = prices.models[MODEL];
    if (!rate) {
        throw new Error(`${MODEL} is not priced in evals/prices.json`);
    }

    const { rows, errors } = readTrials(runsRoot, rate);
    if (rows.length === 0) {
        throw new Error(`no scored trials under ${runsRoot}; name the runs root as the first argument`);
    }

    const harnesses = HARNESSES.map((harness) => {
        const mine = rows.filter((row) => row.arm === harness.id);

        return {
            ...harness,
            overall: summarize(mine),
            slices: Object.fromEntries(
                SLICES.map((slice) => [slice.id, summarize(mine.filter((row) => row.slice === slice.id))]).filter(
                    ([, summary]) => summary !== null,
                ),
            ),
        };
    }).filter((harness) => harness.overall !== null);

    // Per task, on the widened slice only. The calibration slice is on the page as the reason the
    // widened one exists, not as a result, so breaking it down task by task would invite reading it
    // as one.
    const widened = rows.filter((row) => row.slice === "widen");
    const tasks = [...new Set(widened.map((row) => row.task))].sort().map((task) => ({
        task,
        byHarness: Object.fromEntries(
            harnesses
                .map((harness) => [
                    harness.id,
                    summarize(widened.filter((row) => row.task === task && row.arm === harness.id)),
                ])
                .filter(([, summary]) => summary !== null),
        ),
    }));

    const data = {
        generatedAt: new Date().toISOString().slice(0, 10),
        benchmark: "Terminal-Bench 2.0",
        status: "in progress",
        model: MODEL,
        rate,
        pricedAt: prices.pricedAt,
        slices: SLICES,
        harnesses,
        tasks,
        errors,
        totalAttempts: rows.length,
        taskCount: new Set(rows.map((row) => row.task)).size,
    };
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `${JSON.stringify(data, null, 4)}\n`);

    process.stdout.write(
        `${rows.length} scored trials, ${errors.length} unscored -> ${path.relative(root, outFile)}\n`,
    );
    for (const harness of harnesses) {
        const cache = harness.overall.cacheHitRate;
        process.stdout.write(
            `  ${harness.label.padEnd(14)} ${String(harness.overall.solved).padStart(3)}/${String(harness.overall.attempts).padEnd(3)}` +
                ` ${harness.overall.rate.toFixed(3)}  cache ${cache === null ? "  n/m" : `${(cache * 100).toFixed(1)}%`}` +
                `  $${harness.overall.cost.toFixed(4)}/attempt${harness.overall.costIsUpperBound ? " (upper bound)" : ""}\n`,
        );
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}

export { costOf, summarize };
