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
import { listTasks, prepareWorkspace, runChecker, scopeReport, workspaceFingerprint } from "./eval-tasks.mjs";
import { loadPrices, priceAttempt } from "./eval-prices.mjs";
import { conversationSummary, proxyTotals, startProxy, summarizeToolResults } from "./eval-proxy.mjs";
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
        "  --tier=1|2|3|4|5              limit to one tier",
        "  --task=<id>                   repeatable task filter",
        "  --attempts=N                  attempts per harness/task (1-10, default 1)",
        "  --model=<id>                  model id sent to the proxy (default fake-model)",
        "  --out=<dir>                   write report.json here (default: temp dir, printed)",
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

async function runAttempt({ harness, task, model, timeoutMs }) {
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
    let sessionMint = null;
    let mintError = "";
    if (forwardUrl && harness.needsProxySession) {
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
    const priced = priceAttempt(prices, model, { native, totals, sessionMint });
    // What the harness actually met, read back from the shim counters rather
    // than assumed from what the task asked for.
    const faults = readFaults(faultHandle);
    const firstSummary = conversationSummary(proxy.requests);
    const attempt = {
        pass: check.pass,
        notes: check.notes,
        exitCode: harnessResult.exitCode,
        timedOut: Boolean(harnessResult.timedOut),
        faults,
        harnessError,
        durationMs: harnessResult.durationMs,
        wallMs: Date.now() - startedAt,
        modelRequests: native?.steps ?? proxy.requests.length,
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
        score: check.score,
        breakdown: check.breakdown,
        scope,
        modelCost: priced.modelCost,
        mintCost: priced.mintCost,
        cost: priced.cost,
        costComplete: priced.costComplete,
        filesBefore: before.size,
        filesAfter: after.size,
    };
    await proxy.close();
    fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

    return attempt;
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
                attempts.push(await runAttempt({ harness, task, model: options.model, timeoutMs: options.timeoutMs }));
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
        pricesSha256: shaFile(path.join(root, "evals", "prices.json")),
        pricesDated: prices.pricedAt,
        method: "Disposable workspace per attempt. Proxy harnesses (pi family, Codex CLI, DeepSeek Harness) send model traffic through a logging proxy; native harnesses (OpenCode) report per-step tokens, cost and tool calls from their own transcript. Codex CLI reads only the Responses API now, so the proxy accepts that path and forwards it to the provider's responses endpoint inside a disposable CODEX_HOME; Codex's own sandbox rejects every command on Windows, so Codex runs use its full-access sandbox mode inside the attempt's disposable workspace, and that gate is not measured either. Costs are split: modelCost is the harness's own spend and is the comparable figure, mintCost is eval plumbing, and cost is their sum. Forwarded proxy traffic mints one OpenCode session per attempt for endpoint routing; only proxy harnesses need one and the mint carries OpenCode's own system prompt, so charging it to the harness would bill the Pi family for OpenCode's context. Proxy prompt_tokens arrive inclusive of cache rereads, so only the fresh portion carries the input price; reasoning tokens are billed at the output rate. Tool calls are counted from the tools the model invoked, never from the tools it was offered, which are reported separately as per-request schema weight. Approval dialogs cannot be answered headless, so SpecPi runs set the permission package's explicit yoloMode opt-in inside the disposable home; the gate itself is not measured. Files are judged by the task checker; costs come from logged usage times evals/prices.json. Unknown models and unpriced cache writes are lower bounds. Synthetic offline runs make zero model calls and cost zero.",
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
