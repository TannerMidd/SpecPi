#!/usr/bin/env node
// Publish the harness-eval findings to the site, from the run reports.
//
// One command derives the dataset and redraws every figure on the evaluations
// page, so a new run cannot leave a chart disagreeing with the table beside it.
// The numbers live in site/evaluations/harness-eval.json, which the page links
// as the machine-readable record; the charts are injected into the page between
// marker comments so the prose stays hand-written.
//
// Usage: node scripts/eval-site.mjs [report.json...]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { attemptMintCost, attemptModelCost, attemptScore, attemptToolCounts, usageSummary } from "./eval-report.mjs";
import { attemptTurns } from "./eval-proxy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pageDir = path.join(root, "site", "evaluations");

// Named explicitly rather than globbed. evals/runs/ also holds older runs on
// other models and other harness sets, and a pattern like tier2-* sweeps those
// in: it once counted a retired OpenCode run twice and inflated its attempts
// from 25 to 57 without anything looking wrong.
const DEFAULT_REPORTS = [
    // One complete matrix: every harness, every tier, one model, one sitting. It replaces the
    // patchwork of per-tier-per-harness runs this page grew from, where tier 4 covered four of
    // seven harnesses and tier 5 had never run at all, so no two rows were guaranteed to have
    // faced the same work. The superseded runs stay in evals/runs as history; naming this set
    // explicitly is what stops a glob sweeping them back in.
    ...[1, 2, 3, 4, 5].map((tier) => path.join(root, "evals", "runs", `full-tier${tier}`, "report.json")),
];

// Fixed per harness so a colour means the same thing on every surface; these
// mirror the tokens in site/research.css.
const HARNESSES = [
    { id: "pi", label: "Pi", colour: "var(--ct-pi)" },
    { id: "specpi-default", label: "SpecPi", colour: "var(--ct-specpi)" },
    { id: "specpi-jev", label: "SpecPi + Jev", colour: "var(--ct-specpi-jev)" },
    { id: "opencode", label: "OpenCode", colour: "var(--ct-opencode)" },
    { id: "codex", label: "Codex CLI", colour: "var(--ct-codex)" },
    { id: "omp", label: "Oh My Pi", colour: "var(--ct-omp)" },
    { id: "dsh", label: "DeepSeek Harness", colour: "var(--ct-deepseek)" },
];

const TIER_NAME = {
    1: "Tier 1 · smoke",
    2: "Tier 2 · edits",
    3: "Tier 3 · repair",
    4: "Tier 4 · ultimate",
    5: "Tier 5 · discipline",
};

function mean(values) {
    return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function sum(values) {
    return values.reduce((total, value) => total + value, 0);
}

// The harness's own spend. The session mint is eval scaffolding that only proxy
// harnesses need, so it is reported beside the figure and never inside it.
function attemptSpend(attempt) {
    return attemptModelCost(attempt) ?? 0;
}

// An attempt that errored before making a single model call never ran the
// task, so scoring it as a failure blames the harness for the eval's own
// plumbing. Parallel runs made this real: contention on OpenCode's shared
// session store produced attempts with zero requests that then read as
// losses. These are counted and reported separately, never averaged in.
export function isLaunchFailure(attempt) {
    return Boolean(attempt?.harnessError) && (attempt?.modelRequests ?? 0) === 0;
}

export function collect(files) {
    const reports = files.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
    const cells = reports.flatMap((report) => report.results);
    const meta = reports[reports.length - 1];
    // The page states one model and prices every row against it, so a set spanning two models
    // would publish one label over both. The comment below records this being caught once for
    // attempts per cell; model had the same shape and no guard. Refusing is right rather than
    // picking a winner: a mixed set is a question about which run to publish, not a rendering
    // detail, and the answer is the caller's.
    const models = [...new Set(reports.map((report) => report.model))].sort();
    if (models.length > 1) {
        throw new Error(
            `reports span ${models.length} models (${models.join(", ")}); ` +
                "render one model at a time, because the page labels and prices every row as one",
        );
    }

    const tiers = [...new Set(cells.map((cell) => cell.tier))].sort((a, b) => a - b);
    // Reports differ in how many attempts they ran and in whether their time
    // budget was shortened, and one global figure taken from whichever file
    // sorted last is wrong for every other file — it once published "one
    // attempt per cell" for tiers that ran three, because a later scouting
    // run happened to be read last. Per tier, which is the grain a reader
    // compares at.
    const attemptsPerTier = {};
    const timeoutPerTier = {};
    for (const tier of tiers) {
        const owning = reports.filter((report) => report.results.some((cell) => cell.tier === tier));
        attemptsPerTier[tier] = [...new Set(owning.map((report) => report.attemptsPerCell))].sort((a, b) => a - b);
        const overrides = [...new Set(owning.map((report) => report.timeoutOverrideMs ?? null))];
        timeoutPerTier[tier] = overrides.length === 1 ? overrides[0] : null;
    }

    const tasksByTier = new Map(
        tiers.map((tier) => [tier, [...new Set(cells.filter((cell) => cell.tier === tier).map((cell) => cell.task))]]),
    );

    const harnesses = HARNESSES.map((harness) => {
        const own = cells.filter((cell) => cell.harness === harness.id);
        const perTier = {};
        for (const tier of tiers) {
            // Paired with their task id: rescoring an attempt needs the task's demonstrated
            // tool-call floor, which flatMapping the attempts on their own throws away.
            const attempts = own
                .filter((cell) => cell.tier === tier)
                .flatMap((cell) => cell.attempts.map((attempt) => ({ attempt, task: cell.task })));
            const usable = attempts.filter((entry) => !isLaunchFailure(entry.attempt));
            if (attempts.length === 0) {
                continue;
            }

            const plain = usable.map((entry) => entry.attempt);
            const usage = usageSummary(plain);
            perTier[tier] = {
                attempts: usable.length,
                launchFailures: attempts.length - usable.length,
                solved: plain.filter((attempt) => attempt.pass).length,
                score: mean(usable.map((entry) => attemptScore(entry.attempt, entry.task))),
                correctness: mean(plain.map((attempt) => attemptScore(attempt))),
                cost: mean(plain.map((attempt) => attemptSpend(attempt))),
                mintCost: mean(plain.map((attempt) => attemptMintCost(attempt) ?? 0)),
                promptTokens: usage.meanInputTokens,
                outputTokens: usage.meanOutputTokens,
                cacheHitRate: usage.cacheHitRate,
                toolCalls: usage.meanToolCalls,
                requests: mean(plain.map((attempt) => attemptTurns(attempt))),
                seconds: mean(plain.map((attempt) => (attempt.durationMs ?? 0) / 1000)),
            };
        }

        const every = own.flatMap((cell) => cell.attempts.map((attempt) => ({ attempt, task: cell.task })));
        const paired = every.filter((entry) => !isLaunchFailure(entry.attempt));
        const all = paired.map((entry) => entry.attempt);
        const usage = usageSummary(all);
        // Reports written before the proxy could tell an offer from a call
        // record offers only. Averaging those in would publish one harness's
        // offers as another's calls, so an unmeasured run reports null.
        const counts = all.map((attempt) => attemptToolCounts(attempt));
        const measured = counts.filter((count) => count.callsMeasured);
        // A first call is the harness's fixed overhead: the same schema and
        // instructions ride every request in the run. A native harness never
        // sends one through the proxy, so it has no character count here.
        const first = all.map((attempt) => attempt.firstCall).filter((call) => call && call.toolSchemaChars > 2);
        const scopeChecked = all.filter((attempt) => attempt.scope);
        const outcomes = all.map((attempt) => attempt.toolOutcomes).filter(Boolean);
        const contexts = all.map((attempt) => attempt.context).filter(Boolean);

        return {
            id: harness.id,
            label: harness.label,
            colour: harness.colour,
            native: Boolean(all[0]?.native),
            perTier,
            overall: {
                attempts: all.length,
                launchFailures: every.length - all.length,
                solved: all.filter((attempt) => attempt.pass).length,
                score: mean(paired.map((entry) => attemptScore(entry.attempt, entry.task))),
                correctness: mean(all.map((attempt) => attemptScore(attempt))),
                cost: mean(all.map((attempt) => attemptSpend(attempt))),
                mintCost: mean(all.map((attempt) => attemptMintCost(attempt) ?? 0)),
                promptTokens: usage.meanInputTokens,
                outputTokens: usage.meanOutputTokens,
                cacheHitRate: usage.cacheHitRate,
                toolCalls: measured.length === counts.length ? usage.meanToolCalls : null,
                toolsOffered:
                    measured.length === 0 ? null : mean(measured.map((count) => sum(Object.values(count.offers)))),
                requests: mean(all.map((attempt) => attemptTurns(attempt))),
                seconds: mean(all.map((attempt) => (attempt.durationMs ?? 0) / 1000)),
                cleanScope: scopeChecked.filter((attempt) => attempt.scope.clean).length,
                scopeChecked: scopeChecked.length,
                // Effort, not just spend. A harness is not efficient because it was cheap: it is
                // efficient when it reaches the same result with fewer calls, fewer turns, fewer
                // errors to recover from and less context carried. Each of these is collected per
                // attempt already and was being aggregated nowhere.
                toolResults: sum(outcomes.map((entry) => entry.results ?? 0)),
                toolErrors: sum(outcomes.map((entry) => entry.errors ?? 0)),
                repeatedCalls: sum(outcomes.map((entry) => entry.repeatedCalls ?? 0)),
                // Null rather than zero for a native harness: it never crosses the proxy, so its
                // context is unobserved, and publishing 0 would read as "never grew".
                contextGrowth:
                    contexts.length === 0 ? null : mean(contexts.map((entry) => entry.growthPerRequest ?? 0)),
                peakContext: contexts.length === 0 ? null : mean(contexts.map((entry) => entry.peakPromptTokens ?? 0)),
                compactions: contexts.length === 0 ? null : sum(contexts.map((entry) => entry.compactions ?? 0)),
            },
            firstCall:
                first.length === 0
                    ? null
                    : {
                          toolCount: first[0].toolCount,
                          toolNames: first[0].toolNames,
                          toolSchemaChars: first[0].toolSchemaChars,
                          instructionChars: first[0].instructionChars,
                      },
        };
    }).filter((harness) => harness.overall.attempts > 0);

    return {
        generatedAt: new Date().toISOString().slice(0, 10),
        model: meta.model,
        specpiVersion: meta.specpiVersion,
        piVersion: meta.piVersion,
        platform: meta.platform,
        pricesDated: meta.pricesDated,
        attemptsPerCell: meta.attemptsPerCell,
        attemptsPerTier,
        timeoutPerTier,
        tiers,
        taskCount: sum(tiers.map((tier) => tasksByTier.get(tier).length)),
        tasksByTier: Object.fromEntries(tiers.map((tier) => [tier, tasksByTier.get(tier)])),
        totalAttempts: sum(harnesses.map((harness) => harness.overall.attempts)),
        harnesses,
    };
}

/* ---------- charts ---------- */

const WIDTH = 720;
const LEFT = 150;
const PLOT = 440;
const VALUE_GAP = 8;

export function esc(text) {
    return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function niceMax(value, step) {
    return Math.max(step, Math.ceil(value / step) * step);
}

// One horizontal bar renderer for every figure. A group is a labelled band of
// bars sharing the chart's scale; a bar may be split into segments so a stacked
// breakdown uses the same axis and the same spacing as a plain one.
export function hbars({ id, title, axisLabel, groups, max, gridStep, tick, barHeight = 17, gap = 5, groupGap = 14 }) {
    const parts = [];
    const legendY = 6;
    const axisY = legendY + 28;
    let y = axisY + 12;
    const rows = [];
    for (const group of groups) {
        if (group.label) {
            rows.push({ kind: "label", y, text: group.label });
            y += 19;
        }

        for (const bar of group.bars) {
            rows.push({ kind: "bar", y, bar });
            y += barHeight + gap;
        }

        y += groupGap;
    }

    const plotBottom = y - groupGap - gap + 4;
    const height = plotBottom + 36;
    const scale = (value) => (Math.max(0, value) / max) * PLOT;
    const at = (value) => (LEFT + scale(value)).toFixed(1);

    parts.push(`<text x="0" y="${legendY + 12}" class="ct-lb">${esc(title)}</text>`);
    for (let index = 0; index <= 4; index += 1) {
        const value = (max / 4) * index;
        const x = at(value);
        parts.push(
            `<line x1="${x}" y1="${axisY}" x2="${x}" y2="${plotBottom}" stroke="var(--line)" opacity="${value === 0 ? ".85" : ".45"}" />`,
        );
        parts.push(
            `<text x="${x}" y="${plotBottom + 17}" text-anchor="middle" class="ct-ax">${esc(tick(value))}</text>`,
        );
    }

    for (const row of rows) {
        if (row.kind === "label") {
            parts.push(`<text x="0" y="${row.y + 12}" class="ct-row">${esc(row.text)}</text>`);
            continue;
        }

        const { bar } = row;
        const segments = bar.segments ?? [{ value: bar.value, colour: bar.colour, opacity: "1" }];
        let cursor = 0;
        for (const segment of segments) {
            const raw = scale(segment.value) - (segments.length > 1 ? 2 : 0);
            const width = segment.value > 0 ? Math.max(2, raw) : 0;
            if (width > 0) {
                parts.push(
                    `<rect x="${at(cursor)}" y="${row.y}" width="${width.toFixed(1)}" height="${barHeight}" rx="2" fill="${segment.colour}" opacity="${segment.opacity ?? "1"}" />`,
                );
            }

            cursor += segment.value;
        }

        parts.push(
            `<text x="${LEFT - 10}" y="${row.y + barHeight - 4}" text-anchor="end" class="ct-sub">${esc(bar.label)}</text>`,
        );
        parts.push(
            `<text x="${(LEFT + scale(bar.value) + VALUE_GAP).toFixed(1)}" y="${row.y + barHeight - 4}" class="ct-val">${esc(bar.display)}</text>`,
        );
    }

    parts.push(`<text x="0" y="${height - 6}" class="ct-ax">${esc(axisLabel)}</text>`);

    return `<svg class="chart" id="${id}" viewBox="0 0 ${WIDTH} ${height}" role="img" preserveAspectRatio="xMidYMid meet" aria-label="${esc(title)}">${parts.join("")}</svg>`;
}

export const thousands = (value) => value.toLocaleString("en-US", { maximumFractionDigits: 0 });

export function renderCharts(data) {
    const charts = {};
    const byTier = (tier) => data.harnesses.filter((harness) => harness.perTier[tier]);

    // Solve rate. The point of this figure is that it is flat: a metric that
    // cannot separate its subjects is a finding about the metric, not a gap in
    // the table, so it is published rather than quietly dropped.
    charts["chart-solve"] = hbars({
        id: "chart-solve",
        title: "Tasks solved",
        axisLabel: "Share of attempts passing the task checker",
        max: 100,
        gridStep: 25,
        tick: (value) => `${value.toFixed(0)}%`,
        groups: data.tiers.map((tier) => ({
            label: TIER_NAME[tier],
            bars: byTier(tier).map((harness) => {
                const cell = harness.perTier[tier];
                const rate = (cell.solved / cell.attempts) * 100;

                return {
                    label: harness.label,
                    value: rate,
                    colour: harness.colour,
                    display: `${rate.toFixed(0)}%  ${cell.solved}/${cell.attempts}`,
                };
            }),
        })),
    });

    const costMax = niceMax(
        Math.max(...data.harnesses.flatMap((harness) => data.tiers.map((tier) => harness.perTier[tier]?.cost ?? 0))),
        0.005,
    );
    charts["chart-cost"] = hbars({
        id: "chart-cost",
        title: "Model spend per attempt",
        axisLabel: "US dollars per attempt · same model, same tasks, same frozen price list",
        max: costMax,
        tick: (value) => `$${value.toFixed(3)}`,
        groups: data.tiers.map((tier) => ({
            label: TIER_NAME[tier],
            bars: byTier(tier).map((harness) => ({
                label: harness.label,
                value: harness.perTier[tier].cost,
                colour: harness.colour,
                display: `$${harness.perTier[tier].cost.toFixed(4)}`,
            })),
        })),
    });

    // Fixed overhead. OpenCode is absent by necessity, not by choice: it never
    // sends its prompt through the proxy, so there is no character count to put
    // on this axis and an invented one would be worse than a gap.
    const schema = data.harnesses.filter((harness) => harness.firstCall);
    const schemaMax = niceMax(
        Math.max(...schema.map((harness) => harness.firstCall.toolSchemaChars + harness.firstCall.instructionChars)),
        8000,
    );
    charts["chart-schema"] = hbars({
        id: "chart-schema",
        title: "Characters sent on every model call, before any work happens",
        axisLabel: "Tool schemas (solid) plus system instructions (dimmed)",
        max: schemaMax,
        tick: (value) => thousands(value),
        barHeight: 22,
        gap: 9,
        groups: [
            {
                bars: schema.map((harness) => ({
                    label: `${harness.label} · ${harness.firstCall.toolCount} tools`,
                    value: harness.firstCall.toolSchemaChars + harness.firstCall.instructionChars,
                    colour: harness.colour,
                    display: thousands(harness.firstCall.toolSchemaChars + harness.firstCall.instructionChars),
                    segments: [
                        { value: harness.firstCall.toolSchemaChars, colour: harness.colour, opacity: "1" },
                        { value: harness.firstCall.instructionChars, colour: harness.colour, opacity: ".42" },
                    ],
                })),
            },
        ],
    });

    const tokenMax = niceMax(Math.max(...data.harnesses.map((harness) => harness.overall.promptTokens)), 20000);
    charts["chart-tokens"] = hbars({
        id: "chart-tokens",
        title: "Prompt tokens per attempt, all tiers",
        axisLabel: "Mean prompt tokens, cache rereads included",
        max: tokenMax,
        tick: (value) => thousands(value),
        barHeight: 22,
        gap: 9,
        groups: [
            {
                bars: data.harnesses.map((harness) => ({
                    label: harness.label,
                    value: harness.overall.promptTokens,
                    colour: harness.colour,
                    display: thousands(harness.overall.promptTokens),
                })),
            },
        ],
    });

    // Offered against invoked, excluding native harnesses for the same reason
    // as the schema chart: the proxy never sees their tool list.
    const offered = data.harnesses.filter(
        (harness) => harness.overall.toolsOffered > 0 && harness.overall.toolCalls !== null,
    );
    const offerMax = niceMax(Math.max(...offered.map((harness) => harness.overall.toolsOffered)), 20);
    charts["chart-tools"] = hbars({
        id: "chart-tools",
        title: "Tool definitions offered against tool calls actually made",
        axisLabel: "Per attempt: definitions sent (solid) and calls invoked (dimmed)",
        max: offerMax,
        tick: (value) => thousands(value),
        barHeight: 15,
        gap: 4,
        groupGap: 12,
        groups: offered.map((harness) => ({
            label: harness.label,
            bars: [
                {
                    label: "offered",
                    value: harness.overall.toolsOffered,
                    colour: harness.colour,
                    display: harness.overall.toolsOffered.toFixed(1),
                },
                {
                    label: "invoked",
                    value: harness.overall.toolCalls,
                    colour: harness.colour,
                    display: harness.overall.toolCalls.toFixed(1),
                    segments: [{ value: harness.overall.toolCalls, colour: harness.colour, opacity: ".42" }],
                },
            ],
        })),
    });

    return charts;
}

/* ---------- tables ---------- */

export function table(head, rows, className = "numeric") {
    const header = head.map((cell) => `<th>${esc(cell)}</th>`).join("");
    const body = rows
        .map(
            (row) =>
                `<tr>${row.map((cell, index) => (index === 0 ? `<th>${cell}</th>` : `<td>${cell}</td>`)).join("")}</tr>`,
        )
        .join("");

    return `<table class="${className}"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

export function renderTables(data) {
    const pct = (value) => (value === null ? "not measured" : `${(value * 100).toFixed(0)}%`);
    const overall = table(
        ["Harness", "Solved", "Score", "Cost/attempt", "Prompt tok", "Output tok", "Cache hit", "Calls", "In scope"],
        data.harnesses.map((harness) => {
            const cell = harness.overall;

            return [
                esc(harness.label),
                `${cell.solved}/${cell.attempts}`,
                cell.score.toFixed(3),
                `$${cell.cost.toFixed(4)}`,
                thousands(cell.promptTokens),
                thousands(cell.outputTokens),
                pct(cell.cacheHitRate),
                cell.toolCalls === null ? "not measured" : cell.toolCalls.toFixed(1),
                `${cell.cleanScope}/${cell.scopeChecked}`,
            ];
        }),
    );

    // Spend relative to the cheapest harness in each tier, which is what shows
    // the fixed overhead washing out as the tasks get bigger.
    const ratio = table(
        ["Harness", ...data.tiers.map((tier) => `Tier ${tier}`)],
        data.harnesses.map((harness) => [
            esc(harness.label),
            ...data.tiers.map((tier) => {
                const own = harness.perTier[tier];
                if (!own) {
                    return "not measured";
                }

                const cheapest = Math.min(
                    ...data.harnesses.map((entry) => entry.perTier[tier]?.cost ?? Number.POSITIVE_INFINITY),
                );

                return `${(own.cost / cheapest).toFixed(2)}&times;`;
            }),
        ]),
    );

    // Cost is one way to be inefficient and the least diagnostic: it is the sum of everything
    // else. This table keeps the components apart, because they say different things about a
    // harness. Calls and turns are how much work it took to get there. Tool errors and repeated
    // calls are whether it recovered or spiralled. Cache hit rate and context growth are what it
    // carries on every request thereafter, which is what the fresh-token bill is made of.
    const rate = (part, whole) => (whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "&mdash;");
    const efficiency = table(
        [
            "Harness",
            "Score",
            "Tool calls",
            "Turns",
            "Tool errors",
            "Repeated calls",
            "Cache hit",
            "Context growth / turn",
            "Compactions",
            "Score per 100 calls",
        ],
        data.harnesses.map((harness) => {
            const own = harness.overall;
            const calls = own.toolCalls;

            return [
                esc(harness.label),
                own.score.toFixed(3),
                calls === null ? "not measured" : calls.toFixed(1),
                own.requests.toFixed(1),
                rate(own.toolErrors, own.toolResults),
                String(own.repeatedCalls),
                pct(own.cacheHitRate),
                own.contextGrowth === null ? "not measured" : thousands(own.contextGrowth),
                own.compactions === null ? "not measured" : String(own.compactions),
                calls === null || calls === 0 ? "not measured" : ((100 * own.score) / calls).toFixed(1),
            ];
        }),
    );

    return { "table-overall": overall, "table-ratio": ratio, "table-efficiency": efficiency };
}

/**
 * The failure-mode distribution, from `node scripts/jev-triage.mjs`. "Codex fails 7 of 37" is a
 * count; this is what a page can say about why.
 *
 * Two things this table is careful about. Every verdict here went through the same gate a session
 * would use, and an answer that did not clear it is published as `ungated` rather than rounded into
 * the nearest mode -- 14 of 24 did not clear it, and a distribution that hid that would be claiming
 * a confidence the classifier never reported. And `unknown` is a real option the classifier chose,
 * which is a different statement from `ungated`: one says the evidence does not determine it, the
 * other says the model would not commit.
 */
export function renderFailureModes(triage) {
    const total = triage.classified.length;
    const share = (count) => (total > 0 ? `${((100 * count) / total).toFixed(0)}%` : "&mdash;");
    const harnessesFor = (mode) => [
        ...new Set(triage.classified.filter((item) => item.mode === mode).map((item) => item.harness)),
    ];
    const rows = Object.entries(triage.byMode)
        .sort((a, b) => b[1] - a[1])
        .map(([mode, count]) => [
            esc(mode),
            String(count),
            share(count),
            esc(harnessesFor(mode).sort().join(", ")),
            esc(mode === "ungated" ? "No verdict cleared the gate" : (triage.modes[mode] ?? "")),
        ]);

    return table(["Failure mode", "Attempts", "Share", "Harnesses", "Meaning"], rows, "numeric triage");
}

// The README carries the same headline figures as the page. Typing them by
// hand guarantees they drift, so it gets the same marker treatment: one
// command updates both, or neither.
export function renderReadme(data) {
    // A row may only be compared with another row when both cover the same
    // work. Aggregating whatever tiers a harness happened to run ranks the
    // ones that skipped the expensive tier as the cheapest: adding tier 4
    // moved Pi from first to third on cost without Pi changing at all, purely
    // because two harnesses had no tier 4 attempts to carry. So the headline
    // is computed over the tiers every listed harness ran, and the rest are
    // named rather than blended in.
    const common = data.tiers.filter((tier) => data.harnesses.every((harness) => harness.perTier[tier]));
    const excluded = data.tiers.filter((tier) => !common.includes(tier));
    const combine = (harness) => {
        const parts = common.map((tier) => harness.perTier[tier]);
        const attempts = sum(parts.map((part) => part.attempts));
        const weighted = (pick) =>
            attempts === 0 ? 0 : sum(parts.map((part) => pick(part) * part.attempts)) / attempts;

        return {
            attempts,
            solved: sum(parts.map((part) => part.solved)),
            cost: weighted((part) => part.cost),
            promptTokens: weighted((part) => part.promptTokens),
        };
    };

    const row = (harness) => {
        const cell = combine(harness);
        const overhead = harness.firstCall
            ? thousands(harness.firstCall.toolSchemaChars + harness.firstCall.instructionChars)
            : "not measured";

        return `| ${harness.label} | ${cell.solved}/${cell.attempts} | $${cell.cost.toFixed(4)} | ${thousands(cell.promptTokens)} | ${overhead} |`;
    };

    const ordered = [...data.harnesses].sort((a, b) => combine(a).cost - combine(b).cost);
    const covered = sum(common.map((tier) => data.tasksByTier[tier].length));
    const attempts = sum(data.harnesses.map((harness) => combine(harness).attempts));

    return [
        `**${attempts} attempts across ${data.harnesses.length} harnesses and ${covered} tasks**, all on \`${data.model}\`.`,
        "",
        "| Harness | Solved | Cost/attempt | Prompt tokens | Sent before any work |",
        "| --- | --- | --- | --- | --- |",
        ...ordered.map(row),
        "",
        "Cost is the harness's own model spend, priced from recorded usage against a",
        "dated price file. The last column is the tool schema plus system instructions",
        "riding every single request, which is the fixed toll a harness charges before",
        "the model does anything.",
        ...(excluded.length === 0
            ? []
            : [
                  "",
                  `Tier ${excluded.join(", ")} is left out of this table because not every harness has`,
                  "attempts there, and a per-attempt cost only compares across rows when every row",
                  "covers the same tasks. The evaluations page charts it per tier.",
              ]),
    ].join("\n");
}

export function inject(html, charts) {
    let output = html;
    for (const [id, svg] of Object.entries(charts)) {
        const open = `<!-- ${id} -->`;
        const close = `<!-- /${id} -->`;
        const start = output.indexOf(open);
        const end = output.indexOf(close);
        if (start < 0 || end < 0) {
            throw new Error(`site/evaluations/index.html has no ${open} ... ${close} slot`);
        }

        output = `${output.slice(0, start + open.length)}${svg}${output.slice(end)}`;
    }

    return output;
}

function main() {
    const files = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
    const requested = files.length > 0 ? files.map((file) => path.resolve(file)) : DEFAULT_REPORTS;
    // An explicitly named report must exist, because naming one and silently
    // dropping it would publish a smaller run than the caller asked for. The
    // default set may legitimately be incomplete while a tier is still running,
    // so a missing one there is announced and skipped.
    const reports = [];
    for (const file of requested) {
        if (fs.existsSync(file)) {
            reports.push(file);
        } else if (files.length > 0) {
            throw new Error(`missing report: ${file}`);
        } else {
            process.stdout.write(`eval site: skipping absent ${path.relative(root, file)}\n`);
        }
    }

    if (reports.length === 0) {
        throw new Error("no reports found");
    }

    const data = collect(reports);
    fs.mkdirSync(pageDir, { recursive: true });
    const dataFile = path.join(pageDir, "harness-eval.json");
    fs.writeFileSync(dataFile, `${JSON.stringify(data, null, 2)}\n`);
    process.stdout.write(`eval site -> ${dataFile} (${data.totalAttempts} attempts, ${data.taskCount} tasks)\n`);

    // Optional, because it is the one artifact on this page that costs a third-party call to
    // produce. An absent file leaves the slot alone rather than publishing an empty table.
    const triageFile = path.join(root, "evals", "runs", "jev-triage.json");
    const triage = fs.existsSync(triageFile) ? JSON.parse(fs.readFileSync(triageFile, "utf8")) : null;
    const pageFile = path.join(pageDir, "index.html");
    if (fs.existsSync(pageFile)) {
        const slots = {
            ...renderCharts(data),
            ...renderTables(data),
            ...(triage ? { "table-failure-modes": renderFailureModes(triage) } : {}),
        };
        fs.writeFileSync(pageFile, inject(fs.readFileSync(pageFile, "utf8"), slots));
        process.stdout.write(`eval site -> ${pageFile} (${Object.keys(slots).length} figures)\n`);
    }

    const readmeFile = path.join(root, "README.md");
    if (fs.existsSync(readmeFile)) {
        const readme = fs.readFileSync(readmeFile, "utf8");
        if (readme.includes("<!-- eval-summary -->")) {
            fs.writeFileSync(readmeFile, inject(readme, { "eval-summary": `\n\n${renderReadme(data)}\n\n` }));
            process.stdout.write(`eval site -> ${readmeFile}\n`);
        }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
