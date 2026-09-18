#!/usr/bin/env node
// Phase 1 of the Jev advisor plan: calibrate Jev against ground truth this repository already owns.
//
// The eval checkers are deterministic — SHA-256 comparisons, exact answer matching, fixed partial
// credit — and the suite's method is that harnesses are judged by files, not transcripts. So Jev is
// not a grader here and would be strictly worse as one. The relationship is inverted instead: those
// objective verdicts are free labels, and asking Jev to predict them from behavioural metadata
// alone produces a reliability curve on this project's own data.
//
// Nothing in this script touches a session. It reads recorded reports, asks one batched question
// per attempt, and prints calibration bins plus precision at each candidate threshold. Those
// numbers are what the gate.mjs thresholds are supposed to be read off, instead of guessed.
//
// Usage:
//   node scripts/jev-calibrate.mjs [--runs evals/runs] [--limit 200] [--out <file.json>] [--dry-run]
//
// The key comes from TYPESAFE_API_KEY, read from the shell or from evals/.env (see evals/.env.example).

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./eval-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const advisor = path.join(root, "extensions", "jev-advisor");
const { ask, endpoint, noul, score } = await import(pathToUrl(path.join(advisor, "client.mjs")));
const { buildState } = await import(pathToUrl(path.join(advisor, "sanitize.mjs")));

function pathToUrl(value) {
    return new URL(`file://${value.replaceAll("\\", "/").replace(/^([A-Za-z]:)/u, "/$1")}`).href;
}

function parseArgs(argv) {
    const options = { runs: path.join(root, "evals", "runs"), limit: 200, out: undefined, dryRun: false };
    for (const argument of argv) {
        if (argument.startsWith("--runs=")) {
            options.runs = path.resolve(argument.slice("--runs=".length));
        } else if (argument.startsWith("--limit=")) {
            options.limit = Number.parseInt(argument.slice("--limit=".length), 10);
        } else if (argument.startsWith("--out=")) {
            options.out = path.resolve(argument.slice("--out=".length));
        } else if (argument.startsWith("--env-file=")) {
            options.envFile = path.resolve(argument.slice("--env-file=".length));
        } else if (argument === "--no-env-file") {
            options.noEnvFile = true;
        } else if (argument === "--probe") {
            options.probe = true;
        } else if (argument === "--dry-run") {
            options.dryRun = true;
        } else if (argument === "--help" || argument === "-h") {
            options.help = true;
        }
    }

    if (!Number.isInteger(options.limit) || options.limit < 1) {
        throw new Error("--limit must be a positive integer");
    }

    return options;
}

/** Behavioural metadata only. The checker's verdict is the label and is never sent. */
export function attemptFeatures(harness, task, attempt) {
    const tokens = attempt.tokens ?? {};
    const series = tokens.series ?? [];
    const calls = Object.values(tokens.toolCalls ?? {}).reduce((total, value) => total + value, 0);
    const faults = attempt.faults ?? undefined;

    return {
        harness,
        task: task.task,
        tier: task.tier,
        category: task.category,
        requests: attempt.modelRequests ?? series.length,
        toolCalls: calls,
        distinctTools: Object.keys(tokens.toolCalls ?? {}).length,
        toolsOffered: (attempt.firstCall?.toolNames ?? []).length,
        timedOut: attempt.timedOut === true,
        exitCode: attempt.exitCode ?? 0,
        harnessError: (attempt.harnessError ?? "").slice(0, 80),
        durationSeconds: Math.round((attempt.durationMs ?? 0) / 1000),
        faultsSeen: faults ? Object.values(faults).reduce((total, item) => total + (item?.seen ?? 0), 0) : 0,
        faultsFailed: faults ? Object.values(faults).reduce((total, item) => total + (item?.failed ?? 0), 0) : 0,
        outputTokens: tokens.outputTokens ?? 0,
        freshTokens: series.reduce((total, item) => total + (item.promptTokens - item.cachedTokens), 0),
    };
}

export function questions() {
    return {
        task_success_likely: noul(
            "This coding-agent attempt finished the task it was given, judged only from how it behaved",
        ),
        gave_up_early: noul("The attempt stopped before doing enough work to have solved the task"),
        effort: score("How much work did this attempt actually do?", [
            "Barely started",
            "A normal amount for this kind of task",
            "Thrashed: far more steps than the task needed",
        ]),
    };
}

export function collectAttempts(runsDir, limit) {
    const rows = [];
    if (!fs.existsSync(runsDir)) {
        return rows;
    }

    for (const entry of fs.readdirSync(runsDir).sort()) {
        const file = path.join(runsDir, entry, "report.json");
        if (!fs.existsSync(file)) {
            continue;
        }

        let report;
        try {
            report = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {
            continue;
        }

        for (const result of report.results ?? []) {
            for (const [index, attempt] of (result.attempts ?? []).entries()) {
                if (typeof attempt.pass !== "boolean") {
                    continue;
                }

                rows.push({
                    id: `${entry}/${result.harness}/${result.task}#${index}`,
                    label: attempt.pass,
                    features: attemptFeatures(result.harness, result, attempt),
                });
                if (rows.length >= limit) {
                    return rows;
                }
            }
        }
    }

    return rows;
}

/** Ten equal-width bins. A calibrated model puts observed frequency near the bin's midpoint. */
export function reliability(points, bins = 10) {
    const table = Array.from({ length: bins }, (_, index) => ({
        from: index / bins,
        to: (index + 1) / bins,
        n: 0,
        positives: 0,
        sum: 0,
    }));
    for (const point of points) {
        const index = Math.min(bins - 1, Math.max(0, Math.floor(point.probability * bins)));
        table[index].n += 1;
        table[index].sum += point.probability;
        if (point.label) {
            table[index].positives += 1;
        }
    }

    return table
        .filter((bin) => bin.n > 0)
        .map((bin) => ({
            ...bin,
            predicted: bin.sum / bin.n,
            observed: bin.positives / bin.n,
        }));
}

/** Expected calibration error: the headline number for "are these probabilities honest". */
export function expectedCalibrationError(table, total) {
    return table.reduce((total_, bin) => total_ + (bin.n / total) * Math.abs(bin.predicted - bin.observed), 0);
}

export function precisionAt(points, threshold) {
    const flagged = points.filter((point) => point.probability >= threshold);
    const positives = flagged.filter((point) => point.label).length;

    return {
        threshold,
        flagged: flagged.length,
        precision: flagged.length === 0 ? undefined : positives / flagged.length,
        recall: points.filter((point) => point.label).length
            ? positives / points.filter((point) => point.label).length
            : undefined,
    };
}

/**
 * Dotenv-style local key loading, reusing the eval suite's own loader and its own `evals/.env`
 * rather than inventing a second mechanism beside it. A variable already set in the shell always wins, values are never printed, and only
 * the path and a count are reported. `--no-env-file` skips it entirely.
 */
function applyEnvFile(options) {
    const file = options.envFile ?? path.join(root, "evals", ".env");
    if (options.noEnvFile || !fs.existsSync(file)) {
        return;
    }

    const loaded = loadEnvFile(file);
    console.error(`env: ${loaded.loaded} of ${loaded.entries} variable(s) from ${file}`);
}

/**
 * One tiny call, to prove a key and an endpoint work before spending a whole run on them. It sends
 * a fixed synthetic state carrying nothing from this machine, so it is safe to run anywhere.
 */
async function probe() {
    if (!process.env.TYPESAFE_API_KEY) {
        console.error("TYPESAFE_API_KEY is not set. Put it in evals/.env (see evals/.env.example) or the environment.");
        process.exitCode = 1;

        return;
    }

    console.log(`endpoint: ${endpoint()}`);
    console.log("key: present (never printed)");
    const state = { subject: "A build failed after a dependency bump", retries: 2, exitCode: 1 };
    const response = await ask(
        state,
        {
            is_transient: noul("This failure looks transient rather than a real defect"),
            severity: score("How serious is this?", ["Cosmetic", "Worth fixing", "Blocking"]),
        },
        { timeoutMs: 5000 },
    );
    if (!response.ok) {
        console.error(`probe failed: ${response.reason} (${response.latencyMs ?? "?"}ms)`);
        process.exitCode = 1;

        return;
    }

    console.log(`model: ${response.model ?? "unreported"}`);
    console.log(`latency: ${response.latencyMs}ms`);
    for (const [name, answer] of Object.entries(response.answers)) {
        console.log(
            `  ${name.padEnd(14)} ${answer.kind.padEnd(7)} value=${answer.value} confidence=${answer.confidence ?? "n/a"}`,
        );
    }

    console.log("");
    console.log("Probe succeeded. The key and endpoint work.");
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(
            "Usage: node scripts/jev-calibrate.mjs [--probe] [--runs=<dir>] [--limit=<n>] [--out=<file.json>] [--env-file=<path>] [--no-env-file] [--dry-run]",
        );

        return;
    }

    applyEnvFile(options);
    if (options.probe) {
        await probe();

        return;
    }

    const rows = collectAttempts(options.runs, options.limit);
    if (rows.length === 0) {
        console.error(`No labelled attempts found under ${options.runs}.`);
        process.exitCode = 1;

        return;
    }

    console.log(`Found ${rows.length} labelled attempts (${rows.filter((row) => row.label).length} passed).`);
    if (options.dryRun) {
        console.log("Dry run: no request sent. First feature row:");
        console.log(JSON.stringify(buildState(rows[0].features, { maxBytes: 1024 }).state, null, 2));

        return;
    }

    if (!process.env.TYPESAFE_API_KEY) {
        console.error(
            "TYPESAFE_API_KEY is not set. Put it in evals/.env (see evals/.env.example) or the environment, or re-run with --dry-run to inspect what would be sent.",
        );
        process.exitCode = 1;

        return;
    }

    const points = [];
    const failures = [];
    for (const row of rows) {
        const built = buildState(row.features, { maxBytes: 1024 });
        const response = await ask(built.state, questions(), { timeoutMs: 5000 });
        if (!response.ok) {
            failures.push({ id: row.id, reason: response.reason });
            continue;
        }

        const probability = response.answers?.task_success_likely?.value;
        if (typeof probability !== "number") {
            failures.push({ id: row.id, reason: "missing-answer" });
            continue;
        }

        points.push({ id: row.id, label: row.label, probability, latencyMs: response.latencyMs });
    }

    if (points.length === 0) {
        console.error(
            `Every request failed. First reasons: ${failures
                .slice(0, 3)
                .map((item) => item.reason)
                .join(", ")}`,
        );
        process.exitCode = 1;

        return;
    }

    const table = reliability(points);
    const ece = expectedCalibrationError(table, points.length);
    const thresholds = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95].map((value) => precisionAt(points, value));
    const meanLatency = Math.round(points.reduce((total, point) => total + (point.latencyMs ?? 0), 0) / points.length);

    console.log("");
    console.log(`Scored ${points.length} attempts, ${failures.length} failed, mean latency ${meanLatency}ms.`);
    console.log(`Expected calibration error: ${ece.toFixed(4)} (lower is better; <0.05 is well calibrated).`);
    console.log("");
    console.log("bin          n   predicted  observed");
    for (const bin of table) {
        console.log(
            `${bin.from.toFixed(1)}-${bin.to.toFixed(1)}  ${String(bin.n).padStart(4)}  ${bin.predicted.toFixed(3).padStart(9)}  ${bin.observed.toFixed(3).padStart(8)}`,
        );
    }

    console.log("");
    console.log("threshold  flagged  precision  recall");
    for (const row of thresholds) {
        console.log(
            `${row.threshold.toFixed(2).padStart(9)}  ${String(row.flagged).padStart(7)}  ${(row.precision === undefined ? "-" : row.precision.toFixed(3)).padStart(9)}  ${(row.recall === undefined ? "-" : row.recall.toFixed(3)).padStart(6)}`,
        );
    }

    if (options.out) {
        fs.writeFileSync(
            options.out,
            `${JSON.stringify({ schema: 1, generatedAt: new Date().toISOString(), points, table, ece, thresholds, failures }, null, 4)}\n`,
        );
        console.log(`\nWrote ${options.out}`);
    }
}

if (import.meta.url === pathToUrl(process.argv[1] ?? "")) {
    await main();
}
