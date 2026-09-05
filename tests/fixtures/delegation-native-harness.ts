import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import registerCommandGuard from "../../extensions/command-guard/index.ts";
import registerDelegation from "../../extensions/delegation/index.ts";

const PROVIDER = "specpi-native-entry-fixture";
const MODEL = "native-parent";

function captureApi(pi: any, forward = true) {
    const hooks = new Map<string, any[]>();
    const commands = new Map<string, any>();
    const tools = new Map<string, any>();
    const api = {
        ...pi,
        events: pi.events,
        on(name: string, handler: any) {
            hooks.set(name, [...(hooks.get(name) ?? []), handler]);
            if (forward) {
                pi.on(name, handler);
            }
        },
        registerCommand(name: string, command: any) {
            commands.set(name, command);
            if (forward) {
                pi.registerCommand(name, command);
            }
        },
        registerTool(tool: any) {
            tools.set(tool.name, tool);
            if (forward) {
                pi.registerTool(tool);
            }
        },
    };

    return {
        api,
        commands,
        tools,
        async emit(name: string, event: any, ctx: any) {
            const results = [];
            for (const handler of hooks.get(name) ?? []) {
                results.push(await handler(event, ctx));
            }

            return results;
        },
    };
}

function job(id = "j1", question = "Assess the public fixture", mode = "review", sources: string[] = []) {
    return { id, mode, question, context: "Public fixture", sources, requirements: ["r1"] };
}

function packet(jobs = [job()]) {
    return {
        objective: "Assess the native child-session fixture",
        requirements: [{ id: "r1", text: "Check fixture evidence" }],
        decisions: ["Use selected public sources"],
        nonGoals: ["No writes or external network"],
        reason: {
            benefit: jobs.every((entry) => entry.mode === "review") ? "independent_review" : "context_isolation",
            why: "A separate bounded evidence assessment informs parent review",
            parentWork: "Inspect integration boundaries",
        },
        jobs,
    };
}

function binding(receipt: any) {
    return Object.fromEntries(
        ["batchId", "jobId", "attemptId", "packetDigest", "generation", "resultRevision"].map((key) => [
            key,
            receipt[key],
        ]),
    );
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string) {
    const deadline = Date.now() + 10000;
    while (!(await predicate())) {
        assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function text(content: any) {
    return typeof content === "string"
        ? content
        : (content ?? [])
              .filter((item: any) => item.type === "text")
              .map((item: any) => item.text)
              .join("");
}

function handoff(messages: any[]) {
    for (const message of messages) {
        if (message.role !== "user") {
            continue;
        }

        try {
            const parsed = JSON.parse(text(message.content));
            if (Array.isArray(parsed.requirements) && Array.isArray(parsed.sources)) {
                return parsed;
            }
        } catch {
            // Other parent-selected prose is not the structured worker handoff.
        }
    }

    throw new Error("Child request is missing its structured handoff");
}

async function configuredServer() {
    const key = Symbol.for("specpi.fixture.native-http.v1");
    if ((globalThis as any)[key]) {
        return (globalThis as any)[key];
    }

    const state: any = { requests: [], held: [], hold: false, errors: [], closed: false };
    const server = http.createServer(async (request, response) => {
        try {
            assert.equal(request.method, "POST");
            assert.equal(request.url, "/v1/chat/completions");
            const chunks = [];
            let size = 0;
            for await (const chunk of request) {
                size += chunk.length;
                assert.ok(size <= 1024 * 1024, "Synthetic request exceeds fixture bounds");
                chunks.push(chunk);
            }

            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const entry = {
                body,
                authenticated: request.headers.authorization === "Bearer synthetic-models-only",
                parentHeader: request.headers["x-parent-hook-fixture"],
                closed: false,
            };
            state.requests.push(entry);
            response.on("close", () => {
                entry.closed = true;
            });
            if (state.hold) {
                await new Promise<void>((resolve) => state.held.push({ resolve, entry }));
            }

            if (response.destroyed) {
                return;
            }

            const supplied = handoff(body.messages);
            const source = supplied.sources[0];
            const needsRead = Boolean(source && !body.messages.some((message: any) => message.role === "tool"));
            const report = {
                status: "complete",
                answer: "Native SDK child-session assessment complete",
                requirements: supplied.requirements.map((item: any) => ({
                    id: item.id,
                    status: "addressed",
                    evidence: [{ sourceId: source?.id ?? "p1", lineStart: 1, lineEnd: 1 }],
                })),
                findings: [],
                missing: [],
                nextStep: "Parent checks the cited evidence",
            };
            const delta = needsRead
                ? {
                      role: "assistant",
                      tool_calls: [
                          {
                              index: 0,
                              id: `read-${state.requests.length}`,
                              type: "function",
                              function: {
                                  name: "read_source",
                                  arguments: JSON.stringify({ sourceId: source.id, startLine: 1, maxLines: 1 }),
                              },
                          },
                      ],
                  }
                : { role: "assistant", content: JSON.stringify(report) };
            response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
            const event = (choices: any[], usage?: any) => ({
                id: `chatcmpl-fixture-${state.requests.length}`,
                object: "chat.completion.chunk",
                created: 1,
                model: body.model,
                choices,
                ...(usage ? { usage } : {}),
            });
            if (process.env.SPECPI_NATIVE_FIXTURE_MODE === "stream-performance" && !needsRead) {
                for (const character of delta.content) {
                    response.write(
                        `data: ${JSON.stringify(event([{ index: 0, delta: { content: character }, finish_reason: null }]))}\n\n`,
                    );
                }
            } else {
                response.write(`data: ${JSON.stringify(event([{ index: 0, delta, finish_reason: null }]))}\n\n`);
            }

            response.write(
                `data: ${JSON.stringify(event([{ index: 0, delta: {}, finish_reason: needsRead ? "tool_calls" : "stop" }]))}\n\n`,
            );
            response.write(
                `data: ${JSON.stringify(event([], { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }))}\n\n`,
            );
            response.end("data: [DONE]\n\n");
        } catch (error) {
            state.errors.push(String(error));
            response.writeHead(500, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ error: { message: "Synthetic fixture request failed" } }));
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    state.url = `http://127.0.0.1:${address.port}/v1`;
    const modelsPath = path.join(process.env.PI_CODING_AGENT_DIR!, "models.json");
    const models = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
    for (const provider of Object.values(models.providers) as any[]) {
        provider.baseUrl = state.url;
    }

    fs.writeFileSync(modelsPath, JSON.stringify(models));
    state.release = () => {
        for (const item of state.held) {
            item.resolve();
        }
    };

    state.close = () => {
        if (!state.closed) {
            state.closed = true;
            state.release();
            state.closing = new Promise<void>((resolve) => server.close(() => resolve()));
            server.closeAllConnections();
        }

        return state.closing;
    };

    (globalThis as any)[key] = state;

    return state;
}

function fixtureContext(actual: any, notices: any[] = [], approvals: string[] = [], answer = () => "Allow once") {
    const ui = {
        ...actual.ui,
        notify(message: string, kind: string) {
            notices.push({ message, kind });
        },
        setStatus() {},
        async select(title: string) {
            approvals.push(title);

            return answer();
        },
        async confirm() {
            return true;
        },
    };

    return new Proxy(actual, {
        get(target, key) {
            if (["sessionManager", "agent", "session", "authStorage"].includes(String(key))) {
                throw new Error("Native fixture forbids private/session access");
            }

            return key === "ui" ? ui : key === "hasUI" ? true : Reflect.get(target, key);
        },
    });
}

function toolsFor(native: any, ctx: any) {
    let sequence = 0;
    const raw = async (input: any) =>
        native.tools
            .get("delegate")
            .execute(`native-${++sequence}`, input, new AbortController().signal, undefined, ctx);
    const execute = async (input: any) => {
        const output = await raw(input);
        assert.notEqual(output.isError, true, JSON.stringify(output));

        return output.details;
    };

    return {
        raw,
        execute,
        status: () => execute({ operation: "status" }),
        command: (value: string, context = ctx) => native.commands.get("delegate").handler(value, context),
    };
}

async function selectModel(pi: any, ctx: any) {
    await ctx.modelRegistry.refresh();
    const model = ctx.modelRegistry.find(PROVIDER, MODEL);
    assert.ok(model);
    assert.equal(await pi.setModel(model), true);
    pi.setThinkingLevel("high");
}

async function finishBatch(tools: any, batch: any) {
    await waitFor(async () => (await tools.status()).active === 0, "child session completion");
    const collected = await tools.execute({ operation: "collect", batchId: batch.batchId });
    assert.ok(
        collected.results.every((item: any) => item.receipt.state === "complete"),
        JSON.stringify(collected),
    );

    return collected;
}

async function resolveBatch(tools: any, collected: any, prefix: string) {
    for (const item of collected.results) {
        await tools.execute({
            operation: "resolve",
            requestId: `${prefix}-${item.receipt.jobId}`,
            ...binding(item.receipt),
            decision: "accept",
            findings: [],
        });
    }
}

function registerReloadProof(pi: any, native: any, server: any) {
    const key = Symbol.for("specpi.fixture.native-reload.v2");
    const trace = ((globalThis as any)[key] ??= { registrations: 0, lifecycle: [] });
    trace.registrations += 1;
    trace.currentNative = native;
    trace.currentPi = pi;
    pi.on("session_shutdown", (event: any) => {
        if (event.reason === "reload") {
            trace.lifecycle.push("shutdown:reload");
        }
    });
    pi.on("session_start", async (event: any, actual: any) => {
        if (event.reason === "new") {
            trace.newStartReason = event.reason;

            return;
        }

        if (event.reason !== "reload") {
            return;
        }

        trace.lifecycle.push("start:reload");
        const tools = toolsFor(native, fixtureContext(actual));
        const state = await tools.status();
        assert.equal(trace.registrations, 2);
        assert.equal(state.enabled, false);
        assert.equal(state.sessionCalls, 1);
        assert.equal(state.sessionBatches, 1);
        assert.ok(state.generation > trace.before.generation);
        assert.equal(pi.getActiveTools().includes("delegate"), false);
        assert.ok(pi.getAllTools().some((tool: any) => tool.name === "delegate"));
        await trace.oldNative.emit("session_shutdown", { reason: "late old callback" }, actual);
        assert.equal((await tools.status()).generation, state.generation);
        console.log(
            `NATIVE_RELOAD_FIXTURE=${JSON.stringify({ publicCommandReload: true, registrations: 2, reloadReason: "reload", enabled: false, activeTool: false, calls: 1, batches: 1, generationAdvanced: true, oldCallbackInert: true, lifecycle: trace.lifecycle })}`,
        );
    });
    pi.registerCommand("native-fixture-reload", {
        description: "Exercise actual public reload",
        handler: async (_args: string, actual: any) => {
            assert.equal(trace.registrations, 1);
            trace.lifecycle.push("command");
            const ctx = fixtureContext(actual);
            await selectModel(pi, ctx);
            const tools = toolsFor(native, ctx);
            await tools.command("on");
            const batch = await tools.execute({ operation: "run", requestId: "before-reload", packet: packet() });
            await finishBatch(tools, batch);
            trace.before = await tools.status();
            trace.oldNative = native;
            assert.equal(server.requests.length, 1);
            await actual.reload();

            return;
        },
    });
    pi.registerCommand("native-fixture-replace", {
        description: "Exercise actual public replacement",
        handler: async (_args: string, old: any) => {
            assert.equal(trace.registrations, 2);
            const oldNative = native;
            await old.newSession({
                withSession: async (replacement: any) => {
                    assert.notEqual(old, replacement);
                    assert.equal(trace.registrations, 3);
                    assert.equal(trace.newStartReason, "new");
                    const freshPi = trace.currentPi;
                    const freshNative = trace.currentNative;
                    const ctx = fixtureContext(replacement);
                    const tools = toolsFor(freshNative, ctx);
                    const before = await tools.status();
                    assert.equal(before.enabled, false);
                    assert.equal(before.sessionCalls, 1);
                    assert.equal(before.sessionBatches, 1);
                    assert.equal(freshPi.getActiveTools().includes("delegate"), false);
                    await selectModel(freshPi, ctx);
                    await tools.command("on");
                    const enabled = await tools.status();
                    assert.equal(enabled.enabled, true);
                    await oldNative.emit("session_shutdown", { reason: "late old callback" }, ctx);
                    assert.equal((await tools.status()).generation, enabled.generation);
                    const batch = await tools.execute({ operation: "run", requestId: "after-new", packet: packet() });
                    await finishBatch(tools, batch);
                    await tools.command("off");
                    const after = await tools.status();
                    assert.equal(after.enabled, false);
                    assert.equal(after.sessionCalls, 2);
                    assert.equal(after.sessionBatches, 2);
                    assert.equal(server.requests.length, 2);
                    console.log(
                        `NATIVE_REPLACEMENT_FIXTURE=${JSON.stringify({ publicNewSession: true, registrations: 3, startReason: "new", freshContext: true, initiallyOff: true, callsBefore: 1, batchesBefore: 1, callsAfter: 2, batchesAfter: 2, newWorkerCompleted: true, oldCallbackInert: true, finallyOff: true })}`,
                    );
                },
            });

            return;
        },
    });
}

export default async function nativeEntryFixture(pi: any) {
    const server = await configuredServer();
    let parentHooks = 0;
    pi.on("before_provider_headers", (event: any) => {
        parentHooks += 1;
        event.headers["x-parent-hook-fixture"] = "not-child";
    });
    pi.on("before_provider_request", () => {
        parentHooks += 1;
    });
    const guard = captureApi(pi);
    if (process.env.SPECPI_NATIVE_FIXTURE_MODE !== "guard-absent") {
        registerCommandGuard(guard.api, { approvalTimeoutMs: 1000, startupTimeoutMs: 1000 });
    }

    const first = captureApi(pi);
    await registerDelegation(first.api);
    pi.on("session_shutdown", async (event: any) => {
        if (!["reload", "new"].includes(event.reason)) {
            await server.close();
        }
    });
    if (process.env.SPECPI_NATIVE_FIXTURE_MODE === "reload") {
        registerReloadProof(pi, first, server);

        return;
    }

    let started = false;
    const executeFixture = async (_event: any, actual: any) => {
        if (started) {
            return;
        }

        started = true;
        const notices: any[] = [];
        const approvals: string[] = [];
        let answer = "Allow once";
        const ctx = fixtureContext(actual, notices, approvals, () => answer);
        await selectModel(pi, ctx);
        let active = first;
        let tools = toolsFor(active, ctx);
        const ordinaryTools = pi.getActiveTools();
        assert.equal(ordinaryTools.includes("delegate"), false);
        assert.equal((await tools.status()).enabled, false);
        if (process.env.SPECPI_NATIVE_FIXTURE_MODE === "runtime-auth") {
            await tools.command("on");
            assert.equal((await tools.status()).enabled, false, JSON.stringify(notices));
            assert.equal(server.requests.length, 0);
            console.log(
                `NATIVE_RUNTIME_AUTH_FIXTURE=${JSON.stringify({ runtimeAuthRejected: true, enabled: false, requests: 0 })}`,
            );

            return;
        }

        if (process.env.SPECPI_NATIVE_FIXTURE_MODE === "stream-performance") {
            const originalRealpath = fs.realpathSync.native;
            let failed = false;
            fs.realpathSync.native = ((filename: any, ...args: any[]) => {
                if (!failed && filename === ctx.cwd) {
                    failed = true;
                    throw new Error("Synthetic transient root lookup failure");
                }

                return originalRealpath(filename, ...args);
            }) as any;
            try {
                await tools.command("on");
                assert.equal(failed, true);
                assert.match(notices.at(-1).message, /working directory differs/);
            } finally {
                fs.realpathSync.native = originalRealpath;
            }

            await tools.command("on");
            assert.equal((await tools.status()).enabled, true, JSON.stringify(notices));
            let rootChecks = 0;
            fs.realpathSync.native = ((filename: any, ...args: any[]) => {
                if (filename === ctx.cwd) {
                    rootChecks += 1;
                }

                return originalRealpath(filename, ...args);
            }) as any;
            try {
                const collected = await finishBatch(
                    tools,
                    await tools.execute({ operation: "run", requestId: "stream-performance", packet: packet() }),
                );
                assert.equal(collected.results[0].receipt.calls, 1);
                assert.ok(rootChecks < 160, `${rootChecks} root checks for one streamed result`);
                assert.equal(server.requests.length, 1);
                assert.deepEqual(server.errors, []);
                console.log(
                    `NATIVE_STREAM_FIXTURE=${JSON.stringify({ transientRootRecovered: true, completed: true, calls: 1, rootChecks })}`,
                );
            } finally {
                fs.realpathSync.native = originalRealpath;
                await active.emit("session_shutdown", { reason: "fixture cleanup" }, ctx);
            }

            return;
        }

        if (process.env.SPECPI_NATIVE_FIXTURE_MODE === "model-selection") {
            try {
                await guard.commands.get("guard").handler("strict", ctx);
                await tools.command("on");
                assert.equal((await tools.status()).enabled, true, JSON.stringify(notices));
                const first = await tools.execute({
                    operation: "run",
                    requestId: "original",
                    packet: packet([job("j1", "Read the source", "scout", ["fixture.md"])]),
                });
                await finishBatch(tools, first);
                assert.equal(server.requests.length, 2);
                const next = ctx.modelRegistry.find("specpi-native-next-fixture", "native-next");
                assert.ok(next);
                const switching = fixtureContext(actual, notices, approvals, async () => {
                    assert.equal(await pi.setModel(next), true);

                    return "Allow once";
                });
                const denied = await guard.emit(
                    "tool_call",
                    {
                        toolName: "delegate",
                        toolCallId: "old-model-approval",
                        input: { operation: "run", requestId: "old-approval", packet: packet() },
                    },
                    switching,
                );
                assert.ok(
                    denied.some((entry: any) => entry?.block),
                    JSON.stringify(denied),
                );
                assert.equal(server.requests.length, 2);
                const selected = await tools.status();
                assert.equal(selected.enabled, true, JSON.stringify(notices));
                assert.equal(selected.requested, true);
                assert.equal(selected.model.provider, next.provider);
                assert.equal(selected.model.id, next.id);
                assert.equal(pi.getActiveTools().includes("delegate"), true);
                assert.equal((await tools.raw({ operation: "collect", batchId: first.batchId })).isError, true);
                const second = await tools.execute({ operation: "run", requestId: "new-provider", packet: packet() });
                await finishBatch(tools, second);
                assert.equal(server.requests[2].body.model, next.id);
                assert.equal(server.requests[2].authenticated, true);
                pi.setThinkingLevel("low");
                await waitFor(async () => {
                    const state = await tools.status();

                    return state.enabled && state.model?.thinkingLevel === "low";
                }, "thinking selection refresh");
                const third = await tools.execute({ operation: "run", requestId: "new-thinking", packet: packet() });
                await finishBatch(tools, third);
                assert.equal(server.requests[3].body.model, next.id);
                assert.equal(server.requests[3].body.reasoning_effort, "low");
                const final = await tools.status();
                assert.equal(final.sessionCalls, 4);
                assert.equal(final.sessionBatches, 3);
                await tools.command("off");
                assert.equal(await pi.setModel(ctx.modelRegistry.find(PROVIDER, MODEL)), true);
                assert.equal((await tools.status()).enabled, false);
                assert.equal((await tools.status()).requested, false);
                assert.equal(pi.getActiveTools().includes("delegate"), false);
                assert.deepEqual(server.errors, []);
                console.log(
                    `NATIVE_MODEL_SELECTION_FIXTURE=${JSON.stringify({ providerModelFollowed: true, thinkingFollowed: true, staleApprovalRejected: true, offPreserved: true, calls: final.sessionCalls, batches: final.sessionBatches })}`,
                );
            } finally {
                await active.emit("session_shutdown", { reason: "fixture cleanup" }, ctx);
            }

            return;
        }

        if (["guard-absent", "guard-off"].includes(process.env.SPECPI_NATIVE_FIXTURE_MODE ?? "")) {
            const mode = process.env.SPECPI_NATIVE_FIXTURE_MODE === "guard-off" ? "off" : "absent";
            try {
                if (mode === "off") {
                    await guard.commands.get("guard").handler("off", ctx);
                }

                await tools.command("on");
                assert.equal((await tools.status()).enabled, true, JSON.stringify(notices));
                assert.equal((await tools.status()).guard, mode);
                const batch = await tools.execute({
                    operation: "run",
                    requestId: "optional-guard",
                    packet: packet([job("j1", "Assess the source", "scout", ["fixture.md"])]),
                });
                const collected = await finishBatch(tools, batch);
                assert.equal(collected.results[0].receipt.calls, 2);
                assert.equal(server.requests.length, 2);
                for (const request of server.requests) {
                    assert.deepEqual(request.body.tools.map((tool: any) => tool.function.name).sort(), [
                        "list_sources",
                        "read_source",
                        "search_sources",
                    ]);
                    assert.equal(request.body.max_tokens ?? request.body.max_completion_tokens, 8192);
                    assert.equal(JSON.stringify(request.body).includes("NATIVE_AMBIENT"), false);
                }

                await tools.command("off");
                await tools.command("on");
                assert.equal((await tools.status()).sessionCalls, 2);
                assert.equal((await tools.status()).sessionBatches, 1);
                assert.equal(approvals.length, 0);
                assert.deepEqual(server.errors, []);
                console.log(
                    `NATIVE_OPTIONAL_GUARD_FIXTURE=${JSON.stringify({ mode, completed: true, calls: 2, snapshotToolsOnly: true, countersPreserved: true })}`,
                );
            } finally {
                await active.emit("session_shutdown", { reason: "fixture cleanup" }, ctx);
            }

            return;
        }

        const checked = async (input: any) => {
            const outcomes = await guard.emit(
                "tool_call",
                { toolName: "delegate", toolCallId: `guard-${input.operation}`, input },
                ctx,
            );
            assert.ok(
                outcomes.every((outcome: any) => outcome?.block !== true),
                JSON.stringify(outcomes),
            );

            return tools.execute(input);
        };

        try {
            assert.ok(pi.getAllTools().some((tool: any) => tool.name === "delegate"));
            assert.deepEqual([...first.commands.keys()], ["delegate"]);
            const headless = new Proxy(ctx, {
                get(target, key) {
                    return key === "hasUI" ? false : Reflect.get(target, key);
                },
            });
            await tools.command("on", headless);
            assert.equal((await tools.status()).enabled, false);
            assert.match(notices.at(-1).message, /human interactive command/);
            for (const [key, value, error] of [
                ["model", undefined, /Select a Pi model/],
                ["cwd", path.dirname(ctx.cwd), /working directory differs/],
            ] as const) {
                const unavailable = new Proxy(ctx, {
                    get(target, property) {
                        return property === key ? value : Reflect.get(target, property);
                    },
                });
                await tools.command("on", unavailable);
                assert.equal((await tools.status()).enabled, false);
                assert.match(notices.at(-1).message, error);
                assert.equal(server.requests.length, 0);
            }

            await guard.commands.get("guard").handler("strict", ctx);
            await tools.command("on");
            assert.equal((await tools.status()).enabled, true, JSON.stringify(notices));
            assert.equal(pi.getActiveTools().includes("delegate"), true);
            assert.deepEqual(
                pi.getActiveTools().filter((name: string) => name !== "delegate"),
                ordinaryTools,
            );
            const input = {
                operation: "run",
                requestId: "first",
                packet: packet([job("j1", "Inspect the public source", "scout", ["fixture.md"])]),
            };
            answer = "Deny (Recommended)";
            const denied = await guard.emit("tool_call", { toolName: "delegate", toolCallId: "denied", input }, ctx);
            assert.ok(denied.some((entry: any) => entry?.block));
            assert.equal(server.requests.length, 0);
            answer = "Allow once";
            const firstResult = await finishBatch(tools, await checked(input));
            assert.equal(firstResult.results[0].receipt.calls, 2);
            assert.equal(firstResult.results[0].receipt.usageComplete, true);
            assert.equal(server.requests.length, 2);
            const read = server.requests[1].body.messages.find((message: any) => message.role === "tool");
            assert.equal(JSON.parse(text(read.content)).text, "Public native fixture evidence.");
            for (const request of server.requests) {
                assert.equal(request.body.model, MODEL);
                assert.equal(request.body.reasoning_effort, "high");
                assert.equal(request.body.max_tokens ?? request.body.max_completion_tokens, 8192);
                assert.equal(request.authenticated, true);
                assert.equal(request.parentHeader, undefined);
                assert.deepEqual(request.body.tools.map((tool: any) => tool.function.name).sort(), [
                    "list_sources",
                    "read_source",
                    "search_sources",
                ]);
                assert.equal(JSON.stringify(request.body).includes("NATIVE_AMBIENT"), false);
            }

            assert.equal(parentHooks, 0);
            await resolveBatch(tools, firstResult, "first-resolve");
            server.hold = true;
            const pending = await checked({
                operation: "run",
                requestId: "pending",
                packet: packet([job("j1", "Assess fixture clarity"), job("j2", "Assess fixture limitations")]),
            });
            await waitFor(() => server.held.length === 2, "two admitted child calls");
            assert.equal((await tools.status()).active, 2);
            await checked({ operation: "cancel", requestId: "cancel-pending", batchId: pending.batchId });
            const cancelled = await checked({ operation: "collect", batchId: pending.batchId });
            assert.ok(
                cancelled.results.every((item: any) => item.receipt.state === "cancelled" && item.result === null),
            );
            await waitFor(async () => (await tools.status()).active === 0, "SDK cancellation settlement");
            server.hold = false;
            server.release();
            const reloadUrl = new URL("../../extensions/delegation/native.mjs", import.meta.url);
            reloadUrl.searchParams.set("fixture-reload", "child-session");
            const reloaded = await import(reloadUrl.href);
            const second = captureApi(pi, false);
            await reloaded.registerNativeDelegation(second.api);
            active = second;
            await active.emit("session_start", { reason: "reload" }, ctx);
            tools = toolsFor(active, ctx);
            assert.equal((await tools.status()).enabled, false);
            assert.equal((await tools.status()).sessionCalls, 4);
            assert.equal((await tools.status()).sessionBatches, 2);
            await tools.command("on");
            const beforeOld = await tools.status();
            await first.emit("session_shutdown", { reason: "old callback" }, ctx);
            assert.equal((await tools.status()).generation, beforeOld.generation);
            assert.equal((await tools.status()).enabled, true);
            const third = await finishBatch(
                tools,
                await checked({
                    operation: "run",
                    requestId: "after-rebind",
                    packet: packet([job("j1", "Explain fixture meaning"), job("j2", "Identify fixture assumptions")]),
                }),
            );
            await resolveBatch(tools, third, "third-resolve");
            const fourth = await checked({
                operation: "run",
                requestId: "freshness",
                packet: packet([job("j1", "Verify source freshness", "scout", ["fixture.md"])]),
            });
            await waitFor(async () => (await tools.status()).active === 0, "final source assessment");
            fs.writeFileSync(path.join(ctx.cwd, "fixture.md"), "Changed public fixture.\n");
            assert.equal((await tools.raw({ operation: "collect", batchId: fourth.batchId })).isError, true);
            await tools.command("off");
            assert.deepEqual(pi.getActiveTools(), ordinaryTools);
            await tools.command("on");
            assert.equal((await tools.raw({ operation: "run", requestId: "fifth", packet: packet() })).isError, true);
            const final = await tools.status();
            assert.equal(final.sessionCalls, 8);
            assert.equal(final.sessionBatches, 4);
            assert.equal(server.requests.length, 8);
            assert.deepEqual(server.errors, []);
            await tools.command("off");
            pi.registerProvider(PROVIDER, {
                baseUrl: server.url,
                api: "openai-completions",
                apiKey: "synthetic-extension-override",
                models: [
                    {
                        id: MODEL,
                        name: "Unsupported selected override",
                        reasoning: true,
                        input: ["text"],
                        contextWindow: 32768,
                        maxTokens: 16384,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    },
                ],
            });
            await tools.command("on");
            assert.equal((await tools.status()).enabled, false, JSON.stringify(notices));
            assert.equal(server.requests.length, 8);
            console.log(
                `NATIVE_ENTRY_FIXTURE=${JSON.stringify({ ordinaryEntryRegistered: true, defaultOff: true, headlessActivationDenied: true, sameModelThinking: true, snapshotRead: true, strictGuardIntercepted: true, noAmbientResources: true, parentHooksNotInherited: true, actualSdkToolLoop: true, cancelledResultSuppressed: true, rebindCountersPreserved: true, oldCallbacksInert: true, sourceFreshness: true, batchQuotaPreserved: true, registeredOverrideRejected: true, activeToolGated: true, calls: final.sessionCalls, batches: final.sessionBatches, ceilings: { concurrency: final.limits.concurrency, sessionCalls: final.limits.sessionCalls, sessionBatches: final.limits.sessionBatches, batchJobs: final.limits.batchJobs, outputTokens: final.limits.outputTokens } })}`,
            );
        } finally {
            server.release();
            await active.emit("session_shutdown", { reason: "fixture cleanup" }, ctx);
        }
    };

    if (
        ["guard-absent", "guard-off", "model-selection", "stream-performance"].includes(
            process.env.SPECPI_NATIVE_FIXTURE_MODE ?? "",
        )
    ) {
        // Exercise activation after startup through the public command lifecycle.
        pi.registerCommand("native-fixture-command", {
            description: "Exercise native delegation through a public Pi command",
            handler: (args: string, ctx: any) => executeFixture({}, ctx),
        });
    } else {
        pi.on("session_start", executeFixture);
    }
}
