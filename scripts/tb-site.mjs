#!/usr/bin/env node
// Publish the Terminal-Bench findings to the evaluations page.
//
// The tier suite on that page is this repository's own, and it says so: it was built to separate
// harnesses and mostly could not, because nearly everything passed. Terminal-Bench is somebody
// else's benchmark with somebody else's tasks, which is the only reason it is worth the section --
// a suite cannot mark its own homework, and a second opinion from tasks nobody here chose is the
// closest thing to an outside check this page has.
//
// The figures come from site/evaluations/terminal-bench.json, which scripts/tb-metrics.mjs derives
// from the run. The run itself is not in this repository and must not be: Terminal-Bench task content
// carries canary strings that are not supposed to enter a training corpus, so only aggregates and
// public task names cross into the data file.
//
// Usage: node scripts/tb-metrics.mjs <run-dir>[:arm,arm] ... && node scripts/tb-site.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { esc, hbars, inject, table, thousands } from "./eval-site.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pageDir = path.join(root, "site", "evaluations");
const dataFile = path.join(pageDir, "terminal-bench.json");
const pageFile = path.join(pageDir, "index.html");

// Same tokens as the tier charts, so a colour means one harness across the whole page. Two arms here
// have no tier-suite counterpart: Pi (base) is the floor the Pi-derived harnesses are measured
// against, and it borrows Pi's colour because it is Pi.
const COLOURS = {
    pi: "var(--ct-pi)",
    control: "var(--ct-specpi)",
    jev: "var(--ct-specpi-jev)",
    omp: "var(--ct-omp)",
    codex: "var(--ct-codex)",
    opencode: "var(--ct-opencode)",
    dsh: "var(--ct-deepseek)",
};

function niceMax(value, step) {
    return Math.max(step, Math.ceil(value / step) * step);
}

function renderCharts(data) {
    const arms = data.harnesses;
    const charts = {};

    // Context per attempt. This is the figure the section exists for: the arms agree closely on how
    // many tool calls a task takes and disagree by more than two to one on what each call costs to
    // send, so the spread here is overhead rather than effort.
    const contextMax = niceMax(Math.max(...arms.map((a) => a.promptTokens)), 100_000);
    charts["tb-chart-context"] = hbars({
        id: "tb-chart-context",
        title: "Prompt tokens per attempt",
        axisLabel: "Mean prompt tokens per attempt, cache reads included. Lower is lighter.",
        max: contextMax,
        tick: (value) => `${Math.round(value / 1000)}k`,
        groups: [
            {
                bars: arms.map((arm) => ({
                    label: arm.label,
                    value: arm.promptTokens,
                    colour: COLOURS[arm.id],
                    display: thousands(arm.promptTokens),
                })),
            },
        ],
    });

    // Tool calls beside requests. Drawn together because apart they mislead: a harness can look busy
    // on calls and idle on requests, and what a reader wants is whether it is doing more work or
    // merely taking more turns to do the same work.
    const callMax = niceMax(Math.max(...arms.map((a) => Math.max(a.toolCalls ?? 0, a.requests ?? 0))), 5);
    charts["tb-chart-calls"] = hbars({
        id: "tb-chart-calls",
        title: "Tool calls and model requests per attempt",
        axisLabel: "Solid is tool calls, pale is model requests. DSH prints prose, so its calls cannot be counted.",
        max: callMax,
        tick: (value) => value.toFixed(0),
        groups: arms.map((arm) => ({
            label: arm.label,
            bars: [
                {
                    label: "tool calls",
                    value: arm.toolCalls ?? 0,
                    colour: COLOURS[arm.id],
                    display: arm.toolCalls === null ? "not recoverable" : arm.toolCalls.toFixed(1),
                },
                {
                    label: "requests",
                    value: arm.requests ?? 0,
                    // Dimming goes on a segment, not the bar: hbars fills a bare bar at full opacity
                    // and drops a bar-level opacity, which renders the two rows indistinguishable.
                    segments: [{ value: arm.requests ?? 0, colour: COLOURS[arm.id], opacity: ".42" }],
                    colour: COLOURS[arm.id],
                    display: arm.requests === null ? "-" : arm.requests.toFixed(1),
                },
            ],
        })),
    });

    // Tokens per request isolates the overhead the other two charts only imply: it is what a harness
    // spends to ask one question, with the number of questions divided out.
    const perCallMax = niceMax(Math.max(...arms.map((a) => a.tokensPerRequest ?? 0)), 5000);
    charts["tb-chart-overhead"] = hbars({
        id: "tb-chart-overhead",
        title: "Prompt tokens per model request",
        axisLabel: "Context sent per request, with the number of requests divided out.",
        max: perCallMax,
        tick: (value) => `${Math.round(value / 1000)}k`,
        groups: [
            {
                bars: arms.map((arm) => ({
                    label: arm.label,
                    value: arm.tokensPerRequest ?? 0,
                    colour: COLOURS[arm.id],
                    display: thousands(arm.tokensPerRequest ?? 0),
                })),
            },
        ],
    });

    return charts;
}

// What each Jev system is for, so a row of zeroes reads as "the situation did not arise" rather than
// "the system did nothing". Wording follows each question module's own header.
const SYSTEMS = {
    retention: "Is this large tool result worth carrying for the rest of the session?",
    compaction: "Where should a compaction cut, given the cache is discarded anyway?",
    gap: "Is this capability-gap report worth writing?",
    sources: "Which files should a delegation batch snapshot?",
    progress: "Has the session stopped making progress?",
    capabilities: "Will this session need a withdrawn tool group?",
    untrusted: "Is this fetched content addressing the agent rather than a reader?",
    guard: "Should this shell or file call run, where local rules could not settle it?",
};

function renderAdvisor(advisor) {
    if (!advisor) {
        return table(
            ["System", "Question it answers", "Calls", "Applied"],
            [["&mdash;", "no ledger in this run", "0", "0"]],
        );
    }

    // Every system is listed, including the five that were never asked anything. Showing only the
    // three that fired would hide the more useful fact: most of this layer had no occasion to act.
    return table(
        ["System", "Question it answers", "Calls", "Applied", "Outcomes"],
        Object.entries(SYSTEMS).map(([name, purpose]) => {
            const bucket = advisor.bySystem[name];
            if (!bucket) {
                return [esc(name), esc(purpose), "0", "0", "never invoked"];
            }

            const outcomes = Object.entries(bucket.outcomes)
                .map(([outcome, count]) => `${esc(outcome)} ${count}`)
                .join(", ");

            return [esc(name), esc(purpose), `${bucket.calls}`, `${bucket.applied}`, outcomes];
        }),
    );
}

function renderTables(data) {
    const overall = table(
        [
            "Harness",
            "Solved",
            "Prompt tok",
            "Output tok",
            "Cache hit *",
            "Cost/attempt *",
            "Tool calls",
            "Requests",
            "Tok/request",
            "Agent sec",
        ],
        data.harnesses.map((arm) => [
            esc(arm.label),
            `${arm.solved}/${arm.attempts}`,
            thousands(arm.promptTokens),
            thousands(arm.outputTokens),
            // Null rather than zero when a run had no valid cache measurement: a 0% cache hit is a
            // claim about a harness, and "we did not measure this" is not that claim.
            arm.cacheHitRate === null ? "not measured" : `${(arm.cacheHitRate * 100).toFixed(0)}%`,
            arm.cost === null ? "not measured" : `$${arm.cost.toFixed(4)}`,
            arm.toolCalls === null ? "not recoverable" : arm.toolCalls.toFixed(1),
            arm.requests === null ? "&mdash;" : arm.requests.toFixed(1),
            thousands(arm.tokensPerRequest ?? 0),
            (arm.seconds ?? 0).toFixed(0),
        ]),
    );

    // The mix is the one place a harness's shape shows rather than its size: Codex routes almost
    // everything through one command tool, Oh My Pi spreads the same work over five.
    const mix = table(
        ["Harness", "Distinct tools", "Share of calls"],
        data.harnesses.map((arm) => {
            if (!arm.toolMix) {
                return [esc(arm.label), "not recoverable", "&mdash;"];
            }

            // toolsUsed rather than the length of the mix: the mix is truncated for display, so
            // counting its entries silently undercuts any harness with a long tail.
            const entries = Object.entries(arm.toolMix);
            const shown = entries.map(([name, share]) => `${esc(name)} ${(share * 100).toFixed(0)}%`).join(", ");
            const more = arm.toolsUsed > entries.length ? `, +${arm.toolsUsed - entries.length} more` : "";

            return [esc(arm.label), `${arm.toolsUsed}`, shown + more];
        }),
    );

    const perTask = table(
        ["Task", ...data.harnesses.map((arm) => esc(arm.label))],
        data.tasks.map((task) => [
            esc(task),
            ...data.harnesses.map((arm) => {
                const cell = arm.perTask[task];
                if (!cell) {
                    return "&mdash;";
                }

                return `${cell.solved}/${cell.attempts} · ${thousands(cell.promptTokens)}`;
            }),
        ]),
    );

    return {
        "tb-table-overall": overall,
        "tb-table-mix": mix,
        "tb-table-task": perTask,
        "tb-table-advisor": renderAdvisor(data.advisor),
    };
}

function main() {
    if (!fs.existsSync(dataFile)) {
        throw new Error(`missing ${path.relative(root, dataFile)}; run specpi_harbor/metrics7.py first`);
    }

    const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    const slots = { ...renderCharts(data), ...renderTables(data) };
    fs.writeFileSync(pageFile, inject(fs.readFileSync(pageFile, "utf8"), slots));

    const attempts = data.harnesses.reduce((total, arm) => total + arm.attempts, 0);
    process.stdout.write(
        `tb site -> ${path.relative(root, pageFile)} (${data.harnesses.length} harnesses, ${attempts} attempts, ${data.tasks.length} tasks)\n`,
    );
}

main();
