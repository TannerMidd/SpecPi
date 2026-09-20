#!/usr/bin/env node
// Derive site/evaluations/tier6.json from one or more tier 6 run directories.
//
// Tier 6 is the suite built to contain the situations the other tiers cannot reach, and it exists
// because three earlier attempts at it failed in ways worth stating plainly:
//
//   v1 was batchable      every task collapsed to a shell one-liner, so sessions stayed short.
//   v2 was greppable      one grep with four alternations returned the answer set exactly.
//   v3 was un-triggered   the corpus was 254k against a 200k window and still nothing compacted,
//                         because an agent with a shell chunks or scripts rather than loading it.
//
// What finally worked was declaring a small context window instead of growing the corpus. A 24k
// window overruns on the transcript itself, which no shortcut avoids, and it is the first
// configuration in this project's history in which any session compacted at all.
//
// Several run directories pool. The pair comparison was sharded across processes to halve wall
// time, and shards of one arm are the same arm: `specpi-jev-a` and `specpi-jev-b` pool into
// `specpi-jev`. Pooling matters more than it sounds. Every reading of this comparison at n=6 was
// wrong -- once by a factor of four in the layer's favour, once against it -- so the numbers here
// are meant to be pooled to a sample that can carry a claim, and the pass-rate difference carries a
// Fisher exact p-value rather than a ratio that implies significance it does not have.
//
// Usage: node scripts/tier6-metrics.mjs <run-dir> [<run-dir>...]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { isLaunchFailure } from "./eval-site.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFile = path.join(root, "site", "evaluations", "tier6.json");

const ORDER = ["pi", "specpi-default", "specpi-jev", "omp", "codex", "opencode", "dsh"];
const LABELS = {
    pi: "Pi (base)",
    "specpi-default": "SpecPi",
    "specpi-jev": "SpecPi + Jev",
    omp: "Oh My Pi",
    codex: "Codex CLI",
    opencode: "OpenCode",
    dsh: "DeepSeek Harness",
};

const TASKS = ["t6-context-marathon", "t6-retention-haystack"];

// What each Jev system is for, so a row of zeroes reads as "the situation did not arise" rather
// than "the system did nothing". Wording follows each question module's own header.
const SYSTEMS = {
    compaction: "Where should a compaction cut, given the cache is discarded anyway?",
    retention: "Is this large tool result worth carrying for the rest of the session?",
    progress: "Has the session stopped making progress?",
    gap: "Is this capability-gap report worth writing?",
    sources: "Which files should a delegation batch snapshot?",
    untrusted: "Is this fetched content addressing the agent rather than a reader?",
    capability: "Will this session need a withdrawn tool group?",
    // Kept although the guard is no longer part of the layer: these tables render recorded runs,
    // and the runs that carried a guard row used the short-lived native guard. Dropping the label
    // would silently delete a measurement rather than correct it.
    guard: "Should this shell or file call run, where local rules could not settle it? (native guard, since retired)",
};

/**
 * Conversation turns, never the raw proxy log length.
 *
 * The advisor posts through the same proxy as the agent so its spend lands in one place, and
 * counting those posts as turns reported the specpi-jev arm as taking two to three times the turns
 * it took. `series` is the filtered count and has always been correct.
 */
function turns(attempt) {
    if (Array.isArray(attempt?.series)) {
        return attempt.series.length;
    }

    return Math.max(0, (attempt?.modelRequests ?? 0) - (attempt?.advisor?.calls ?? 0));
}

function mean(values) {
    const found = values.filter((value) => Number.isFinite(value));

    return found.length === 0 ? null : found.reduce((total, value) => total + value, 0) / found.length;
}

/**
 * The median alongside the mean, because one of these numbers is skewed and it matters which.
 *
 * A single haystack attempt cost $0.155 against a $0.037 median, and reporting only the mean turned
 * a 1.9x difference into a 2.8x one. Both are published so a reader can see the spread rather than
 * take the summary's word for it.
 */
function median(values) {
    const found = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (found.length === 0) {
        return null;
    }

    const mid = Math.floor(found.length / 2);

    return found.length % 2 === 1 ? found[mid] : (found[mid - 1] + found[mid]) / 2;
}

function choose(n, k) {
    if (k < 0 || k > n) {
        return 0;
    }

    let result = 1;
    for (let i = 0; i < k; i += 1) {
        result = (result * (n - i)) / (i + 1);
    }

    return result;
}

/**
 * Two-sided Fisher exact test on a 2x2 of pass/fail counts.
 *
 * Exact rather than chi-square because the counts are small, and present at all because the
 * temptation to read "four of six against six of six" as a finding is exactly what this number
 * exists to resist: at that sample it is p = 0.455, which is a coin.
 */
function fisherExact(a, b, c, d) {
    const total = a + b + c + d;
    if (total === 0) {
        return 1;
    }

    const row1 = a + b;
    const col1 = a + c;
    const observed = (choose(row1, a) * choose(total - row1, col1 - a)) / choose(total, col1);
    let p = 0;
    for (let k = Math.max(0, col1 - (total - row1)); k <= Math.min(row1, col1); k += 1) {
        const current = (choose(row1, k) * choose(total - row1, col1 - k)) / choose(total, col1);
        if (current <= observed * 1.0000001) {
            p += current;
        }
    }

    return Math.min(1, p);
}

/** Shards of one arm are one arm: `specpi-jev-a` and `specpi-jev-b` both pool into `specpi-jev`. */
function armOf(entry) {
    const match = /^(.*)-[ab]$/u.exec(entry);

    return match && ORDER.includes(match[1]) ? match[1] : entry;
}

/**
 * Whether the declared window was actually in force for this attempt.
 *
 * A session cannot exceed its context window without compacting, so a peak above the window with
 * zero compactions is proof the window never reached that harness. This is not hypothetical:
 * Codex and OpenCode reach their providers through their own configuration rather than this
 * runner's, so tier 6 attempts recorded before they were taught to read a declared window ran at
 * the provider default -- peak 51,000 to 82,000 tokens, never compacting. Pooling those beside
 * windowed attempts would average two different experiments into one row and show Codex as a
 * harness that does not compact.
 *
 * Tested rather than hardcoded as a list of runs to skip, because a list goes stale silently and
 * this does not.
 */
function ranWindowed(attempt, window) {
    const context = attempt.context ?? {};

    return !((context.compactions ?? 0) === 0 && (context.peakPromptTokens ?? 0) > window);
}

function collect(runDirs, window) {
    const attempts = new Map();
    const launchFailures = { count: 0, reasons: {} };
    const unwindowed = { count: 0, arms: {} };
    const runs = [];
    for (const dir of runDirs) {
        if (!fs.existsSync(dir)) {
            throw new Error(`no such run directory: ${dir}`);
        }

        let used = false;
        for (const entry of fs.readdirSync(dir).sort()) {
            const arm = armOf(entry);
            if (!ORDER.includes(arm)) {
                continue;
            }

            const report = path.join(dir, entry, "report.json");
            if (!fs.existsSync(report)) {
                continue;
            }

            used = true;
            const data = JSON.parse(fs.readFileSync(report, "utf8"));
            for (const result of data.results ?? []) {
                const key = `${arm}\u0000${result.task}`;
                const list = attempts.get(key) ?? [];
                for (const attempt of result.attempts ?? []) {
                    // An attempt that errored before its first model call never ran the task, so
                    // scoring it as a failure blames the harness for this suite's own plumbing.
                    // Running four harnesses at once is what makes this real: contention on the
                    // shared OpenCode session store produced "session mint timed out" attempts with
                    // zero requests, and averaging those in would have published Oh My Pi at 0 for 4
                    // when two of the four never started.
                    if (isLaunchFailure(attempt)) {
                        launchFailures.count += 1;
                        const reason = attempt.harnessError || "unknown";
                        launchFailures.reasons[reason] = (launchFailures.reasons[reason] ?? 0) + 1;
                        continue;
                    }

                    if (!ranWindowed(attempt, window)) {
                        unwindowed.count += 1;
                        unwindowed.arms[arm] = (unwindowed.arms[arm] ?? 0) + 1;
                        continue;
                    }

                    list.push(attempt);
                }

                attempts.set(key, list);
            }
        }

        if (used) {
            runs.push(path.basename(dir));
        }
    }

    return { attempts, runs, launchFailures, unwindowed };
}

function summarise(list) {
    const context = list.map((attempt) => attempt.context ?? {});

    return {
        attempts: list.length,
        solved: list.filter((attempt) => attempt.pass).length,
        turns: mean(list.map(turns)),
        compactions: mean(context.map((entry) => entry.compactions ?? 0)),
        reclaimed: mean(context.map((entry) => entry.reclaimedTokens ?? 0)),
        peakPromptTokens: mean(context.map((entry) => entry.peakPromptTokens ?? 0)),
        cost: mean(list.map((attempt) => attempt.cost)),
        costMedian: median(list.map((attempt) => attempt.cost)),
        seconds: mean(list.map((attempt) => attempt.durationMs / 1000)),
        advisorCalls: mean(list.map((attempt) => attempt.advisor?.calls ?? 0)),
        // Split by kind because they are not the same failure, and only one of them is evidence
        // about compaction. A session that ends without writing its answer believed it was done; a
        // wrong id list means it read the corpus and misjudged it.
        noOutput: list.filter((attempt) => !attempt.pass && /missing or does not parse/u.test(attempt.notes ?? ""))
            .length,
    };
}

function advisorLedger(attempts) {
    const bySystem = {};
    let calls = 0;
    let applied = 0;
    for (const [key, list] of attempts) {
        if (!key.startsWith("specpi-jev\u0000")) {
            continue;
        }

        for (const attempt of list) {
            const ledger = attempt.advisor?.ledger;
            if (!ledger) {
                continue;
            }

            calls += ledger.calls ?? 0;
            applied += ledger.applied ?? 0;
            for (const [system, bucket] of Object.entries(ledger.bySystem ?? {})) {
                const seen = (bySystem[system] ??= { calls: 0, applied: 0, outcomes: {} });
                seen.calls += bucket.calls ?? 0;
                seen.applied += bucket.applied ?? 0;
                for (const [outcome, count] of Object.entries(bucket.outcomes ?? {})) {
                    seen.outcomes[outcome] = (seen.outcomes[outcome] ?? 0) + count;
                }
            }
        }
    }

    return { calls, applied, bySystem };
}

function main() {
    const runDirs = process.argv.slice(2);
    if (runDirs.length === 0) {
        throw new Error("usage: node scripts/tier6-metrics.mjs <run-dir> [<run-dir>...]");
    }

    const WINDOW = 24000;
    const { attempts, runs, launchFailures, unwindowed } = collect(runDirs, WINDOW);
    const harnesses = [];
    for (const arm of ORDER) {
        const perTask = {};
        let any = false;
        for (const task of TASKS) {
            const list = attempts.get(`${arm}\u0000${task}`);
            if (list && list.length > 0) {
                perTask[task] = summarise(list);
                any = true;
            }
        }

        if (any) {
            const all = TASKS.flatMap((task) => attempts.get(`${arm}\u0000${task}`) ?? []);
            harnesses.push({ id: arm, label: LABELS[arm], ...summarise(all), perTask });
        }
    }

    // The comparison the tier was widened for, tested rather than asserted.
    const comparison = {};
    for (const task of TASKS) {
        const base = attempts.get(`specpi-default\u0000${task}`) ?? [];
        const jev = attempts.get(`specpi-jev\u0000${task}`) ?? [];
        if (base.length === 0 || jev.length === 0) {
            continue;
        }

        const basePass = base.filter((attempt) => attempt.pass).length;
        const jevPass = jev.filter((attempt) => attempt.pass).length;
        comparison[task] = {
            base: { n: base.length, solved: basePass },
            jev: { n: jev.length, solved: jevPass },
            p: fisherExact(basePass, base.length - basePass, jevPass, jev.length - jevPass),
        };
    }

    const totalCompactions = harnesses.reduce(
        (total, arm) => total + Math.round((arm.compactions ?? 0) * arm.attempts),
        0,
    );

    const payload = {
        generatedAt: new Date().toISOString(),
        note: "Tier 6 declares a 24,000-token context window. Every other tier runs at 200,000.",
        contextWindow: WINDOW,
        runs,
        tasks: TASKS,
        harnesses,
        comparison,
        totalCompactions,
        launchFailures,
        unwindowed,
        systems: SYSTEMS,
        advisor: advisorLedger(attempts),
    };

    fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 4)}\n`);
    process.stdout.write(
        `tier6 -> ${path.relative(root, outFile)} (${harnesses.length} harnesses, ` +
            `${harnesses.reduce((total, arm) => total + arm.attempts, 0)} attempts, ` +
            `${totalCompactions} compactions)\n`,
    );
    if (unwindowed.count > 0) {
        process.stdout.write(
            `  excluded ${unwindowed.count} attempt(s) whose window was not in force: ` +
                `${Object.entries(unwindowed.arms)
                    .map(([arm, count]) => `${arm} x${count}`)
                    .join(", ")}\n`,
        );
    }

    if (launchFailures.count > 0) {
        process.stdout.write(
            `  excluded ${launchFailures.count} attempt(s) that never started: ` +
                `${Object.entries(launchFailures.reasons)
                    .map(([reason, count]) => `${reason} x${count}`)
                    .join(", ")}\n`,
        );
    }
}

main();
