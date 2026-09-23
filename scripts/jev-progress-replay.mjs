// Does system 5's stuck verdict say anything about whether a run is going to fail -- and would it,
// given the commands rather than only counts of them?
//
// Replays recorded Terminal-Bench 2 transcripts through the advisor's own progress bookkeeping,
// turn by turn, and asks Jev wherever the shipped local gate would have asked. Two states are sent
// at each such point: the one the advisor sends today, and a candidate that adds the last few calls
// and how each ended, without the local reasons that the shipped state hands the classifier. Each
// run's highest `is_stuck` is scored against the task's own verifier, pooled and -- the number that
// decides it -- within task, where task difficulty cannot carry the result.
//
// Usage: node scripts/jev-progress-replay.mjs [--runs=<runs-root>] [--limit=<n>] [--concurrency=<n>]
//        [--out=<file.json>] [--no-env-file]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./eval-env.mjs";
import { DEFAULT_RUNS, TUNE_SITTINGS, auc, collect, pool, textOf, withinTaskAuc } from "./jev-completion-replay.mjs";

process.env.JEV_KEY_SOURCE ??= "environment";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const advisor = path.join(root, "extensions", "jev-advisor");
const pathToUrl = (value) => new URL(`file://${value.replaceAll("\\", "/").replace(/^([A-Za-z]:)/u, "/$1")}`).href;
const { apiKey, ask } = await import(pathToUrl(path.join(advisor, "client.mjs")));
const { buildState, buildQuestions, compact } = await import(pathToUrl(path.join(advisor, "sanitize.mjs")));
// The system as it last shipped. It has since been withdrawn from the advisor, on this replay's result.
const progress = await import(pathToUrl(path.join(root, "scripts", "jev-progress-system.mjs")));

// Mirrors index.ts. A replay that kept a different history would measure a different gate.
const HISTORY_WINDOW = 12;
const MAX_CHECKPOINTS = 12;

function lastLine(text) {
    return (
        String(text ?? "")
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter(Boolean)
            .at(-1) ?? ""
    );
}

/** The candidate: today's evidence, minus the local reasons, plus what the recent calls were. */
export function candidateInput({ history, objective, calls }) {
    const shipped = progress.buildInput({ history, objective, reasons: [] });
    delete shipped.reasons;

    return {
        ...shipped,
        recentCalls: calls
            .slice(-4)
            .map((item) => compact(`${item.ok ? "ok" : "failed"}: ${item.call} -> ${item.last}`, 110)),
    };
}

/** Walk one transcript as the advisor would see it and return every point where it would ask. */
export function checkpoints(entries) {
    const messages = entries.map((entry) => entry?.message).filter(Boolean);
    const history = {
        turn: 0,
        signatures: [],
        tools: [],
        errors: [],
        consecutiveErrors: 0,
        turnsSinceChange: 0,
        filesChanged: 0,
        changedThisTurn: false,
        askedAtTurn: undefined,
    };
    const inputs = new Map();
    const calls = [];
    const found = [];
    let objective = "";
    let open = false;
    const endTurn = () => {
        history.turnsSinceChange = history.changedThisTurn ? 0 : history.turnsSinceChange + 1;
        const local = progress.suspicious(history);
        if (local.ask && found.length < MAX_CHECKPOINTS) {
            history.askedAtTurn = history.turn;
            found.push({
                turn: history.turn,
                reasons: local.reasons,
                shipped: progress.buildInput({ history, objective, reasons: local.reasons }),
                candidate: candidateInput({ history, objective, calls }),
            });
        }
    };

    for (const message of messages) {
        if (message.role === "user" && !objective) {
            objective = compact(textOf(message.content), 180);
        } else if (message.role === "assistant") {
            if (open) {
                endTurn();
            }

            open = true;
            history.turn += 1;
            history.changedThisTurn = false;
            for (const part of Array.isArray(message.content) ? message.content : []) {
                if (part?.type !== "toolCall") {
                    continue;
                }

                inputs.set(part.id, { name: part.name, input: part.arguments });
                history.signatures.push(progress.signature(part.name, part.arguments));
                history.tools.push(part.name);
                if (history.signatures.length > HISTORY_WINDOW) {
                    history.signatures.shift();
                }

                if (history.tools.length > HISTORY_WINDOW) {
                    history.tools.shift();
                }
            }
        } else if (message.role === "toolResult") {
            const text = textOf(message.content);
            const call = inputs.get(message.toolCallId);
            const ok = message.isError !== true;
            if (!ok) {
                history.consecutiveErrors += 1;
                history.errors.push(text.slice(0, 200));
                if (history.errors.length > HISTORY_WINDOW) {
                    history.errors.shift();
                }
            } else {
                history.consecutiveErrors = 0;
                if (progress.MUTATING_TOOLS.has(message.toolName)) {
                    history.filesChanged += 1;
                    history.changedThisTurn = true;
                }
            }

            calls.push({
                call: compact(`${message.toolName}: ${call?.input?.command ?? call?.input?.path ?? ""}`, 60),
                ok,
                last: compact(lastLine(text), 40),
            });
            if (calls.length > HISTORY_WINDOW) {
                calls.shift();
            }
        }
    }

    if (open) {
        endTurn();
    }

    return found;
}

function parseArgs(argv) {
    const options = {
        runs: DEFAULT_RUNS,
        concurrency: 6,
        out: path.join(root, "evals", "runs", "jev-progress-replay.json"),
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
        } else if (argument === "--no-env-file") {
            options.noEnvFile = true;
        } else {
            throw new Error(`unknown argument: ${argument}`);
        }
    }

    return options;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const envFile = path.join(root, "evals", ".env");
    if (!options.noEnvFile && fs.existsSync(envFile)) {
        loadEnvFile(envFile);
    }

    if (!apiKey()) {
        throw new Error("No Jev key found. Set OPENROUTER_API_KEY or put it in evals/.env.");
    }

    // Timed-out runs are included: unlike the completion check, this one runs during the session.
    const trials = collect(options.runs).filter((trial) => trial.session);
    const chosen = Number.isInteger(options.limit) ? trials.slice(0, options.limit) : trials;
    const wire = buildQuestions(progress.questions());
    const points = [];
    const modes = { shipped: {}, candidate: {} };
    let calls = 0;
    let failed = 0;
    await pool(chosen, options.concurrency, async (trial) => {
        const entries = fs
            .readFileSync(trial.session, "utf8")
            .split(/\r?\n/u)
            .filter(Boolean)
            .map((line) => JSON.parse(line));
        const found = checkpoints(entries);
        const point = { id: trial.id, sitting: trial.sitting, arm: trial.arm, task: trial.task, pass: trial.pass };
        point.checkpoints = found.length;
        for (const variant of ["shipped", "candidate"]) {
            let highest;
            for (const checkpoint of found) {
                // The advisor's per-field "progress" profile went with the system; both states are
                // well under the 1 KiB cap, so fitting them whole changes nothing that was measured.
                const built = buildState(checkpoint[variant], {});
                if (!built.ok) {
                    continue;
                }

                calls += 1;
                const response = await ask(built.state, wire, { timeoutMs: 5000 });
                if (!response.ok) {
                    failed += 1;
                    continue;
                }

                const stuck = response.answers.is_stuck?.value;
                const mode = response.answers.failure_mode?.value;
                modes[variant][mode] = (modes[variant][mode] ?? 0) + 1;
                if (Number.isFinite(stuck) && (highest === undefined || stuck > highest)) {
                    highest = stuck;
                }
            }

            point[variant] = highest;
        }

        points.push(point);
    });

    const flagged = points.filter((point) => point.checkpoints > 0);
    const split = (set) => ({
        all: set,
        tune: set.filter((point) => TUNE_SITTINGS.has(point.sitting)),
        test: set.filter((point) => !TUNE_SITTINGS.has(point.sitting)),
    });
    const rate = (set) => (set.length > 0 ? set.filter((point) => point.pass).length / set.length : undefined);
    const summary = {
        localGate: {
            runs: points.length,
            asked: flagged.length,
            passRateAsked: rate(flagged),
            passRateNotAsked: rate(points.filter((point) => point.checkpoints === 0)),
        },
        failureModes: modes,
        ...Object.fromEntries(
            Object.entries(split(flagged)).map(([name, set]) => [
                name,
                {
                    n: set.length,
                    failures: set.filter((point) => !point.pass).length,
                    auc: { shipped: auc(set, "shipped"), candidate: auc(set, "candidate") },
                    withinTaskAuc: {
                        shipped: withinTaskAuc(set, "shipped"),
                        candidate: withinTaskAuc(set, "candidate"),
                    },
                },
            ]),
        ),
    };
    const report = { schema: 1, generatedAt: new Date().toISOString(), calls, failed, summary, points };
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
    console.error(`${calls} calls, ${failed} failed -> ${options.out}`);
}

if (import.meta.url === pathToUrl(process.argv[1] ?? "")) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
