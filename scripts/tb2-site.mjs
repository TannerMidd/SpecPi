#!/usr/bin/env node
// Publish the Terminal-Bench 2.0 findings to the evaluations page.
//
// This is the whole of that page now. The tier suite that used to fill it was this repository's
// own, and it was retired for the reason it kept reporting: it was built to separate harnesses and
// mostly could not, because nearly everything passed. Terminal-Bench 2.0 is somebody else's
// benchmark with somebody else's tasks, which is the only kind of second opinion a suite cannot
// give itself.
//
// The figures come from site/evaluations/terminal-bench-2.json, which scripts/tb2-metrics.mjs
// derives from the runs. The runs are not in this repository and must not be, because the task
// content carries canary strings.
//
// Usage: node scripts/tb2-metrics.mjs && node scripts/tb2-site.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { esc, hbars, inject, table, thousands } from "./eval-site.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pageDir = path.join(root, "site", "evaluations");
const dataFile = path.join(pageDir, "terminal-bench-2.json");
const pageFile = path.join(pageDir, "index.html");
const readmeFile = path.join(root, "README.md");

function niceMax(value, step) {
    return Math.max(step, Math.ceil(value / step) * step);
}

const money = (value) => `$${value.toFixed(4)}`;
const percent = (value) => (value === null ? "not measured" : `${(value * 100).toFixed(1)}%`);

// One band per slice, one bar per harness inside it, so a harness keeps its colour and its position
// across every figure and the eye can carry a row from one chart to the next.
function bySlice(data, { id, title, axisLabel, value, display, step, tick, include = () => true }) {
    const groups = data.slices
        .map((slice) => ({
            label: `${slice.label} · ${sliceShape(data, slice.id)}`,
            bars: data.harnesses
                .filter((harness) => harness.slices[slice.id] && include(harness))
                .map((harness) => ({
                    label: harness.label,
                    value: value(harness.slices[slice.id]),
                    display: display(harness.slices[slice.id]),
                    colour: harness.colour,
                })),
        }))
        .filter((group) => group.bars.length > 0);
    const max = niceMax(Math.max(...groups.flatMap((group) => group.bars.map((bar) => bar.value))), step);

    return hbars({ id, title, axisLabel, groups, max, tick });
}

// "13 tasks × 3" reads as the shape of the work, which is what makes an unequal row obvious rather
// than buried: Oh My Pi ran the widened slice twice, and the band label is where that shows.
function sliceShape(data, sliceId) {
    const runs = data.harnesses.map((harness) => harness.slices[sliceId]).filter(Boolean);
    const tasks = Math.max(...runs.map((run) => run.tasks));
    const attempts = [...new Set(runs.map((run) => Math.round(run.attempts / run.tasks)))].sort((a, b) => a - b);

    return `${tasks} tasks × ${attempts.join(" and ")}`;
}

function renderCharts(data) {
    const charts = {};

    // Solve rate. The figure the benchmark exists for, and on this evidence the one that separates
    // the arms least: the whole spread is inside the interval any one row carries at this many
    // attempts, which is the point the prose beside it makes.
    charts["chart-solve"] = bySlice(data, {
        id: "chart-solve",
        title: "Solved, per attempt",
        axisLabel: "share of attempts reaching reward 1",
        value: (run) => run.rate,
        display: (run) => `${run.solved}/${run.attempts}`,
        step: 0.25,
        tick: (value) => `${Math.round(value * 100)}%`,
    });

    // Input tokens. This is where the arms actually differ, and by enough that it survives the
    // attempt counts that the solve rates do not.
    charts["chart-tokens"] = bySlice(data, {
        id: "chart-tokens",
        title: "Prompt tokens per attempt",
        axisLabel: "tokens sent, summed over the attempt's model calls",
        value: (run) => run.inputTokens,
        display: (run) => thousands(run.inputTokens),
        step: 250_000,
        tick: (value) => `${Math.round(value / 1000)}k`,
    });

    // Cost, measured rows only. An upper bound and a measurement do not belong on one scale: Claude
    // Code's bound is six times the largest measured value, so plotting it flattened the three real
    // bars into a smear and made the chart argue the opposite of what the run supports. The bound is
    // in the table and in the callout beside it, which is where a number that is not a measurement
    // can be read without being compared by eye against ones that are.
    charts["chart-cost"] = bySlice(data, {
        id: "chart-cost",
        title: "Cost per attempt",
        axisLabel: "USD at the frozen price list, for the rows whose cached share was recorded",
        value: (run) => run.cost,
        display: (run) => money(run.cost),
        step: 0.01,
        tick: (value) => `$${value.toFixed(3)}`,
        include: (harness) => !harness.overall.costIsUpperBound,
    });

    // Cache. One bar per harness rather than per slice: the rate barely moves between slices, and
    // the row worth seeing is the one that has no bar at all.
    const cached = data.harnesses.filter((harness) => harness.overall.cacheHitRate !== null);
    charts["chart-cache"] = hbars({
        id: "chart-cache",
        title: "Prompt cache hit rate",
        axisLabel: "cached share of prompt tokens, both slices pooled",
        groups: [
            {
                bars: cached.map((harness) => ({
                    label: harness.label,
                    value: harness.overall.cacheHitRate,
                    display: percent(harness.overall.cacheHitRate),
                    colour: harness.colour,
                })),
            },
        ],
        max: 1,
        tick: (value) => `${Math.round(value * 100)}%`,
    });

    return charts;
}

function renderTables(data) {
    const overall = table(
        ["Harness", "Solved", "Rate", "Prompt tok", "Output tok", "Cache hit", "Cost/attempt"],
        data.harnesses.map((harness) => [
            esc(harness.label),
            `${harness.overall.solved}/${harness.overall.attempts}`,
            harness.overall.rate.toFixed(3),
            thousands(harness.overall.inputTokens),
            thousands(harness.overall.outputTokens),
            percent(harness.overall.cacheHitRate),
            harness.overall.costIsUpperBound ? `${money(harness.overall.cost)} or less` : money(harness.overall.cost),
        ]),
    );

    // The widened slice only. The calibration slice is on the page as the reason the widened one
    // exists rather than as a result, and a task breakdown of it would invite reading it as one.
    const tasks = table(
        ["Task", ...data.harnesses.map((harness) => esc(harness.label))],
        data.tasks.map((entry) => [
            `<code>${esc(entry.task)}</code>`,
            ...data.harnesses.map((harness) => {
                const run = entry.byHarness[harness.id];
                if (!run) {
                    return "&mdash;";
                }

                const cell = `${run.solved}/${run.attempts}`;

                return run.solved === 0 ? `<strong>${cell}</strong>` : cell;
            }),
        ]),
    );

    return { "table-overall": overall, "table-tasks": tasks };
}

// The README carries the same headline as the page. Typing it by hand guarantees it drifts, so it
// gets the same marker treatment: one command updates both, or neither. Rows are ordered by cost,
// because the ordering by score is the one this run says not to read.
function renderReadme(data) {
    const rows = [...data.harnesses].sort((a, b) => a.overall.cost - b.overall.cost);
    const cell = (harness) => [
        harness.label,
        `${harness.overall.solved}/${harness.overall.attempts}`,
        harness.overall.rate.toFixed(3),
        harness.overall.costIsUpperBound ? `${money(harness.overall.cost)} or less` : money(harness.overall.cost),
        thousands(harness.overall.inputTokens),
        percent(harness.overall.cacheHitRate),
    ];

    return [
        `**${data.totalAttempts} scored attempts across ${data.taskCount} tasks and ${data.harnesses.length} harnesses**,`,
        `all on \`${data.model}\`.`,
        "",
        "| Harness | Solved | Rate | Cost/attempt | Prompt tokens | Cache hit |",
        "| --- | --- | --- | --- | --- | --- |",
        ...rows.map((harness) => `| ${cell(harness).join(" | ")} |`),
        "",
        "Solve rate does not separate these harnesses -- Pi against SpecPi + Jev is Fisher",
        "p = 0.83 -- so the column worth reading is what each one spent reaching the same",
        "answers. Cost is recomputed from recorded tokens against a dated price file, never",
        "taken from a harness's self-report. Claude Code's cached share was not recorded on",
        "this run, so its cost is an upper bound.",
    ].join("\n");
}

function main() {
    const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    const page = fs.readFileSync(pageFile, "utf8");
    const filled = inject(page, { ...renderCharts(data), ...renderTables(data) });
    fs.writeFileSync(pageFile, filled);

    const readme = fs.readFileSync(readmeFile, "utf8");
    fs.writeFileSync(readmeFile, inject(readme, { "eval-summary": `\n\n${renderReadme(data)}\n\n` }));
    process.stdout.write(
        `Terminal-Bench 2.0: ${data.harnesses.length} harnesses, ${data.totalAttempts} attempts -> ${path.relative(root, pageFile)}\n`,
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
