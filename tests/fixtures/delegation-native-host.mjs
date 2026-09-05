import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadPiSdk, createLauncherRuntimeFactory } from "../../scripts/agent.mjs";
import { createDelegationExtension } from "../../extensions/delegation/extension.mjs";

// Serialized into an isolated global extension and loaded by the native SDK's
// public resource loader. The provider has no network or real credential path.
function nativeProviderExtension(pi) {
    pi.on("before_provider_headers", (event) => {
        event.headers["x-native-policy"] = "retained";
    });
    pi.on("before_provider_request", (event) => ({ ...event.payload, nativePolicy: "retained" }));
    pi.registerProvider("specpi-native-fixture", {
        apiKey: "synthetic-key",
        baseUrl: "https://native-fixture.invalid/route",
        api: "specpi-native-fixture-api",
        models: [
            {
                id: "native-model",
                name: "Synthetic native model",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32_768,
                maxTokens: 4096,
            },
        ],
        streamSimple(model, context, options) {
            const events = createAssistantMessageEventStream();
            const message = {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            status: "complete",
                            answer: "Native SDK delegation complete",
                            requirements: [{ id: "r1", status: "addressed", evidence: [] }],
                            findings: [],
                            missing: [],
                            nextStep: "Parent verifies",
                        }),
                    },
                ],
                api: model.api,
                model: model.id,
                provider: model.provider,
                timestamp: Date.now(),
                stopReason: "stop",
                usage: {
                    input: 2,
                    output: 3,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 5,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
            };
            void (async () => {
                try {
                    const payload = await options.onPayload?.({ fixture: true }, model);
                    pi.events.emit("specpi-native-fixture-observed", {
                        model: { id: model.id, provider: model.provider, baseUrl: model.baseUrl },
                        headers: options.headers,
                        sessionId: options.sessionId,
                        payload,
                        tools: context.tools.map((tool) => tool.name),
                    });
                    await options.onResponse?.({ status: 200, headers: {} }, model);
                    events.push({ type: "done", reason: "stop", message });
                } catch (error) {
                    message.stopReason = "error";
                    message.errorMessage = error.message;
                    events.push({ type: "error", reason: "error", error: message });
                }
            })();

            return events;
        },
    });
}

const sdkDirectory = process.env.SPECPI_FIXTURE_SDK_ABSOLUTE;
assert.ok(sdkDirectory && path.isAbsolute(sdkDirectory), "The native fixture requires an explicit SDK directory");
const sdk = await loadPiSdk({ sdkDirectory });
assert.equal(sdk.VERSION, "0.84.4");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "specpi-native-host-"));
const cwd = path.join(root, "project");
const agentDir = path.join(root, "agent");
await fs.mkdir(cwd);
await fs.mkdir(path.join(agentDir, "extensions"), { recursive: true });
await fs.writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "specpi-native-fixture", defaultModel: "native-model" }),
);
await fs.writeFile(
    path.join(agentDir, "extensions", "provider.js"),
    `import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";\n${nativeProviderExtension.toString()}\nexport default nativeProviderExtension;\n`,
);
let host;
let session;
const observed = [];
const notices = [];
const errors = [];
try {
    const delegation = createDelegationExtension(() => host, { root: cwd });
    const factory = createLauncherRuntimeFactory(sdk, {
        delegationFactory(pi) {
            pi.events.on("specpi-native-fixture-observed", (value) => observed.push(value));
            delegation(pi);
        },
        onHost(value) {
            host = value;
        },
    });
    const created = await factory({ cwd, agentDir, sessionManager: sdk.SessionManager.inMemory(cwd) });
    session = created.session;
    assert.equal(created.services.settingsManager.isProjectTrusted(), false);
    assert.deepEqual(created.services.resourceLoader.getAgentsFiles().agentsFiles, []);
    for (const command of ["guard", "scope", "delegate"]) {
        assert.equal(
            created.extensionsResult.extensions.filter((extension) => extension.commands.has(command)).length,
            1,
        );
    }

    const ui = {
        ...session.extensionRunner.getUIContext(),
        async select(_title, choices) {
            return choices.includes("Allow once") ? "Allow once" : choices[0];
        },
        async confirm() {
            return true;
        },
        notify(message) {
            notices.push(message);
        },
    };
    await session.bindExtensions({
        mode: "tui",
        uiContext: ui,
        onError(error) {
            errors.push(error.error);
        },
    });
    await session.extensionRunner.getCommand("delegate").handler("on", session.extensionRunner.createCommandContext());
    assert.ok(
        notices.some((notice) => notice.startsWith("Delegation enabled")),
        notices.join("\n"),
    );
    const tool = session.agent.state.tools.find((entry) => entry.name === "delegate");
    assert.ok(tool);
    let sequence = 0;
    const execute = async (input) => {
        const id = `native-fixture-${++sequence}`;
        const toolCall = { type: "toolCall", id, name: "delegate", arguments: input };
        const guard = await session.agent.beforeToolCall({ toolCall, args: input });
        assert.notEqual(guard?.block, true, guard?.reason);
        const result = await tool.execute(id, input, new AbortController().signal);
        assert.notEqual(result.isError, true, JSON.stringify(result));
        await session.agent.afterToolCall({ toolCall, args: input, result, isError: false });

        return result.details;
    };

    const launched = await execute({
        operation: "run",
        requestId: "native-run",
        packet: {
            objective: "Verify native SDK delegation",
            requirements: [{ id: "r1", text: "Run native path" }],
            decisions: [],
            nonGoals: ["No network"],
            reason: {
                deliverable: "Native report",
                consumer: "Parent",
                independence: "Independent fixture",
                parentWork: "Inspect integration",
            },
            jobs: [
                {
                    id: "j1",
                    mode: "consult",
                    question: "Assess fixture",
                    context: "Synthetic public input",
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
            afterCursor: collected?.cursor ?? 0,
            waitMs: 100,
        });
        if (collected.results.length > 0) {
            break;
        }
    }

    assert.equal(collected.results[0]?.receipt.state, "complete", JSON.stringify(collected));
    assert.equal(collected.results[0].result.answer, "Native SDK delegation complete");
    assert.equal(collected.results[0].receipt.usageComplete, true);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].model.baseUrl, "https://native-fixture.invalid/route");
    assert.equal(observed[0].headers["x-native-policy"], "retained");
    assert.equal(observed[0].payload.nativePolicy, "retained");
    assert.notEqual(observed[0].sessionId, session.agent.sessionId);
    assert.deepEqual(observed[0].tools, []);
    assert.deepEqual(errors, []);
    console.log(
        `NATIVE_DELEGATION_FIXTURE=${JSON.stringify({ sdkVersion: sdk.VERSION, nativeImport: true, delegation: true, calls: observed.length })}`,
    );
} finally {
    if (session) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        await session.abort();
        session.dispose();
    }

    await fs.rm(root, { recursive: true, force: true });
}
