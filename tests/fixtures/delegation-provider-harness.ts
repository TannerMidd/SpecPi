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
import { createPiHost } from "../../extensions/delegation/provider.mjs";
import { createLauncherRuntimeFactory } from "../../scripts/agent.mjs";
import { createDelegationExtension } from "../../extensions/delegation/extension.mjs";

const usage = {
    input: 7,
    output: 3,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 13,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fixtureProvider(
    observe: (value: any) => void,
    behavior: () => string = () => "normal",
    answer = () => "fixture complete",
    waitForRelease = async () => {},
) {
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
    const stream = (requestModel: any, context: any, options: any) => {
        const events = createAssistantMessageEventStream();
        const message: any = {
            role: "assistant",
            content: [{ type: "text", text: answer() }],
            api: requestModel.api,
            provider: requestModel.provider,
            model: requestModel.id,
            usage,
            stopReason: "stop",
            timestamp: Date.now(),
        };
        void (async () => {
            try {
                let payload: any = { messages: context.messages, marker: "original" };
                payload = (await options.onPayload?.(payload, requestModel)) ?? payload;
                observe({ requestModel, context, options, payload });
                await options.onResponse?.({ status: 200, headers: { "x-fixture-response": "yes" } }, requestModel);
                if (behavior() === "wait") {
                    await new Promise<void>((resolve) => {
                        if (options.signal.aborted) {
                            resolve();
                        } else {
                            options.signal.addEventListener("abort", () => resolve(), { once: true });
                        }
                    });
                    throw new Error("aborted fixture");
                }

                if (behavior() === "noncooperative") {
                    await waitForRelease();
                }

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
        api: { stream, streamSimple: stream },
    });

    return { provider, model };
}

async function consume(host: any, context: any, overrides: any = {}) {
    const stream = await host.stream(context, {
        signal: new AbortController().signal,
        sessionId: "child-fixture",
        maxTokens: 128,
        timeoutMs: 5000,
        ...overrides,
    });
    const types = [];
    for await (const event of stream) {
        types.push(event.type);
    }

    return { types, result: await stream.result() };
}

async function providerProof(root: string) {
    const cwd = path.join(root, "provider-project");
    const agentDir = path.join(root, "provider-agent");
    fs.mkdirSync(cwd);
    fs.mkdirSync(agentDir);
    const observed: any[] = [];
    let behavior = "normal";
    let oversizedContext = false;
    let oversizedPayload = false;
    let responses = 0;
    let releaseProvider: () => void;
    const providerSettlement = new Promise<void>((resolve) => {
        releaseProvider = resolve;
    });
    const fixture = fixtureProvider(
        (value) => observed.push(value),
        () => behavior,
        () => "fixture complete",
        () => providerSettlement,
    );
    const services = await sdk.createAgentSessionServices({
        cwd,
        agentDir,
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
                    pi.registerProvider(fixture.provider);
                    pi.on("context", (event) => ({
                        messages: [
                            ...event.messages,
                            {
                                role: "user",
                                content: oversizedContext ? "x".repeat(270_000) : "configured context",
                                timestamp: 1,
                            },
                        ],
                    }));
                    pi.on("before_provider_headers", (event) => {
                        event.headers["x-policy"] = "retained";
                    });
                    pi.on("before_provider_request", (event) => ({
                        ...(event.payload as any),
                        marker: oversizedPayload ? "x".repeat(270_000) : "configured payload",
                    }));
                    pi.on("after_provider_response", (event) => {
                        assert.equal(event.status, 200);
                        responses += 1;
                    });
                },
            ],
        },
    });
    const { session } = await sdk.createAgentSessionFromServices({
        services,
        sessionManager: sdk.SessionManager.inMemory(cwd),
        model: services.modelRuntime.getModel("specpi-fixture", "fixture-model"),
        thinkingLevel: "low",
    });
    let current = true;
    session.agent.state.messages = [{ role: "user", content: "PARENT_TRANSCRIPT_MUST_NOT_LEAK", timestamp: 1 }];
    session.agent.state.systemPrompt = "PARENT_SYSTEM_MUST_NOT_LEAK";
    session.agent.prepareNextTurnWithContext = async () => {
        throw new Error("parent compaction must not run");
    };

    const host = createPiHost(session, { id: "owner-fixture", isCurrent: () => current });
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
        tools: [{ name: "snapshot_read", description: "fixture tool", parameters: { type: "object", properties: {} } }],
    };
    try {
        const completion = await consume(host, context);
        assert.deepEqual(completion.types, ["start", "done"]);
        assert.deepEqual(completion.result.usage, usage);
        assert.equal(observed.length, 1);
        assert.equal(responses, 1);
        const request = observed[0];
        assert.equal(request.requestModel.baseUrl, "https://configured.invalid/route");
        assert.equal(request.requestModel.id, "fixture-model");
        assert.equal(request.options.headers["x-policy"], "retained");
        assert.equal(request.options.headers["x-fixture-auth"], "synthetic");
        assert.equal(request.options.sessionId, "child-fixture");
        assert.notEqual(request.options.sessionId, session.agent.sessionId);
        assert.equal(request.options.reasoning, "low");
        assert.equal(request.options.transport, "sse");
        assert.equal(request.options.maxRetries, 0);
        assert.equal(request.options.maxTokens, 128);
        assert.equal(request.payload.marker, "configured payload");
        assert.match(JSON.stringify(request.context.messages), /configured context/u);
        assert.doesNotMatch(JSON.stringify(request.context), /PARENT_|"type":"image"/u);
        assert.deepEqual(
            request.context.tools.map((tool: any) => tool.name),
            ["snapshot_read"],
        );
        assert.equal(context.messages.length, 1);

        oversizedContext = true;
        await assert.rejects(consume(host, context), /256 KiB/u);
        assert.equal(observed.length, 1);
        oversizedContext = false;
        oversizedPayload = true;
        const oversized = await consume(host, context);
        assert.equal(oversized.result.stopReason, "error");
        assert.match(oversized.result.errorMessage, /256 KiB/u);
        assert.equal(observed.length, 1);
        oversizedPayload = false;

        const originalModel = session.agent.state.model;
        session.agent.state.model = { ...originalModel };
        assert.equal(host.isCurrent(), false);
        await assert.rejects(consume(host, context), /lease/u);
        session.agent.state.model = originalModel;
        session.agent.state.thinkingLevel = "high";
        await assert.rejects(consume(host, context), /lease/u);
        session.agent.state.thinkingLevel = "low";
        current = false;
        await assert.rejects(consume(host, context), /lease/u);
        current = true;
        const alreadyAborted = new AbortController();
        alreadyAborted.abort();
        await assert.rejects(consume(host, context, { signal: alreadyAborted.signal }), /cancelled/u);

        behavior = "wait";
        const abort = new AbortController();
        const pending = consume(host, context, { signal: abort.signal });
        const timer = setTimeout(() => abort.abort(), 20);
        await assert.rejects(pending, /cancelled/u);
        clearTimeout(timer);
        assert.equal(observed.length, 2);
        behavior = "noncooperative";
        const originalStream = session.agent.streamFunction;
        let releaseStream: () => void;
        const lateStream = new Promise<void>((resolve) => {
            releaseStream = resolve;
        });
        session.agent.streamFunction = async function (...args: any[]) {
            const stream = await (originalStream as any).apply(this, args);
            await lateStream;

            return stream;
        };

        const lateHost = createPiHost(session, { id: "late-owner", isCurrent: () => current });
        const lateAbort = new AbortController();
        let settled = false;
        const pendingLate = consume(lateHost, context, { signal: lateAbort.signal }).finally(() => {
            settled = true;
        });
        const expectedRejection = assert.rejects(pendingLate, /cancelled/u);
        const deadline = Date.now() + 1000;
        while (observed.length < 3) {
            assert.ok(Date.now() < deadline, "Provider dispatch did not start");
            await new Promise((resolve) => setTimeout(resolve, 1));
        }

        lateAbort.abort();
        releaseStream!();
        await new Promise((resolve) => setTimeout(resolve, 15));
        assert.equal(settled, false, "A late stream must keep its caller occupied until provider settlement");
        releaseProvider!();
        await expectedRejection;
    } finally {
        await session.abort();
        session.dispose();
    }
}

async function launcherProof(root: string) {
    const cwd = path.join(root, "launcher-project");
    const agentDir = path.join(root, "launcher-agent");
    fs.mkdirSync(path.join(cwd, ".pi", "extensions"), { recursive: true });
    fs.mkdirSync(path.join(cwd, ".pi", "skills", "fixture-project"), { recursive: true });
    fs.mkdirSync(path.join(cwd, ".pi", "prompts"), { recursive: true });
    fs.mkdirSync(path.join(agentDir, "extensions", "command-guard"), { recursive: true });
    fs.writeFileSync(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "specpi-fixture", defaultModel: "fixture-model" }),
    );
    fs.writeFileSync(
        path.join(cwd, ".pi", "extensions", "must-not-load.ts"),
        "throw new Error('PROJECT_EXTENSION_EXECUTED');\n",
    );
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "PROJECT_AGENTS_MUST_NOT_LOAD\n");
    fs.writeFileSync(path.join(cwd, ".pi", "SYSTEM.md"), "PROJECT_SYSTEM_MUST_NOT_LOAD\n");
    fs.writeFileSync(
        path.join(cwd, ".pi", "skills", "fixture-project", "SKILL.md"),
        "---\nname: fixture-project\ndescription: Isolated project fixture\n---\nFixture instructions\n",
    );
    fs.writeFileSync(path.join(cwd, ".pi", "prompts", "fixture-project.md"), "Project fixture prompt\n");
    fs.writeFileSync(
        path.join(cwd, ".pi", "settings.json"),
        JSON.stringify({ defaultProvider: "untrusted", packages: ["npm:must-not-install"] }),
    );
    fs.writeFileSync(
        path.join(agentDir, "extensions", "command-guard", "index.ts"),
        "throw new Error('DUPLICATE_GUARD_EXECUTED');\n",
    );
    fs.writeFileSync(
        path.join(agentDir, "extensions", "provider-policy.ts"),
        "export default function(pi) { pi.on('before_provider_headers', (event) => { event.headers['x-external-policy'] = 'preserved'; }); }\n",
    );
    const observed: any[] = [];
    const fixture = fixtureProvider((value) => observed.push(value));
    let host: any;
    let factoryCalls = 0;
    const delegationFactory = (pi: any) => {
        factoryCalls += 1;
        pi.registerProvider(fixture.provider);
    };

    const factory = createLauncherRuntimeFactory(sdk, {
        delegationFactory,
        onHost: (value: any) => {
            host = value;
        },
    });
    const result = await factory({ cwd, agentDir, sessionManager: sdk.SessionManager.inMemory(cwd) });
    try {
        assert.equal(result.services.settingsManager.isProjectTrusted(), false);
        assert.deepEqual(result.services.resourceLoader.getAgentsFiles().agentsFiles, []);
        assert.equal(
            result.services.resourceLoader.getSkills().skills.some((skill: any) => skill.name === "fixture-project"),
            false,
        );
        assert.equal(
            result.services.resourceLoader
                .getPrompts()
                .prompts.some((prompt: any) => prompt.name === "fixture-project"),
            false,
        );
        assert.notEqual(result.services.resourceLoader.getSystemPrompt(), "PROJECT_SYSTEM_MUST_NOT_LOAD\n");
        const guarded = result.extensionsResult.extensions.filter((extension: any) => extension.commands.has("guard"));
        assert.equal(guarded.length, 1);
        assert.ok(result.extensionsResult.extensions.some((extension: any) => extension.commands.has("scope")));
        const denied = await result.session.agent.beforeToolCall!({
            toolCall: { type: "toolCall", id: "fixture-deny", name: "bash", arguments: { command: "rm -rf /" } },
            args: { command: "rm -rf /" },
        } as any);
        assert.equal(denied?.block, true);
        const initial = await consume(host, {
            systemPrompt: "child",
            messages: [{ role: "user", content: "fixture", timestamp: 1 }],
            tools: [],
        });
        assert.equal(initial.result.stopReason, "stop", initial.result.errorMessage);
        assert.equal(observed[0].options.headers["x-external-policy"], "preserved");
        const previous = host;
        await result.session.reload();
        assert.equal(previous.isCurrent(), false);
        assert.equal(factoryCalls, 2);
        assert.deepEqual(result.services.resourceLoader.getAgentsFiles().agentsFiles, []);
        assert.equal(
            result.services.resourceLoader
                .getExtensions()
                .extensions.filter((extension: any) => extension.commands.has("guard")).length,
            1,
        );
        // The headless fixture has no UI binding; explicitly emit the public session start event.
        await result.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
        assert.ok(host?.isCurrent());
        assert.equal(previous.isCurrent(), false, "Old leases must never revive after reload");
        await consume(host, { systemPrompt: "child", messages: [], tools: [] });
        assert.equal(observed[1].options.headers["x-external-policy"], "preserved");
        const beforeThinkingChange = host;
        result.session.agent.state.thinkingLevel = "high";
        await result.session.extensionRunner.emit({
            type: "thinking_level_select",
            thinkingLevel: "high",
            previousThinkingLevel: "medium",
        } as any);
        assert.equal(beforeThinkingChange.isCurrent(), false);
        assert.equal(host.thinkingLevel, "high");
        assert.ok(host.isCurrent());
    } finally {
        await result.session.abort();
        result.session.dispose();
    }

    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }));
    fs.writeFileSync(
        path.join(cwd, ".pi", "extensions", "must-not-load.ts"),
        "export default function(pi) { pi.registerCommand('fixture-project-command', { description: 'Fixture', handler: async () => {} }); }\n",
    );
    const trustedFactory = createLauncherRuntimeFactory(sdk, { trustProject: true, delegationFactory });
    const trusted = await trustedFactory({ cwd, agentDir, sessionManager: sdk.SessionManager.inMemory(cwd) });
    try {
        assert.equal(trusted.services.settingsManager.isProjectTrusted(), true);
        assert.ok(
            trusted.extensionsResult.extensions.some((extension: any) =>
                extension.commands.has("fixture-project-command"),
            ),
        );
        assert.ok(
            trusted.services.resourceLoader
                .getAgentsFiles()
                .agentsFiles.some((entry: any) => entry.content.includes("PROJECT_AGENTS_MUST_NOT_LOAD")),
        );
        assert.ok(
            trusted.services.resourceLoader.getSkills().skills.some((skill: any) => skill.name === "fixture-project"),
        );
        assert.ok(
            trusted.services.resourceLoader
                .getPrompts()
                .prompts.some((prompt: any) => prompt.name === "fixture-project"),
        );
        const otherCwd = path.join(root, "other-project");
        fs.mkdirSync(otherCwd);
        const other = await trustedFactory({
            cwd: otherCwd,
            agentDir,
            sessionManager: sdk.SessionManager.inMemory(otherCwd),
        });
        assert.equal(
            other.services.settingsManager.isProjectTrusted(),
            false,
            "Trust does not follow a switch to a different project",
        );
        other.session.dispose();
    } finally {
        trusted.session.dispose();
    }

    fs.writeFileSync(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ packages: ["npm:specpi-delegation-missing-fixture@0.0.0"] }),
    );
    const offline = process.env.PI_OFFLINE;
    delete process.env.PI_OFFLINE;
    try {
        const missing = createLauncherRuntimeFactory(sdk, { delegationFactory });
        await assert.rejects(
            missing({ cwd, agentDir, sessionManager: sdk.SessionManager.inMemory(cwd) }),
            /Missing source/u,
        );
        assert.equal(
            fs.existsSync(path.join(agentDir, "npm", "node_modules", "specpi-delegation-missing-fixture")),
            false,
        );
    } finally {
        process.env.PI_OFFLINE = offline;
    }
}

async function oauthProof(root: string) {
    const cwd = path.join(root, "oauth-project");
    fs.mkdirSync(cwd);
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
    const modelRuntime = await sdk.ModelRuntime.create({
        credentials,
        modelsPath: null,
        modelsStore: new InMemoryModelsStore(),
        allowModelNetwork: false,
    });
    const services = await sdk.createAgentSessionServices({
        cwd,
        agentDir: root,
        modelRuntime,
        settingsManager: sdk.SettingsManager.inMemory({}, { projectTrusted: false }),
        resourceLoaderOptions: {
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionFactories: [(pi) => pi.registerProvider(provider)],
        },
    });
    const { session } = await sdk.createAgentSessionFromServices({
        services,
        sessionManager: sdk.SessionManager.inMemory(cwd),
        model: modelRuntime.getModel("specpi-fixture", "fixture-model"),
    });
    try {
        const host = createPiHost(session, { id: "oauth-owner", isCurrent: () => true });
        const completion = await consume(host, { systemPrompt: "child", messages: [], tools: [] });
        assert.equal(completion.result.stopReason, "stop");
        assert.equal(refreshes, 1);
        assert.equal(observed[0].requestModel.baseUrl, "https://oauth-fixture.invalid/adapted");
        assert.equal(observed[0].options.apiKey, "synthetic-fresh");
        assert.equal(observed[0].options.headers["x-oauth-adapter"], "retained");
        assert.deepEqual(Object.keys(host).sort(), ["id", "isCurrent", "model", "stream", "thinkingLevel"]);
    } finally {
        session.dispose();
    }
}

async function delegationProof(root: string) {
    const cwd = path.join(root, "delegation-project");
    const agentDir = path.join(root, "delegation-agent");
    fs.mkdirSync(cwd);
    fs.mkdirSync(agentDir);
    fs.writeFileSync(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "specpi-fixture", defaultModel: "fixture-model" }),
    );
    const report = {
        status: "complete",
        answer: "Synthetic analysis complete",
        requirements: [{ id: "r1", status: "addressed", evidence: [] }],
        findings: [],
        missing: [],
        nextStep: "Parent checks the result",
    };
    const observed: any[] = [];
    const fixture = fixtureProvider(
        (value) => observed.push(value),
        () => "normal",
        () => JSON.stringify(report),
    );
    let host: any;
    const delegation = createDelegationExtension(() => host, { root: cwd });
    const factory = createLauncherRuntimeFactory(sdk, {
        delegationFactory(pi: any) {
            pi.registerProvider(fixture.provider);
            delegation(pi);
        },
        onHost(value: any) {
            host = value;
        },
    });
    const { session } = await factory({ cwd, agentDir, sessionManager: sdk.SessionManager.inMemory(cwd) });
    const errors: string[] = [];
    const notices: string[] = [];
    const ui = {
        ...session.extensionRunner.getUIContext(),
        async select(_title: string, choices: string[]) {
            return choices.includes("Allow once") ? "Allow once" : choices[0];
        },
        async confirm() {
            return true;
        },
        notify(message: string) {
            notices.push(message);
        },
    };
    try {
        await session.bindExtensions({
            mode: "tui",
            uiContext: ui,
            onError(error) {
                errors.push(error.error);
            },
        });
        const command = session.extensionRunner.getCommand("delegate");
        assert.ok(command);
        await command.handler("on", session.extensionRunner.createCommandContext());
        assert.ok(
            notices.some((notice) => notice.startsWith("Delegation enabled")),
            notices.join("\n"),
        );
        const tool = session.agent.state.tools.find((entry) => entry.name === "delegate");
        assert.ok(tool, "Real AgentSession exposes the registered delegate tool");
        let callNumber = 0;
        const execute = async (input: any) => {
            const id = `delegate-fixture-${++callNumber}`;
            const toolCall = { type: "toolCall", id, name: "delegate", arguments: input };
            const before = await session.agent.beforeToolCall!({ toolCall, args: input } as any);
            assert.notEqual(before?.block, true, before?.reason);
            const result: any = await tool.execute(id, input, new AbortController().signal);
            assert.notEqual(result.isError, true, JSON.stringify(result));
            await session.agent.afterToolCall!({ toolCall, args: input, result, isError: false } as any);

            return result.details;
        };

        const launched = await execute({
            operation: "run",
            requestId: "fixture-run",
            packet: {
                objective: "Assess a public fixture",
                requirements: [{ id: "r1", text: "Assess fixture" }],
                decisions: [],
                nonGoals: ["No file changes"],
                reason: {
                    deliverable: "Analysis",
                    consumer: "Parent",
                    independence: "Independent analysis",
                    parentWork: "Review integration",
                },
                jobs: [
                    {
                        id: "j1",
                        mode: "consult",
                        question: "Assess fixture",
                        context: "Public synthetic text",
                        sources: [],
                    },
                ],
            },
        });
        let collected;
        for (let attempt = 0; attempt < 10; attempt += 1) {
            collected = await execute({
                operation: "collect",
                batchId: launched.batchId,
                waitMs: 100,
                afterCursor: collected?.cursor ?? 0,
            });
            if (collected.results.length > 0) {
                break;
            }
        }

        assert.equal(collected.results[0]?.receipt.state, "complete", JSON.stringify(collected));
        assert.equal(collected.results[0].result.answer, report.answer);
        assert.equal(collected.results[0].receipt.calls, 1);
        assert.equal(collected.results[0].receipt.usageComplete, true);
        assert.equal(observed.length, 1);
        assert.deepEqual(observed[0].context.tools, []);
        assert.equal(errors.length, 0, errors.join("\n"));
        await command.handler("off", session.extensionRunner.createCommandContext());
    } finally {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        await session.abort();
        session.dispose();
    }
}

export default async function () {
    assert.equal(sdk.VERSION, "0.84.4", "Run this fixture against the pinned isolated SDK");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-delegation-fixture-"));
    try {
        const mode = process.env.SPECPI_DELEGATION_FIXTURE_MODE;
        if (mode === "launcher") {
            await launcherProof(root);
            await delegationProof(root);
        } else {
            await providerProof(root);
            await oauthProof(root);
        }

        console.log(`DELEGATION_FIXTURE=${JSON.stringify({ sdkVersion: sdk.VERSION, [mode ?? "provider"]: true })}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}
