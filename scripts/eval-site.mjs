// Shared pieces of the evaluations pipeline: reading run reports into one dataset, and the small
// chart and table renderers the published figures are drawn with.
//
// This file used to publish the evaluations page as well. That page carried six tiers of a suite
// written in this repository, and it was retired in favour of Terminal-Bench 2.0 for the reason it
// kept reporting -- nearly everything passed, so it could not separate the harnesses it existed to
// separate. What is left here is the part with other callers: scripts/tb2-site.mjs draws the
// published figures with these renderers, and scripts/jev-effect.mjs and scripts/tier6-metrics.mjs
// read run reports through collect() and isLaunchFailure().

import fs from "node:fs";
import process from "node:process";
import { attemptMintCost, attemptModelCost, attemptScore, attemptToolCounts, usageSummary } from "./eval-report.mjs";
import { attemptTurns } from "./eval-proxy.mjs";

// Fixed per harness so a colour means the same thing on every surface; these
// mirror the tokens in site/research.css.
const HARNESSES = [
    { id: "pi", label: "Pi", colour: "var(--ct-pi)" },
    { id: "specpi-default", label: "SpecPi", colour: "var(--ct-specpi)" },
    { id: "specpi-jev", label: "SpecPi + Jev", colour: "var(--ct-specpi-jev)" },
    { id: "opencode", label: "OpenCode", colour: "var(--ct-opencode)" },
    { id: "codex", label: "Codex CLI", colour: "var(--ct-codex)" },
    { id: "claude-code", label: "Claude Code", colour: "var(--ct-claudecode)" },
    { id: "omp", label: "Oh My Pi", colour: "var(--ct-omp)" },
    { id: "dsh", label: "DeepSeek Harness", colour: "var(--ct-deepseek)" },
];

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

/**
 * One cell per harness, task and tier, taking the last report that measured it.
 *
 * A cell sometimes has to be measured again: a checker is found to be wrong, and the attempts it
 * graded have to be re-run, because the workspaces are discarded so they cannot be re-graded.
 * Flat-mapping every report would then average the old cell with its replacement and publish
 * both standards at once. Later wins, and what it replaced is named on stdout rather than
 * dropped quietly -- a superseded cell is a thing the operator should see, not a detail.
 */
function supersede(reports) {
    const byCell = new Map();
    const replaced = [];
    for (const report of reports) {
        for (const cell of report.results) {
            const key = `${cell.harness}	${cell.task}	${cell.tier}`;
            if (byCell.has(key)) {
                replaced.push(`${cell.harness}/${cell.task}`);
            }

            byCell.set(key, cell);
        }
    }

    if (replaced.length > 0) {
        process.stdout.write(`eval site: ${replaced.length} cell(s) superseded by a later report: ${replaced.join(", ")}
`);
    }

    return [...byCell.values()];
}

export function collect(files) {
    const reports = files.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
    const cells = supersede(reports);
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

export function inject(html, charts) {
    let output = html;
    for (const [id, svg] of Object.entries(charts)) {
        const open = `<!-- ${id} -->`;
        const close = `<!-- /${id} -->`;
        const start = output.indexOf(open);
        const end = output.indexOf(close);
        if (start < 0 || end < 0) {
            throw new Error(`no ${open} ... ${close} slot to fill`);
        }

        output = `${output.slice(0, start + open.length)}${svg}${output.slice(end)}`;
    }

    return output;
}
