#!/usr/bin/env node
// Eval runner. Runs each harness against each task in a disposable home
// with the model pointed at a logging proxy, judges the workspace with the
// task checker, and writes report.json. Offline by default: the proxy
// answers synthetically and only the fake harnesses run without extra
// wiring. Set EVAL_FORWARD_URL to forward proxy traffic to a real provider.
// Never touches the live Pi directory and never reads provider credentials.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { compositeScore, effortBreakdown } from "./eval-effort.mjs";
import { listTasks, prepareWorkspace, runChecker, scopeReport, workspaceFingerprint } from "./eval-tasks.mjs";
import { loadPrices, priceAttempt } from "./eval-prices.mjs";
import {
    advisorTotals,
    conversationSummary,
    modelRequests,
    proxyTotals,
    startProxy,
    summarizeToolResults,
} from "./eval-proxy.mjs";
import { isolatedHome, mintOpenCodeSession, resolveHarnesses } from "./eval-harnesses.mjs";
import { loadEnvFile } from "./eval-env.mjs";
import { prepareFaults, readFaults } from "./eval-faults.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
    const options = {
        harnesses: ["fake", "failing-fake"],
        tier: undefined,
        task: [],
        attempts: 1,
        model: "fake-model",
        out: null,
        envFile: null,
        timeoutMs: null,
        list: false,
        dryRun: false,
    };
    for (const argument of argv) {
        if (argument === "--list") {
            options.list = true;
        } else if (argument === "--dry-run") {
            options.dryRun = true;
        } else if (argument.startsWith("--harness=")) {
            options.harnesses = argument.slice("--harness=".length).split(",").filter(Boolean);
        } else if (argument.startsWith("--tier=")) {
            options.tier = Number.parseInt(argument.slice("--tier=".length), 10);
        } else if (argument.startsWith("--task=")) {
            options.task.push(argument.slice("--task=".length));
        } else if (argument.startsWith("--attempts=")) {
            options.attempts = Number.parseInt(argument.slice("--attempts=".length), 10);
        } else if (argument.startsWith("--timeout=")) {
            options.timeoutMs = Number.parseInt(argument.slice("--timeout=".length), 10) * 1000;
        } else if (argument.startsWith("--model=")) {
            options.model = argument.slice("--model=".length);
        } else if (argument.startsWith("--out=")) {
            options.out = path.resolve(argument.slice("--out=".length));
        } else if (argument.startsWith("--env-file=")) {
            options.envFile = path.resolve(argument.slice("--env-file=".length));
        } else if (argument === "--keep-transcripts") {
            options.keepTranscripts = true;
        } else if (argument === "--help" || argument === "-h") {
            options.help = true;
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }

    if (!Number.isSafeInteger(options.attempts) || options.attempts < 1 || options.attempts > 10) {
        throw new Error("--attempts must be an integer from 1 to 10");
    }

    return options;
}

function usage() {
    return [
        "Usage: node scripts/eval-run.mjs [options]",
        "  --harness=fake,failing-fake   harnesses to run (default: fake,failing-fake)",
        "  --tier=1|2|3|4|5|6            limit to one tier",
        "  --task=<id>                   repeatable task filter",
        "  --attempts=N                  attempts per harness/task (1-10, default 1)",
        "  --model=<id>                  model id sent to the proxy (default fake-model)",
        "  --out=<dir>                   write report.json here (default: temp dir, printed)",
        "  --keep-transcripts            also write per-attempt request transcripts beside report.json",
        "  --env-file=<file>             load provider credentials (git-ignored, never logged)",
        "  --timeout=<seconds>           override each task's own time budget",
        "  --list                        print the matrix without running",
        "  --dry-run                     print the matrix and cost ceiling without running",
        "  Env: EVAL_FORWARD_URL forwards proxy traffic to a real provider.",
    ].join("\n");
}

function shaFile(file) {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function selectTasks(options) {
    let tasks = listTasks({ tier: options.tier });
    if (options.task.length > 0) {
        const wanted = new Set(options.task);
        tasks = tasks.filter((task) => wanted.has(task.id));
        for (const id of wanted) {
            if (!tasks.some((task) => task.id === id)) {
                throw new Error(`Unknown task: ${id}`);
            }
        }
    }

    return tasks;
}

/**
 * Per-attempt request transcripts, off by default. `node scripts/jev-triage.mjs` reads report.json
 * alone and works without these; they make the classification better when present. They are
 * synthetic tasks in disposable workspaces, but the directory is gitignored regardless.
 */
function writeTranscript(directory, { harness, task, proxy, attempt }) {
    try {
        fs.mkdirSync(directory, { recursive: true });
        const file = path.join(directory, `${harness}__${task}__${Date.now()}.json`);
        fs.writeFileSync(
            file,
            `${JSON.stringify(
                {
                    schema: 1,
                    harness,
                    task,
                    pass: attempt.pass,
                    notes: attempt.notes,
                    // Conversation turns only, for the same reason the count above filters:
                    // interleaving advisor posts into a numbered transcript makes the session look
                    // like it took turns it never took. Advisor spend is reported in `advisor`.
                    requests: modelRequests(proxy.requests ?? []).map((request, index) => ({
                        index,
                        toolCalls: request.toolCalls ?? null,
                        promptTokens: request.usage?.prompt_tokens ?? null,
                        completionTokens: request.usage?.completion_tokens ?? null,
                    })),
                },
                null,
                4,
            )}
`,
        );
    } catch {
        // A transcript is a convenience. Losing one must never fail the attempt that produced it.
    }
}

/**
 * Whether the configured provider is the OpenCode Go endpoint, which routes on a session id.
 *
 * Matched on host rather than on the whole URL so a path or version change does not silently turn
 * minting off, and so any other provider -- OpenRouter, a local gateway -- is recognised as not
 * needing one without having to be listed.
 */
export function needsOpenCodeSession(forwardUrl) {
    try {
        return new URL(forwardUrl).hostname.endsWith("opencode.ai");
    } catch {
        // An unparseable URL is not something to guess about: keep the old behaviour.
        return true;
    }
}

/**
 * Remove an attempt's disposable directory, and never lose the attempt if it cannot be removed.
 *
 * On Windows a directory stays locked while any process still holds it as a working directory, and
 * a harness that leaves a helper alive for a moment after its own exit keeps the attempt's
 * workspace locked with it -- Claude Code does, which is how this was found. The attempt's result
 * is already computed by this point, so throwing here discarded a finished measurement to report a
 * temporary file that the operating system will clean up anyway. It retries for longer than the
 * old three attempts, then says so and moves on.
 */
function discardRunDir(runDir) {
    try {
        fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    } catch (error) {
        process.stderr.write(`eval: could not remove ${runDir} (${String(error?.message ?? error)})\n`);
    }
}

async function runAttempt({ harness, task, model, timeoutMs, transcriptDir }) {
    const runDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-eval-run-")));
    const workspaceDir = path.join(runDir, "workspace");
    const homeDir = path.join(runDir, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    prepareWorkspace(task, workspaceDir);
    const before = workspaceFingerprint(workspaceDir);
    const forwardUrl = process.env.EVAL_FORWARD_URL || undefined;
    // Proxy harnesses need a live OpenCode session id for the Go endpoint
    // to route their calls. Minting happens before the proxy starts so the
    // id is fixed for the attempt; failures here fail the attempt closed
    // instead of burning task budget on unroutable calls.
    //
    // Only that endpoint needs one. The session id is an OpenCode routing
    // requirement, not a property of forwarding, so against any other provider
    // minting spends an OpenCode call per attempt, charges its tokens to the
    // run as mintCost, and requires an OpenCode login the run is not otherwise
    // using -- to produce an id the provider ignores.
    let sessionMint = null;
    let mintError = "";
    if (forwardUrl && needsOpenCodeSession(forwardUrl) && harness.needsProxySession) {
        try {
            sessionMint = await mintOpenCodeSession({ workspaceDir, model });
        } catch (error) {
            mintError = String(error?.message ?? error);
        }
    }

    const proxy = await startProxy({ forwardUrl, sessionId: sessionMint?.sessionId });
    const startedAt = Date.now();
    let faultHandle = null;
    let harnessResult = null;
    let harnessError = mintError;
    try {
        if (mintError) {
            throw new Error(mintError);
        }

        faultHandle = prepareFaults(task, homeDir, workspaceDir);
        harnessResult = await harness.run({
            task,
            workspaceDir,
            homeDir,
            faults: faultHandle,
            proxyUrl: proxy.url,
            model,
            timeoutMs: timeoutMs ?? task.timeoutMs ?? 120000,
        });
    } catch (error) {
        harnessError = String(error?.message ?? error);
        harnessResult = { exitCode: 1, timedOut: false, durationMs: Date.now() - startedAt, stderrTail: harnessError };
    }

    const check = await runChecker(task, workspaceDir).catch((error) => {
        return { pass: false, score: 0, breakdown: [], notes: `checker failed: ${String(error?.message ?? error)}` };
    });
    const after = workspaceFingerprint(workspaceDir);
    // Scope discipline is a harness property, not a model one: it is scored
    // on every task whether or not the task is about restraint.
    const scope = task.writable === null ? null : scopeReport(before, after, task.writable);
    const totals = proxyTotals(proxy.requests);
    const prices = loadPrices();
    // Harnesses with native usage reporting (OpenCode) bring their own
    // step and token counts; the frozen list still prices the cost so
    // harnesses stay comparable, with the native figure kept alongside.
    // priceAttempt owns every rule about which tokens cost what, and the
    // renderers reprice stored attempts through the same function.
    const native = harnessResult.usage ?? null;
    // Synthetic offline runs log requests without token usage; cost stays
    // zero and complete because the frozen list prices fake-model at zero.
    // Two halves of one story: the proxy saw the traffic leave, and the ledger inside the
    // disposable home says whether the answers were taken and what they saved. A cost column
    // carrying only the first can price the layer but cannot say whether it did anything.
    const advisor = { ...advisorTotals(proxy.requests), ledger: harnessResult.advisorLedger ?? null };
    const priced = priceAttempt(prices, model, { native, totals, sessionMint, advisor });
    // What the harness actually met, read back from the shim counters rather
    // than assumed from what the task asked for.
    const faults = readFaults(faultHandle);
    const firstSummary = conversationSummary(proxy.requests);
    const measuredTokens = native ? { toolCalls: native.toolCalls } : { toolCalls: totals.toolCalls };
    const scored = compositeScore(task, {
        correctness: check.score,
        pass: check.pass,
        tokens: measuredTokens,
    });
    const attempt = {
        pass: check.pass,
        notes: check.notes,
        exitCode: harnessResult.exitCode,
        timedOut: Boolean(harnessResult.timedOut),
        faults,
        harnessError,
        durationMs: harnessResult.durationMs,
        wallMs: Date.now() - startedAt,
        // Filtered, not the raw log. The advisor posts through the same proxy so that its spend
        // lands in the same accounting, and counting those posts as conversation turns reported the
        // specpi-jev row as taking two to three times as many turns as plain SpecPi for identical
        // work -- an artefact that reads as a damning efficiency result. eval-proxy exports this
        // filter for exactly this reason and every other consumer already used it; `series` and
        // `tokens.withUsage` were right while the count beside them was wrong.
        modelRequests: native?.steps ?? modelRequests(proxy.requests).length,
        firstCall: firstSummary,
        tokens: native
            ? {
                  inputTokens: native.inputTokens,
                  outputTokens: native.outputTokens,
                  reasoningTokens: native.reasoningTokens,
                  cachedTokens: native.cachedTokens,
                  cacheWriteTokens: native.cacheWriteTokens,
                  withUsage: native.steps,
                  toolCalls: native.toolCalls,
                  toolsOffered: null,
              }
            : totals,
        native,
        sessionMint,
        rpcEvents: harnessResult.rpcEvents ?? null,
        // The per-request shape of the run, kept so context growth and
        // compaction are visible instead of being summed away.
        series: native ? null : totals.series,
        context: native ? null : totals.context,
        // Tool outcomes: how often a tool came back an error, which is the
        // difference between a harness that recovers and one that spirals.
        toolOutcomes: native ? null : summarizeToolResults(proxy.requests),
        // The checker owns correctness and sees only the workspace, so its verdict stays exactly
        // what it was and the fake/failing-fake contract is untouched. Effort is a runner-side
        // measurement -- the checker cannot see tool calls -- so the composite is formed here and
        // both halves are recorded, which is what lets a stored report be rescored later.
        score: scored.score,
        correctness: scored.correctness,
        effort: scored.effort,
        breakdown: [...(check.breakdown ?? []), ...effortBreakdown(scored)],
        scope,
        modelCost: priced.modelCost,
        advisorCost: priced.advisorCost,
        advisor,
        mintCost: priced.mintCost,
        cost: priced.cost,
        costComplete: priced.costComplete,
        filesBefore: before.size,
        filesAfter: after.size,
        // Bounded and always recorded: the checker's notes say what was wrong with the files, and
        // this says what the harness was complaining about while it got there. Failure triage reads
        // both, and neither costs anything to keep.
        stderrTail: String(harnessResult.stderrTail ?? "").slice(-2000),
    };
    if (transcriptDir) {
        writeTranscript(transcriptDir, { harness: harness.id, task: task.id, proxy, attempt });
    }

    await proxy.close();
    discardRunDir(runDir);

    return attempt;
}

// A model that serves only the Responses API is reached by translating for the seven harnesses
// that speak chat-completions, which is a material fact about how those rows were measured and
// belongs in the method rather than in a commit message. Nothing is said when nothing was
// translated, so a report of a chat-completions run reads exactly as it always has.
function wireMethod() {
    if (String(process.env.EVAL_FORWARD_WIRE || "chat").toLowerCase() !== "responses") {
        return "";
    }

    return (
        "The model under test serves only the Responses API, so the proxy translated each " +
        "chat-completions request to that shape on the way out and the reply back on the way in. " +
        "Codex CLI speaks Responses natively and was passed through untranslated; Claude Code " +
        "speaks the Messages API and was translated twice. Reasoning items carry no " +
        "chat-completions equivalent and do not survive the crossing, but their tokens are " +
        "counted and billed at the output rate. "
    );
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(usage());

        return;
    }

    if (options.envFile) {
        const loaded = loadEnvFile(options.envFile);
        console.error(`eval env: ${loaded.loaded} of ${loaded.entries} variable(s) from ${loaded.file}`);
    }

    const harnesses = resolveHarnesses(options.harnesses);
    const tasks = selectTasks(options);
    if (options.list || options.dryRun) {
        for (const harness of harnesses) {
            const availability = harness.isAvailable();
            console.log(
                `${harness.id} (${harness.label}): ${availability.available ? "available" : "unavailable"} — ${availability.detail}`,
            );
        }

        console.log(`tasks (${tasks.length}): ${tasks.map((task) => task.id).join(", ")}`);
        console.log(`attempts: ${options.attempts}, model: ${options.model}`);
        if (options.dryRun) {
            console.log("dry run: no homes, workspaces, or model calls were created.");
        }

        return;
    }

    const outDir = options.out ?? fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-eval-out-")));
    fs.mkdirSync(outDir, { recursive: true });
    const specpiVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
    let piVersion = "unknown";
    try {
        piVersion = JSON.parse(
            fs.readFileSync(
                path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
                "utf8",
            ),
        ).version;
    } catch {
        piVersion = "unknown";
    }

    const prices = loadPrices();
    const results = [];
    for (const harness of harnesses) {
        const availability = harness.isAvailable();
        for (const task of tasks) {
            const attempts = [];
            for (let attempt = 1; attempt <= options.attempts; attempt++) {
                if (!availability.available) {
                    attempts.push({
                        pass: false,
                        notes: `harness unavailable: ${availability.detail}`,
                        exitCode: null,
                        timedOut: false,
                        harnessError: availability.detail,
                        durationMs: 0,
                        wallMs: 0,
                        modelRequests: 0,
                        firstCall: conversationSummary([]),
                        tokens: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, withUsage: 0, toolCalls: {} },
                        score: 0,
                        breakdown: [],
                        scope: null,
                        cost: 0,
                        costComplete: true,
                        filesBefore: 0,
                        filesAfter: 0,
                        skipped: true,
                    });
                    continue;
                }

                console.error(`eval ${harness.id} ${task.id} attempt ${attempt}/${options.attempts}...`);
                attempts.push(
                    await runAttempt({
                        harness,
                        task,
                        model: options.model,
                        timeoutMs: options.timeoutMs,
                        transcriptDir: options.keepTranscripts ? path.join(outDir, "transcripts") : undefined,
                    }),
                );
            }

            results.push({
                harness: harness.id,
                label: harness.label,
                task: task.id,
                tier: task.tier,
                category: task.category,
                attempts,
            });
        }
    }

    const report = {
        schema: 1,
        createdAt: new Date().toISOString(),
        specpiVersion,
        piVersion,
        nodeVersion: process.version,
        platform: process.platform,
        model: options.model,
        attemptsPerCell: options.attempts,
        // A run shortened with --timeout looks identical to a full one once
        // it is a file, and on a tier whose tasks are budgeted in tens of
        // minutes that difference decides whether a zero means "could not"
        // or "ran out of clock". Recorded so a report can say which it was.
        timeoutOverrideMs: options.timeoutMs ?? null,
        forwarded: Boolean(process.env.EVAL_FORWARD_URL),
        // Which wire the provider was spoken to on. A run against a Responses-only model is not
        // measuring quite the same thing as a run against a chat-completions one -- seven of the
        // eight harnesses had their requests and replies translated -- and a report that does not
        // record it cannot be told apart from one that did no such thing.
        forwardWire: String(process.env.EVAL_FORWARD_WIRE || "chat").toLowerCase(),
        pricesSha256: shaFile(path.join(root, "evals", "prices.json")),
        pricesDated: prices.pricedAt,
        method: `${wireMethod()}Disposable workspace per attempt. Proxy harnesses (pi family, Codex CLI, DeepSeek Harness) send model traffic through a logging proxy; native harnesses (OpenCode) report per-step tokens, cost and tool calls from their own transcript. Codex CLI reads only the Responses API now, so the proxy accepts that path and forwards it to the provider's responses endpoint inside a disposable CODEX_HOME; Codex's own sandbox rejects every command on Windows, so Codex runs use its full-access sandbox mode inside the attempt's disposable workspace, and that gate is not measured either. Costs are split: modelCost is the harness's own spend and is the comparable figure, mintCost is eval plumbing, and cost is their sum. Proxy traffic forwarded to the OpenCode endpoint mints one OpenCode session per attempt, because that endpoint routes on a session id; the mint carries OpenCode's own system prompt, so charging it to the harness would bill the Pi family for OpenCode's context, and it is reported separately as mintCost. Any other provider is sent to directly and mints nothing. Proxy prompt_tokens arrive inclusive of cache rereads, so only the fresh portion carries the input price; reasoning tokens are billed at the output rate. Tool calls are counted from the tools the model invoked, never from the tools it was offered, which are reported separately as per-request schema weight. A task that declares a context window runs the Pi family with compaction settings that fit it: a reserve equal to the 8,192-token output limit and a keep target of half the remainder, since Pi's defaults assume a far larger window. Approval dialogs cannot be answered headless, so SpecPi runs set the permission package's explicit yoloMode opt-in inside the disposable home; the gate itself is not measured. Files are judged by the task checker; costs come from logged usage times evals/prices.json. Unknown models and unpriced cache writes are lower bounds. Synthetic offline runs make zero model calls and cost zero.`,
        results,
    };
    // isolatedHome is exercised here so the helper stays covered even though
    // per-attempt homes above use their own run directory layout.
    const probeHome = isolatedHome();
    fs.rmSync(probeHome, { recursive: true, force: true });
    fs.writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 4)}\n`);
    const cells = results.length;
    const runs = results.reduce((total, cell) => total + cell.attempts.length, 0);
    console.log(`eval complete: ${cells} cells, ${runs} attempts -> ${path.join(outDir, "report.json")}`);
}

try {
    await main();
} catch (error) {
    console.error(String(error?.message ?? error));
    console.error(usage());
    process.exitCode = 1;
}
