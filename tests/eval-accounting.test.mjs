import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import test from "node:test";
import {
    attemptMintCost,
    attemptModelCost,
    breakEvenPerExtraSolve,
    formatCost,
    median,
    mean,
    pairedContingency,
    summarizeAttempts,
    wilsonInterval,
} from "../scripts/eval-report.mjs";
import { loadPrices, priceUsage, repriceReport, sumCosts } from "../scripts/eval-prices.mjs";
import {
    contextShape,
    conversationSummary,
    deriveResponsesUrl,
    extractToolCalls,
    extractUsage,
    normalizeToolName,
    proxyTotals,
    startProxy,
    summarizeRequest,
    summarizeToolResults,
} from "../scripts/eval-proxy.mjs";
import {
    codexConfig,
    findOpenCodeCli,
    harnessAdapters,
    parseOpenCodeJsonl,
    resolveCodexModel,
    resolveOpenCodeModel,
} from "../scripts/eval-harnesses.mjs";

test("eval accounting reports mean and cost-per-success together", () => {
    const attempts = [
        { pass: true, cost: 1, costComplete: true },
        { pass: false, cost: 3, costComplete: true },
    ];
    const summary = summarizeAttempts(attempts);
    assert.equal(summary.attempts, 2);
    assert.equal(summary.solved, 1);
    assert.equal(summary.solveRate, 0.5);
    assert.equal(summary.meanCostPerAttempt, 2);
    assert.equal(summary.medianCostPerAttempt, 2);
    assert.equal(summary.costPerSuccess, 4);
    // Success-conditioned cost hides the failed attempt, so it is lower
    // and must never stand alone.
    assert.equal(summary.successConditionedCost, 1);
    assert.equal(summary.costComplete, true);
});

test("eval accounting marks unknown prices incomplete instead of zero", () => {
    const prices = loadPrices();
    const known = priceUsage(prices, "kimi-k3", { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0 });
    assert.equal(known.complete, true);
    assert.ok(known.cost > 0);
    const unknown = priceUsage(prices, "no-such-model", { inputTokens: 1_000_000, outputTokens: 0 });
    assert.equal(unknown.complete, false);
    assert.equal(unknown.cost, 0);
    assert.equal(formatCost(unknown.cost, unknown.complete), "≥ $0.00");
    assert.equal(formatCost(0.001726, true), "$0.0017");
    assert.equal(formatCost(0.0287, true), "$0.029");
    assert.equal(formatCost(1.46, true), "$1.46");
    // Cached tokens are priced once at the cache rate: callers pass
    // inputTokens net of the reread portion (see the priceUsage contract).
    const cached = priceUsage(prices, "deepseek-v4.1-flash", {
        inputTokens: 300,
        outputTokens: 100,
        cachedTokens: 700,
    });
    const expected = (300 * 0.15 + 100 * 0.6 + 700 * 0.003) / 1_000_000;
    assert.ok(Math.abs(cached.cost - expected) < 1e-12, `${cached.cost} vs ${expected}`);
    const { total, complete } = sumCosts([
        { cost: 1, costComplete: true },
        { cost: 0, costComplete: false },
    ]);
    assert.equal(total, 1);
    assert.equal(complete, false);
});

test("eval accounting bills reasoning tokens and flags unpriced cache writes", () => {
    const prices = loadPrices();
    // Harnesses that report reasoning apart exclude it from outputTokens,
    // so dropping it undercounts every thinking step. These figures are a
    // real OpenCode attempt from evals/runs/all-tier2-deepseek, whose own
    // cost self-report matches only when reasoning is billed as output.
    const attempt = { inputTokens: 10864, outputTokens: 204, reasoningTokens: 53, cachedTokens: 30336 };
    const priced = priceUsage(prices, "deepseek-v4.1-flash", attempt);
    assert.equal(priced.complete, true);
    assert.ok(Math.abs(priced.cost - 0.00187480800000000024) < 1e-12, String(priced.cost));
    const withoutReasoning = priceUsage(prices, "deepseek-v4.1-flash", { ...attempt, reasoningTokens: 0 });
    assert.ok(priced.cost > withoutReasoning.cost);

    // An unpriced cache write is a lower bound, not a silent zero.
    const unpricedWrite = priceUsage(prices, "deepseek-v4.1-flash", { inputTokens: 100, cacheWriteTokens: 500 });
    assert.equal(unpricedWrite.complete, false);
    assert.match(unpricedWrite.reason, /cache-write/u);
    assert.equal(formatCost(unpricedWrite.cost, unpricedWrite.complete).startsWith("≥"), true);
    const noWrite = priceUsage(prices, "deepseek-v4.1-flash", { inputTokens: 100, cacheWriteTokens: 0 });
    assert.equal(noWrite.complete, true);
});

test("eval reprices stored reports under the current rules", () => {
    // An archived report carries logged usage and the frozen list, so it
    // can be repriced instead of rewritten when the rules are corrected.
    const report = {
        model: "deepseek-v4.1-flash",
        results: [
            {
                attempts: [
                    {
                        // Proxy harness: prompt_tokens include the rereads.
                        tokens: { inputTokens: 1000, outputTokens: 100, cachedTokens: 800 },
                        native: null,
                        sessionMint: { inputTokens: 10000, outputTokens: 2, cachedTokens: 0 },
                        cost: 999,
                    },
                    {
                        // Native harness: no mint, reasoning billed as output.
                        tokens: {},
                        native: { inputTokens: 1000, outputTokens: 100, reasoningTokens: 50, cachedTokens: 800 },
                        sessionMint: null,
                        cost: 999,
                    },
                ],
            },
        ],
    };
    const [proxy, native] = repriceReport(report).results[0].attempts;
    const expectedProxy = (200 * 0.15 + 100 * 0.6 + 800 * 0.003) / 1_000_000;
    assert.ok(Math.abs(proxy.modelCost - expectedProxy) < 1e-12, String(proxy.modelCost));
    assert.ok(Math.abs(proxy.mintCost - (10000 * 0.15 + 2 * 0.6) / 1_000_000) < 1e-12);
    assert.ok(Math.abs(proxy.cost - (proxy.modelCost + proxy.mintCost)) < 1e-12);
    // The mint is the larger term here, which is exactly why it cannot sit
    // inside the harness figure.
    assert.ok(proxy.mintCost > proxy.modelCost);

    const expectedNative = (1000 * 0.15 + 150 * 0.6 + 800 * 0.003) / 1_000_000;
    assert.ok(Math.abs(native.modelCost - expectedNative) < 1e-12, String(native.modelCost));
    assert.equal(native.mintCost, 0);
});

test("eval stats handle empty inputs and pair outcomes", () => {
    assert.equal(mean([]), 0);
    assert.equal(median([]), 0);
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
    assert.deepEqual(wilsonInterval(0, 0), { low: 0, high: 1 });
    const interval = wilsonInterval(6, 10);
    assert.ok(interval.low < 0.6 && 0.6 < interval.high);
    const pairs = pairedContingency([{ pass: true }, { pass: false }], [{ pass: true }, { pass: true }]);
    assert.deepEqual(pairs, { both: 1, onlyFirst: 0, onlySecond: 1, neither: 0, pairs: 2 });
    assert.equal(breakEvenPerExtraSolve({ solved: 1, totalCost: 2 }, { solved: 2, totalCost: 5 }), 3);
    assert.equal(breakEvenPerExtraSolve({ solved: 2, totalCost: 2 }, { solved: 2, totalCost: 5 }), null);
});

test("eval proxy summarizes first-call context and normalizes tool names", () => {
    const summary = summarizeRequest({
        tools: [{ function: { name: "read" } }, { function: { name: "bash" } }],
        messages: [{ role: "system", content: "hello " }],
    });
    assert.equal(summary.toolCount, 2);
    assert.deepEqual(summary.toolNames, ["bash", "read"]);
    assert.equal(summary.toolSchemaChars > 0, true);
    assert.equal(summary.instructionChars, 6);
    assert.equal(normalizeToolName("pwsh"), "bash");
    assert.equal(normalizeToolName("Read"), "read");
    assert.equal(normalizeToolName("delegate"), "subagent");
    const totals = proxyTotals([
        {
            usage: { prompt_tokens: 10, completion_tokens: 4 },
            summary: { toolNames: ["read", "write"] },
            toolCalls: ["read"],
        },
        { usage: null, summary: { toolNames: ["read", "write"] }, toolCalls: ["pwsh"] },
    ]);
    assert.equal(totals.inputTokens, 10);
    assert.equal(totals.outputTokens, 4);
    // Calls come from what the model invoked; offers are the schema the
    // request carried, which is paid for every turn whether used or not.
    assert.deepEqual(totals.toolCalls, { read: 1, bash: 1 });
    assert.deepEqual(totals.toolsOffered, { read: 2, write: 2 });
});

test("eval proxy counts invoked tools, never offered ones", () => {
    // A tool list on the request is not evidence of a call: counting it as
    // one reports "create_goal 61" for a tool the model never reached for.
    const offeredOnly = proxyTotals([{ usage: null, summary: { toolNames: ["create_goal", "read"] }, toolCalls: [] }]);
    assert.deepEqual(offeredOnly.toolCalls, {});
    assert.deepEqual(offeredOnly.toolsOffered, { create_goal: 1, read: 1 });

    const completion = JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: { name: "read" } }, { function: { name: "pwsh" } }] } }],
    });
    assert.deepEqual(extractToolCalls(completion), ["read", "pwsh"]);

    // Streamed calls arrive in fragments: the first carries the name, the
    // rest only argument text for the same index.
    const stream = [
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"write","arguments":"{\\"p"}}]}}]}',
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ath\\":1}"}}]}}]}',
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"bash","arguments":"{}"}}]}}]}',
        'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":9}}',
        "data: [DONE]",
        "",
    ].join("\n");
    assert.deepEqual(extractToolCalls(stream), ["write", "bash"]);
    assert.deepEqual(extractToolCalls("not json at all"), []);
    assert.deepEqual(extractToolCalls(JSON.stringify({ choices: [{ message: { content: "hi" } }] })), []);
});

test("eval accounting keeps eval plumbing out of the harness figure", () => {
    // The session mint is real spend, but only proxy harnesses need one
    // and it carries OpenCode's own prompt, so it must not land on the
    // harness being measured.
    const proxyHarness = [
        { pass: true, modelCost: 1, mintCost: 4, cost: 5, costComplete: true },
        { pass: false, modelCost: 3, mintCost: 4, cost: 7, costComplete: true },
    ];
    const summary = summarizeAttempts(proxyHarness);
    assert.equal(summary.meanCostPerAttempt, 2);
    assert.equal(summary.meanMintCostPerAttempt, 4);
    assert.equal(summary.meanTotalCostPerAttempt, 6);
    assert.equal(summary.costPerSuccess, 4);
    assert.equal(attemptModelCost(proxyHarness[0]), 1);
    assert.equal(attemptMintCost(proxyHarness[0]), 4);

    // A native harness pays no mint, so its two figures agree.
    const nativeHarness = summarizeAttempts([{ pass: true, modelCost: 2, mintCost: 0, cost: 2, costComplete: true }]);
    assert.equal(nativeHarness.meanCostPerAttempt, 2);
    assert.equal(nativeHarness.meanMintCostPerAttempt, 0);

    // Reports written before the split carry the total alone and still render.
    assert.equal(attemptModelCost({ cost: 9 }), 9);
    assert.equal(attemptMintCost({ cost: 9 }), 0);
    assert.equal(summarizeAttempts([{ pass: true, cost: 9, costComplete: true }]).meanCostPerAttempt, 9);
});

test("eval suggested models are priced and mapped for OpenCode", () => {
    const prices = loadPrices();
    for (const model of ["deepseek-v4.1-flash", "muse-spark-1.3", "muse-spark-1.3-contributor"]) {
        const priced = priceUsage(prices, model, { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0 });
        assert.equal(priced.complete, true, model);
        assert.ok(priced.cost > 0, model);
    }

    assert.equal(resolveOpenCodeModel("deepseek-v4.1-flash"), "opencode-go/deepseek-v4.1-flash");
    assert.equal(resolveOpenCodeModel("muse-spark-1.3-contributor"), "opencode-go/muse-spark-1.3-contributor");
    assert.equal(resolveOpenCodeModel("example-provider/example-model"), "example-provider/example-model");
    assert.throws(() => resolveOpenCodeModel("no-such-model"), /Unknown eval model/u);
    assert.ok(typeof findOpenCodeCli() === "string" || findOpenCodeCli() === undefined);
});

test("eval parses OpenCode JSON event streams into usage", () => {
    const stream = [
        JSON.stringify({ type: "step_start", sessionID: "ses_probe" }),
        JSON.stringify({ type: "tool_use", part: { tool: "write" } }),
        JSON.stringify({
            type: "step_finish",
            part: { tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 20, write: 0 } }, cost: 0.001 },
        }),
        JSON.stringify({ type: "tool_use", part: { tool: "bash" } }),
        JSON.stringify({ type: "step_finish", part: { tokens: { input: 50, output: 5 }, cost: 0.0005 } }),
        "not json",
        "",
    ].join("\n");
    const parsed = parseOpenCodeJsonl(stream);
    assert.equal(parsed.steps, 2);
    assert.deepEqual(parsed.totals, { input: 150, output: 15, reasoning: 5, cacheRead: 20, cacheWrite: 0 });
    assert.equal(parsed.cost, 0.0015);
    assert.deepEqual(parsed.toolCalls, { write: 1, bash: 1 });
    assert.equal(parsed.sessionId, "ses_probe");
    assert.deepEqual(parseOpenCodeJsonl("").steps, 0);
});
test("eval proxy forwards with auth and model override without logging them", async () => {
    const seen = [];
    const upstream = await new Promise((resolve) => {
        const server = http.createServer(async (request, response) => {
            let raw = "";
            for await (const chunk of request) {
                raw += chunk;
            }

            seen.push({
                auth: request.headers.authorization ?? null,
                session: request.headers["x-opencode-session"] ?? null,
                body: JSON.parse(raw),
            });
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 5 } }));
        });
        server.listen(0, "127.0.0.1", () => resolve(server));
    });
    const address = upstream.address();
    const previousKey = process.env.EVAL_FORWARD_KEY;
    const previousModel = process.env.EVAL_FORWARD_MODEL;
    process.env.EVAL_FORWARD_KEY = "test-key-never-logged";
    process.env.EVAL_FORWARD_MODEL = "provider/real-model";
    const proxy = await startProxy({ forwardUrl: `http://127.0.0.1:${address.port}/v1`, sessionId: "test-session" });
    try {
        const response = await fetch(proxy.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "logical-model", messages: [] }),
        });
        assert.equal(response.status, 200);
        assert.equal(seen.length, 1);
        assert.equal(seen[0].auth, "Bearer test-key-never-logged");
        assert.equal(seen[0].session, "test-session");
        assert.equal(seen[0].body.model, "provider/real-model");
        assert.equal(proxy.requests.length, 1);
        assert.deepEqual(proxy.requests[0].usage, { prompt_tokens: 50, completion_tokens: 5 });
        assert.equal(JSON.stringify(proxy.requests).includes("test-key-never-logged"), false);
    } finally {
        await proxy.close();
        await new Promise((resolve) => upstream.close(resolve));
        if (previousKey === undefined) {
            delete process.env.EVAL_FORWARD_KEY;
        } else {
            process.env.EVAL_FORWARD_KEY = previousKey;
        }

        if (previousModel === undefined) {
            delete process.env.EVAL_FORWARD_MODEL;
        } else {
            process.env.EVAL_FORWARD_MODEL = previousModel;
        }
    }
});
test("eval proxy logs the tools a forwarded response actually invoked", async () => {
    const stream = [
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"read","arguments":"{}"}}]}}]}',
        'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":40,"completion_tokens":6}}',
        "data: [DONE]",
        "",
    ].join("\n");
    const upstream = await new Promise((resolve) => {
        const server = http.createServer(async (request, response) => {
            for await (const chunk of request) {
                void chunk;
            }

            response.writeHead(200, { "Content-Type": "text/event-stream" });
            response.end(stream);
        });
        server.listen(0, "127.0.0.1", () => resolve(server));
    });
    const proxy = await startProxy({ forwardUrl: `http://127.0.0.1:${upstream.address().port}/v1` });
    try {
        await fetch(proxy.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "deepseek-v4.1-flash",
                messages: [],
                tools: [{ function: { name: "read" } }, { function: { name: "create_goal" } }],
            }),
        });
        const totals = proxyTotals(proxy.requests);
        // One call was made; two tools were offered and paid for.
        assert.deepEqual(totals.toolCalls, { read: 1 });
        assert.deepEqual(totals.toolsOffered, { read: 1, create_goal: 1 });
        assert.equal(totals.inputTokens, 40);
    } finally {
        await proxy.close();
        await new Promise((resolve) => upstream.close(resolve));
    }
});

test("eval proxy selects the conversation request over auxiliary calls", () => {
    assert.equal(conversationSummary([]).toolCount, 0);
    const title = { summary: summarizeRequest({ tools: [], messages: [] }), usage: null };
    const conversation = {
        summary: summarizeRequest({ tools: [{ function: { name: "read" } }], messages: [] }),
        usage: null,
    };
    assert.equal(conversationSummary([title, conversation]).toolCount, 1);
    assert.equal(conversationSummary([conversation, title]).toolCount, 1);
    assert.equal(conversationSummary([title]).toolCount, 0);
});

test("eval deepseek harness stays unavailable without its binary", async () => {
    const previous = process.env.SPECPI_DSH_CLI;
    delete process.env.SPECPI_DSH_CLI;
    try {
        assert.equal(harnessAdapters.dsh.isAvailable().available, false);
        await assert.rejects(
            harnessAdapters.dsh.run({
                task: { id: "probe", prompt: "hi" },
                workspaceDir: os.tmpdir(),
                homeDir: os.tmpdir(),
                proxyUrl: "http://127.0.0.1:9/v1",
                model: "deepseek-v4.1-flash",
                timeoutMs: 1000,
            }),
            /SPECPI_DSH_CLI/u,
        );
    } finally {
        if (previous !== undefined) {
            process.env.SPECPI_DSH_CLI = previous;
        }
    }
});

test("eval proxy extracts usage from JSON and event streams", () => {
    assert.deepEqual(extractUsage(JSON.stringify({ usage: { prompt_tokens: 7 } })), { prompt_tokens: 7 });
    const stream = [
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":271,"completion_tokens":30}}',
        "data: [DONE]",
        "",
    ].join("\n");
    assert.deepEqual(extractUsage(stream), { prompt_tokens: 271, completion_tokens: 30 });
    assert.equal(extractUsage("not json at all"), null);
    const totals = proxyTotals([
        { usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 4 } }, summary: { toolNames: [] } },
    ]);
    assert.equal(totals.cachedTokens, 4);
});

test("eval proxy answers synthetically without forwarding", async () => {
    const proxy = await startProxy();
    try {
        const response = await fetch(proxy.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "hi" }], tools: [] }),
        });
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.match(text, /data: \[DONE\]/u);
        assert.equal(proxy.requests.length, 1);
        assert.equal(proxy.requests[0].model, "fake-model");
    } finally {
        await proxy.close();
    }
});

test("eval proxy counts tool results and flags error-shaped ones", () => {
    // Each request carries the whole conversation, so the request holding the
    // most tool results is scanned and the rest ignored: counting them all
    // would multiply every result by the number of turns that followed it.
    const early = { body: { messages: [{ role: "tool", content: "ok" }] } };
    const late = {
        body: {
            messages: [
                { role: "tool", content: "ok" },
                { role: "assistant", content: "Error: this is not a tool message" },
                { role: "tool", content: "ENOENT: no such file or directory, open 'nope.txt'" },
                { role: "tool", content: "bash: frobnicate: command not found" },
                { role: "tool", content: [{ text: "Traceback (most recent call last):" }] },
                { role: "tool", content: "process exited with code 2" },
                { role: "tool", content: "wrote 42 lines" },
            ],
        },
    };
    const outcome = summarizeToolResults([early, late]);
    assert.equal(outcome.results, 6, "six tool messages, the assistant message is not one");
    assert.equal(outcome.errors, 4);
    // Each result is attributed to one signature, the first that matches.
    assert.equal(
        Object.values(outcome.signatures).reduce((a, b) => a + b, 0),
        4,
    );
    assert.ok(outcome.signatures["no-such-file"] || outcome.signatures.enoent);

    // A clean run reports zero without pretending it measured nothing.
    const clean = summarizeToolResults([{ body: { messages: [{ role: "tool", content: "done" }] } }]);
    assert.equal(clean.results, 1);
    assert.equal(clean.errors, 0);
    assert.deepEqual(clean.signatures, {});
    const empty = summarizeToolResults([]);
    assert.equal(empty.results, 0);
    assert.equal(empty.errors, 0);
    assert.deepEqual(empty.signatures, {});
});

test("eval proxy attributes a failing tool result to the tool that produced it", () => {
    // "A tool failed" cannot separate a harness with a flaky shell from one
    // with a flaky editor, so the tool_call_id is joined back to its name.
    const outcome = summarizeToolResults([
        {
            body: {
                messages: [
                    {
                        role: "assistant",
                        tool_calls: [
                            { id: "c1", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
                            { id: "c2", function: { name: "edit", arguments: '{"path":"a"}' } },
                            { id: "c3", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
                        ],
                    },
                    { role: "tool", tool_call_id: "c1", content: "ENOENT: no such file or directory" },
                    { role: "tool", tool_call_id: "c2", content: "patched" },
                    { role: "tool", tool_call_id: "c3", content: "ENOENT: no such file or directory" },
                ],
            },
        },
    ]);
    assert.equal(outcome.results, 3);
    assert.equal(outcome.errors, 2);
    assert.deepEqual(outcome.byTool.bash, { results: 2, errors: 2 });
    assert.deepEqual(outcome.byTool.edit, { results: 1, errors: 0 });
    // The same bash call was sent twice with identical arguments.
    assert.equal(outcome.repeatedCalls, 1);
});

test("eval proxy reports context shape, so compaction is visible", () => {
    // Prompt tokens climb as the conversation grows; a fall means the harness
    // dropped history, which no total can show.
    const shape = contextShape([
        { promptTokens: 1000 },
        { promptTokens: 9000 },
        { promptTokens: 2000 },
        { promptTokens: 4000 },
    ]);
    assert.equal(shape.compactions, 1);
    assert.equal(shape.reclaimedTokens, 7000);
    assert.equal(shape.peakPromptTokens, 9000);

    // Ordinary churn is not a compaction.
    assert.equal(contextShape([{ promptTokens: 1000 }, { promptTokens: 950 }]).compactions, 0);
    assert.equal(contextShape([]).compactions, 0);
});
test("eval proxy reads the Responses API the way Codex sends it", () => {
    // Codex puts the system prompt in `instructions`, names tools at the top
    // level, keeps the conversation in `input`, and reports usage with
    // responses field names. All four are normalized into the same metrics
    // the chat-completions harnesses report.
    const request = summarizeRequest({
        instructions: "system text",
        input: [
            { type: "message", role: "developer", content: [{ type: "input_text", text: " plus skills" }] },
            { type: "message", role: "user", content: [{ type: "input_text", text: "ignored" }] },
        ],
        tools: [{ type: "function", name: "exec_command" }, { type: "web_search" }],
    });
    assert.equal(request.toolCount, 2);
    assert.deepEqual(request.toolNames, ["exec_command", "web_search"]);
    assert.equal(request.instructionChars, "system text plus skills".length);
    assert.equal(normalizeToolName("exec_command"), "bash");
    assert.equal(normalizeToolName("write_stdin"), "bash");
    assert.equal(normalizeToolName("view_image"), "read");
    assert.equal(normalizeToolName("multi_agent_v1"), "subagent");
    assert.equal(normalizeToolName("spawn_agent"), "subagent");

    // Responses usage: input_tokens include cache rereads, output_tokens
    // exclude reasoning. Both are folded into the chat-shaped counters so the
    // frozen price list bills them by the same rules.
    const completed = [
        "event: response.completed",
        `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 5 } } } })}`,
        "data: [DONE]",
        "",
    ].join("\n");
    assert.deepEqual(extractUsage(completed), {
        prompt_tokens: 100,
        completion_tokens: 15,
        prompt_tokens_details: { cached_tokens: 40 },
        reasoning_tokens: 5,
    });
    const totals = proxyTotals([{ usage: extractUsage(completed), summary: request, toolCalls: [] }]);
    assert.equal(totals.inputTokens, 100);
    assert.equal(totals.cachedTokens, 40);
    assert.equal(totals.outputTokens, 15);

    // Calls are deduplicated across the added/done pair that announces the
    // same call, so a streamed call is counted once.
    const callItem = {
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "ls" }),
    };
    const stream = [
        "event: response.output_item.added",
        `data: ${JSON.stringify({ type: "response.output_item.added", item: { ...callItem, arguments: "" } })}`,
        "event: response.output_item.done",
        `data: ${JSON.stringify({ type: "response.output_item.done", item: callItem })}`,
        "data: [DONE]",
        "",
    ].join("\n");
    assert.deepEqual(extractToolCalls(stream), ["exec_command"]);
    assert.deepEqual(
        extractToolCalls(JSON.stringify({ output: [{ type: "function_call", name: "exec_command", call_id: "a" }] })),
        ["exec_command"],
    );

    // Tool outcomes come from function_call_output items, not role:tool
    // messages, and the fullest request still wins.
    const outcome = summarizeToolResults([
        {
            body: {
                input: [
                    { type: "function_call_output", call_id: "a", output: "wrote 42 lines" },
                    { type: "function_call_output", call_id: "b", output: "ENOENT: no such file or directory" },
                    { type: "message", role: "developer", content: "Error: not a tool result" },
                ],
            },
        },
    ]);
    assert.equal(outcome.results, 2);
    assert.equal(outcome.errors, 1);
    assert.ok(outcome.signatures.enoent || outcome.signatures["no-such-file"]);
});

test("eval proxy routes Responses requests to the responses endpoint", async () => {
    // A Responses body without a forward URL is answered synthetically in the
    // responses shape, which is what lets --harness=codex self-check offline.
    const offline = await startProxy();
    try {
        const response = await fetch(`${offline.url}/responses`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "fake-model", instructions: "probe", input: [] }),
        });
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.match(text, /response\.completed/u);
        assert.match(text, /data: \[DONE\]/u);
        assert.equal(offline.requests.length, 1);
    } finally {
        await offline.close();
    }

    // Forwarding picks the responses endpoint for /responses and leaves the
    // configured chat URL in charge of chat traffic.
    assert.equal(
        deriveResponsesUrl("https://opencode.ai/zen/go/v1/chat/completions"),
        "https://opencode.ai/zen/go/v1/responses",
    );
    assert.equal(deriveResponsesUrl("http://127.0.0.1:9/v1"), "http://127.0.0.1:9/v1");
    const seen = [];
    const upstream = await new Promise((resolve) => {
        const server = http.createServer(async (request, response) => {
            let raw = "";
            for await (const chunk of request) {
                raw += chunk;
            }

            seen.push({ url: request.url, body: JSON.parse(raw) });
            response.writeHead(200, { "Content-Type": "text/event-stream" });
            response.end(
                [
                    `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })}`,
                    "data: [DONE]",
                    "",
                ].join("\n"),
            );
        });
        server.listen(0, "127.0.0.1", () => resolve(server));
    });
    const proxy = await startProxy({
        forwardUrl: "http://127.0.0.1:9/chat/completions",
        responsesForwardUrl: `http://127.0.0.1:${upstream.address().port}/v1/responses`,
    });
    try {
        const response = await fetch(`${proxy.url}/responses`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "deepseek-v4.1-flash", instructions: "probe", input: [] }),
        });
        assert.equal(response.status, 200);
        assert.equal(seen.length, 1);
        assert.equal(seen[0].url, "/v1/responses");
        assert.equal(proxy.requests[0].usage.prompt_tokens, 12);
    } finally {
        await proxy.close();
        await new Promise((resolve) => upstream.close(resolve));
    }
});

test("eval codex harness configures the proxy provider and resolves models", async () => {
    // The codex adapter joins the proxy family: isolating its home is what
    // keeps the machine's own Codex state and credentials out of the run.
    const adapter = harnessAdapters.codex;
    assert.equal(adapter.id, "codex");
    assert.equal(adapter.label, "Codex CLI");
    assert.equal(adapter.needsProxySession, true);
    assert.equal(typeof adapter.isAvailable().available, "boolean");
    const config = codexConfig({ baseUrl: "http://127.0.0.1:1234/v1", model: "deepseek-v4.1-flash" });
    assert.match(config, /^model = "deepseek-v4\.1-flash"$/mu);
    assert.match(config, /^\[model_providers\.eval\]$/mu);
    assert.match(config, /^base_url = "http:\/\/127\.0\.0\.1:1234\/v1"$/mu);
    assert.match(config, /^env_key = "CODEX_EVAL_API_KEY"$/mu);
    // Codex 0.153 dropped chat completions, so the provider must speak the
    // Responses API or the harness cannot route at all.
    assert.match(config, /^wire_api = "responses"$/mu);
    // The placeholder is what the proxy swaps for the real credential.
    assert.equal(config.includes(process.env.EVAL_FORWARD_KEY ?? "__unset__"), false);
    assert.equal(resolveCodexModel("deepseek-v4.1-flash"), "deepseek-v4.1-flash");
    assert.equal(resolveCodexModel("opencode-go/deepseek-v4.1-flash"), "deepseek-v4.1-flash");
    assert.equal(resolveCodexModel("opencode-go/muse-spark-1.3"), "muse-spark-1.3");
});
