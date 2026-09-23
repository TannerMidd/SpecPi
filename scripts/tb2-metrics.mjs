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
// Three numbers are not taken at face value:
//
//   OpenCode's output count leaves out its reasoning. Harbor's OpenCode agent records tokens.output
//   as n_output_tokens and files tokens.reasoning away in each step's metrics, while every other arm's
//   count comes from completion_tokens, which already includes reasoning. Reasoning bills at the
//   output rate and was 2.6 times OpenCode's recorded output on 22 Sep, so its trials are marked
//   reasoningApart below and the reasoning is read back out of trajectory.json.
//
//   Claude Code's cache count is zero in every 21 Sep trial, and that is a gap in the measurement
//   rather than a finding. Its traffic crosses this repository's Messages/chat-completions
//   translation, which at the time never mapped the provider's cached share back to
//   cache_read_input_tokens. Those runs are marked noCache below: their cached share is null rather
//   than zero, and they are left out of Claude Code's cache and cost, which come from the 22 Sep
//   sitting that ran after the fix. Their tokens and rewards were recorded correctly and still count.
//
//   Claude Code's own cost_usd is computed at Anthropic's prices for a model that was DeepSeek, so
//   it overstates by about two orders of magnitude. Every arm's cost here is recomputed from logged
//   tokens at the frozen rate instead.
//
// And one cost is left out. Harbor records the agent's tokens, not the Jev advisor's, so the
// SpecPi + Jev figure is the agent's spend alone. evals/prices.json prices the advisor so that a Jev
// row never excludes it; this one has to, so the advisor's own ledger is counted instead and the page
// says what is missing rather than folding in a guess.
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
//
// One entry per sitting, not per arm. A sitting is one launch: the arms inside it faced the same
// provider state, the same container churn and the same hour, and only a comparison within one is
// attributable to the harness.
//
// Recording them separately is the point. Bare Pi -- unchanged software, identical tasks, same
// machine -- scored 30, 22, 21, 30, 32 and 27 of 39 across the six sittings below. An eleven-solve
// spread from one harness against itself is wider than any gap measured between harnesses here, so
// a single sitting cannot support a claim about either.
const SOURCES = [
    // 2026-09-21
    { sitting: "s1", slice: "slice1", arm: "pi", dir: "tb2-pair-20260921-131712/pi" },
    { sitting: "s1", slice: "slice1", arm: "jev", dir: "tb2-pair-20260921-131712/jev" },
    { sitting: "s1", slice: "slice1", arm: "omp", dir: "tb2-omp-slice1-20260921-180429" },
    // Both 21 Sep Claude Code runs predate the cache-mapping fix; noCache keeps them out of its cost.
    { sitting: "s1", slice: "slice1", arm: "claude-code", dir: "tb2-cc-slice1-20260921-150054", noCache: true },
    { sitting: "s1", slice: "widen", arm: "pi", dir: "tb2-widen-20260921-142615/pi" },
    { sitting: "s1", slice: "widen", arm: "jev", dir: "tb2-widen-20260921-142615/jev" },
    { sitting: "s1", slice: "widen", arm: "omp", dir: "tb2-omp-widen-20260921-184339" },
    { sitting: "s1", slice: "widen", arm: "claude-code", dir: "tb2-cc-widen-20260921-165619", noCache: true },

    // 2026-09-22
    { sitting: "s2", slice: "widen", arm: "jev", dir: "tb2-jevcc-20260922-002420/jev" },
    { sitting: "s2", slice: "widen", arm: "claude-code", dir: "tb2-jevcc-20260922-002420/claude-code" },
    { sitting: "s3", slice: "widen", arm: "pi", dir: "tb2-picontrol-20260922-075714/pi" },
    { sitting: "s4", slice: "widen", arm: "pi", dir: "tb2-rep1-20260922-084504/pi" },
    { sitting: "s4", slice: "widen", arm: "jev", dir: "tb2-rep1-20260922-084504/jev" },
    { sitting: "s5", slice: "widen", arm: "pi", dir: "tb2-rep2-20260922-094001/pi" },
    { sitting: "s5", slice: "widen", arm: "jev", dir: "tb2-rep2-20260922-094001/jev" },
    { sitting: "s6", slice: "widen", arm: "pi", dir: "tb2-rep3-20260922-103224/pi" },
    { sitting: "s6", slice: "widen", arm: "jev", dir: "tb2-rep3-20260922-103224/jev" },
    // OpenCode and the DeepSeek Harness joined in a four-arm sitting with Pi and SpecPi + Jev, so each
    // has partners to be compared against. DSH reports no usage of its own; its tokens are what a
    // counting proxy inside the container saw leave. It is pinned to 0.1.5-rc.3, because rc.2 -- npm's
    // `latest` -- now resolves rc.3 sub-packages and fails to boot.
    { sitting: "s7", slice: "widen", arm: "pi", dir: "tb2-four-20260922-132056/pi" },
    { sitting: "s7", slice: "widen", arm: "jev", dir: "tb2-four-20260922-132056/jev" },
    { sitting: "s7", slice: "widen", arm: "opencode", dir: "tb2-four-20260922-132056/opencode", reasoningApart: true },
    { sitting: "s7", slice: "widen", arm: "dsh", dir: "tb2-four-20260922-132056/dsh" },
];

const SITTINGS = {
    s1: "21 Sep",
    s2: "22 Sep · a",
    s3: "22 Sep · b",
    s4: "22 Sep · c",
    s5: "22 Sep · d",
    s6: "22 Sep · e",
    s7: "22 Sep · f",
};

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
    { id: "opencode", label: "OpenCode", colour: "var(--ct-opencode)" },
    { id: "dsh", label: "DeepSeek Harness", colour: "var(--ct-deepseek)" },
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

// The Jev arm's per-trial records. jev-setup.json shows which layer build was installed: 0.30.0 dropped
// the compaction budget along with the system, so a setup that still lists one ran an earlier build
// with the withdrawn system present, switched off for these runs. The transmission ledger is the only
// record of the advisor's own calls, which Harbor's token counts do not include.
function readLayer(agentDir) {
    let carriesCompaction = null;
    try {
        const setup = JSON.parse(fs.readFileSync(path.join(agentDir, "jev-setup.json"), "utf8"));
        carriesCompaction = Object.hasOwn(setup.budgets ?? {}, "compaction");
    } catch {
        // No setup record: the build is unknown rather than assumed.
    }

    let calls = 0;
    let stateBytes = 0;
    try {
        for (const line of fs.readFileSync(path.join(agentDir, "jev-transmissions.jsonl"), "utf8").split(/\r?\n/u)) {
            if (!line.trim()) {
                continue;
            }

            const entry = JSON.parse(line);
            calls += 1;
            stateBytes += entry.stateBytes ?? 0;
        }
    } catch {
        // An attempt the advisor never called writes no ledger.
    }

    return { carriesCompaction, calls, stateBytes };
}

// Reasoning tokens an OpenCode trial recorded outside n_output_tokens, summed from the per-step
// metrics in its trajectory. Null when the trajectory is missing, so the caller can tell an attempt
// that reasoned nothing from one whose reasoning went unrecorded.
function readReasoning(agentDir) {
    let trajectory;
    try {
        trajectory = JSON.parse(fs.readFileSync(path.join(agentDir, "trajectory.json"), "utf8"));
    } catch {
        return null;
    }

    return (trajectory.steps ?? []).reduce((total, step) => total + (step.metrics?.extra?.reasoning_tokens ?? 0), 0);
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
            const reasoningTokens = source.reasoningApart ? readReasoning(path.join(path.dirname(file), "agent")) : 0;
            if (reasoningTokens === null) {
                throw new Error(`${file}: reasoning is recorded apart for this arm but its trajectory is missing`);
            }

            const outputTokens = (agent.n_output_tokens ?? 0) + reasoningTokens;
            const cacheTokens = source.noCache ? null : (agent.n_cache_tokens ?? 0);
            const layer = source.arm === "jev" ? readLayer(path.join(path.dirname(file), "agent")) : null;
            rows.push({
                sitting: source.sitting,
                slice: source.slice,
                arm: source.arm,
                task,
                reward,
                inputTokens,
                outputTokens,
                cacheTokens,
                cost: costOf(rate, inputTokens, cacheTokens ?? 0, outputTokens),
                outputCost: (outputTokens * rate.outputPerMTok) / 1e6,
                costIsUpperBound: cacheTokens === null,
                // What the trial reports it ran, so the page can say which Pi it measured rather
                // than restating the version this repository happens to pin for its own tests.
                agentVersion: trial.agent_info?.version ?? null,
                layer,
            });
        }
    }

    return { rows, errors };
}

// Fisher's exact test, two-tailed. The page and the README both quote these, and a quoted p-value
// that is not recomputed from the run it describes is the fastest thing on a page to go stale --
// this one already did, surviving a rerun that moved it from 0.83 to 0.40.
function logFactorial(n) {
    let total = 0;
    for (let i = 2; i <= n; i += 1) {
        total += Math.log(i);
    }

    return total;
}

function hypergeometric(a, b, c, d) {
    return Math.exp(
        logFactorial(a + b) +
            logFactorial(c + d) +
            logFactorial(a + c) +
            logFactorial(b + d) -
            logFactorial(a + b + c + d) -
            logFactorial(a) -
            logFactorial(b) -
            logFactorial(c) -
            logFactorial(d),
    );
}

function fisherExact(a, b, c, d) {
    const total = a + b + c + d;
    const observed = hypergeometric(a, b, c, d);
    let p = 0;
    for (let i = 0; i <= Math.min(a + b, a + c); i += 1) {
        const j = a + b - i;
        const k = a + c - i;
        const l = total - i - j - k;
        if (j < 0 || k < 0 || l < 0) {
            continue;
        }

        const q = hypergeometric(i, j, k, l);
        if (q <= observed * 1.0000001) {
            p += q;
        }
    }

    return p;
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

    // Price the attempts whose cached share was recorded. Where none were, every prompt token bills
    // fresh and the result is an upper bound rather than a cost -- said so, rather than averaged in.
    const priced = cached.length > 0 ? cached : rows;

    return {
        attempts,
        solved,
        rate: solved / attempts,
        tasks: new Set(rows.map((row) => row.task)).size,
        inputTokens: Math.round(inputTokens / attempts),
        outputTokens: Math.round(outputTokens / attempts),
        // Null rather than zero: a cached share of nothing and a cached share nobody recorded are
        // different claims, and only one of them is supported.
        cacheHitRate: cachedInput > 0 ? cacheTokens / cachedInput : null,
        cost: priced.reduce((total, row) => total + row.cost, 0) / priced.length,
        // At a 93% cache rate most prompt tokens bill at the cache-read price, so output is most of
        // the spend. This is why a consistent prompt-token saving shows up so faintly in cost.
        outputCostShare:
            priced.reduce((total, row) => total + row.outputCost, 0) /
            priced.reduce((total, row) => total + row.cost, 0),
        costIsUpperBound: cached.length === 0,
        // How much of the row the cost covers, so a figure drawn from a subset says so.
        costAttempts: priced.length,
    };
}

// Two harnesses compared only in the sittings where both ran in the same launch. This is the page's
// own rule -- a sitting moves bare Pi by eleven solves, so a gap between rows drawn from different
// sittings is partly the hour -- and it has to govern cost and tokens as much as solve rate. Pooling
// every sitting had SpecPi + Jev 11% cheaper than Pi; paired, it is cheaper in three of four sittings,
// by about half that, and dearer in the fourth.
//
// Ratios are summarised by their geometric mean, the average that treats "half as much" and "twice
// as much" as equal and opposite. Cost is compared only where both sides recorded a cached share.
function geometricMean(values) {
    return Math.exp(values.reduce((total, value) => total + Math.log(value), 0) / values.length);
}

function pairOf(a, b) {
    const shared = a.sittings.filter((entry) => b.sittings.some((other) => other.id === entry.id));
    if (shared.length === 0) {
        return null;
    }

    const sittings = shared.map((entry) => {
        const other = b.sittings.find((candidate) => candidate.id === entry.id);
        const costComparable = !entry.costIsUpperBound && !other.costIsUpperBound;

        return {
            id: entry.id,
            label: entry.label,
            a: { solved: entry.solved, attempts: entry.attempts, inputTokens: entry.inputTokens, cost: entry.cost },
            b: { solved: other.solved, attempts: other.attempts, inputTokens: other.inputTokens, cost: other.cost },
            tokenRatio: entry.inputTokens / other.inputTokens,
            costRatio: costComparable ? entry.cost / other.cost : null,
        };
    });
    const tokenRatios = sittings.map((entry) => entry.tokenRatio);
    const costRatios = sittings.map((entry) => entry.costRatio).filter((ratio) => ratio !== null);
    const sum = (side, key) => sittings.reduce((total, entry) => total + entry[side][key], 0);

    return {
        a: a.id,
        b: b.id,
        sittings,
        tokens: {
            sittings: tokenRatios.length,
            lowerIn: tokenRatios.filter((ratio) => ratio < 1).length,
            low: Math.min(...tokenRatios),
            high: Math.max(...tokenRatios),
            typical: geometricMean(tokenRatios),
        },
        cost:
            costRatios.length > 0
                ? {
                      sittings: costRatios.length,
                      lowerIn: costRatios.filter((ratio) => ratio < 1).length,
                      low: Math.min(...costRatios),
                      high: Math.max(...costRatios),
                      typical: geometricMean(costRatios),
                  }
                : null,
        solved: {
            a: sum("a", "solved"),
            b: sum("b", "solved"),
            attemptsA: sum("a", "attempts"),
            attemptsB: sum("b", "attempts"),
            p: fisherExact(
                sum("a", "solved"),
                sum("a", "attempts") - sum("a", "solved"),
                sum("b", "solved"),
                sum("b", "attempts") - sum("b", "solved"),
            ),
        },
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
        const widened = mine.filter((row) => row.slice === "widen");

        // One row per sitting on the widened slice. This is the spread the page is about: the same
        // harness, the same tasks, a different hour.
        const sittings = Object.keys(SITTINGS)
            .map((id) => {
                const inSitting = widened.filter((row) => row.sitting === id);
                const layers = inSitting.map((row) => row.layer).filter(Boolean);

                return {
                    id,
                    label: SITTINGS[id],
                    ...(summarize(inSitting) ?? {}),
                    ...(layers.length > 0
                        ? { carriesCompaction: layers.some((layer) => layer.carriesCompaction === true) }
                        : {}),
                };
            })
            .filter((entry) => entry.attempts > 0);
        const rates = sittings.map((entry) => entry.rate);

        return {
            ...harness,
            overall: summarize(mine),
            widened: summarize(widened),
            sittings,
            // Named as a range rather than a deviation: with three to five sittings the spread is
            // the honest summary and a standard deviation would dress it up as more than it is.
            spread:
                rates.length > 1 ? { low: Math.min(...rates), high: Math.max(...rates), sittings: rates.length } : null,
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
        sittingLabels: SITTINGS,
        harnesses,
        // The Pi build every Pi-derived trial reported. The page used to state the version this
        // repository pins for its own tests, which is not the one the benchmark installed.
        piVersions: [
            ...new Set(
                rows
                    .filter((row) => row.arm === "pi" || row.arm === "jev")
                    .map((row) => row.agentVersion)
                    .filter(Boolean),
            ),
        ].sort(),
        // Which Jev sittings ran a layer build that still carried the withdrawn compaction system.
        jevBuilds: (() => {
            const jev = harnesses.find((harness) => harness.id === "jev");
            const sittings = jev?.sittings ?? [];

            return {
                withCompaction: sittings.filter((entry) => entry.carriesCompaction).map((entry) => entry.label),
                withoutCompaction: sittings
                    .filter((entry) => entry.carriesCompaction === false)
                    .map((entry) => entry.label),
            };
        })(),
        // The advisor's own calls, which the SpecPi + Jev cost cannot include. Counted from its ledger,
        // with its listed price, so the page can say what is missing without estimating it.
        advisor: (() => {
            const layers = rows.filter((row) => row.layer).map((row) => row.layer);

            return {
                calls: layers.reduce((total, layer) => total + layer.calls, 0),
                attemptsWithCalls: layers.filter((layer) => layer.calls > 0).length,
                attempts: layers.length,
                stateBytes: layers.reduce((total, layer) => total + layer.stateBytes, 0),
                rate: prices.models["jev-1.13.0"] ?? null,
            };
        })(),
        paired: harnesses.flatMap((a, index) => harnesses.slice(index + 1).map((b) => pairOf(a, b))).filter(Boolean),
        // Every pair, so no quoted comparison has to be maintained by hand.
        comparisons: harnesses.flatMap((a, index) =>
            harnesses.slice(index + 1).map((b) => ({
                a: a.id,
                b: b.id,
                p: fisherExact(
                    a.overall.solved,
                    a.overall.attempts - a.overall.solved,
                    b.overall.solved,
                    b.overall.attempts - b.overall.solved,
                ),
            })),
        ),
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
        const spread = harness.spread
            ? `  sittings ${harness.spread.sittings}: ${(harness.spread.low * 100).toFixed(0)}-${(harness.spread.high * 100).toFixed(0)}%`
            : "";
        process.stdout.write(
            `  ${harness.label.padEnd(14)} ${String(harness.overall.solved).padStart(3)}/${String(harness.overall.attempts).padEnd(3)}` +
                ` ${harness.overall.rate.toFixed(3)}  cache ${cache === null ? "  n/m" : `${(cache * 100).toFixed(1)}%`}` +
                `  $${harness.overall.cost.toFixed(4)}/attempt${harness.overall.costIsUpperBound ? " (upper bound)" : ""}${spread}
`,
        );
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}

export { costOf, summarize };
