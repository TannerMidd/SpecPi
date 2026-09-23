#!/usr/bin/env node
// System 3: classify why recorded eval attempts failed.
//
// "Codex fails 9 of 26" is a count. "Here is the distribution of why" is an evaluations page. That
// classification is manual transcript reading today, and it is a textbook map-reduce over many
// short, independent items — which is what a System One model is for.
//
// This works from the metadata already in report.json, so it runs against everything recorded so
// far without waiting for transcript retention. When `eval-run.mjs --keep-transcripts` has been
// used, the stderr tail and checker breakdown are richer and the classification improves; nothing
// here requires it.
//
// Offline only. No session hook, no latency budget. Grades never weaken a check: check.mjs still
// decides pass and fail, and this only explains the failures it already found.
//
// Usage:
//   node scripts/jev-triage.mjs [--runs=<dir>] [--harness=<id>] [--limit=200] [--out=<file.json>] [--dry-run]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./eval-env.mjs";

// This repository's own runs use the key they were handed -- `evals/.env` or the shell -- and never
// a developer's `/login openrouter` credential. Without this, resolution would prefer `auth.json`
// and a calibration run would silently bill a personal account while `--probe` verified a key the
// run did not use. Set before the client is imported, because it is read at call time.
process.env.JEV_KEY_SOURCE ??= "environment";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function pathToUrl(value) {
    return new URL(`file://${value.replaceAll("\\", "/").replace(/^([A-Za-z]:)/u, "/$1")}`).href;
}

const advisor = path.join(root, "extensions", "jev-advisor");
const { apiKey, ask, choice, noul } = await import(pathToUrl(path.join(advisor, "client.mjs")));
const { buildState, compact } = await import(pathToUrl(path.join(advisor, "sanitize.mjs")));
const { choiceValue, nounTrue } = await import(pathToUrl(path.join(advisor, "gate.mjs")));
const { PUBLISHED_REPORTS } = await import(pathToUrl(path.join(root, "scripts", "jev-calibrate.mjs")));

// The taxonomy the withdrawn progress system asked against, kept with it in scripts/ so this
// script's published distribution still names the categories that system used.
export const { FAILURE_MODES } = await import(pathToUrl(path.join(root, "scripts", "jev-progress-system.mjs")));

function parseArgs(argv) {
    const options = {
        runs: undefined,
        limit: 400,
        harness: undefined,
        out: path.join(root, "evals", "runs", "jev-triage.json"),
        dryRun: false,
    };
    for (const argument of argv) {
        if (argument.startsWith("--runs=")) {
            options.runs = path.resolve(argument.slice("--runs=".length));
        } else if (argument.startsWith("--harness=")) {
            options.harness = argument.slice("--harness=".length);
        } else if (argument.startsWith("--limit=")) {
            options.limit = Number.parseInt(argument.slice("--limit=".length), 10);
        } else if (argument.startsWith("--out=")) {
            options.out = path.resolve(argument.slice("--out=".length));
        } else if (argument === "--no-out") {
            options.out = undefined;
        } else if (argument.startsWith("--env-file=")) {
            options.envFile = path.resolve(argument.slice("--env-file=".length));
        } else if (argument === "--no-env-file") {
            options.noEnvFile = true;
        } else if (argument === "--dry-run") {
            options.dryRun = true;
        } else if (argument === "--help" || argument === "-h") {
            options.help = true;
        }
    }

    return options;
}

export function failureFeatures(harness, result, attempt) {
    const tokens = attempt.tokens ?? {};
    const series = tokens.series ?? [];
    const faults = attempt.faults ?? undefined;
    const repeated = Object.entries(tokens.toolCalls ?? {}).sort((a, b) => b[1] - a[1])[0];

    return {
        harness,
        task: result.task,
        tier: result.tier,
        category: result.category,
        checkerNotes: compact(attempt.notes ?? "", 200),
        score: attempt.score,
        requests: attempt.modelRequests ?? series.length,
        timedOut: attempt.timedOut === true,
        exitCode: attempt.exitCode ?? 0,
        harnessError: compact(attempt.harnessError ?? "", 160),
        stderrTail: compact(attempt.stderrTail ?? "", 200),
        durationSeconds: Math.round((attempt.durationMs ?? 0) / 1000),
        mostRepeatedTool: repeated ? `${repeated[0]} x${repeated[1]}` : "none",
        faultsSeen: faults ? Object.values(faults).reduce((total, item) => total + (item?.seen ?? 0), 0) : 0,
        faultsFailed: faults ? Object.values(faults).reduce((total, item) => total + (item?.failed ?? 0), 0) : 0,
        hadFaults: Boolean(faults),
    };
}

export function questions() {
    return {
        failure_mode: choice("Why did this attempt fail?", FAILURE_MODES),
        recoverable: noul("A retry of the same attempt would plausibly have succeeded"),
        harness_at_fault: noul("The harness, rather than the model, is what made this attempt fail"),
    };
}

/**
 * The published matrix, not every directory under evals/runs. A distribution assembled from
 * superseded per-tier runs, scouting runs and the cache probe would be a distribution over a corpus
 * nobody can name, and this one is meant to be published beside the results it explains.
 */
export function collectFailures(reports, { limit, harness }) {
    const rows = [];
    for (const file of reports) {
        if (!fs.existsSync(file)) {
            continue;
        }

        const entry = path.basename(path.dirname(file));
        let report;
        try {
            report = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {
            continue;
        }

        for (const result of report.results ?? []) {
            if (harness && result.harness !== harness) {
                continue;
            }

            for (const [index, attempt] of (result.attempts ?? []).entries()) {
                if (attempt.pass !== false || attempt.skipped === true) {
                    continue;
                }

                rows.push({
                    id: `${entry}/${result.harness}/${result.task}#${index}`,
                    harness: result.harness,
                    task: result.task,
                    tier: result.tier,
                    features: failureFeatures(result.harness, result, attempt),
                });
                if (rows.length >= limit) {
                    return rows;
                }
            }
        }
    }

    return rows;
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

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(
            "Usage: node scripts/jev-triage.mjs [--runs=<dir>] [--harness=<id>] [--limit=<n>] [--out=<file.json>] [--env-file=<path>] [--no-env-file] [--dry-run]",
        );

        return;
    }

    applyEnvFile(options);
    const reports = options.runs
        ? fs
              .readdirSync(options.runs)
              .sort()
              .map((name) => path.join(options.runs, name, "report.json"))
        : PUBLISHED_REPORTS.map((file) => path.join(root, file));
    const rows = collectFailures(reports, options);
    if (rows.length === 0) {
        console.log("No failed attempts found. Nothing to triage.");

        return;
    }

    console.log(`Found ${rows.length} failed attempts.`);
    if (options.dryRun) {
        console.log("Dry run: no request sent. First feature row:");
        console.log(JSON.stringify(buildState(rows[0].features, { maxBytes: 1024 }).state, null, 2));

        return;
    }

    // The key name follows the backend, and the default backend is OpenRouter, so reading
    // TYPESAFE_API_KEY directly refused every environment that had only OPENROUTER_API_KEY set.
    if (!apiKey()) {
        console.error(
            "No Jev key found. Put OPENROUTER_API_KEY in evals/.env (see evals/.env.example) or the environment, or re-run with --dry-run to inspect what would be sent.",
        );
        process.exitCode = 1;

        return;
    }

    const classified = [];
    for (const row of rows) {
        const built = buildState(row.features, { maxBytes: 1024 });
        const response = await ask(built.state, questions(), { timeoutMs: 5000 });
        if (!response.ok) {
            classified.push({ ...row, mode: "unknown", reason: response.reason });
            continue;
        }

        // Gated through the same gate a session would use, so the published distribution is the
        // one the online classifier in Phase 6 would actually act on. An ungated answer is kept as
        // its own bucket rather than promoted to a verdict: "not determinable" is a real finding
        // and rounding it into the nearest mode is how a distribution starts lying.
        const gated = choiceValue(response.answers?.failure_mode, "gap");
        classified.push({
            id: row.id,
            harness: row.harness,
            task: row.task,
            tier: row.tier,
            mode: gated ?? "ungated",
            claimed: response.answers?.failure_mode?.value ?? "unknown",
            confidence: response.answers?.failure_mode?.confidence,
            recoverable: response.answers?.recoverable?.value,
            recoverableGated: nounTrue(response.answers?.recoverable, "gap"),
            harnessAtFault: response.answers?.harness_at_fault?.value,
            harnessAtFaultGated: nounTrue(response.answers?.harness_at_fault, "gap"),
        });
    }

    const byHarness = {};
    const byMode = {};
    for (const item of classified) {
        byHarness[item.harness] = byHarness[item.harness] ?? {};
        byHarness[item.harness][item.mode] = (byHarness[item.harness][item.mode] ?? 0) + 1;
        byMode[item.mode] = (byMode[item.mode] ?? 0) + 1;
    }

    console.log("");
    for (const [harness, modes] of Object.entries(byHarness)) {
        const total = Object.values(modes).reduce((sum, value) => sum + value, 0);
        console.log(`${harness} (${total} failures)`);
        for (const [mode, count] of Object.entries(modes).sort((a, b) => b[1] - a[1])) {
            console.log(`  ${mode.padEnd(20)} ${count}`);
        }
    }

    console.log("");
    console.log(`overall (${classified.length} failures)`);
    for (const [mode, count] of Object.entries(byMode).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${mode.padEnd(20)} ${count}`);
    }

    if (options.out) {
        fs.mkdirSync(path.dirname(options.out), { recursive: true });
        fs.writeFileSync(
            options.out,
            `${JSON.stringify(
                {
                    schema: 2,
                    generatedAt: new Date().toISOString(),
                    reports: reports.map((file) => path.relative(root, file).replaceAll("\\", "/")),
                    modes: FAILURE_MODES,
                    classified,
                    byHarness,
                    byMode,
                },
                null,
                4,
            )}\n`,
        );
        console.log(`\nWrote ${options.out}`);
    }
}

if (import.meta.url === pathToUrl(process.argv[1] ?? "")) {
    await main();
}
