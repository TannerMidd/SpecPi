#!/usr/bin/env node
// Publish the tier 6 findings to the evaluations page.
//
// Tier 6 is the answer to the sentence the Terminal-Bench section ends on: that measuring an
// advisory layer over long sessions would need a suite built to contain those cases. This is that
// suite, and the thing that finally made it work was not a better task. It was declaring a 24,000
// token context window instead of growing the corpus past 200,000 -- an agent with a shell chunks
// or scripts rather than loading a large corpus, so the corpus never reached the model, while a
// small window overruns on the transcript itself and no shortcut avoids that.
//
// The figures come from site/evaluations/tier6.json, which scripts/tier6-metrics.mjs derives.
// Unlike the Terminal-Bench section this corpus is the repository's own, so the task content is in
// the tree and there is no canary to keep out of it.
//
// Usage: node scripts/tier6-metrics.mjs <run-dir>... && node scripts/tier6-site.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { esc, hbars, inject, table, thousands } from "./eval-site.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pageDir = path.join(root, "site", "evaluations");
const dataFile = path.join(pageDir, "tier6.json");
const pageFile = path.join(pageDir, "index.html");

// Same tokens as every other figure on the page, so a colour means one harness throughout.
const COLOURS = {
    pi: "var(--ct-pi)",
    "specpi-default": "var(--ct-specpi)",
    "specpi-jev": "var(--ct-specpi-jev)",
    omp: "var(--ct-omp)",
    codex: "var(--ct-codex)",
    opencode: "var(--ct-opencode)",
    dsh: "var(--ct-deepseek)",
};

const TASK_LABELS = {
    "t6-context-marathon": "marathon",
    "t6-retention-haystack": "haystack",
};

function niceMax(value, step) {
    return Math.max(step, Math.ceil(value / step) * step);
}

function renderCharts(data) {
    const arms = data.harnesses;

    // Compactions per attempt. This is the figure the whole tier exists for: every number in this
    // column was zero in every previously published run, because no session had ever compacted.
    const compactMax = niceMax(Math.max(...arms.map((arm) => arm.compactions ?? 0)), 5);

    return {
        "tier6-chart-compaction": hbars({
            id: "tier6-chart-compaction",
            title: "Compactions per attempt",
            axisLabel: "How often a session had to make room, at a 24,000-token window. Every other tier reports zero.",
            max: compactMax,
            tick: (value) => value.toFixed(0),
            groups: [
                {
                    bars: arms.map((arm) => ({
                        label: arm.label,
                        value: arm.compactions ?? 0,
                        colour: COLOURS[arm.id],
                        display: (arm.compactions ?? 0).toFixed(1),
                    })),
                },
            ],
        }),
    };
}

function renderTables(data) {
    const overall = table(
        ["Harness", "Attempts", "Solved", "Turns", "Compactions", "Reclaimed", "Peak prompt", "Cost/attempt"],
        data.harnesses.map((arm) => [
            esc(arm.label),
            `${arm.attempts}`,
            `${arm.solved}/${arm.attempts}`,
            (arm.turns ?? 0).toFixed(1),
            (arm.compactions ?? 0).toFixed(1),
            thousands(Math.round(arm.reclaimed ?? 0)),
            thousands(Math.round(arm.peakPromptTokens ?? 0)),
            arm.cost === null ? "&mdash;" : `$${arm.cost.toFixed(4)}`,
        ]),
    );

    // The pair comparison, with its p-value in the table rather than in prose. A reader who sees
    // "6/6 against 4/6" will form a conclusion before reaching any caveat underneath it, so the
    // number that governs whether the conclusion is allowed sits in the same row.
    const compare = table(
        ["Task", "SpecPi", "SpecPi + Jev", "Fisher exact p", "Reading"],
        Object.entries(data.comparison ?? {}).map(([task, cell]) => [
            esc(TASK_LABELS[task] ?? task),
            `${cell.base.solved}/${cell.base.n}`,
            `${cell.jev.solved}/${cell.jev.n}`,
            cell.p.toFixed(3),
            cell.p < 0.05 ? "difference is significant" : "cannot be told from chance",
        ]),
    );

    // Median beside mean wherever cost appears, because one attempt at $0.155 against a $0.037
    // median turned a 1.9x difference into a 2.8x one when only the mean was published.
    const cost = table(
        ["Harness", "Task", "Mean cost", "Median cost", "Turns", "Compactions", "No usable output"],
        data.harnesses.flatMap((arm) =>
            data.tasks
                .filter((task) => arm.perTask[task])
                .map((task) => {
                    const cell = arm.perTask[task];

                    return [
                        esc(arm.label),
                        esc(TASK_LABELS[task] ?? task),
                        cell.cost === null ? "&mdash;" : `$${cell.cost.toFixed(4)}`,
                        cell.costMedian === null ? "&mdash;" : `$${cell.costMedian.toFixed(4)}`,
                        (cell.turns ?? 0).toFixed(1),
                        (cell.compactions ?? 0).toFixed(1),
                        `${cell.noOutput}`,
                    ];
                }),
        ),
    );

    const advisor = table(
        ["System", "Question it answers", "Calls", "Applied", "Outcomes"],
        Object.entries(data.systems).map(([name, purpose]) => {
            const bucket = data.advisor.bySystem[name];
            if (!bucket) {
                return [esc(name), esc(purpose), "0", "0", "never invoked"];
            }

            const outcomes = Object.entries(bucket.outcomes)
                .map(([outcome, count]) => `${esc(outcome)} ${count}`)
                .join(", ");

            return [esc(name), esc(purpose), `${bucket.calls}`, `${bucket.applied}`, outcomes];
        }),
    );

    return {
        "tier6-table-overall": overall,
        "tier6-table-compare": compare,
        "tier6-table-cost": cost,
        "tier6-table-advisor": advisor,
    };
}

function main() {
    if (!fs.existsSync(dataFile)) {
        throw new Error(`missing ${path.relative(root, dataFile)}; run scripts/tier6-metrics.mjs first`);
    }

    const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    const slots = { ...renderCharts(data), ...renderTables(data) };
    fs.writeFileSync(pageFile, inject(fs.readFileSync(pageFile, "utf8"), slots));

    const attempts = data.harnesses.reduce((total, arm) => total + arm.attempts, 0);
    process.stdout.write(
        `tier6 site -> ${path.relative(root, pageFile)} ` +
            `(${data.harnesses.length} harnesses, ${attempts} attempts, ${data.totalCompactions} compactions)\n`,
    );
}

main();
