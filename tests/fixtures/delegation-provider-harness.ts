import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import {
    createProvider,
    createAssistantMessageEventStream,
    InMemoryCredentialStore,
    InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { createNativePiHost } from "../../extensions/delegation/provider.mjs";

const usage = {
    input: 7,
    output: 3,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 13,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fixtureProvider(observe: (value: any) => void) {
    const model = {
        id: "fixture-model",
        provider: "specpi-fixture",
        api: "specpi-fixture-api",
        name: "Synthetic fixture",
        baseUrl: "https://model.invalid",
        reasoning: true,
        input: ["text", "image"],
        cost: usage.cost,
        contextWindow: 32_768,
        maxTokens: 4096,
    } as any;
    const stream = (requestModel: any, context: any, options: any, route: string) => {
        const events = createAssistantMessageEventStream();
        const message: any = {
            role: "assistant",
            content: [{ type: "text", text: "fixture complete", textSignature: "synthetic-signature" }],
            api: requestModel.api,
            provider: requestModel.provider,
            model: requestModel.id,
            usage,
            stopReason: "stop",
            timestamp: Date.now(),
            providerMetadata: { replay: "synthetic-opaque-metadata" },
        };
        void (async () => {
            try {
                let payload: any = { messages: context.messages, marker: "original" };
                payload = (await options.onPayload?.(payload, requestModel)) ?? payload;
                observe({ requestModel, context, options, payload, route });
                await options.onResponse?.({ status: 200, headers: { "x-fixture-response": "yes" } }, requestModel);
                events.push({ type: "start", partial: message });
                events.push({ type: "done", reason: "stop", message });
            } catch (error) {
                message.stopReason = options.signal?.aborted ? "aborted" : "error";
                message.errorMessage = error instanceof Error ? error.message : "fixture failure";
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
        auth: {
            apiKey: {
                name: "Synthetic keyless fixture",
                resolve: async () => ({
                    auth: { baseUrl: "https://configured.invalid/route", headers: { "x-fixture-auth": "synthetic" } },
                }),
            },
        },
        api: {
            stream: (requestModel, context, options) => stream(requestModel, context, options, "stream"),
            streamSimple: (requestModel, context, options) => stream(requestModel, context, options, "streamSimple"),
        },
    });

    return { provider, model };
}

async function consume(host: any, context: any) {
    const stream = await host.stream(context, {
        signal: new AbortController().signal,
        sessionId: "child-fixture",
        maxTokens: 128,
        timeoutMs: 5000,
    });
    const events = [];
    for await (const event of stream) {
        events.push(event);
    }

    return { events, result: await stream.result() };
}

async function createFixtureSession(
    root: string,
    label: string,
    provider: any,
    configure: any = () => {},
    credentials = new InMemoryCredentialStore(),
) {
    const cwd = path.join(root, label);
    const agentDir = path.join(root, label + "-agent");
    fs.mkdirSync(cwd);
    fs.mkdirSync(agentDir);
    const modelRuntime = await sdk.ModelRuntime.create({
        credentials,
        modelsPath: null,
        modelsStore: new InMemoryModelsStore(),
        allowModelNetwork: false,
    });
    const services = await sdk.createAgentSessionServices({
        cwd,
        agentDir,
        modelRuntime,
        settingsManager: sdk.SettingsManager.inMemory(
            { images: { blockImages: true }, transport: "sse", thinkingBudgets: { low: 19 } },
            { projectTrusted: false },
        ),
        resourceLoaderOptions: {
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionFactories: [
                (pi) => {
                    if (provider.config) {
                        pi.registerProvider(provider.name, provider.config);
                    } else {
                        pi.registerProvider(provider);
                    }

                    configure(pi);
                },
            ],
        },
    });
    await modelRuntime.getAvailable(undefined, { signal: AbortSignal.timeout(5000) });
    const { session } = await sdk.createAgentSessionFromServices({
        services,
        sessionManager: sdk.SessionManager.inMemory(cwd),
        model: modelRuntime.getModel("specpi-fixture", "fixture-model"),
        thinkingLevel: "low",
    });

    return session;
}

async function providerProof(root: string) {
    const observed: any[] = [];
    const hookCalls = { context: 0, headers: 0, payload: 0, response: 0 };
    const fixture = fixtureProvider((value) => observed.push(value));
    const session = await createFixtureSession(root, "provider", fixture.provider, (pi: any) => {
        pi.on("context", (event: any) => {
            hookCalls.context += 1;

            return { messages: [...event.messages, { role: "user", content: "configured context", timestamp: 1 }] };
        });
        pi.on("before_provider_headers", (event: any) => {
            hookCalls.headers += 1;
            event.headers["x-parent-policy"] = "parent-only";
        });
        pi.on("before_provider_request", (event: any) => {
            hookCalls.payload += 1;

            return { ...event.payload, marker: "configured payload" };
        });
        pi.on("after_provider_response", () => {
            hookCalls.response += 1;
        });
    });
    try {
        // A real parent turn proves these policy handlers are active, not merely registered.
        await session.prompt("PARENT_TRANSCRIPT_MUST_NOT_LEAK");
        assert.deepEqual(hookCalls, { context: 1, headers: 1, payload: 1, response: 1 });
        assert.equal(observed[0].route, "streamSimple");
        assert.equal(observed[0].options.headers["x-parent-policy"], "parent-only");
        const ctx = session.extensionRunner!.createContext();
        const host = createNativePiHost(ctx, { id: "owner-fixture", isCurrent: () => true });
        const context = {
            systemPrompt: "child packet",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "child input" },
                        { type: "image", data: "AA==", mimeType: "image/png" },
                    ],
                    timestamp: 1,
                },
            ],
            tools: [
                { name: "snapshot_read", description: "fixture tool", parameters: { type: "object", properties: {} } },
            ],
        };
        const completion = await consume(host, context);
        assert.equal(completion.events.length, 1);
        assert.equal(completion.events[0].type, "done");
        assert.deepEqual(completion.result.usage, usage);
        assert.deepEqual(hookCalls, { context: 1, headers: 1, payload: 1, response: 1 });
        assert.equal(observed.length, 2);
        const request = observed[1];
        assert.equal(request.route, "stream");
        assert.equal(request.requestModel.baseUrl, "https://configured.invalid/route");
        assert.equal(request.requestModel.id, ctx.model!.id);
        assert.equal(request.requestModel.provider, ctx.model!.provider);
        assert.equal(request.options.headers["x-fixture-auth"], "synthetic");
        assert.equal(request.options.headers["x-parent-policy"], undefined);
        assert.equal(request.options.sessionId, "child-fixture");
        assert.notEqual(request.options.sessionId, session.agent.sessionId);
        for (const key of [
            "reasoning",
            "thinkingBudgets",
            "transport",
            "onPayload",
            "onResponse",
            "transformHeaders",
        ]) {
            assert.equal(request.options[key], undefined, key);
        }

        assert.equal(request.options.maxRetries, 0);
        assert.equal(request.options.maxTokens, 128);
        assert.equal(request.payload.marker, "original");
        assert.deepEqual(request.context, context);
        assert.doesNotMatch(JSON.stringify(request.context), /PARENT_|configured context/u);
        assert.equal(completion.result.content[0].textSignature, "synthetic-signature");
        assert.equal(completion.result.providerMetadata.replay, "synthetic-opaque-metadata");

        await consume(host, { ...context, messages: [completion.result] });
        assert.deepEqual(observed[2].context.messages[0], completion.result);
        assert.deepEqual(Object.keys(host).sort(), ["id", "isCurrent", "model", "stream"]);
        const originalModel = session.agent.state.model;
        session.agent.state.model = { ...originalModel };
        assert.equal(host.isCurrent(), false);
        await assert.rejects(consume(host, context), /lease/u);
    } finally {
        await session.abort();
        session.dispose();
    }
}

async function oauthProof(root: string) {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("specpi-fixture", async () => ({
        type: "oauth",
        access: "synthetic-expired",
        refresh: "synthetic-refresh",
        expires: 1,
    }));
    let refreshes = 0;
    const observed: any[] = [];
    const fixture = fixtureProvider((value) => observed.push(value));
    const provider = {
        ...fixture.provider,
        auth: {
            oauth: {
                name: "Synthetic OAuth adapter",
                async login() {
                    throw new Error("Interactive login must not run");
                },
                async refresh(credential: any, signal: AbortSignal) {
                    assert.equal(credential.refresh, "synthetic-refresh");
                    assert.equal(signal.aborted, false);
                    refreshes += 1;

                    return { ...credential, access: "synthetic-fresh", expires: Date.now() + 3_600_000 };
                },
                async toAuth(credential: any) {
                    return {
                        apiKey: credential.access,
                        baseUrl: "https://oauth-fixture.invalid/adapted",
                        headers: { "x-oauth-adapter": "retained" },
                    };
                },
            },
        },
    };
    const session = await createFixtureSession(root, "oauth", provider, undefined, credentials);
    try {
        assert.equal(refreshes, 0, "The child registry call must exercise the synthetic OAuth refresh");
        const host = createNativePiHost(session.extensionRunner!.createContext(), {
            id: "oauth-owner",
            isCurrent: () => true,
        });
        const completion = await consume(host, { systemPrompt: "child", messages: [], tools: [] });
        assert.equal(completion.result.stopReason, "stop");
        assert.equal(refreshes, 1);
        assert.equal(observed[0].requestModel.baseUrl, "https://oauth-fixture.invalid/adapted");
        assert.equal(observed[0].options.apiKey, "synthetic-fresh");
        assert.equal(observed[0].options.headers["x-oauth-adapter"], "retained");
        assert.deepEqual(Object.keys(host).sort(), ["id", "isCurrent", "model", "stream"]);
    } finally {
        session.dispose();
    }
}

async function configuredHeadersProof(root: string) {
    const observed: any[] = [];
    const fixture = fixtureProvider((value) => observed.push(value));
    const session = await createFixtureSession(root, "configured-headers", {
        name: "specpi-fixture",
        config: {
            api: "specpi-fixture-api",
            apiKey: "synthetic-fixture-key",
            baseUrl: "https://configured-provider.invalid",
            headers: { "x-configured-provider": "retained" },
            models: [fixture.model],
            streamSimple: (model: any, context: any, options: any) => fixture.provider.stream(model, context, options),
        },
    });
    try {
        const host = createNativePiHost(session.extensionRunner!.createContext(), {
            id: "headers-owner",
            isCurrent: () => true,
        });
        await consume(host, { systemPrompt: "child", messages: [], tools: [] });
        assert.equal(observed.length, 1);
        assert.equal(observed[0].options.headers["x-configured-provider"], "retained");
        assert.equal(observed[0].options.apiKey, "synthetic-fixture-key");
    } finally {
        session.dispose();
    }
}

export default async function () {
    assert.equal(sdk.VERSION, "0.84.4", "Run this fixture against the pinned isolated SDK");
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-delegation-fixture-")));
    try {
        await providerProof(root);
        await oauthProof(root);
        await configuredHeadersProof(root);
        console.log(
            `DELEGATION_FIXTURE=${JSON.stringify({
                sdkVersion: sdk.VERSION,
                nativeRegistry: true,
                oauth: true,
                parentHooksExcluded: true,
            })}`,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}
