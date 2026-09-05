import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import {
    createProvider,
    createAssistantMessageEventStream,
    InMemoryCredentialStore,
    InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { createNativePiHost } from "../../extensions/delegation/provider.mjs";
import { runWorker } from "../../extensions/delegation/worker.mjs";
import { LIMITS } from "../../extensions/delegation/protocol.mjs";

const usage = {
    input: 7,
    output: 3,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 13,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const report = {
    status: "complete",
    answer: "Synthetic evidence reviewed.",
    requirements: [{ id: "r1", status: "addressed", evidence: [{ sourceId: "p1", lineStart: 1, lineEnd: 1 }] }],
    findings: [],
    missing: [],
    nextStep: "Parent integrates the evidence.",
};
const final = () => ({
    content: [{ type: "text", text: JSON.stringify(report), textSignature: "synthetic-signature" }],
    stopReason: "stop",
});
const readCall = (name = "read_source", args: any = { sourceId: "s1", startLine: 1, maxLines: 1 }) => ({
    content: [{ type: "toolCall", id: "call-fixture", name, arguments: args }],
    stopReason: "toolUse",
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(root: string, label: string, script: any, settings: any = {}) {
    const cwd = path.join(root, label);
    const agentDir = path.join(root, label + "-agent");
    fs.mkdirSync(cwd);
    fs.mkdirSync(agentDir);
    // These canaries must never be loaded by a child resource loader.
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "AMBIENT_PROJECT_CANARY");
    fs.mkdirSync(path.join(cwd, ".pi", "extensions"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "extensions", "canary.ts"), "throw new Error('AMBIENT_EXTENSION_CANARY')");
    const observed: any[] = [];
    const sessions: any[] = [];
    const hookCalls = { context: 0, headers: 0, payload: 0, response: 0 };
    let refreshes = 0;
    let childRuntimes = 0;
    const credentials = new InMemoryCredentialStore();
    if (settings.oauth) {
        await credentials.modify("specpi-fixture", async () => ({
            type: "oauth",
            access: "synthetic-expired",
            refresh: "synthetic-refresh",
            expires: 1,
        }));
    }

    const model: any = {
        id: "fixture-model",
        provider: "specpi-fixture",
        api: "specpi-fixture-api",
        name: "Synthetic fixture",
        baseUrl: "https://model.invalid",
        reasoning: true,
        input: ["text", "image"],
        cost: usage.cost,
        contextWindow: 32768,
        maxTokens: 4096,
    };
    const stream = (requestModel: any, context: any, options: any, route: string) => {
        const events = createAssistantMessageEventStream();
        const message: any = {
            role: "assistant",
            api: requestModel.api,
            provider: requestModel.provider,
            model: requestModel.id,
            content: [],
            usage,
            stopReason: "stop",
            timestamp: Date.now(),
            providerMetadata: { replay: "synthetic-opaque-metadata" },
        };
        void (async () => {
            try {
                const payload =
                    (await options.onPayload?.({ messages: context.messages, marker: "original" }, requestModel)) ?? {};
                const observation = { requestModel, context, options, payload, route };
                observed.push(observation);
                await options.onResponse?.({ status: 200, headers: { "x-fixture-response": "yes" } }, requestModel);
                Object.assign(message, await script(observation, observed.length));
                events.push({ type: "start", partial: { ...message, content: [] } });
                const block = message.content[0];
                events.push({
                    type: block?.type === "toolCall" ? "toolcall_delta" : "text_delta",
                    contentIndex: 0,
                    delta: block?.type === "toolCall" ? JSON.stringify(block.arguments) : (block?.text ?? ""),
                    partial: message,
                });
                if (["error", "aborted"].includes(message.stopReason)) {
                    events.push({ type: "error", reason: message.stopReason, error: message });
                } else {
                    events.push({ type: "done", reason: message.stopReason, message });
                }
            } catch (error) {
                message.stopReason = options.signal?.aborted ? "aborted" : "error";
                message.errorMessage = error instanceof Error ? error.message : "fixture failed";
                events.push({ type: "error", reason: message.stopReason, error: message });
            }
        })();

        return events;
    };

    const provider = createProvider({
        id: "specpi-fixture",
        models: [model],
        baseUrl: "https://provider.invalid",
        headers: { "x-provider": "configured" },
        auth: settings.oauth
            ? {
                  oauth: {
                      name: "Synthetic OAuth",
                      async login() {
                          throw new Error("No interactive fixture login");
                      },
                      async refresh(credential: any, signal: AbortSignal) {
                          assert.equal(credential.refresh, "synthetic-refresh");
                          assert.equal(signal.aborted, false);
                          refreshes += 1;

                          return { ...credential, access: "synthetic-fresh", expires: Date.now() + 3600000 };
                      },
                      async toAuth(credential: any) {
                          return {
                              apiKey: credential.access,
                              baseUrl: "https://oauth-fixture.invalid/adapted",
                              headers: { "x-oauth-adapter": "retained" },
                          };
                      },
                  },
              }
            : {
                  apiKey: {
                      name: "Synthetic keyless fixture",
                      resolve: async () => ({
                          auth: {
                              baseUrl: "https://configured.invalid/route",
                              headers: { "x-fixture-auth": "synthetic" },
                          },
                      }),
                  },
              },
        api: {
            stream: (m, c, o) => stream(m, c, o, "stream"),
            streamSimple: (m, c, o) => stream(m, c, o, "streamSimple"),
        },
    });
    const createRuntime = async () => {
        const runtime = await sdk.ModelRuntime.create({
            credentials,
            modelsPath: null,
            modelsStore: new InMemoryModelsStore(),
            allowModelNetwork: false,
            refreshOnCreate: false,
        });
        runtime.registerNativeProvider(provider);

        return runtime;
    };

    const parentRuntime = await createRuntime();
    const services = await sdk.createAgentSessionServices({
        cwd,
        agentDir,
        modelRuntime: parentRuntime,
        settingsManager: sdk.SettingsManager.inMemory({ images: { blockImages: true } }, { projectTrusted: false }),
        resourceLoaderOptions: {
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionFactories: [
                (pi) => {
                    pi.on("context", (event) => {
                        hookCalls.context += 1;

                        return {
                            messages: [
                                ...event.messages,
                                { role: "user", content: "PARENT_CONTEXT_CANARY", timestamp: 1 },
                            ],
                        };
                    });
                    pi.on("before_provider_headers", (event) => {
                        hookCalls.headers += 1;
                        event.headers["x-parent-policy"] = "parent-only";
                    });
                    pi.on("before_provider_request", (event) => {
                        hookCalls.payload += 1;

                        return { ...event.payload, marker: "parent-payload" };
                    });
                    pi.on("after_provider_response", () => {
                        hookCalls.response += 1;
                    });
                },
            ],
        },
    });
    const { session: parent } = await sdk.createAgentSessionFromServices({
        services,
        model: parentRuntime.getModel(model.provider, model.id),
        thinkingLevel: "low",
        sessionManager: sdk.SessionManager.inMemory(cwd),
    });
    const parentCtx = parent.extensionRunner!.createContext();
    let current = true;
    const injectedSdk = {
        ...sdk,
        clampThinkingLevel,
        SettingsManager: {
            ...sdk.SettingsManager,
            create: (_cwd: any, _dir: any, options: any) => {
                assert.deepEqual(options, { projectTrusted: false });

                return sdk.SettingsManager.inMemory({
                    transport: "sse",
                    thinkingBudgets: { low: 19 },
                    ...settings.settings,
                });
            },
            inMemory: sdk.SettingsManager.inMemory,
        },
        ModelRuntime: {
            create: async (options: any) => {
                assert.deepEqual(options, { allowModelNetwork: false, refreshOnCreate: false });
                childRuntimes += 1;

                return createRuntime();
            },
        },
        createAgentSession: async (options: any) => {
            assert.deepEqual(options.resourceLoader.getAgentsFiles(), { agentsFiles: [] });
            assert.equal(options.resourceLoader.getExtensions().extensions.length, 0);
            assert.equal(options.sessionManager.getSessionFile(), undefined);
            const result = await sdk.createAgentSession(options);
            sessions.push(result.session);
            if (settings.delaySetup) {
                const original = result.session.agent.streamFunction;
                result.session.agent.streamFunction = async (...args: any[]) => {
                    const stream = await original(...args);
                    await settings.delaySetup;

                    return stream;
                };
            }

            return result;
        },
    };
    // This fixture deliberately supplies a synthetic configured-provider service seam.
    // Stock models.json/native startup is exercised in delegation-native.test.mjs.
    const ctx: any = {
        cwd,
        model: parentCtx.model,
        modelRegistry: {
            getRegisteredProviderIds: () => [],
            getProviderAuthStatus: () => ({ source: settings.oauth ? "stored" : "environment" }),
        },
    };
    for (const name of [
        "runtime",
        "getProviderAuth",
        "getApiKeyAndHeaders",
        "complete",
        "getRegisteredProviderConfig",
    ]) {
        Object.defineProperty(ctx.modelRegistry, name, {
            get() {
                throw new Error("Forbidden credential or private-runtime access");
            },
        });
    }

    const host = createNativePiHost(ctx, {
        id: label,
        isCurrent: () => current,
        sdk: injectedSdk,
        thinkingLevel: "low",
    });
    const wrongHost = createNativePiHost(parentCtx, {
        id: label + "-registered",
        isCurrent: () => true,
        sdk: injectedSdk,
        thinkingLevel: "low",
    });
    await assert.rejects(async () => wrongHost.ready(), /runtime provider override/u);

    return {
        host,
        parent,
        ctx,
        observed,
        sessions,
        hookCalls,
        refreshes: () => refreshes,
        runtimes: () => childRuntimes,
        revoke: () => {
            current = false;
        },
        close: () => {
            parent.dispose();
        },
    };
}

function controls(overrides: any = {}) {
    const controller = new AbortController();
    let calls = 0;
    const usages: any[] = [];

    return {
        controller,
        calls: () => calls,
        usages,
        value: {
            signal: controller.signal,
            deadline: Date.now() + 5000,
            assertLive: () => {},
            abort: () => controller.abort(),
            admitCall: () => {
                if (calls >= 4) {
                    throw new Error("Call allowance exhausted");
                }

                calls += 1;
            },
            onUsage: (value: any) => usages.push(value),
            limits: { ...LIMITS, outputTokens: 8192 },
            ...overrides,
        },
    };
}

async function pipelineProof(root: string) {
    const state = await fixture(root, "pipeline", (_request: any, call: number) => (call === 2 ? readCall() : final()));
    try {
        await state.parent.prompt("PARENT_TRANSCRIPT_CANARY");
        assert.deepEqual(state.hookCalls, { context: 1, headers: 1, payload: 1, response: 1 });
        const toolCalls: any[] = [];
        const handle = await state.host.openSession({
            systemPrompt: "Only child packet",
            tools: [
                {
                    name: "read_source",
                    label: "read_source",
                    description: "Read snapshot",
                    parameters: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            sourceId: { type: "string" },
                            startLine: { type: "integer" },
                            maxLines: { type: "integer" },
                        },
                        required: ["sourceId", "startLine", "maxLines"],
                    },
                    execute: async (_id: string, args: any) => {
                        toolCalls.push(args);

                        return { content: [{ type: "text", text: "SNAPSHOT_TOOL_EVIDENCE" }], details: {} };
                    },
                },
            ],
        });
        const first = controls();
        const result = await handle.run("child packet", first.value);
        assert.equal(state.sessions.length, 1);
        assert.equal(state.runtimes(), 1);
        assert.equal(state.sessions[0].autoCompactionEnabled, false);
        assert.equal(state.sessions[0].autoRetryEnabled, false);
        assert.equal(first.calls(), 2);
        assert.equal(first.usages.length, 2);
        assert.deepEqual(first.usages[0], usage);
        assert.equal(toolCalls.length, 1);
        assert.equal(result.content[0].textSignature, "synthetic-signature");
        assert.equal(result.providerMetadata.replay, "synthetic-opaque-metadata");
        assert.equal(state.observed[2].context.messages[1].providerMetadata.replay, "synthetic-opaque-metadata");
        assert.equal(state.observed[2].context.messages[2].content[0].text, "SNAPSHOT_TOOL_EVIDENCE");
        for (const request of state.observed.slice(1)) {
            assert.equal(request.route, "streamSimple");
            assert.equal(request.options.reasoning, "low");
            assert.equal(request.options.thinkingBudgets.low, 19);
            assert.equal(request.options.transport, "sse");
            assert.equal(request.options.maxRetries, 0);
            assert.equal(request.options.maxTokens, 4096);
            assert.equal(request.options.headers["x-fixture-auth"], "synthetic");
            assert.equal(request.options.headers["x-parent-policy"], undefined);
            assert.equal(request.requestModel.baseUrl, "https://configured.invalid/route");
            assert.equal(request.payload.marker, "original");
            assert.notEqual(request.options.sessionId, state.parent.agent.sessionId);
            assert.doesNotMatch(JSON.stringify(request.context), /PARENT_|AMBIENT_/u);
        }

        assert.deepEqual(state.hookCalls, { context: 1, headers: 1, payload: 1, response: 1 });
        first.controller.abort(); // The completed run's signal must already be detached.
        const followUp = controls();
        await handle.run("Changed-input follow-up", followUp.value);
        assert.equal(state.sessions.length, 1);
        assert.match(JSON.stringify(state.observed[3].context), /child packet.*Changed-input follow-up/u);
        assert.equal(state.observed[3].options.sessionId, state.observed[1].options.sessionId);
        state.ctx.model = { ...state.ctx.model };
        await assert.rejects(handle.run("stale", controls().value), /lease/u);
        handle.release();
        handle.release();
    } finally {
        state.close();
    }
}

async function boundsProof(root: string) {
    for (const kind of [
        "unknown-tool",
        "bad-args",
        "oversize",
        "tool-throw",
        "admission",
        "context",
        "provider-error",
    ]) {
        let executions = 0;
        const state = await fixture(root, kind, () => {
            if (kind === "unknown-tool") {
                return readCall("bash");
            }

            if (kind === "bad-args") {
                return readCall("read_source", { sourceId: 7 });
            }

            if (kind === "tool-throw") {
                return readCall();
            }

            if (kind === "oversize") {
                return { content: [{ type: "text", text: "x".repeat(256 * 1024) }], stopReason: "stop" };
            }

            if (kind === "provider-error") {
                return { content: [], stopReason: "error", errorMessage: "429 overloaded" };
            }

            return final();
        });
        const run = controls(
            kind === "admission"
                ? {
                      admitCall: () => {
                          throw new Error("No calls left");
                      },
                  }
                : {},
        );
        const handle = await state.host.openSession({
            systemPrompt: "child",
            tools: [
                {
                    name: "read_source",
                    label: "read_source",
                    description: "Read",
                    parameters: {
                        type: "object",
                        properties: {
                            sourceId: { type: "string" },
                            startLine: { type: "integer" },
                            maxLines: { type: "integer" },
                        },
                        required: ["sourceId", "startLine", "maxLines"],
                    },
                    execute: async () => {
                        executions += 1;
                        throw new Error("Denied fixture tool");
                    },
                },
            ],
        });
        try {
            await assert.rejects(handle.run(kind === "context" ? "x".repeat(256 * 1024) : "child", run.value));
            assert.equal(state.observed.length, ["admission", "context"].includes(kind) ? 0 : 1, kind);
            assert.equal(executions, kind === "tool-throw" ? 1 : 0, kind);
        } finally {
            handle.release();
            state.close();
        }
    }
}

async function settlementProof(root: string) {
    for (const kind of ["abort", "revoke", "release", "deadline"]) {
        let finish: any;
        const gate = new Promise((resolve) => {
            finish = resolve;
        });
        const state = await fixture(root, "settlement-" + kind, async () => {
            await gate;

            return final();
        });
        const handle = await state.host.openSession({ systemPrompt: "child", tools: [] });
        const run = controls(kind === "deadline" ? { deadline: Date.now() + 50 } : {});
        let settled = false;
        const pending = handle.run("child", run.value).finally(() => {
            settled = true;
        });
        const rejection = assert.rejects(pending);
        while (!state.observed.length) {
            await sleep(1);
        }

        if (kind === "abort") {
            run.controller.abort();
        }

        if (kind === "revoke") {
            state.revoke();
        }

        if (kind === "release") {
            handle.release();
        }

        await sleep(70);
        assert.equal(settled, false, kind);
        finish();
        await rejection;
        assert.equal(run.usages.length, 1);
        handle.release();
        state.close();
    }

    let finishSetup: any;
    let finishRequest: any;
    const setup = new Promise((resolve) => {
        finishSetup = resolve;
    });
    const request = new Promise((resolve) => {
        finishRequest = resolve;
    });
    const state = await fixture(
        root,
        "late-stream-setup",
        async () => {
            await request;

            return final();
        },
        { delaySetup: setup },
    );
    const handle = await state.host.openSession({ systemPrompt: "child", tools: [] });
    const run = controls();
    let settled = false;
    const pending = handle.run("child", run.value).finally(() => {
        settled = true;
    });
    const rejection = assert.rejects(pending);
    while (!state.observed.length) {
        await sleep(1);
    }

    run.controller.abort();
    await sleep(10);
    assert.equal(settled, false, "A live stream has not yet been returned to the bridge");
    finishSetup();
    await sleep(10);
    assert.equal(settled, false, "Late stream setup must not release the original request");
    finishRequest();
    await rejection;
    assert.equal(run.usages.length, 1);
    handle.release();
    state.close();
}

async function oauthProof(root: string) {
    const state = await fixture(root, "oauth", final, { oauth: true });
    try {
        assert.equal(state.refreshes(), 0);
        const handle = await state.host.openSession({ systemPrompt: "child", tools: [] });
        await handle.run("child", controls().value);
        assert.equal(state.refreshes(), 1);
        assert.equal(state.observed[0].options.apiKey, "synthetic-fresh");
        assert.equal(state.observed[0].options.headers["x-oauth-adapter"], "retained");
        assert.equal(state.observed[0].requestModel.baseUrl, "https://oauth-fixture.invalid/adapted");
        handle.release();
    } finally {
        state.close();
    }
}

async function workerProof(root: string) {
    const state = await fixture(root, "worker", (_request: any, call: number) => (call === 1 ? readCall() : final()));
    const packet = {
        objective: "Review selected evidence",
        requirements: [
            { id: "r1", text: "Review evidence" },
            { id: "r2", text: "Other parent concern" },
        ],
        decisions: [],
        nonGoals: [],
    };
    const job: any = {
        spec: {
            id: "j1",
            mode: "review",
            requirements: ["r1"],
            question: "Is the evidence sufficient?",
            context: "Inline evidence",
            sources: ["source.txt"],
        },
        deadline: Date.now() + 5000,
        toolCalls: 0,
        toolBytes: 0,
    };
    const snapshot = {
        sources: [{ id: "s1", path: "source.txt", lineCount: 1 }],
        assertFresh() {},
        assertBindings() {},
        read: () => "Selected evidence",
        search: () => [],
    };
    const run = controls();
    try {
        const result = await runWorker({ packet, job, host: state.host, snapshot, ...run.value });
        assert.equal(result.status, "complete");
        assert.equal(job.toolCalls, 1);
        assert.equal(state.sessions.length, 1);
        assert.doesNotMatch(JSON.stringify(state.observed[0].context), /Other parent concern/u);
        job.release();
        job.followUpPrompt = "Changed input after released failure";
        const next = controls();
        await runWorker({ packet, job, host: state.host, snapshot, ...next.value });
        const prompt = JSON.stringify(state.observed.at(-1).context);
        assert.match(prompt, /Is the evidence sufficient/u);
        assert.match(prompt, /Changed input after released failure/u);
        job.release();
    } finally {
        state.close();
    }
}

export default async function () {
    assert.match(sdk.VERSION, /^\d+\.\d+\.\d+/u);
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-delegation-fixture-")));
    try {
        await pipelineProof(root);
        await boundsProof(root);
        await settlementProof(root);
        await oauthProof(root);
        await workerProof(root);
        console.log(
            `DELEGATION_FIXTURE=${JSON.stringify({ sdkVersion: sdk.VERSION, realSessions: true, streaming: true, toolReplay: true, thinking: true, oauth: true, noAmbientResources: true, parentHooksExcluded: true, settlement: true })}`,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}
