#!/usr/bin/env node
// What the Jev layer did to the harness it is meant to improve, and what it did with its own calls.
//
// The published comparison used to be arithmetic done by hand over two report files, which is
// exactly the kind of number that cannot be checked a month later. This reads the reports and
// prints the table, using the same aggregates the evaluations page is built from rather than a
// second definition of "cost per attempt" that could drift from the first.
//
// Two things are printed and they answer different questions:
//
//   The comparison   plain SpecPi against SpecPi with the layer on, on the measures the layer's
//                    mechanism actually targets. A third column appears when a second set of Jev
//                    reports is given, which is how "before and after the gate was calibrated" gets
//                    published as a change rather than as a replacement.
//   The ledger       what the layer's own calls did: per system, how many were made, how many
//                    changed anything, and why the rest did not. Without this a system that asks
//                    and never acts is indistinguishable from one whose gate can never be
//                    satisfied, which is the defect the calibration pass had to find by hand.
//
// Usage:
//   node scripts/jev-effect.mjs --jev=<report.json,...> [--baseline=<report.json,...>]
//                               [--control=<report.json,...>] [--json]
//
// `--control` defaults to the published matrix, which is where the plain-SpecPi row comes from.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { collect } from "./eval-site.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_CONTROL = [1, 2, 3, 4, 5].map((tier) =>
    path.join(root, "evals", "runs", `full-tier${tier}`, "report.json"),
);

function list(value) {
    return String(value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => path.resolve(root, item));
}

function parseArgs(argv) {
    const options = { jev: [], baseline: [], control: DEFAULT_CONTROL, json: false };
    for (const argument of argv) {
        if (argument === "--json") {
            options.json = true;
        } else if (argument.startsWith("--jev=")) {
            options.jev = list(argument.slice("--jev=".length));
        } else if (argument.startsWith("--baseline=")) {
            options.baseline = list(argument.slice("--baseline=".length));
        } else if (argument.startsWith("--control=")) {
            options.control = list(argument.slice("--control=".length));
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }

    if (options.jev.length === 0) {
        throw new Error("Give at least one report with --jev=<report.json,...>");
    }

    return options;
}

/** One harness's aggregates out of one set of reports, or undefined when it never ran in them. */
export function harnessRow(files, id) {
    const present = files.filter((file) => fs.existsSync(file));
    if (present.length === 0) {
        return undefined;
    }

    return collect(present).harnesses.find((harness) => harness.id === id);
}

/**
 * The advisor's own ledger, folded out of every attempt in the reports. It is stored per attempt
 * because that is where it is collected, so the rollup has to re-summarize rather than add: an
 * `outcomes` map cannot be averaged, and the interesting question is about the whole run.
 */
export function ledgerRollup(files) {
    const attempts = files
        .filter((file) => fs.existsSync(file))
        .flatMap((file) => JSON.parse(fs.readFileSync(file, "utf8")).results)
        .flatMap((cell) => cell.attempts ?? []);
    const ledgers = attempts.map((attempt) => attempt?.advisor?.ledger).filter(Boolean);
    if (ledgers.length === 0) {
        return { attempts: attempts.length, measured: 0, calls: 0, applied: 0, bySystem: {} };
    }

    const bySystem = {};
    for (const ledger of ledgers) {
        for (const [name, bucket] of Object.entries(ledger.bySystem ?? {})) {
            const total = (bySystem[name] ??= { calls: 0, failed: 0, applied: 0, savedBytes: 0, outcomes: {} });
            total.calls += bucket.calls ?? 0;
            total.failed += bucket.failed ?? 0;
            total.applied += bucket.applied ?? 0;
            total.savedBytes += bucket.savedBytes ?? 0;
            for (const [outcome, count] of Object.entries(bucket.outcomes ?? {})) {
                total.outcomes[outcome] = (total.outcomes[outcome] ?? 0) + count;
            }
        }
    }

    const totals = Object.values(bySystem);

    return {
        attempts: attempts.length,
        // An attempt whose home held no ledger made no call, which is different from an attempt
        // that was never measured, and the ratio is the honest denominator for "calls per attempt".
        measured: ledgers.length,
        calls: totals.reduce((sum, item) => sum + item.calls, 0),
        failed: totals.reduce((sum, item) => sum + item.failed, 0),
        applied: totals.reduce((sum, item) => sum + item.applied, 0),
        savedBytes: totals.reduce((sum, item) => sum + item.savedBytes, 0),
        bySystem,
    };
}

const MEASURES = [
    ["Score", (row) => row.overall.score, (value) => value.toFixed(3)],
    ["Cost per attempt", (row) => row.overall.cost, (value) => `$${value.toFixed(4)}`],
    ["Tool calls per attempt", (row) => row.overall.toolCalls, (value) => value.toFixed(1)],
    ["Turns per attempt", (row) => row.overall.requests, (value) => value.toFixed(1)],
    [
        "Tool error rate",
        (row) => (row.overall.toolResults === 0 ? null : row.overall.toolErrors / row.overall.toolResults),
        (value) => `${(value * 100).toFixed(1)}%`,
    ],
    ["Context growth per turn", (row) => row.overall.contextGrowth, (value) => Math.round(value).toString()],
    ["Cache hit rate", (row) => row.overall.cacheHitRate, (value) => `${Math.round(value * 100)}%`],
    ["Attempts", (row) => row.overall.attempts, (value) => String(value)],
];

function cell(row, read, format) {
    if (!row) {
        return "--";
    }

    const value = read(row);

    return value === null || value === undefined || Number.isNaN(value) ? "--" : format(value);
}

function table(columns) {
    const header = ["Measure", ...columns.map(([label]) => label)];
    const rows = MEASURES.map(([label, read, format]) => [label, ...columns.map(([, row]) => cell(row, read, format))]);
    const widths = header.map((_, index) => Math.max(...[header, ...rows].map((line) => line[index].length)));
    const line = (values) =>
        values
            .map((value, index) => value.padEnd(widths[index]))
            .join("  ")
            .trimEnd();

    return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n");
}

function ledgerLines(rollup) {
    if (rollup.calls === 0) {
        return ["  no advisor calls recorded in these reports"];
    }

    const lines = [
        `  ${rollup.calls} calls over ${rollup.measured} of ${rollup.attempts} attempts` +
            ` (${(rollup.calls / Math.max(1, rollup.measured)).toFixed(1)} per measured attempt),` +
            ` ${rollup.failed} failed, ${rollup.applied} changed something, ${rollup.savedBytes} bytes dropped`,
    ];
    for (const [name, bucket] of Object.entries(rollup.bySystem).sort((a, b) => b[1].calls - a[1].calls)) {
        const why = Object.entries(bucket.outcomes)
            .sort((a, b) => b[1] - a[1])
            .map(([outcome, count]) => `${outcome} ${count}`)
            .join(", ");
        lines.push(`  ${name.padEnd(12)} ${bucket.calls} asked, ${bucket.applied} applied  [${why}]`);
    }

    return lines;
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const control = harnessRow(options.control, "specpi-default");
    const before = options.baseline.length > 0 ? harnessRow(options.baseline, "specpi-jev") : undefined;
    const after = harnessRow(options.jev, "specpi-jev");
    const rollup = ledgerRollup(options.jev);
    if (options.json) {
        process.stdout.write(`${JSON.stringify({ control, before, after, ledger: rollup }, null, 4)}\n`);

        return;
    }

    const columns = [["SpecPi", control]];
    if (before) {
        columns.push(["SpecPi + Jev (before)", before]);
    }

    columns.push([before ? "SpecPi + Jev (after)" : "SpecPi + Jev", after]);
    process.stdout.write(`${table(columns)}\n\n`);
    process.stdout.write(`Advisor ledger, ${before ? "after" : ""} runs:\n${ledgerLines(rollup).join("\n")}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
