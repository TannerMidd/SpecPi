// Would a completion check have told the passing runs from the failing ones?
//
// RESULT, 2026-09-23: no, not usefully, so the check was not built. Across 479 Terminal-Bench 2 runs
// that ended without a timeout, `task_complete` ranked failures below passes with a pooled AUC of
// 0.62-0.72 over two runs -- but almost all of that is Jev recognising hard tasks. Within a task,
// comparing attempts that passed against attempts that failed, it fell to 0.54-0.58, and the other
// two questions sat at or below chance. A requirement-focused variant with a longer request scored
// 0.50-0.63 within task, below the 0.65 held-out bar fixed before it ran. A follow-up fired on this signal would have cost a turn on runs
// that were failing at the base rate. The closing messages of passing and failing runs read alike,
// and the verifier checks details the transcript never shows.
//
// The questions live here rather than in the advisor, because nothing in the advisor asks them.
// Re-run this if Jev or the evidence available at that moment changes.
//
// Replays recorded Terminal-Bench 2 transcripts through these questions, at the moment the agent
// stopped on its own, and scores the answers against the task's own verifier. Only
// trials that ended without a timeout are asked: a timed-out agent never reached the point where
// the check runs.
//
// The transcripts are benchmark runs written by this repository's own harness adapters, not a
// user's Pi sessions. What is sent is the same redacted, 1 KiB-bounded state a live session would
// send.
//
// Usage: node scripts/jev-completion-replay.mjs [--runs=<runs-root>] [--limit=<n>] [--concurrency=<n>]
//        [--out=<file.json>] [--dry-run] [--env-file=<path>] [--no-env-file]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./eval-env.mjs";

// Bill the eval key, never a developer's `/login openrouter` account. Read at call time.
process.env.JEV_KEY_SOURCE ??= "environment";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const advisor = path.join(root, "extensions", "jev-advisor");
const pathToUrl = (value) => new URL(`file://${value.replaceAll("\\", "/").replace(/^([A-Za-z]:)/u, "/$1")}`).href;
const { apiKey, ask } = await import(pathToUrl(path.join(advisor, "client.mjs")));
const { buildState, buildQuestions, compact, redact } = await import(pathToUrl(path.join(advisor, "sanitize.mjs")));
const { noul } = await import(pathToUrl(path.join(advisor, "client.mjs")));
const { MUTATING_TOOLS } = await import(pathToUrl(path.join(root, "scripts", "jev-progress-system.mjs")));

const MAX_COMMANDS = 4;

/** The last non-empty line of a result: usually the verdict, the exit code or the error. */
function lastLine(text) {
    const lines = String(text ?? "")
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);

    return lines.at(-1) ?? "";
}

/** The text of the run's last assistant message, or nothing if it ended on tool calls or an error. */
function finalAssistantText(messages) {
    const message = [...messages].reverse().find((item) => item?.role === "assistant");

    return message ? textOf(message.content).trim() : "";
}

/** Head and tail of the closing message. A summary's caveats are usually at its end. */
function closing(text) {
    const flat = compact(text, 4000);

    return flat.length <= 300 ? flat : `${flat.slice(0, 170)} ... ${flat.slice(-125)}`;
}

/** What was sent: the request, the closing message and the last few shell commands with outcomes. */
export function buildInput({ request, finalText, history }) {
    return {
        request: compact(request ?? "", 230),
        finalMessage: closing(finalText),
        commands: history.commands
            .slice(-MAX_COMMANDS)
            .map((item) => compact(redact(`${item.ok ? "ok" : "failed"}: ${item.command} -> ${item.last}`), 96)),
        filesChanged: history.changes,
        checkedAfterLastChange: history.checkedSinceChange,
    };
}

export function questions() {
    return {
        task_complete: noul(
            "Judging by the request, the closing message and the recorded commands, every requirement of the task has been met",
        ),
        admits_gap: noul(
            "The closing message admits that part of the task is unfinished, untested, failing or handled only partly",
        ),
        unsupported_claim: noul(
            "The closing message claims a result that the recorded commands and their output do not show",
        ),
    };
}

export const DEFAULT_RUNS = "F:/Development/tb-bench/runs";

// The Pi and SpecPi + Jev arms of the sittings the published Terminal-Bench 2 page is built from,
// plus the Jev solo sitting. Both arms run Pi underneath, so both record the same transcript shape.
const SOURCES = [
    { sitting: "s1", arm: "pi", dir: "tb2-pair-20260921-131712/pi" },
    { sitting: "s1", arm: "jev", dir: "tb2-pair-20260921-131712/jev" },
    { sitting: "s1", arm: "pi", dir: "tb2-widen-20260921-142615/pi" },
    { sitting: "s1", arm: "jev", dir: "tb2-widen-20260921-142615/jev" },
    { sitting: "s2", arm: "jev", dir: "tb2-jevcc-20260922-002420/jev" },
    { sitting: "s3", arm: "pi", dir: "tb2-picontrol-20260922-075714/pi" },
    { sitting: "s4", arm: "pi", dir: "tb2-rep1-20260922-084504/pi" },
    { sitting: "s4", arm: "jev", dir: "tb2-rep1-20260922-084504/jev" },
    { sitting: "s5", arm: "pi", dir: "tb2-rep2-20260922-094001/pi" },
    { sitting: "s5", arm: "jev", dir: "tb2-rep2-20260922-094001/jev" },
    { sitting: "s6", arm: "pi", dir: "tb2-rep3-20260922-103224/pi" },
    { sitting: "s6", arm: "jev", dir: "tb2-rep3-20260922-103224/jev" },
    { sitting: "s7", arm: "pi", dir: "tb2-four-20260922-132056/pi" },
    { sitting: "s7", arm: "jev", dir: "tb2-four-20260922-132056/jev" },
    { sitting: "s8", arm: "jev", dir: "tb2-jev-solo-20260922-161440/jev" },
];

// Held out from any threshold choice, so the reported separation is not read off the data that
// chose it. The 22 Sep sittings c, d and e tune; everything else tests.
export const TUNE_SITTINGS = new Set(["s4", "s5", "s6"]);
const DROP_TASKS = new Set(["pytorch-model-recovery"]);

function parseArgs(argv) {
    const options = {
        runs: DEFAULT_RUNS,
        concurrency: 4,
        out: path.join(root, "evals", "runs", "jev-completion-replay.json"),
    };
    for (const argument of argv) {
        if (argument.startsWith("--runs=")) {
            options.runs = argument.slice("--runs=".length);
        } else if (argument.startsWith("--limit=")) {
            options.limit = Number.parseInt(argument.slice("--limit=".length), 10);
        } else if (argument.startsWith("--concurrency=")) {
            options.concurrency = Math.max(1, Number.parseInt(argument.slice("--concurrency=".length), 10) || 1);
        } else if (argument.startsWith("--out=")) {
            options.out = path.resolve(argument.slice("--out=".length));
        } else if (argument === "--dry-run") {
            options.dryRun = true;
        } else if (argument.startsWith("--env-file=")) {
            options.envFile = path.resolve(argument.slice("--env-file=".length));
        } else if (argument === "--no-env-file") {
            options.noEnvFile = true;
        } else {
            throw new Error(`unknown argument: ${argument}`);
        }
    }

    return options;
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return undefined;
    }
}

export function textOf(content) {
    return (Array.isArray(content) ? content : [{ type: "text", text: content }])
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
}

/** Rebuild what a live session would hold when the agent stops: history, request, closing text. */
export function reconstruct(entries) {
    const messages = entries.map((entry) => entry?.message).filter(Boolean);
    const history = { commands: [], changes: 0, checkedSinceChange: true };
    const calls = new Map();
    let request = "";
    for (const message of messages) {
        if (message.role === "user" && !request) {
            request = textOf(message.content);
        } else if (message.role === "assistant" && Array.isArray(message.content)) {
            for (const part of message.content) {
                if (part?.type === "toolCall") {
                    calls.set(part.id, part.arguments);
                }
            }
        } else if (message.role === "toolResult") {
            const ok = message.isError !== true;
            if (ok && MUTATING_TOOLS.has(message.toolName)) {
                history.changes += 1;
                history.checkedSinceChange = false;
            }

            if (message.toolName === "bash") {
                history.commands.push({
                    command: compact(calls.get(message.toolCallId)?.command ?? "", 48),
                    ok,
                    last: compact(lastLine(textOf(message.content)), 36),
                });
                // A successful command after a change counts as a possible check; the commands
                // themselves go into the state, so Jev sees which kind it was.
                history.checkedSinceChange ||= ok;
            }
        }
    }

    return { request, finalText: finalAssistantText(messages), history };
}

export function collect(runsRoot) {
    const found = [];
    for (const source of SOURCES) {
        const base = path.join(runsRoot, source.dir);
        if (!fs.existsSync(base)) {
            continue;
        }

        for (const stamp of fs.readdirSync(base)) {
            const stampDir = path.join(base, stamp);
            if (!fs.statSync(stampDir).isDirectory()) {
                continue;
            }

            for (const trial of fs.readdirSync(stampDir)) {
                const trialDir = path.join(stampDir, trial);
                const result = readJson(path.join(trialDir, "result.json"));
                if (!result || DROP_TASKS.has(result.task_name)) {
                    continue;
                }

                let reward;
                try {
                    reward = Number.parseFloat(fs.readFileSync(path.join(trialDir, "verifier", "reward.txt"), "utf8"));
                } catch {
                    continue;
                }

                const sessions = path.join(trialDir, "agent", "pi", "sessions");
                const file = fs.existsSync(sessions)
                    ? fs.readdirSync(sessions).find((name) => name.endsWith(".jsonl"))
                    : undefined;
                found.push({
                    id: `${source.dir}/${stamp}/${trial}`,
                    sitting: source.sitting,
                    arm: source.arm,
                    task: result.task_name,
                    pass: reward === 1,
                    timedOut: Boolean(result.exception_info),
                    session: file ? path.join(sessions, file) : undefined,
                });
            }
        }
    }

    return found;
}

/** Probability that a random failure scores higher than a random pass. 0.5 is no signal. */
export function auc(points, key, failHigh = true) {
    const fails = points.filter((point) => !point.pass && Number.isFinite(point[key])).map((point) => point[key]);
    const passes = points.filter((point) => point.pass && Number.isFinite(point[key])).map((point) => point[key]);
    if (fails.length === 0 || passes.length === 0) {
        return undefined;
    }

    let wins = 0;
    for (const fail of fails) {
        for (const pass of passes) {
            const a = failHigh ? fail : -fail;
            const b = failHigh ? pass : -pass;
            wins += a > b ? 1 : a === b ? 0.5 : 0;
        }
    }

    return wins / (fails.length * passes.length);
}

/** AUC over pairs drawn from the same task only, so task difficulty cannot carry it. */
export function withinTaskAuc(points, key, failHigh = true) {
    const tasks = new Map();
    for (const point of points) {
        tasks.set(point.task, [...(tasks.get(point.task) ?? []), point]);
    }

    let wins = 0;
    let pairs = 0;
    for (const group of tasks.values()) {
        const fails = group.filter((point) => !point.pass && Number.isFinite(point[key]));
        const passes = group.filter((point) => point.pass && Number.isFinite(point[key]));
        for (const fail of fails) {
            for (const pass of passes) {
                const a = failHigh ? fail[key] : -fail[key];
                const b = failHigh ? pass[key] : -pass[key];
                wins += a > b ? 1 : a === b ? 0.5 : 0;
                pairs += 1;
            }
        }
    }

    return pairs > 0 ? { auc: wins / pairs, pairs } : undefined;
}

/** What a follow-up rule would have done: how many it would fire on, and how many were failures. */
export function operating(points, rule) {
    const flagged = points.filter(rule);
    const failures = points.filter((point) => !point.pass).length;

    return {
        flagged: flagged.length,
        flaggedFailures: flagged.filter((point) => !point.pass).length,
        flaggedPasses: flagged.filter((point) => point.pass).length,
        failures,
        passes: points.length - failures,
        precision: flagged.length > 0 ? flagged.filter((point) => !point.pass).length / flagged.length : undefined,
        recall: failures > 0 ? flagged.filter((point) => !point.pass).length / failures : undefined,
    };
}

export async function pool(items, limit, worker) {
    let next = 0;
    const run = async () => {
        while (next < items.length) {
            const index = next;
            next += 1;
            await worker(items[index], index);
        }
    };

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

function summarize(points) {
    const split = {
        all: points,
        tune: points.filter((point) => TUNE_SITTINGS.has(point.sitting)),
        test: points.filter((point) => !TUNE_SITTINGS.has(point.sitting)),
    };
    const rules = {
        "admits_gap>=0.85": (point) => point.admits_gap >= 0.85,
        "admits_gap>=0.7": (point) => point.admits_gap >= 0.7,
        "task_complete<=0.15": (point) => point.task_complete <= 0.15,
        "task_complete<=0.3": (point) => point.task_complete <= 0.3,
        "unsupported_claim>=0.85": (point) => point.unsupported_claim >= 0.85,
    };

    return Object.fromEntries(
        Object.entries(split).map(([name, set]) => [
            name,
            {
                n: set.length,
                failures: set.filter((point) => !point.pass).length,
                auc: {
                    task_complete: auc(set, "task_complete", false),
                    admits_gap: auc(set, "admits_gap"),
                    unsupported_claim: auc(set, "unsupported_claim"),
                },
                // The number that decides it. Pooled AUC rewards knowing which tasks are hard; only
                // a comparison between attempts at the same task measures judging the run.
                withinTaskAuc: {
                    task_complete: withinTaskAuc(set, "task_complete", false),
                    admits_gap: withinTaskAuc(set, "admits_gap"),
                    unsupported_claim: withinTaskAuc(set, "unsupported_claim"),
                },
                rules: Object.fromEntries(Object.entries(rules).map(([label, rule]) => [label, operating(set, rule)])),
            },
        ]),
    );
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (!options.noEnvFile) {
        const file = options.envFile ?? path.join(root, "evals", ".env");
        if (fs.existsSync(file)) {
            loadEnvFile(file);
        }
    }

    const trials = collect(options.runs);
    const eligible = trials.filter((trial) => !trial.timedOut && trial.session);
    const chosen = Number.isInteger(options.limit) ? eligible.slice(0, options.limit) : eligible;
    console.error(
        `${trials.length} trials, ${trials.filter((trial) => trial.timedOut).length} timed out, ${chosen.length} to ask`,
    );
    if (!options.dryRun && !apiKey()) {
        throw new Error("No Jev key found. Set OPENROUTER_API_KEY or put it in evals/.env.");
    }

    const wire = buildQuestions(questions());
    const points = [];
    let refused = 0;
    let failed = 0;
    await pool(chosen, options.concurrency, async (trial) => {
        const entries = fs
            .readFileSync(trial.session, "utf8")
            .split(/\r?\n/u)
            .filter(Boolean)
            .map((line) => JSON.parse(line));
        const view = reconstruct(entries);
        // No advisor profile exists for this state, so the whole of it is fitted to the shared 1 KiB
        // cap. A run with no closing message -- one that ended on a provider error -- has nothing
        // to judge and is refused, as the advisor refuses any state missing its evidence.
        const built = buildState(buildInput(view), {});
        if (!built.ok || !built.state.finalMessage || !built.state.request) {
            refused += 1;

            return;
        }

        if (options.dryRun) {
            points.push({ ...trial, session: undefined, stateBytes: built.bytes, state: built.state });

            return;
        }

        const response = await ask(built.state, wire, { timeoutMs: 5000 });
        if (!response.ok) {
            failed += 1;

            return;
        }

        const value = (name) => response.answers[name]?.value;
        points.push({
            id: trial.id,
            sitting: trial.sitting,
            arm: trial.arm,
            task: trial.task,
            pass: trial.pass,
            stateBytes: built.bytes,
            checkedAfterLastChange: built.state.checkedAfterLastChange,
            task_complete: value("task_complete"),
            admits_gap: value("admits_gap"),
            unsupported_claim: value("unsupported_claim"),
        });
    });

    if (options.dryRun) {
        for (const point of points.slice(0, 3)) {
            console.log(JSON.stringify(point.state, null, 2), `\n${point.stateBytes} bytes, pass=${point.pass}\n`);
        }

        console.error(`${points.length} states built, ${refused} refused locally`);

        return;
    }

    const report = {
        schema: 1,
        generatedAt: new Date().toISOString(),
        asked: chosen.length,
        answered: points.length,
        refused,
        failed,
        tuneSittings: [...TUNE_SITTINGS],
        summary: summarize(points),
        points,
    };
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report.summary, null, 2));
    console.error(`${points.length} answered, ${refused} refused locally, ${failed} failed -> ${options.out}`);
}

if (import.meta.url === pathToUrl(process.argv[1] ?? "")) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
