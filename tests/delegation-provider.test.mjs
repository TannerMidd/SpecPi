import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { runPiFixture } from "../scripts/pi-test-harness.mjs";
import { createNativePiHost } from "../extensions/delegation/provider.mjs";

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

test("native session host requires pinned public SDK contracts and explicit thinking", () => {
    const state = fixture();
    for (const options of [
        {},
        { ...state.options, thinkingLevel: undefined },
        { ...state.options, sdk: { ...state.sdk, VERSION: "0.86.0" } },
    ]) {
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
    assert.ok(["0.84.4", "0.85.0"].includes(proof.sdkVersion));
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
