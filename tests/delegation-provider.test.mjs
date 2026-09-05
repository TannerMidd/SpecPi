import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { runPiFixture } from "../scripts/pi-test-harness.mjs";
import { createNativePiHost, getPiSessionCompatibilityError } from "../extensions/delegation/provider.mjs";
import { LIMITS } from "../extensions/delegation/protocol.mjs";
import { runWorker } from "../extensions/delegation/worker.mjs";

function fixture() {
    const model = {
        id: "fixture",
        provider: "fixture",
        api: "mock",
        baseUrl: "https://fixture.invalid",
        reasoning: true,
        input: ["text"],
        contextWindow: 32768,
        maxTokens: 4096,
    };
    let current = true;
    let initialized = 0;
    let opened = 0;
    const ctx = {
        cwd: process.cwd(),
        model,
        modelRegistry: { getRegisteredProviderIds: () => [], getProviderAuthStatus: () => ({ source: "environment" }) },
    };
    const runtime = { getModel: () => ({ ...model }), getProvider: () => ({}), getError: () => undefined };
    const sdk = {
        VERSION: "0.84.4",
        clampThinkingLevel: (_model, level) => level,
        createExtensionRuntime: () => ({}),
        createAgentSession: async () => {
            opened += 1;
            throw new Error("Session construction sentinel");
        },
        SessionManager: { inMemory: () => ({}) },
        SettingsManager: {
            create: (_cwd, _agentDir, options) => {
                assert.deepEqual(options, { projectTrusted: false });

                return {
                    getGlobalSettings: () => ({}),
                    getTransport: () => "sse",
                    getThinkingBudgets: () => ({ low: 19 }),
                };
            },
            inMemory: (settings) => settings,
        },
        ModelRuntime: {
            create: async (options) => {
                initialized += 1;
                assert.deepEqual(options, { allowModelNetwork: false, refreshOnCreate: false });

                return runtime;
            },
        },
    };
    const options = { id: "owner", isCurrent: () => current, sdk, thinkingLevel: "low" };

    return {
        ctx,
        sdk,
        runtime,
        options,
        create: () => createNativePiHost(ctx, options),
        initialized: () => initialized,
        opened: () => opened,
        revoke: () => {
            current = false;
        },
    };
}

test("native session host requires public context contracts and explicit thinking", () => {
    const state = fixture();
    for (const options of [{}, { ...state.options, thinkingLevel: undefined }]) {
        assert.throws(() => createNativePiHost(state.ctx, options), /supported Pi SDK/u);
    }

    for (const ctx of [undefined, {}, { ...state.ctx, modelRegistry: {} }]) {
        assert.throws(() => createNativePiHost(ctx, state.options), /supported Pi SDK/u);
    }

    assert.equal(state.initialized(), 0);
});

test("readiness uses only public non-credential metadata and initializes once", async () => {
    const state = fixture();
    for (const [target, names] of [
        [state.ctx, ["agent", "sessionManager", "settingsManager"]],
        [
            state.ctx.modelRegistry,
            ["runtime", "getProviderAuth", "getApiKeyAndHeaders", "complete", "getRegisteredProviderConfig"],
        ],
    ]) {
        for (const name of names) {
            Object.defineProperty(target, name, {
                get() {
                    throw new Error(`Forbidden access: ${name}`);
                },
            });
        }
    }

    const host = state.create();
    assert.equal(state.initialized(), 0);
    await Promise.all([host.ready(), host.ready()]);
    assert.equal(state.initialized(), 1);
    assert.deepEqual(Object.keys(host).sort(), ["id", "isCurrent", "model", "openSession", "ready"]);
    assert.deepEqual(host.model, { id: "fixture", provider: "fixture", thinkingLevel: "low" });
    state.revoke();
    assert.equal(host.isCurrent(), false);
    await assert.rejects(async () => host.ready(), /lease/u);
});

test("a failed preflight can retry while successful initialization remains shared", async () => {
    const state = fixture();
    const create = state.sdk.ModelRuntime.create;
    let attempts = 0;
    state.sdk.ModelRuntime.create = (...args) => {
        attempts += 1;
        if (attempts === 1) {
            throw new Error("Transient synthetic configuration failure");
        }

        return create(...args);
    };

    const host = state.create();
    await assert.rejects(host.ready(), /Transient/);
    await Promise.all([host.ready(), host.ready()]);
    await host.ready();
    assert.equal(attempts, 2);
    assert.equal(state.initialized(), 1);
});

function streamingFixture(eventScript, overrides = {}) {
    const state = fixture();
    const counts = { full: 0, cheap: 0, tools: 0, dispose: 0, reset: 0, freshSession: 0 };
    state.ctx.model.compat = { fixture: "original" };
    state.options.isCurrent = (streaming = false) => {
        counts[streaming ? "cheap" : "full"] += 1;

        return true;
    };

    const terminal = {
        role: "assistant",
        content: [{ type: "text", text: "complete" }],
        stopReason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    };
    let session;
    state.sdk.createAgentSession = async (options) => {
        session = {
            thinkingLevel: "low",
            getActiveToolNames: () => [],
            setAutoCompactionEnabled() {},
            setAutoRetryEnabled() {},
            agent: {
                state: { messages: [] },
                reset() {
                    counts.reset += 1;
                },
                beforeToolCall() {
                    counts.tools += 1;
                },
                streamFunction: async () => ({
                    [Symbol.asyncIterator]: () => eventScript(terminal, state),
                    result: async () => terminal,
                }),
            },
            async prompt() {
                const stream = await session.agent.streamFunction(options.model, { messages: [], tools: [] }, {});
                for await (const _event of stream) {
                    // Consume actual adapter events without a provider or network request.
                }

                const result = await stream.result();
                for (const toolCall of result.content.filter((part) => part.type === "toolCall")) {
                    await session.agent.beforeToolCall({ toolCall }, new AbortController().signal);
                }

                session.agent.state.messages.push(result);
            },
            dispose() {
                counts.dispose += 1;
            },
            sessionManager: {
                newSession() {
                    counts.freshSession += 1;
                },
            },
            abort: async () => {},
        };
        overrides.configure?.(session);

        return { session };
    };

    const host = state.create();
    const controller = new AbortController();
    const controls = {
        signal: controller.signal,
        deadline: Date.now() + 5000,
        assertLive(streaming = false) {
            assert.equal(host.isCurrent(streaming), true);
        },
        admitCall() {},
        onUsage() {},
        abort() {
            controller.abort();
        },
        limits: { ...LIMITS, ...overrides.limits },
    };

    return { state, host, counts, controls, session: () => session };
}

test("stream deltas do not reserialize model descriptors or full growing partials", async (t) => {
    const state = streamingFixture(async function* (terminal) {
        yield { type: "start", partial: { ...terminal, content: [] } };
        let text = "";
        for (let index = 0; index < 1000; index += 1) {
            text += '🍎\\"';
            yield {
                type: "text_delta",
                contentIndex: 0,
                delta: '🍎\\"',
                partial: { ...terminal, content: [{ type: "text", text }] },
            };
        }

        terminal.content[0].text = text;
        yield { type: "done", reason: "stop", message: terminal };
    });
    const handle = await state.host.openSession({ systemPrompt: "fixture", tools: [] });
    const stringify = JSON.stringify;
    let bytes = 0;
    const spy = t.mock.method(JSON, "stringify", (...args) => {
        const result = stringify(...args);
        bytes += Buffer.byteLength(result);

        return result;
    });
    try {
        const result = await handle.run("fixture", state.controls);
        assert.equal(result.content[0].text.length, 4000);
        assert.equal(state.counts.cheap, 2000);
        assert.ok(state.counts.full < 40, JSON.stringify(state.counts));
        assert.ok(bytes < 100_000, `${bytes} serialized bytes for 1000 deltas`);
    } finally {
        spy.mock.restore();
        handle.release();
    }
});

test("repeated non-delta events cannot repeatedly rescan a large partial", async () => {
    let consumed = 0;
    const state = streamingFixture(async function* (terminal) {
        for (let index = 0; index < 200; index += 1) {
            consumed += 1;
            yield { type: "text_start", contentIndex: 0, partial: terminal };
        }
    });
    const handle = await state.host.openSession({ systemPrompt: "fixture", tools: [] });
    try {
        await assert.rejects(handle.run("fixture", state.controls), /excessive stream boundaries/);
        assert.equal(consumed, 131);
    } finally {
        handle.release();
    }
});

for (const kind of [
    "unknown",
    "event-metadata",
    "huge-metadata",
    "unreported-oversize",
    "delta-size",
    "overflow",
    "nested-model-mutation",
]) {
    test(`stream ${kind} fails before publication and further child tools`, async () => {
        const state = streamingFixture(async function* (terminal, fixtureState) {
            yield { type: "start", partial: { ...terminal, content: [] } };
            if (kind === "nested-model-mutation") {
                fixtureState.ctx.model.compat.fixture = "changed";
                terminal.content = [{ type: "toolCall", id: "fixture-tool", name: "read_source", arguments: {} }];
                terminal.stopReason = "toolUse";
            }

            const partial = { ...terminal, content: [{ type: "text", text: "x" }] };
            if (kind === "huge-metadata") {
                partial.providerMetadata = { value: "x".repeat(300_000) };
            }

            if (kind === "unreported-oversize") {
                partial.content[0].text = "x".repeat(300_000);
            }

            for (let index = 0; index < (kind === "overflow" ? 3 : 1); index += 1) {
                yield {
                    type: kind === "unknown" ? "unknown_delta" : "text_delta",
                    contentIndex: 0,
                    delta:
                        kind === "delta-size" ? "🍎".repeat(100_000) : kind === "overflow" ? "🍎".repeat(30_000) : "x",
                    partial,
                    ...(kind === "event-metadata" ? { unexpected: "unreviewed" } : {}),
                };
            }

            yield { type: "done", reason: terminal.stopReason, message: terminal };
        });
        const handle = await state.host.openSession({
            systemPrompt: "fixture",
            tools:
                kind === "nested-model-mutation"
                    ? [{ name: "read_source", description: "fixture", parameters: {} }]
                    : [],
        });
        try {
            await assert.rejects(
                handle.run("fixture", state.controls),
                kind === "nested-model-mutation"
                    ? /lease/
                    : kind === "delta-size"
                      ? /retained data allowance/
                      : /stream|partial|metadata/,
            );
            assert.equal(state.counts.tools, 0);
            assert.equal(state.controls.signal.aborted, true);
        } finally {
            handle.release();
        }
    });
}

test("cleanup detaches and attempts every stage despite synchronous throws or rejections", async () => {
    for (const rejecting of [false, true]) {
        const state = streamingFixture(
            async function* (terminal) {
                yield { type: "unsupported", partial: terminal };
            },
            {
                configure(session) {
                    const fail = () => {
                        if (rejecting) {
                            return Promise.reject(new Error("SYNTHETIC_CLEANUP_SENTINEL"));
                        }

                        throw new Error("SYNTHETIC_CLEANUP_SENTINEL");
                    };

                    session.abort = fail;
                    const dispose = session.dispose;
                    session.dispose = () => {
                        dispose();

                        return fail();
                    };

                    const reset = session.agent.reset;
                    session.agent.reset = () => {
                        reset();

                        return fail();
                    };
                },
            },
        );
        const handle = await state.host.openSession({ systemPrompt: "fixture", tools: [] });
        await assert.rejects(
            handle.run("fixture", state.controls),
            (error) => !error.message.includes("SYNTHETIC_CLEANUP_SENTINEL"),
        );
        handle.release();
        handle.release();
        await Promise.resolve();
        assert.equal(state.counts.dispose, 1);
        assert.equal(state.counts.reset, 1);
        assert.equal(state.counts.freshSession, 1);
    }
});

test("worker detaches failed cleanup and redacts tool exceptions before Pi can replay them", async () => {
    const packet = { objective: "Review", requirements: [{ id: "r1", text: "Review" }], decisions: [], nonGoals: [] };
    const job = {
        spec: { mode: "review", question: "Review", requirements: ["r1"], context: "fixture", sources: ["source.md"] },
        deadline: Date.now() + 5000,
        toolCalls: 0,
        toolBytes: 0,
    };
    const snapshot = {
        sources: [{ id: "s1", path: "source.md", lineCount: 1 }],
        assertBindings() {},
        read() {
            throw new Error("SYNTHETIC_PRIVATE_PATH_SENTINEL");
        },
    };
    let opened = 0;
    let aborted = 0;
    const host = {
        async openSession({ tools }) {
            opened += 1;

            return {
                release() {
                    throw new Error("SYNTHETIC_CLEANUP_SENTINEL");
                },
                async run() {
                    await tools
                        .find((tool) => tool.name === "read_source")
                        .execute("fixture", { sourceId: "s1", startLine: 1, maxLines: 1 });
                    assert.fail("The rejected tool cannot complete");
                },
            };
        },
    };
    const controls = {
        signal: new AbortController().signal,
        abort() {
            aborted += 1;
        },
        assertLive() {},
        admitCall() {},
        onUsage() {},
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(
            runWorker({ packet, job, host, snapshot, ...controls }),
            (error) => error.message === "Delegation operation failed. Retry after checking Pi configuration.",
        );
        assert.throws(job.release, /SYNTHETIC_CLEANUP_SENTINEL/);
        assert.equal(job.child, undefined);
        job.release();
    }

    assert.equal(opened, 2);
    assert.equal(aborted, 2);
});

test("SDK capabilities permit new versions without weakening provider restrictions", async () => {
    for (const version of ["0.85.1", "0.86.0", "1.0.0", undefined]) {
        const state = fixture();
        state.sdk.VERSION = version;
        const host = state.create();
        await host.ready();
        assert.equal(state.initialized(), 1);
        state.ctx.modelRegistry.getProviderAuthStatus = () => ({ source: "runtime" });
        await assert.rejects(async () => host.ready(), /runtime provider override/u);
        assert.equal(state.opened(), 0);
    }
});

test("missing SDK capabilities fail preflight and identify the unavailable API", () => {
    for (const name of [
        "createAgentSession",
        "ModelRuntime.create",
        "SessionManager.inMemory",
        "SettingsManager.create",
        "SettingsManager.inMemory",
        "createExtensionRuntime",
        "clampThinkingLevel",
    ]) {
        const state = fixture();
        const [owner, property] = name.split(".");
        if (property) {
            state.sdk[owner][property] = undefined;
        } else {
            state.sdk[owner] = undefined;
        }

        const error = getPiSessionCompatibilityError(state.sdk);
        assert.ok(error.includes(name));
        assert.throws(state.create, (caught) => caught.message === error);
        assert.equal(state.initialized(), 0);
    }
});

test("unsupported runtime auth, extension providers, and direct model headers fail before initialization", async () => {
    for (const kind of ["auth", "provider", "headers"]) {
        const state = fixture();
        if (kind === "auth") {
            state.ctx.modelRegistry.getProviderAuthStatus = () => ({ source: "runtime" });
        } else if (kind === "provider") {
            state.ctx.modelRegistry.getRegisteredProviderIds = () => ["fixture"];
        } else {
            state.ctx.model.headers = new Proxy(
                {},
                {
                    ownKeys() {
                        throw new Error("Headers must not be inspected");
                    },
                },
            );
        }

        await assert.rejects(async () => state.create().ready(), /runtime provider override/u);
        assert.equal(state.initialized(), 0);
    }
});

test("configured child model mismatches and parent mutation fail closed without exposing descriptors", async () => {
    for (const key of ["id", "provider", "api", "baseUrl", "maxTokens", "compat", "thinkingLevelMap"]) {
        const state = fixture();
        state.runtime.getModel = () => ({ ...state.ctx.model, [key]: "SYNTHETIC_PRIVATE_SENTINEL" });
        await assert.rejects(
            state.create().ready(),
            (error) => /does not match/u.test(error.message) && !error.message.includes("SYNTHETIC_PRIVATE_SENTINEL"),
        );
    }

    const state = fixture();
    const host = state.create();
    await host.ready();
    state.ctx.model.baseUrl = "https://changed.invalid";
    assert.equal(host.isCurrent(), false);
    await assert.rejects(async () => host.ready(), /lease/u);
});

test("session options are closed and cannot add ambient tools", async () => {
    const state = fixture();
    const host = state.create();
    for (const options of [
        null,
        [],
        {},
        { systemPrompt: "x", tools: [], cwd: "elsewhere" },
        { systemPrompt: "x", tools: [], headers: {} },
        { systemPrompt: "x", tools: [{ name: "bash" }] },
        { systemPrompt: "x".repeat(256 * 1024), tools: [] },
    ]) {
        await assert.rejects(host.openSession(options), /Invalid|snapshot capabilities|retained data/u);
    }

    assert.equal(state.opened(), 0);
});

test("Pi's public thinking normalization determines the reported effective level", () => {
    const state = fixture();
    state.sdk.clampThinkingLevel = (_model, requested) => {
        assert.equal(requested, "low");

        return "off";
    };

    assert.equal(state.create().model.thinkingLevel, "off");
});

test("real Pi SDK sessions stream, replay tools, apply thinking and auth, and retain cancelled requests until settlement", (testContext) => {
    const result = runPiFixture(path.resolve("tests/fixtures/delegation-provider-harness.ts"));
    if (result.unavailable) {
        testContext.skip(result.error?.message ?? "Pi is unavailable");

        return;
    }

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const marker = `${result.stdout}\n${result.stderr}`
        .split(/\r?\n/u)
        .find((line) => line.startsWith("DELEGATION_FIXTURE="));
    assert.ok(marker, `${result.stderr}\n${result.stdout}`);
    const proof = JSON.parse(marker.slice("DELEGATION_FIXTURE=".length));
    assert.match(proof.sdkVersion, /^\d+\.\d+\.\d+/u);
    assert.deepEqual(proof, {
        sdkVersion: proof.sdkVersion,
        realSessions: true,
        streaming: true,
        toolReplay: true,
        thinking: true,
        oauth: true,
        noAmbientResources: true,
        parentHooksExcluded: true,
        settlement: true,
    });
});
