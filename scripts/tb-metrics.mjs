#!/usr/bin/env node
// Derive site/evaluations/terminal-bench.json from a Terminal-Bench run.
//
// The run's own result.json carries tokens and a reward and nothing else, and tokens alone do not
// answer the interesting question about a harness: two of them can spend the same context and differ
// threefold in how many model calls they take to spend it. So this reads each harness's trajectory
// in whatever format that harness writes, and puts the behavioural columns back.
//
// The formats do not agree:
//
//   Pi, SpecPi, SpecPi+Jev and Oh My Pi write JSONL with explicit tool_execution_end events carrying
//   a toolName. Assistant messages are events too, so requests are counted directly.
//
//   Codex and OpenCode write one trajectory.json whose agent steps carry a tool_calls array with a
//   function_name. One agent step is one model response, so those steps are the request count.
//
//   The DeepSeek Harness writes prose. Its tool calls are not recoverable at all, and this emits
//   null rather than zero -- a zero would sort the heaviest arm to the top of a chart about
//   restraint. Its requests do survive, because the run put a counting proxy in front of it.
//
// Timing is agent_execution, not the trial's own span: the difference is image pull, harness install
// and verification, which belong to the benchmark rather than to the harness being measured.
//
// The run itself is deliberately not in this repository. Terminal-Bench task content carries canary
// strings that are not meant to enter a training corpus, so only aggregates and public task names
// cross into the data file this writes.
//
// Usage: node scripts/tb-metrics.mjs <run-dir>[:arm,arm] ...

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFile = path.join(root, "site", "evaluations", "terminal-bench.json");
const pricesFile = path.join(root, "evals", "prices.json");

const MODEL = "deepseek-v4.1-flash";

// extract-elf ran in only one of the two sittings. Keeping a task three arms never attempted would
// let the rows be compared on different work.
const DROP_TASKS = new Set(["extract-elf"]);

const LABELS = {
    pi: "Pi (base)",
    control: "SpecPi",
    jev: "SpecPi + Jev",
    omp: "Oh My Pi",
    codex: "Codex",
    opencode: "OpenCode",
    dsh: "DeepSeek Harness",
};
const ORDER = ["pi", "control", "jev", "omp", "codex", "opencode", "dsh"];
const JSONL = { pi: "pi.txt", control: "pi.txt", jev: "pi.txt", omp: "omp.txt" };

const rates = (() => {
    const models = JSON.parse(fs.readFileSync(pricesFile, "utf8")).models ?? {};
    const entry = models[MODEL] ?? {};

    return { in: entry.inputPerMTok ?? 0, out: entry.outputPerMTok ?? 0, cache: entry.cacheReadPerMTok ?? 0 };
})();

function price(nIn, nOut, nCache) {
    return (Math.max(nIn - nCache, 0) * rates.in) / 1e6 + (nOut * rates.out) / 1e6 + (nCache * rates.cache) / 1e6;
}

function mean(values) {
    const kept = values.filter((value) => value !== null && value !== undefined);

    return kept.length === 0 ? null : kept.reduce((total, value) => total + value, 0) / kept.length;
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return null;
    }
}

function seconds(result) {
    const window = result.agent_execution ?? {};
    if (!window.started_at || !window.finished_at) {
        return null;
    }

    const span = Date.parse(window.finished_at) - Date.parse(window.started_at);

    return Number.isFinite(span) ? span / 1000 : null;
}

function fromJsonl(file) {
    if (!fs.existsSync(file)) {
        return null;
    }

    const tools = new Map();
    let toolCalls = 0;
    let requests = 0;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (line.trim() === "") {
            continue;
        }

        let event;
        try {
            event = JSON.parse(line);
        } catch {
            continue;
        }

        if (event.type === "tool_execution_end") {
            toolCalls += 1;
            const name = event.toolName ?? "?";
            tools.set(name, (tools.get(name) ?? 0) + 1);
        } else if (event.type === "message_end" && event.message?.role === "assistant") {
            requests += 1;
        }
    }

    return { toolCalls, requests, tools };
}

function fromTrajectory(file) {
    const data = fs.existsSync(file) ? readJson(file) : null;
    if (!data) {
        return null;
    }

    const tools = new Map();
    let toolCalls = 0;
    let requests = 0;
    for (const step of data.steps ?? []) {
        if (step.source !== "agent") {
            continue;
        }

        requests += 1;
        for (const call of step.tool_calls ?? []) {
            toolCalls += 1;
            const name = call.function_name ?? "?";
            tools.set(name, (tools.get(name) ?? 0) + 1);
        }
    }

    return { toolCalls, requests, tools };
}

function fromProxy(file) {
    if (!fs.existsSync(file)) {
        return null;
    }

    const lines = fs.readFileSync(file, "utf8").split("\n");

    return { toolCalls: null, requests: lines.filter((line) => line.trim() !== "").length, tools: new Map() };
}

function behaviour(arm, agentDir) {
    if (JSONL[arm]) {
        return fromJsonl(path.join(agentDir, JSONL[arm]));
    }

    if (arm === "dsh") {
        return fromProxy(path.join(agentDir, "dsh-usage.jsonl"));
    }

    return fromTrajectory(path.join(agentDir, "trajectory.json"));
}

function trialDirs(armDir) {
    const dirs = [];
    if (!fs.existsSync(armDir)) {
        return dirs;
    }

    for (const stamp of fs.readdirSync(armDir)) {
        const stampDir = path.join(armDir, stamp);
        if (!fs.statSync(stampDir).isDirectory()) {
            continue;
        }

        for (const trial of fs.readdirSync(stampDir)) {
            const dir = path.join(stampDir, trial);
            if (fs.existsSync(path.join(dir, "result.json"))) {
                dirs.push(dir);
            }
        }
    }

    return dirs;
}

/**
 * Roll up the Jev arm's own transmission ledger.
 *
 * Without this the Jev row is read as a token result and nothing else, which is the wrong question
 * to ask it: every system in that layer targets a situation -- a long session, a destructive command,
 * a stuck loop -- rather than a token count. The ledger is the only record of whether any of those
 * situations arose, and on a benchmark this shape the answer is mostly no. Publishing it is what
 * stops a favourable token number being read as the layer working.
 *
 * `applied` is the layer's own word for "this verdict changed what happened": for the guard it means
 * the call was blocked or escalated rather than handed back to the permission system, and for
 * retention it means a tool result was actually shortened.
 */
function advisorLedger(armDir) {
    const bySystem = new Map();
    let calls = 0;
    let applied = 0;
    let failed = 0;
    for (const trialDir of trialDirs(armDir)) {
        const file = path.join(trialDir, "agent", "jev-transmissions.jsonl");
        if (!fs.existsSync(file)) {
            continue;
        }

        for (const line of fs.readFileSync(file, "utf8").split("\n")) {
            if (line.trim() === "") {
                continue;
            }

            let entry;
            try {
                entry = JSON.parse(line);
            } catch {
                continue;
            }

            const name = typeof entry.system === "string" ? entry.system : "unknown";
            const bucket = bySystem.get(name) ?? { calls: 0, applied: 0, outcomes: {} };
            bucket.calls += 1;
            bucket.applied += entry.applied === true ? 1 : 0;
            // An outcome only appears when the system recorded a reason; "unrecorded" is the
            // ordinary path where it answered and declined to act.
            const outcome =
                typeof entry.outcome === "string" ? entry.outcome : entry.ok === true ? "unrecorded" : "failed";
            bucket.outcomes[outcome] = (bucket.outcomes[outcome] ?? 0) + 1;
            bySystem.set(name, bucket);

            calls += 1;
            applied += entry.applied === true ? 1 : 0;
            failed += entry.ok === true ? 0 : 1;
        }
    }

    return calls === 0 ? null : { calls, applied, failed, bySystem: Object.fromEntries(bySystem) };
}

function collect(sources) {
    const arms = new Map(ORDER.map((arm) => [arm, []]));
    for (const { dir, names } of sources) {
        for (const arm of names) {
            for (const trialDir of trialDirs(path.join(dir, arm))) {
                const result = readJson(path.join(trialDir, "result.json"));
                if (!result) {
                    continue;
                }

                const task = (result.task_name ?? "?").split("/").pop();
                if (DROP_TASKS.has(task)) {
                    continue;
                }

                const agent = result.agent_result ?? {};
                const nCache = agent.n_cache_tokens ?? 0;
                // The first DSH trials ran before its proxy could read this endpoint's cache fields,
                // so their prompts were counted as entirely fresh. Their pass or fail is sound; their
                // token split is not, and a mean mixing them with corrected trials describes neither.
                if (arm === "dsh" && nCache === 0) {
                    continue;
                }

                const reward = result.verifier_result?.rewards?.reward;
                if (reward === undefined || reward === null) {
                    continue;
                }

                const nIn = agent.n_input_tokens ?? 0;
                const nOut = agent.n_output_tokens ?? 0;
                arms.get(arm).push({
                    task,
                    solved: reward > 0,
                    input: nIn,
                    output: nOut,
                    cacheHitRate: nIn === 0 ? 0 : nCache / nIn,
                    cost: price(nIn, nOut, nCache),
                    seconds: seconds(result),
                    capped: Boolean(result.exception_info),
                    ...(behaviour(arm, path.join(trialDir, "agent")) ?? {
                        toolCalls: null,
                        requests: null,
                        tools: new Map(),
                    }),
                });
            }
        }
    }

    return arms;
}

function summarise(rows) {
    const toolCalls = mean(rows.map((row) => row.toolCalls));
    const requests = mean(rows.map((row) => row.requests));
    const promptTokens = mean(rows.map((row) => row.input));

    return {
        attempts: rows.length,
        solved: rows.filter((row) => row.solved).length,
        capped: rows.filter((row) => row.capped).length,
        promptTokens,
        outputTokens: mean(rows.map((row) => row.output)),
        cacheHitRate: mean(rows.map((row) => row.cacheHitRate)),
        cost: mean(rows.map((row) => row.cost)),
        seconds: mean(rows.map((row) => row.seconds)),
        toolCalls,
        requests,
        toolsPerRequest: toolCalls === null || !requests ? null : toolCalls / requests,
        tokensPerRequest: promptTokens === null || !requests ? null : promptTokens / requests,
    };
}

/**
 * Cache hit rate and cost, measured again on a run that did not have the session defect.
 *
 * The main run pointed every trial at one OpenCode session id. That endpoint's prefix cache is
 * scoped to the session, so as distinct conversations piled into one id the earlier prefixes were
 * evicted: median stall rate was 0% for the first 25 trials on a session and 38% past 75, and the
 * arms that looked worst were simply the ones that ran latest. Those two columns measure run
 * position, not harness behaviour, and cannot be published.
 *
 * Everything else in the main run survives, because caching changes how a prompt is billed and not
 * what is sent -- solve rate, prompt tokens, tool calls and requests are identical either way. So
 * only these two columns are taken from the re-measurement, and the data file records which run each
 * came from rather than letting a reader assume one sitting produced all of it.
 */
function cacheOverrides(dir) {
    const overrides = new Map();
    for (const arm of ORDER) {
        const rows = [];
        for (const trialDir of trialDirs(path.join(dir, arm))) {
            const result = readJson(path.join(trialDir, "result.json"));
            const reward = result?.verifier_result?.rewards?.reward;
            if (reward === undefined || reward === null) {
                continue;
            }

            const agent = result.agent_result ?? {};
            rows.push({
                input: agent.n_input_tokens ?? 0,
                output: agent.n_output_tokens ?? 0,
                cache: agent.n_cache_tokens ?? 0,
            });
        }

        if (rows.length === 0) {
            continue;
        }

        const prompt = rows.reduce((total, row) => total + row.input, 0);
        overrides.set(arm, {
            attempts: rows.length,
            // Pooled, not a mean of per-trial ratios: the first request of any session has nothing
            // cached, so averaging ratios punishes whichever arm ran the shortest trials.
            cacheHitRate: prompt === 0 ? null : rows.reduce((total, row) => total + row.cache, 0) / prompt,
            cost: mean(rows.map((row) => price(row.input, row.output, row.cache))),
        });
    }

    return overrides;
}

function main() {
    const args = process.argv.slice(2);
    const cacheArg = args.find((argument) => argument.startsWith("--cache-run="));
    const sources = args
        .filter((argument) => !argument.startsWith("--"))
        .map((argument) => {
            const split = argument.lastIndexOf(":");
            // A drive letter is a colon too, so only a colon past the root separates the arm list.
            const hasArms = split > argument.indexOf(path.sep) && split > 2;
            const dir = hasArms ? argument.slice(0, split) : argument;
            const names = hasArms ? argument.slice(split + 1).split(",") : ORDER;

            return { dir: path.resolve(dir), names };
        });
    if (sources.length === 0) {
        throw new Error("usage: node scripts/tb-metrics.mjs [--cache-run=<dir>] <run-dir>[:arm,arm] ...");
    }

    const overrides = cacheArg ? cacheOverrides(path.resolve(cacheArg.slice("--cache-run=".length))) : new Map();

    const arms = collect(sources);
    const tasks = [...new Set([...arms.values()].flatMap((rows) => rows.map((row) => row.task)))].sort();
    const harnesses = [];
    for (const arm of ORDER) {
        const rows = arms.get(arm);
        if (rows.length === 0) {
            continue;
        }

        const tools = new Map();
        for (const row of rows) {
            for (const [name, count] of row.tools) {
                tools.set(name, (tools.get(name) ?? 0) + count);
            }
        }

        const totalCalls = [...tools.values()].reduce((total, count) => total + count, 0);
        const ranked = [...tools.entries()].sort((a, b) => b[1] - a[1]);
        const perTask = {};
        for (const task of tasks) {
            const sub = rows.filter((row) => row.task === task);
            if (sub.length === 0) {
                continue;
            }

            perTask[task] = {
                attempts: sub.length,
                solved: sub.filter((row) => row.solved).length,
                promptTokens: mean(sub.map((row) => row.input)),
                toolCalls: mean(sub.map((row) => row.toolCalls)),
                requests: mean(sub.map((row) => row.requests)),
                seconds: mean(sub.map((row) => row.seconds)),
            };
        }

        const override = overrides.get(arm);
        harnesses.push({
            id: arm,
            label: LABELS[arm],
            ...summarise(rows),
            // Replaced, not blended: the contaminated figures are wrong rather than noisy, and
            // averaging a wrong number with a right one produces a third wrong number.
            ...(override
                ? {
                      cacheHitRate: override.cacheHitRate,
                      cost: override.cost,
                      cacheAttempts: override.attempts,
                      cacheSource: "clean-session run",
                  }
                : { cacheHitRate: null, cost: null, cacheAttempts: 0, cacheSource: "not validly measured" }),
            // The distinct count is kept whole while the mix is truncated for display, so a reader
            // counting the shown entries cannot undercount a harness with a long tail of tools.
            toolsUsed: totalCalls === 0 ? null : tools.size,
            toolMix:
                totalCalls === 0
                    ? null
                    : Object.fromEntries(ranked.slice(0, 6).map(([name, count]) => [name, count / totalCalls])),
            perTask,
        });
    }

    const data = {
        generatedAt: new Date().toISOString().slice(0, 10),
        benchmark: "Terminal-Bench 2.0",
        model: MODEL,
        endpoint: "opencode.ai/zen/go",
        attemptsPerTask: 4,
        tasks,
        harnesses,
        advisor:
            sources
                .map((source) => (source.names.includes("jev") ? advisorLedger(path.join(source.dir, "jev")) : null))
                .find(Boolean) ?? null,
    };
    fs.writeFileSync(outFile, `${JSON.stringify(data, null, 2)}\n`);
    const attempts = harnesses.reduce((total, arm) => total + arm.attempts, 0);
    process.stdout.write(
        `tb metrics -> ${path.relative(root, outFile)} (${harnesses.length} harnesses, ${attempts} attempts, ${tasks.length} tasks)\n`,
    );
}

main();
