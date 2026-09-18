#!/usr/bin/env node
// One self-contained SVG with every eval result: a combined table plus the
// per-tier solve, cost and context charts. Reads any mix of report.json
// files (multi-harness reports, per-model reports, or both) and groups by
// series and tier. Usage: node scripts/eval-dashboard.mjs --out=<file.svg>
// <report.json...>

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { aggregateSeries, escapeXml, groupSeries, renderCharts } from "./eval-chart.mjs";
import { formatCost } from "./eval-report.mjs";
import { repriceReport } from "./eval-prices.mjs";

const WIDTH = 840;
const MARGIN = 40;
const PLOT_WIDTH = WIDTH - MARGIN * 2;

function text(x, y, content, { size = 12, weight = 400, fill = "#14181f", anchor = "start" } = {}) {
    return (
        `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}"` +
        (anchor === "start" ? "" : ` text-anchor="${anchor}"`) +
        `>${escapeXml(content)}</text>`
    );
}

function svgDims(svg) {
    const match = String(svg).match(/<svg[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"/u);

    return { width: Number(match?.[1] ?? PLOT_WIDTH), height: Number(match?.[2] ?? 400) };
}

function nest(svg, x, y) {
    return String(svg).replace("<svg ", `<svg x="${x}" y="${y}" `);
}

function contextText(bucket) {
    if (!bucket || bucket.attempts === 0) {
        return "—";
    }

    const value = Math.round(bucket.meanFirstTokens).toLocaleString("en-US");

    return `${value} tok${bucket.contextEstimated ? " (est.)" : ""}`;
}

/** Per-series overall buckets split by tier: Map key -> Map tier -> bucket. */
export function dashboardData(reports) {
    const series = groupSeries(reports).map((entry) => {
        const tiers = new Map();
        for (const cell of entry.cells) {
            if (!tiers.has(cell.tier)) {
                tiers.set(cell.tier, []);
            }

            tiers.get(cell.tier).push(cell);
        }

        const byTier = new Map();
        for (const [tier, cells] of tiers) {
            byTier.set(tier, aggregateSeries({ ...entry, cells }));
        }

        return { key: entry.key, label: entry.label, model: entry.model, byTier };
    });
    const tierNumbers = [...new Set(reports.flatMap((report) => report.results.map((cell) => cell.tier)))].sort(
        (a, b) => a - b,
    );

    return { series, tierNumbers };
}

function tierName(tier) {
    return tier === 1 ? "Tier 1 · smoke" : `Tier ${tier}`;
}

function solvedText(bucket) {
    if (!bucket || bucket.attempts === 0) {
        return "—";
    }

    return `${bucket.solved}/${bucket.attempts}`;
}

function combinedTable(data) {
    const lines = [];
    // One solve column per tier in the run, then cost and context for the
    // most demanding tier present, which is the figure worth comparing.
    const tiers = data.tierNumbers;
    const deepest = tiers[tiers.length - 1];
    const tierStart = 300;
    const tierWidth = Math.min(60, Math.floor(200 / Math.max(1, tiers.length)));
    const tailStart = tierStart + tiers.length * tierWidth + 5;
    const columns = [
        MARGIN,
        ...tiers.map((_, index) => tierStart + index * tierWidth),
        tailStart,
        tailStart + 70,
        tailStart + 145,
    ];
    const header = [
        "Series",
        ...tiers.map((tier) => `T${tier}`),
        `Cost/att (T${deepest})`,
        `Overhead (T${deepest})`,
        `First ctx (T${deepest})`,
    ];
    header.forEach((label, index) => {
        lines.push(text(columns[index], 0, label, { size: 11, weight: 600, fill: "#57616f" }));
    });
    data.series.forEach((entry, row) => {
        const y = (row + 1) * 30;
        const last = entry.byTier.get(deepest)?.overall ?? null;
        const values = [
            entry.key,
            ...tiers.map((tier) => solvedText(entry.byTier.get(tier)?.overall ?? null)),
            last ? formatCost(last.meanCostPerAttempt, last.costComplete) : "—",
            last && last.meanMintCostPerAttempt > 0 ? formatCost(last.meanMintCostPerAttempt, last.costComplete) : "—",
            contextText(last),
        ];
        values.forEach((value, index) => {
            lines.push(text(columns[index], y, value, { size: 12, weight: index === 0 ? 600 : 400 }));
        });
    });

    return { lines, height: data.series.length * 30 + 12 };
}

export function buildDashboard(reports) {
    if (reports.length === 0) {
        throw new Error("buildDashboard needs at least one report");
    }

    const data = dashboardData(reports);
    const models = [...new Set(data.series.map((entry) => entry.model))].join(", ");
    const priced = reports[0]?.pricesDated ?? "unknown";
    const parts = [];
    let y = 56;
    parts.push(text(MARGIN, y, "Harness eval · all results", { size: 22, weight: 700 }));
    y += 26;
    parts.push(
        text(MARGIN, y, `Model: ${models} · priced ${priced} · frozen list, failures included`, {
            size: 13,
            fill: "#57616f",
        }),
    );
    y += 44;
    const table = combinedTable(data);
    parts.push(`<g transform="translate(0,${y})">`, ...table.lines, "</g>");
    y += table.height + 30;
    for (const tier of data.tierNumbers) {
        parts.push(text(MARGIN, y, tierName(tier), { size: 17, weight: 700 }));
        y += 16;
        const charts = renderCharts(
            data.series.filter((entry) => entry.byTier.has(tier)).map((entry) => entry.byTier.get(tier)),
        );
        for (const svg of [charts.solve, charts.cost, charts.context]) {
            const dims = svgDims(svg);
            const scale = PLOT_WIDTH / dims.width;
            parts.push(`<g transform="translate(${MARGIN},${y}) scale(${scale.toFixed(4)})">${nest(svg, 0, 0)}</g>`);
            y += dims.height * scale + 28;
        }
    }

    parts.push(
        text(
            MARGIN,
            y,
            "Tier columns are solved/attempts. Counts stay on every bar. Proxy-harness context is estimated at chars ÷ 4.",
            {
                size: 11,
                fill: "#57616f",
            },
        ),
    );
    y += 20;
    parts.push(
        text(
            MARGIN,
            y,
            "Cost is the harness's own model spend. Overhead is the per-attempt OpenCode session mint, which only proxy harnesses need.",
            { size: 11, fill: "#57616f" },
        ),
    );
    y += 20;
    parts.push(
        text(MARGIN, y, "SpecPi runs set the permission package's explicit yoloMode inside the disposable home.", {
            size: 11,
            fill: "#57616f",
        }),
    );
    y += 34;
    const height = Math.round(y);

    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" ` +
        `role="img" font-family="Arial, Helvetica, sans-serif">\n    <title>Harness eval · all results</title>\n    ` +
        `<rect x="0" y="0" width="${WIDTH}" height="${height}" fill="#ffffff" />\n    ` +
        `${parts.join("\n    ")}\n</svg>\n`
    );
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

    if (!options.help && (options.files.length === 0 || !options.out)) {
        throw new Error("Usage: node scripts/eval-dashboard.mjs --out=<file.svg> <report.json...>");
    }

    return options;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log("Usage: node scripts/eval-dashboard.mjs --out=<file.svg> <report.json...>");
        console.log("Writes one self-contained SVG with the combined table and every tier chart.");

        return;
    }

    const reports = options.files.map((file) => repriceReport(JSON.parse(fs.readFileSync(file, "utf8"))));
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, buildDashboard(reports));
    console.log(`eval dashboard -> ${options.out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main().catch((error) => {
        console.error(String(error?.message ?? error));
        process.exitCode = 1;
    });
}
