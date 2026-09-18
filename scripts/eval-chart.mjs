#!/usr/bin/env node
// Chart eval results. Reads one report.json per model run sharing the same
// tasks, aggregates solve rate, frozen cost and first-step context by task
// category, and writes SUMMARY.md plus three standalone SVG charts into an
// output directory (default: alongside the first report).
// Usage: node scripts/eval-chart.mjs --out <dir> <report.json...>

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { attemptModelCost, attemptToolCounts, formatCost, mean, summarizeAttempts } from "./eval-report.mjs";
import { repriceReport } from "./eval-prices.mjs";
import { renderSummary } from "./eval-summarize.mjs";

export const CATEGORIES = ["terminal", "repair", "scoped", "multi"];
const SERIES_COLORS = ["#0e7490", "#864ad2", "#1b5fd6", "#c2410c", "#157f4c", "#a3197f"];

export function escapeXml(text) {
    return String(text).replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function formatCompact(value) {
    if (value >= 1000) {
        return `${(value / 1000).toFixed(1)}k`;
    }

    return `${Math.round(value)}`;
}

/** Group every cell of every report into series keyed by harness label and model. */
export function groupSeries(reports) {
    const series = new Map();
    for (const report of reports) {
        if (report.schema !== 1 || !Array.isArray(report.results)) {
            throw new Error("Unsupported eval report: expected schema 1 with a results array");
        }

        for (const cell of report.results) {
            const key = `${cell.label} · ${report.model}`;
            if (!series.has(key)) {
                series.set(key, { key, label: cell.label, model: report.model, cells: [] });
            }

            series.get(key).cells.push(cell);
        }
    }

    return [...series.values()];
}

function firstContextTokens(attempt) {
    if (Number.isFinite(attempt.native?.firstStepInputTokens) && attempt.native.firstStepInputTokens > 0) {
        return { tokens: attempt.native.firstStepInputTokens, estimated: false };
    }

    const chars = (attempt.firstCall?.toolSchemaChars ?? 0) + (attempt.firstCall?.instructionChars ?? 0);

    // Proxy harnesses log characters, not tokens. Chars ÷ 4 is the standard
    // rough conversion, labelled as an estimate wherever it appears.
    return { tokens: chars / 4, estimated: true };
}

/** Aggregate one series into per-category buckets plus an overall bucket. */
export function aggregateSeries(entry) {
    const buckets = new Map();
    for (const cell of entry.cells) {
        for (const attempt of cell.attempts) {
            const bucketKey = CATEGORIES.includes(cell.category) ? cell.category : "other";
            if (!buckets.has(bucketKey)) {
                buckets.set(bucketKey, []);
            }

            buckets.get(bucketKey).push(attempt);
        }
    }

    const summarizeBucket = (attempts) => {
        const summary = summarizeAttempts(attempts);
        const contexts = attempts.map(firstContextTokens);
        const estimated = contexts.some((context) => context.estimated);

        return {
            ...summary,
            totalCost: attempts.reduce((total, attempt) => total + attemptModelCost(attempt), 0),
            meanSteps: mean(attempts.map((attempt) => attempt.modelRequests ?? 0)),
            meanFirstTokens: mean(contexts.map((context) => context.tokens)),
            contextEstimated: estimated,
            tools: mergeToolCounts(attempts),
        };
    };

    const ordered = [
        ...CATEGORIES.filter((category) => buckets.has(category)),
        ...[...buckets.keys()].filter((key) => !CATEGORIES.includes(key)),
    ];
    const rows = ordered.map((category) => ({ category, ...summarizeBucket(buckets.get(category)) }));
    const overall = summarizeBucket(entry.cells.flatMap((cell) => cell.attempts));

    return { ...entry, rows, overall };
}

function mergeToolCounts(attempts) {
    const calls = {};
    const offers = {};
    let callsMeasured = attempts.length > 0;
    for (const attempt of attempts) {
        const counts = attemptToolCounts(attempt);
        if (!counts.callsMeasured) {
            callsMeasured = false;
        }

        for (const [name, count] of Object.entries(counts.calls)) {
            calls[name] = (calls[name] ?? 0) + count;
        }

        for (const [name, count] of Object.entries(counts.offers)) {
            offers[name] = (offers[name] ?? 0) + count;
        }
    }

    return { calls, offers, callsMeasured };
}

function renderGroupedBars({ title, subtitle, groups, valueLabel, colorFor }) {
    const width = 760;
    const left = 150;
    const plot = 430;
    const barHeight = 20;
    const seriesGap = 6;
    const groupGap = 26;
    const maxValue = Math.max(1e-9, ...groups.flatMap((group) => group.bars.map((bar) => bar.value)));
    const rows = groups.reduce((total, group) => total + group.bars.length, 0);
    // The legend wraps instead of running past the plot edge: long series
    // names (harness plus model) otherwise clip at the viewport.
    const legendNames = groups[0]?.bars.map((bar) => bar.series) ?? [];
    const legendRows = [];
    let currentRow = [];
    let currentWidth = 0;
    for (const name of legendNames) {
        const itemWidth = 17 + name.length * 6.8 + 28;
        if (currentWidth + itemWidth > plot && currentRow.length > 0) {
            legendRows.push(currentRow);
            currentRow = [];
            currentWidth = 0;
        }

        currentRow.push(name);
        currentWidth += itemWidth;
    }

    if (currentRow.length > 0) {
        legendRows.push(currentRow);
    }

    const top = 58 + legendRows.length * 20 + 12;
    const height = top + rows * (barHeight + seriesGap) + (groups.length - 1) * groupGap + 44;
    const scale = (value) => (plot * value) / maxValue;
    const parts = [];
    parts.push(
        `<text x=\"${left}\" y=\"30\" font-size=\"17\" font-weight=\"600\" fill=\"#14181f\">${escapeXml(title)}</text>`,
        `<text x=\"${left}\" y=\"50\" font-size=\"12\" fill=\"#57616f\">${escapeXml(subtitle)}</text>`,
    );
    legendRows.forEach((names, rowIndex) => {
        let legendX = left;
        for (const name of names) {
            parts.push(
                `<rect x=\"${legendX}\" y=\"${62 + rowIndex * 20}\" width=\"11\" height=\"11\" rx=\"2\" fill=\"${colorFor(name)}\" />`,
                `<text x=\"${legendX + 17}\" y=\"${72 + rowIndex * 20}\" font-size=\"12\" fill=\"#14181f\">${escapeXml(name)}</text>`,
            );
            legendX += 17 + name.length * 6.8 + 28;
        }
    });
    let y = top;
    for (const group of groups) {
        parts.push(
            `<text x=\"${left - 12}\" y=\"${y + group.bars.length * (barHeight + seriesGap) * 0.5}\" text-anchor=\"end\" font-size=\"13\" font-weight=\"600\" fill=\"#14181f\">${escapeXml(group.label)}</text>`,
            `<text x=\"${left - 12}\" y=\"${y + group.bars.length * (barHeight + seriesGap) * 0.5 + 16}\" text-anchor=\"end\" font-size=\"11\" fill=\"#57616f\">${escapeXml(group.sub)}</text>`,
        );
        for (const bar of group.bars) {
            const barWidth = Math.max(2, scale(bar.value));
            parts.push(
                `<rect x=\"${left}\" y=\"${y}\" width=\"${barWidth.toFixed(1)}\" height=\"${barHeight}\" rx=\"4\" fill=\"${colorFor(bar.series)}\">` +
                    `<title>${escapeXml(bar.series)} ${escapeXml(group.label)}: ${escapeXml(bar.title)}</title></rect>`,
                `<text x=\"${(left + barWidth + 8).toFixed(1)}\" y=\"${y + 15}\" font-size=\"12\" font-weight=\"600\" fill=\"#14181f\">${escapeXml(valueLabel(bar))}</text>`,
            );
            y += barHeight + seriesGap;
        }

        y += groupGap;
    }

    parts.push(
        `<text x=\"${left}\" y=\"${height - 12}\" font-size=\"11\" fill=\"#57616f\">Counts are solved/attempts; costs use the frozen price list.</text>`,
    );

    return (
        `<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"${width}\" height=\"${height}\" viewBox=\"0 0 ${width} ${height}\" ` +
        `role=\"img\" font-family=\"Arial, Helvetica, sans-serif\">\n    <title>${escapeXml(title)}</title>\n    ${parts.join("\n    ")}\n</svg>\n`
    );
}

export function renderCharts(aggregated) {
    const colorFor = (series) => {
        const index = aggregated.findIndex((entry) => entry.key === series);

        return SERIES_COLORS[index % SERIES_COLORS.length];
    };

    const categories = [
        "overall",
        ...CATEGORIES.filter((category) =>
            aggregated.some((entry) => entry.rows.some((row) => row.category === category)),
        ),
    ];
    const bucketOf = (entry, category) => {
        if (category === "overall") {
            return entry.overall;
        }

        return entry.rows.find((row) => row.category === category);
    };

    const groupsFor = (pick) => {
        return categories.map((category) => {
            const bars = [];
            for (const entry of aggregated) {
                const bucket = bucketOf(entry, category);
                if (bucket && bucket.attempts > 0) {
                    bars.push({ series: entry.key, ...pick(bucket) });
                }
            }

            const solved = aggregated.reduce((total, entry) => total + (bucketOf(entry, category)?.solved ?? 0), 0);
            const attempts = aggregated.reduce((total, entry) => total + (bucketOf(entry, category)?.attempts ?? 0), 0);

            return { label: category, sub: `${solved}/${attempts} solved`, bars };
        });
    };

    const solve = renderGroupedBars({
        title: "Solve rate by category",
        subtitle: "Share of attempts passing the task checker",
        groups: groupsFor((bucket) => ({
            value: bucket.solveRate,
            title: `${bucket.solved}/${bucket.attempts}`,
            valueText: `${Math.round(bucket.solveRate * 100)}%`,
        })),
        valueLabel: (bar) => bar.valueText,
        colorFor,
    });
    const cost = renderGroupedBars({
        title: "Mean model cost per attempt",
        subtitle: "Frozen price list; failures included; eval session-mint overhead excluded",
        groups: groupsFor((bucket) => ({
            value: bucket.meanCostPerAttempt,
            title: formatCost(bucket.meanCostPerAttempt, bucket.costComplete),
            valueText: formatCost(bucket.meanCostPerAttempt, bucket.costComplete),
        })),
        valueLabel: (bar) => bar.valueText,
        colorFor,
    });
    const estimated = aggregated.some((entry) => entry.overall.contextEstimated);
    const context = renderGroupedBars({
        title: "Mean first-step context",
        subtitle: estimated ? "Input tokens; proxy harnesses estimated at chars ÷ 4" : "First-step input tokens",
        groups: groupsFor((bucket) => ({
            value: bucket.meanFirstTokens,
            title: `${Math.round(bucket.meanFirstTokens).toLocaleString("en-US")} tokens${bucket.contextEstimated ? " (est.)" : ""}`,
            valueText: formatCompact(bucket.meanFirstTokens),
        })),
        valueLabel: (bar) => bar.valueText,
        colorFor,
    });

    return { solve, cost, context };
}

export function renderComparison(aggregated, reports) {
    const lines = [];
    lines.push("# Eval comparison");
    lines.push("");
    lines.push(`Models: ${aggregated.map((entry) => entry.key).join(" vs ")}.`);
    lines.push(`Priced ${reports[0]?.pricesDated ?? "unknown"}; method: ${reports[0]?.method ?? ""}`);
    lines.push("");
    lines.push(
        "| Series | Tasks | Solved | Rate | Score | In scope | Cost/attempt | Eval overhead | Mean steps | Mean first context |",
    );
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const entry of aggregated) {
        const context = `${formatCompact(entry.overall.meanFirstTokens)} tok${entry.overall.contextEstimated ? " (est.)" : ""}`;
        const overhead =
            entry.overall.meanMintCostPerAttempt > 0
                ? formatCost(entry.overall.meanMintCostPerAttempt, entry.overall.costComplete)
                : "—";
        const scope = entry.overall.scope;
        const detail = [
            scope.tampered > 0 ? `${scope.tampered} tampered` : "",
            scope.created > 0 ? `${scope.created} stray` : "",
        ]
            .filter(Boolean)
            .join(", ");
        const scopeText =
            scope.cleanRate === null ? "—" : `${scope.clean}/${scope.measured}${detail ? ` (${detail})` : ""}`;
        lines.push(
            `| ${entry.key} | ${entry.cells.length} | ${entry.overall.solved}/${entry.overall.attempts} | ` +
                `${Math.round(entry.overall.solveRate * 100)}% | ${(entry.overall.meanScore * 100).toFixed(0)}% | ` +
                `${scopeText} | ${formatCost(entry.overall.meanCostPerAttempt, entry.overall.costComplete)} | ` +
                `${overhead} | ${entry.overall.meanSteps.toFixed(1)} | ${context} |`,
        );
    }

    lines.push("");
    lines.push(
        "Score is how much of each task landed, averaged over attempts; it carries information where the solve " +
            "rate saturates. In scope counts attempts that changed only the paths the task declared writable — a " +
            "harness property measured on every task, not just the ones about restraint. A stray file left behind " +
            "is untidiness; tampering means a protected file was modified or deleted, which is the serious one.",
    );
    lines.push("");
    lines.push(
        "Cost/attempt is the harness's own model spend. Eval overhead is the per-attempt OpenCode session mint, " +
            "which only proxy harnesses need and which carries OpenCode's own system prompt and tool schema; it is " +
            "reported beside the harness figure rather than folded into it.",
    );
    lines.push("");
    lines.push("Token economics per attempt, which spread far wider than solve rate:");
    lines.push("");
    for (const entry of aggregated) {
        const usage = entry.overall.usage;
        const cache = usage.cacheHitRate === null ? "n/a" : `${Math.round(usage.cacheHitRate * 100)}% cached`;
        lines.push(
            `- ${entry.key}: ${formatCompact(usage.meanInputTokens)} in-tok (${cache}), ` +
                `${formatCompact(usage.meanOutputTokens)} out-tok, ${formatCompact(usage.meanTokensPerRequest)} in-tok/request, ` +
                `${usage.meanToolCalls.toFixed(1)} tool calls over ${entry.overall.meanSteps.toFixed(1)} requests.`,
        );
    }

    lines.push("");
    for (const entry of aggregated) {
        const tools = entry.overall.tools;
        const calls = tools.callsMeasured
            ? describeToolCounts(tools.calls)
            : "not measured (this run predates invoked-tool logging; re-run to record them)";
        lines.push(`- ${entry.key} tool calls: ${calls}.`);
    }

    lines.push("");
    for (const entry of aggregated) {
        // Offers are per-request schema weight, not usage: a tool offered
        // on every request is paid for on every request whether or not the
        // model ever reaches for it.
        lines.push(
            `- ${entry.key} tools offered (per-request schema weight): ${describeToolCounts(entry.overall.tools.offers)}.`,
        );
    }

    lines.push("");

    return `${lines.join("\n")}\n`;
}

function describeToolCounts(counts) {
    const listed = Object.entries(counts ?? {})
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name} ${count}`)
        .join(", ");

    return listed || "none recorded";
}

function parseArgs(argv) {
    const options = { out: null, files: [] };
    for (const argument of argv) {
        if (argument.startsWith("--out=")) {
            options.out = path.resolve(argument.slice("--out=".length));
        } else if (argument === "--help" || argument === "-h") {
            options.help = true;
        } else if (argument.startsWith("--")) {
            throw new Error(`Unknown argument: ${argument}`);
        } else {
            options.files.push(path.resolve(argument));
        }
    }

    if (!options.help && options.files.length === 0) {
        throw new Error("Usage: node scripts/eval-chart.mjs --out <dir> <report.json...>");
    }

    return options;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log("Usage: node scripts/eval-chart.mjs --out <dir> <report.json...>");
        console.log("Writes SUMMARY.md, chart-solve.svg, chart-cost.svg and chart-context.svg.");

        return;
    }

    // Stored attempts are repriced under the current rules, so an
    // archived report renders with the same cost math as a fresh run.
    const reports = options.files.map((file) => repriceReport(JSON.parse(fs.readFileSync(file, "utf8"))));
    const aggregated = groupSeries(reports).map(aggregateSeries);
    const outDir = options.out ?? path.dirname(options.files[0]);
    fs.mkdirSync(outDir, { recursive: true });
    const charts = renderCharts(aggregated);
    const details = reports.map((report) => renderSummary(report)).join("\n---\n\n");
    fs.writeFileSync(path.join(outDir, "SUMMARY.md"), `${renderComparison(aggregated, reports)}\n${details}`);
    fs.writeFileSync(path.join(outDir, "chart-solve.svg"), charts.solve);
    fs.writeFileSync(path.join(outDir, "chart-cost.svg"), charts.cost);
    fs.writeFileSync(path.join(outDir, "chart-context.svg"), charts.context);
    console.log(
        `eval charts: ${["SUMMARY.md", "chart-solve.svg", "chart-cost.svg", "chart-context.svg"].join(", ")} -> ${outDir}`,
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main().catch((error) => {
        console.error(String(error?.message ?? error));
        process.exitCode = 1;
    });
}
