import assert from "node:assert/strict";
import path from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import registerCommandGuard from "../../extensions/command-guard/index.ts";
import registerDelegation from "../../extensions/delegation/index.ts";

function captureApi(pi: any, forward: boolean) {
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
        hooks,
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

function packet(
    jobs = [
        {
            id: "j1",
            mode: "consult",
            question: "Assess public fixture",
            context: "Public fixture",
            sources: [] as string[],
        },
    ],
) {
    return {
        objective: "Assess the public native-entry fixture",
        requirements: [{ id: "r1", text: "Check the fixture" }],
        decisions: ["Use the selected public evidence"],
        nonGoals: ["No writes or network"],
        reason: {
            deliverable: "Bounded report",
            consumer: "Parent",
            independence: "Independent source assessment",
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
    const deadline = Date.now() + 5000;
    while (!(await predicate())) {
        assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

function registerReloadProof(pi: any, native: ReturnType<typeof captureApi>, observed: any[]) {
    const key = Symbol.for("specpi.fixture.native-reload.v1");
    const trace = ((globalThis as any)[key] ??= { registrations: 0, lifecycle: [] });
    trace.registrations += 1;
    trace.currentNative = native;
    trace.currentPi = pi;
    trace.currentObserved = observed;
    pi.on("session_shutdown", (event: any) => {
        if (event.reason === "reload") {
            trace.lifecycle.push("shutdown:reload");
        }
    });
    pi.on("session_start", async (event: any, ctx: any) => {
        if (event.reason === "new") {
            trace.newStartReason = event.reason;

            return;
        }

        if (event.reason !== "reload") {
            return;
        }

        trace.lifecycle.push("start:reload");
        assert.equal(trace.registrations, 2);
        const output = await native.tools
            .get("delegate")
            .execute("reload-status", { operation: "status" }, new AbortController().signal, undefined, ctx);
        assert.notEqual(output.isError, true, JSON.stringify(output));
        const state = output.details;
        assert.equal(state.enabled, false);
        assert.equal(state.sessionCalls, trace.before.sessionCalls);
        assert.equal(state.sessionBatches, trace.before.sessionBatches);
        assert.equal(state.sessionCalls, 1);
        assert.equal(state.sessionBatches, 1);
        assert.ok(state.generation > trace.before.generation);
        assert.equal(pi.getActiveTools().includes("delegate"), false);
        assert.ok(pi.getAllTools().some((tool: any) => tool.name === "delegate"));
        assert.ok(native.commands.has("delegate"));
        await trace.oldNative.emit("session_shutdown", { reason: "late old callback" }, ctx);
        const afterOld = await native.tools
            .get("delegate")
            .execute("reload-status-after-old", { operation: "status" }, new AbortController().signal, undefined, ctx);
        assert.equal(afterOld.details.generation, state.generation);
        assert.equal(afterOld.details.enabled, false);
        console.log(
            `NATIVE_RELOAD_FIXTURE=${JSON.stringify({
                publicCommandReload: true,
                registrations: trace.registrations,
                reloadReason: event.reason,
                enabled: state.enabled,
                activeTool: pi.getActiveTools().includes("delegate"),
                calls: state.sessionCalls,
                batches: state.sessionBatches,
                generationAdvanced: true,
                oldCallbackInert: true,
                lifecycle: trace.lifecycle,
            })}`,
        );
    });
    pi.registerCommand("native-fixture-reload", {
        description: "Exercise the public command-context reload in an isolated fixture",
        handler: async (_args: string, ctx: any) => {
            assert.equal(trace.registrations, 1);
            assert.equal(typeof ctx.reload, "function");
            trace.lifecycle.push("command");
            // The test command is explicitly invoked on the ordinary CLI. This
            // fixture UI supplies the authorized activation without an RPC dialog.
            const ui = {
                ...ctx.ui,
                notify() {},
                setStatus() {},
                async select() {
                    return "Allow once";
                },
                async confirm() {
                    return true;
                },
            };
            const commandContext = new Proxy(ctx, {
                get(target, property) {
                    if (property === "hasUI") {
                        return true;
                    }

                    return property === "ui" ? ui : Reflect.get(target, property);
                },
            });
            const model = ctx.modelRegistry.find("specpi-native-entry-fixture", "native-parent");
            assert.ok(model);
            assert.equal(await pi.setModel(model), true);
            await native.commands.get("delegate").handler("on", commandContext);
            const execute = async (input: any) => {
                const output = await native.tools
                    .get("delegate")
                    .execute("reload-proof", input, new AbortController().signal, undefined, commandContext);
                assert.notEqual(output.isError, true, JSON.stringify(output));

                return output.details;
            };

            const batch = await execute({ operation: "run", requestId: "before-real-reload", packet: packet() });
            await waitFor(
                async () => (await execute({ operation: "status" })).active === 0,
                "completion before public reload",
            );
            const collected = await execute({ operation: "collect", batchId: batch.batchId });
            assert.equal(collected.results[0].receipt.state, "complete");
            assert.equal(observed.length, 1);
            trace.before = await execute({ operation: "status" });
            assert.equal(trace.before.enabled, true);
            trace.oldNative = native;
            await ctx.reload();

            return;
        },
    });
    pi.registerCommand("native-fixture-replace", {
        description: "Exercise public newSession and its fresh withSession context",
        handler: async (_args: string, oldContext: any) => {
            assert.equal(trace.registrations, 2);
            assert.equal(typeof oldContext.newSession, "function");
            const oldNative = native;
            await oldContext.newSession({
                withSession: async (replacement: any) => {
                    assert.notEqual(replacement, oldContext);
                    assert.equal(trace.registrations, 3);
                    assert.equal(trace.newStartReason, "new");
                    const freshNative = trace.currentNative;
                    const freshPi = trace.currentPi;
                    assert.notEqual(freshNative, oldNative);
                    const ui = {
                        ...replacement.ui,
                        notify() {},
                        setStatus() {},
                        async select() {
                            return "Allow once";
                        },
                        async confirm() {
                            return true;
                        },
                    };
                    const freshContext = new Proxy(replacement, {
                        get(target, property) {
                            if (property === "hasUI") {
                                return true;
                            }

                            return property === "ui" ? ui : Reflect.get(target, property);
                        },
                    });
                    const execute = async (input: any) => {
                        const output = await freshNative.tools
                            .get("delegate")
                            .execute("replacement-proof", input, new AbortController().signal, undefined, freshContext);
                        assert.notEqual(output.isError, true, JSON.stringify(output));

                        return output.details;
                    };

                    const before = await execute({ operation: "status" });
                    assert.equal(before.enabled, false);
                    assert.equal(before.sessionCalls, 1);
                    assert.equal(before.sessionBatches, 1);
                    assert.equal(freshPi.getActiveTools().includes("delegate"), false);
                    assert.ok(freshPi.getAllTools().some((tool: any) => tool.name === "delegate"));
                    const model = replacement.modelRegistry.find("specpi-native-entry-fixture", "native-parent");
                    assert.ok(model);
                    assert.equal(await freshPi.setModel(model), true);
                    await freshNative.commands.get("delegate").handler("on", freshContext);
                    const enabled = await execute({ operation: "status" });
                    assert.equal(enabled.enabled, true);
                    assert.equal(freshPi.getActiveTools().includes("delegate"), true);
                    await oldNative.emit("session_shutdown", { reason: "late replaced callback" }, freshContext);
                    const afterOld = await execute({ operation: "status" });
                    assert.equal(afterOld.enabled, true);
                    assert.equal(afterOld.generation, enabled.generation);
                    const batch = await execute({
                        operation: "run",
                        requestId: "after-public-new-session",
                        packet: packet(),
                    });
                    await waitFor(
                        async () => (await execute({ operation: "status" })).active === 0,
                        "new-session completion",
                    );
                    const collected = await execute({ operation: "collect", batchId: batch.batchId });
                    assert.equal(collected.results[0].receipt.state, "complete");
                    assert.equal(trace.currentObserved.length, 1);
                    await freshNative.commands.get("delegate").handler("off", freshContext);
                    const after = await execute({ operation: "status" });
                    assert.equal(after.enabled, false);
                    assert.equal(after.sessionCalls, 2);
                    assert.equal(after.sessionBatches, 2);
                    assert.equal(freshPi.getActiveTools().includes("delegate"), false);
                    console.log(
                        `NATIVE_REPLACEMENT_FIXTURE=${JSON.stringify({
                            publicNewSession: true,
                            registrations: trace.registrations,
                            startReason: trace.newStartReason,
                            freshContext: true,
                            initiallyOff: true,
                            callsBefore: before.sessionCalls,
                            batchesBefore: before.sessionBatches,
                            callsAfter: after.sessionCalls,
                            batchesAfter: after.sessionBatches,
                            newWorkerCompleted: true,
                            oldCallbackInert: true,
                            finallyOff: true,
                        })}`,
                    );
                },
            });

            return;
        },
    });
}

export default function nativeEntryFixture(pi: any) {
    const observed: any[] = [];
    const held: any[] = [];
    let behavior = "complete";
    let inheritedHooks = 0;
    pi.on("before_provider_headers", (event: any) => {
        inheritedHooks += 1;
        event.headers["x-parent-hook-fixture"] = "must-not-be-inherited";
    });
    pi.on("before_provider_request", (event: any) => {
        inheritedHooks += 1;

        return { ...event.payload, parentHookFixture: true };
    });
    pi.registerProvider("specpi-native-entry-fixture", {
        apiKey: "synthetic-fixture-only",
        baseUrl: "https://native-entry-fixture.invalid",
        api: "specpi-native-entry-fixture-api",
        models: [
            {
                id: "native-parent",
                name: "Synthetic native parent",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32768,
                maxTokens: 4096,
            },
        ],
        streamSimple(model: any, context: any, options: any) {
            const events = createAssistantMessageEventStream();
            const entry = { model, context: structuredClone(context), options };
            observed.push(entry);
            let release: () => void = () => {};

            const gate =
                behavior === "hold"
                    ? new Promise<void>((resolve) => {
                          release = resolve;
                      })
                    : Promise.resolve();
            if (behavior === "hold") {
                held.push({ release, signal: options.signal });
            }

            void (async () => {
                try {
                    await gate;
                    const supplied = JSON.parse(context.messages[0].content[0].text);
                    const source = supplied.sources[0];
                    const needsRead = source && !context.messages.some((item: any) => item.role === "toolResult");
                    const content = needsRead
                        ? [
                              {
                                  type: "toolCall",
                                  id: "native-read",
                                  name: "read_source",
                                  arguments: { sourceId: source.id, startLine: 1, maxLines: 1 },
                              },
                          ]
                        : [
                              {
                                  type: "text",
                                  text: JSON.stringify({
                                      status: "complete",
                                      answer: "Native public-registry assessment complete",
                                      requirements: [
                                          {
                                              id: "r1",
                                              status: "addressed",
                                              evidence: [{ sourceId: source?.id ?? "p1", lineStart: 1, lineEnd: 1 }],
                                          },
                                      ],
                                      findings: [],
                                      missing: [],
                                      nextStep: "Parent checks the cited evidence",
                                  }),
                              },
                          ];
                    const message: any = {
                        role: "assistant",
                        content,
                        api: model.api,
                        provider: model.provider,
                        model: model.id,
                        timestamp: Date.now(),
                        stopReason: needsRead ? "toolUse" : "stop",
                        usage: {
                            input: 2,
                            output: 3,
                            cacheRead: 0,
                            cacheWrite: 0,
                            totalTokens: 5,
                            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                        },
                    };
                    events.push({ type: "done", reason: message.stopReason, message });
                } catch (error) {
                    events.push({
                        type: "error",
                        reason: "error",
                        error: {
                            role: "assistant",
                            content: [],
                            api: model.api,
                            provider: model.provider,
                            model: model.id,
                            timestamp: Date.now(),
                            stopReason: "error",
                            errorMessage: String(error),
                            usage: {
                                input: 0,
                                output: 0,
                                cacheRead: 0,
                                cacheWrite: 0,
                                totalTokens: 0,
                                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                            },
                        },
                    });
                }
            })();

            return events;
        },
    });

    const guard = captureApi(pi, true);
    registerCommandGuard(guard.api, { approvalTimeoutMs: 1000, startupTimeoutMs: 1000 });
    const first = captureApi(pi, true);
    registerDelegation(first.api);
    if (process.env.SPECPI_NATIVE_FIXTURE_MODE === "reload") {
        registerReloadProof(pi, first, observed);

        return;
    }

    let started = false;
    pi.on("session_start", async (_event: any, actual: any) => {
        if (started) {
            return;
        }

        started = true;
        const notices: any[] = [];
        const approvals: string[] = [];
        let approvalAnswer = "Allow once";
        const ui = {
            ...actual.ui,
            notify(text: string, kind: string) {
                notices.push({ text, kind });
            },
            setStatus() {},
            async select(title: string) {
                approvals.push(title);

                return approvalAnswer;
            },
            async confirm() {
                return true;
            },
        };
        // The model and registry come from Pi's real public context. A history or
        // private-session lookup in native code fails immediately in this fixture.
        const context = new Proxy(actual, {
            get(target, key) {
                if (["sessionManager", "agent", "session", "credentials", "authStorage"].includes(String(key))) {
                    throw new Error("Native fixture forbids private/session access");
                }

                if (key === "ui") {
                    return ui;
                }

                if (key === "hasUI") {
                    return true;
                }

                return Reflect.get(target, key);
            },
        });
        let active = first;
        let sequence = 0;
        const raw = async (input: any, selected = active, ctx = context) =>
            selected.tools
                .get("delegate")
                .execute(`native-${++sequence}`, input, new AbortController().signal, undefined, ctx);
        const status = async () => (await raw({ operation: "status" })).details;
        const command = async (text: string, selected = active, ctx = context) =>
            selected.commands.get("delegate").handler(text, ctx);
        const checked = async (input: any) => {
            const toolCallId = `guarded-native-${++sequence}`;
            const before = await guard.emit("tool_call", { toolName: "delegate", toolCallId, input }, context);
            assert.ok(
                before.every((entry) => entry?.block !== true),
                JSON.stringify(before),
            );
            const output = await raw(input);
            assert.notEqual(output.isError, true, JSON.stringify(output));

            return output.details;
        };

        const resolveAll = async (collected: any, prefix: string) => {
            for (const item of collected.results) {
                await checked({
                    operation: "resolve",
                    requestId: `${prefix}-${item.receipt.jobId}`,
                    ...binding(item.receipt),
                    decision: "accept",
                    findings: [],
                });
            }
        };

        try {
            assert.deepEqual([...first.commands.keys()], ["delegate"]);
            assert.deepEqual([...first.tools.keys()], ["delegate"]);
            assert.ok(pi.getAllTools().some((tool: any) => tool.name === "delegate"));
            assert.ok(
                first.tools
                    .get("delegate")
                    .parameters.anyOf.every((branch: any) => branch.additionalProperties === false),
            );
            assert.equal((await status()).enabled, false);
            assert.equal(pi.getActiveTools().includes("delegate"), false);
            const ordinaryTools = pi.getActiveTools();
            const headless = new Proxy(context, {
                get(target, key) {
                    return key === "hasUI" ? false : Reflect.get(target, key);
                },
            });
            await command("on", first, headless);
            assert.equal((await status()).enabled, false);
            assert.match(notices.at(-1).text, /human interactive command/);
            assert.equal((await raw({ operation: "run", requestId: "disabled", packet: packet() })).isError, true);
            assert.equal(observed.length, 0);

            const model = actual.modelRegistry.find("specpi-native-entry-fixture", "native-parent");
            assert.ok(model, "The ordinary Pi runtime registered the synthetic provider");
            assert.equal(await pi.setModel(model), true);
            await guard.commands.get("guard").handler("strict", context);
            await command("on");
            assert.equal((await status()).enabled, true, JSON.stringify(notices));
            assert.equal(pi.getActiveTools().includes("delegate"), true);
            assert.deepEqual(
                pi.getActiveTools().filter((name: string) => name !== "delegate"),
                ordinaryTools,
            );
            assert.deepEqual((await status()).model, { provider: model.provider, id: model.id });
            const input = {
                operation: "run",
                requestId: "first-run",
                packet: packet([{ ...packet().jobs[0], mode: "investigate", sources: ["fixture.md"] }]),
            };
            approvalAnswer = "Deny (Recommended)";
            const denied = await guard.emit(
                "tool_call",
                { toolName: "delegate", toolCallId: "denied-native", input },
                context,
            );
            assert.ok(denied.some((entry) => entry?.block === true));
            assert.equal(observed.length, 0);
            approvalAnswer = "Allow once";
            const firstBatch = await checked(input);
            await waitFor(async () => (await status()).active === 0, "native registry worker");
            const firstResult = await checked({ operation: "collect", batchId: firstBatch.batchId });
            assert.equal(firstResult.results[0].receipt.state, "complete", JSON.stringify(firstResult));
            assert.equal(firstResult.results[0].receipt.calls, 2);
            assert.equal(firstResult.results[0].receipt.usageComplete, true);
            assert.equal(firstResult.results[0].result.answer, "Native public-registry assessment complete");
            assert.equal(observed.length, 2);
            const readOutput = observed[1].context.messages.find((item: any) => item.role === "toolResult");
            assert.equal(JSON.parse(readOutput.content[0].text).text, "Public native fixture evidence.");
            assert.ok(
                observed.every((entry) => entry.model.id === model.id && entry.model.provider === model.provider),
            );
            assert.ok(observed.every((entry) => entry.options.maxTokens === 2048 && entry.options.maxRetries === 0));
            assert.equal(inheritedHooks, 0);
            assert.ok(observed.every((entry) => !entry.options.headers?.["x-parent-hook-fixture"]));
            await resolveAll(firstResult, "first-resolve");

            behavior = "hold";
            const twoJobs = packet([packet().jobs[0], { ...packet().jobs[0], id: "j2" }]);
            const heldBatch = await checked({ operation: "run", requestId: "held-run", packet: twoJobs });
            await waitFor(() => held.length === 2, "non-cooperative registry calls");
            assert.equal((await status()).active, 2);
            assert.equal((await status()).sessionCalls, 4);

            // Re-evaluate the dependency-free native module to simulate code reload;
            // no SDK launcher, private session, or global-state reset is involved.
            const reloadUrl = new URL("../../extensions/delegation/native.mjs", import.meta.url);
            reloadUrl.searchParams.set("fixture-reload", "second");
            const reloaded = await import(reloadUrl.href);
            const second = captureApi(pi, false);
            reloaded.registerNativeDelegation(second.api);
            active = second;
            await second.emit("session_start", { reason: "reload" }, context);
            assert.equal((await status()).enabled, false);
            assert.equal(pi.getActiveTools().includes("delegate"), false);
            assert.deepEqual(pi.getActiveTools(), ordinaryTools);
            assert.equal((await status()).active, 2);
            assert.equal((await status()).sessionCalls, 4);
            assert.equal((await status()).sessionBatches, 2);
            assert.ok(held.every((entry) => entry.signal.aborted));
            await command("on");
            assert.equal(pi.getActiveTools().includes("delegate"), true);
            const beforeOldCallbacks = await status();
            await first.emit("session_shutdown", { reason: "late old shutdown" }, context);
            await command("off", first);
            assert.equal((await status()).enabled, true);
            assert.equal((await status()).generation, beforeOldCallbacks.generation);
            assert.equal((await status()).active, 2);
            assert.equal((await raw({ operation: "collect", batchId: heldBatch.batchId })).isError, true);

            behavior = "complete";
            const queued = await checked({ operation: "run", requestId: "queued-after-reload", packet: twoJobs });
            assert.ok(queued.jobs.every((job: any) => job.state === "queued"));
            assert.equal(observed.length, 4);
            held[0].release();
            await waitFor(
                async () =>
                    (await status()).batches
                        .find((batch: any) => batch.batchId === queued.batchId)
                        .jobs.every((job: any) => job.state === "complete" && !job.settling),
                "new generation work",
            );
            assert.equal((await status()).active, 1);
            assert.equal((await status()).sessionCalls, 6);
            held[1].release();
            await waitFor(async () => (await status()).active === 0, "old completion settlement");
            assert.equal((await raw({ operation: "collect", batchId: heldBatch.batchId })).isError, true);
            const queuedResult = await checked({ operation: "collect", batchId: queued.batchId });
            await resolveAll(queuedResult, "queued-resolve");

            const lastBatch = await checked({ operation: "run", requestId: "fourth-batch", packet: packet() });
            await waitFor(async () => (await status()).active === 0, "fourth batch");
            await resolveAll(await checked({ operation: "collect", batchId: lastBatch.batchId }), "last-resolve");
            await command("off");
            assert.equal(pi.getActiveTools().includes("delegate"), false);
            assert.deepEqual(pi.getActiveTools(), ordinaryTools);
            await command("on");
            assert.equal(pi.getActiveTools().includes("delegate"), true);
            const exhausted = await raw({ operation: "run", requestId: "fifth-batch", packet: packet() });
            assert.equal(exhausted.isError, true);
            assert.match(exhausted.content[0].text, /batch limits/);
            const final = await status();
            assert.equal(final.sessionCalls, 7);
            assert.equal(final.sessionBatches, 4);
            assert.equal(observed.length, 7);
            assert.ok(
                approvals.some((title) => title.includes("Unknown tool approval") && title.includes("Delegation run")),
            );

            const wrongRoot = new Proxy(context, {
                get(target, key) {
                    return key === "cwd" ? path.dirname(context.cwd) : Reflect.get(target, key);
                },
            });
            await command("on", second, wrongRoot);
            assert.equal((await status()).enabled, false);
            assert.equal(pi.getActiveTools().includes("delegate"), false);
            console.log(
                `NATIVE_ENTRY_FIXTURE=${JSON.stringify({
                    ordinaryEntryRegistered: true,
                    publicRegistryCompleted: true,
                    defaultOff: true,
                    headlessActivationDenied: true,
                    sameModel: true,
                    snapshotRead: true,
                    strictGuardIntercepted: true,
                    parentHooksNotInherited: true,
                    reloadedModuleSharesController: true,
                    oldCallbacksInert: true,
                    heldSlotsPreserved: true,
                    oldResultStale: true,
                    sharedCallCounter: true,
                    batchQuotaPreserved: true,
                    differentRootDenied: true,
                    activeToolGated: true,
                    calls: observed.length,
                    batches: final.sessionBatches,
                    ceilings: {
                        concurrency: final.limits.concurrency,
                        sessionCalls: final.limits.sessionCalls,
                        sessionBatches: final.limits.sessionBatches,
                    },
                })}`,
            );
        } finally {
            for (const entry of held) {
                entry.release();
            }

            await active.emit("session_shutdown", { reason: "fixture cleanup" }, context);
        }
    });
}
