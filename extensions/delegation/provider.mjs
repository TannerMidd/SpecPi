import { DelegationError } from "./errors.mjs";

const MAX_CONTEXT_BYTES = 256 * 1024;
const MAX_OUTPUT_TOKENS = 8192;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MODEL_FIELDS = [
    "id",
    "provider",
    "api",
    "baseUrl",
    "reasoning",
    "input",
    "contextWindow",
    "maxTokens",
    "thinkingLevelMap",
    "compat",
    "samplingParams",
];

export function getPiSessionCompatibilityError(sdk) {
    const required = [
        ["createAgentSession", sdk?.createAgentSession],
        ["ModelRuntime.create", sdk?.ModelRuntime?.create],
        ["SessionManager.inMemory", sdk?.SessionManager?.inMemory],
        ["SettingsManager.create", sdk?.SettingsManager?.create],
        ["SettingsManager.inMemory", sdk?.SettingsManager?.inMemory],
        ["createExtensionRuntime", sdk?.createExtensionRuntime],
        ["clampThinkingLevel", sdk?.clampThinkingLevel],
    ];
    const missing = required.filter(([, value]) => typeof value !== "function").map(([name]) => name);

    return missing.length
        ? `Pi SDK is missing delegation capabilities: ${missing.join(", ")}. Update Pi or SpecPi and restart Pi.`
        : undefined;
}

function bounded(value, maximum = MAX_CONTEXT_BYTES) {
    let serialized;
    try {
        serialized = JSON.stringify(value);
    } catch {
        throw new DelegationError("Delegation data is not serializable");
    }

    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > maximum) {
        throw new DelegationError("Delegation data exceeds its retained data allowance");
    }

    return serialized;
}

function closed(value, keys) {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Reflect.ownKeys(value).every((key) => keys.includes(key))
    );
}

function descriptor(model) {
    // Only public model behavior fields; never serialize a provider, headers, or credentials.
    return JSON.parse(bounded(Object.fromEntries(MODEL_FIELDS.map((key) => [key, model[key]])), 16 * 1024));
}

function sameValue(left, right) {
    if (Object.is(left, right)) {
        return true;
    }

    if (
        !left ||
        !right ||
        typeof left !== "object" ||
        typeof right !== "object" ||
        Array.isArray(left) !== Array.isArray(right)
    ) {
        return false;
    }

    const keys = Object.keys(left);

    return (
        keys.length === Object.keys(right).length &&
        keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
    );
}

function emptyResources(sdk, systemPrompt) {
    const extensions = { extensions: [], errors: [], runtime: sdk.createExtensionRuntime() };

    return {
        getExtensions: () => extensions,
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => systemPrompt,
        getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [],
        getAppendSystemPromptSources: () => [],
        extendResources() {
            throw new DelegationError("Delegation resources are closed");
        },
        async reload() {},
    };
}

function bestEffort(action) {
    try {
        Promise.resolve(action()).catch(() => {});
    } catch {
        // Cleanup failures must not prevent the remaining independent cleanup stages.
    }
}

function streamBudget(maximum) {
    let events = 0;
    let boundaries = 0;
    let deltaBytes = 0;
    const messageKeys = [
        "role",
        "content",
        "api",
        "provider",
        "model",
        "responseModel",
        "responseId",
        "diagnostics",
        "usage",
        "stopReason",
        "deferred",
        "errorMessage",
        "rawStopReason",
        "endTurn",
        "timestamp",
        "providerMetadata",
    ];
    const shapes = {
        start: ["type", "partial"],
        done: ["type", "reason", "message"],
        error: ["type", "reason", "error"],
    };
    for (const kind of ["text", "thinking", "toolcall"]) {
        shapes[`${kind}_start`] = ["type", "contentIndex", "partial"];
        shapes[`${kind}_delta`] = ["type", "contentIndex", "delta", "partial"];
        shapes[`${kind}_end`] = ["type", "contentIndex", kind === "toolcall" ? "toolCall" : "content", "partial"];
    }

    return (event) => {
        events += 1;
        if (
            events > 65_536 ||
            !Object.hasOwn(shapes, event?.type) ||
            !closed(event, shapes[event.type]) ||
            shapes[event.type].some((key) => !Object.hasOwn(event, key))
        ) {
            throw new DelegationError("Provider returned an unsupported or excessive stream event");
        }

        if (!event.type.endsWith("_delta")) {
            boundaries += 1;
            if (boundaries > 130) {
                throw new DelegationError("Provider returned excessive stream boundaries");
            }
        }

        const message = event.partial ?? event.message ?? event.error;
        if (
            !closed(message, messageKeys) ||
            message.role !== "assistant" ||
            !Array.isArray(message.content) ||
            message.content.length > 64
        ) {
            throw new DelegationError("Provider returned an unsupported partial response");
        }

        if (
            event.type.includes("_") &&
            (!Number.isInteger(event.contentIndex) || event.contentIndex < 0 || event.contentIndex >= 64)
        ) {
            throw new DelegationError("Provider returned an invalid content index");
        }

        if (event.type.endsWith("_delta")) {
            if (typeof event.delta !== "string") {
                throw new DelegationError("Provider returned an invalid stream delta");
            }

            deltaBytes += Buffer.byteLength(bounded(event.delta, maximum), "utf8") - 2;
            if (deltaBytes > maximum) {
                throw new DelegationError("Delegation stream exceeds its retained data allowance");
            }
        }

        if ((event.type === "text_end" || event.type === "thinking_end") && typeof event.content !== "string") {
            throw new DelegationError("Provider returned invalid stream content");
        }

        if (event.type === "toolcall_end" && event.toolCall?.type !== "toolCall") {
            throw new DelegationError("Provider returned an invalid stream tool call");
        }

        if (
            (event.type === "done" && !["stop", "length", "toolUse", "deferred"].includes(event.reason)) ||
            (event.type === "error" && !["error", "aborted"].includes(event.reason))
        ) {
            throw new DelegationError("Provider returned an invalid stream termination");
        }

        // Pi owns already-parsed objects. These bounded structural/length checks do
        // not serialize growing prefixes. Linear accounting relies on Pi keeping
        // partials consistent with deltas; it is not a bound on arbitrary provider
        // allocations. Exact full checks still precede tools and terminal results.
        let nodes = 0;
        let units = 0;
        const inspect = (value) => {
            nodes += 1;
            if (nodes > 512) {
                throw new DelegationError("Provider response metadata exceeds its structural allowance");
            }

            if (typeof value === "string") {
                units += value.length;
            } else if (value && typeof value === "object") {
                for (const key of Object.keys(value)) {
                    units += key.length;
                    inspect(value[key]);
                }
            }

            if (units > maximum) {
                throw new DelegationError("Delegation partial response exceeds its retained data allowance");
            }
        };

        inspect(message);
        for (const part of message.content) {
            if (!["text", "thinking", "toolCall"].includes(part?.type)) {
                throw new DelegationError("Provider returned unsupported content");
            }

            if (part.type !== "toolCall") {
                const value = part[part.type === "text" ? "text" : "thinking"];
                if (typeof value !== "string") {
                    throw new DelegationError("Provider returned invalid text content");
                }
            }
        }

        if (!event.type.endsWith("_delta")) {
            bounded(message, maximum);
            const { partial: _partial, message: _message, error: _error, ...metadata } = event;
            bounded(metadata, maximum);
        }
    };
}

/** A real SDK session using Pi-owned configured auth, without cloning parent runtime overrides or hooks. */
export function createNativePiHost(ctx, { id, isCurrent, sdk, thinkingLevel } = {}) {
    const registry = ctx?.modelRegistry;
    const model = ctx?.model;
    if (
        typeof id !== "string" ||
        !id ||
        typeof isCurrent !== "function" ||
        typeof ctx?.cwd !== "string" ||
        !model ||
        typeof model.id !== "string" ||
        !model.id ||
        typeof model.provider !== "string" ||
        !model.provider ||
        !Number.isInteger(model.maxTokens) ||
        model.maxTokens < 1 ||
        !THINKING_LEVELS.includes(thinkingLevel) ||
        typeof registry?.getProviderAuthStatus !== "function" ||
        typeof registry?.getRegisteredProviderIds !== "function"
    ) {
        throw new DelegationError("Delegation requires the supported Pi SDK and an explicit thinking level");
    }

    const compatibilityError = getPiSessionCompatibilityError(sdk);
    if (compatibilityError) {
        throw new DelegationError(compatibilityError);
    }

    thinkingLevel = sdk.clampThinkingLevel(model, thinkingLevel);
    if (!THINKING_LEVELS.includes(thinkingLevel)) {
        throw new DelegationError("Pi returned an unsupported effective thinking level");
    }

    const selected = descriptor(model);
    const current = (streaming = false) => {
        try {
            return (
                isCurrent(streaming) === true &&
                ctx.modelRegistry === registry &&
                ctx.model === model &&
                (streaming || sameValue(descriptor(model), selected))
            );
        } catch {
            return false;
        }
    };

    const check = (streaming = false) => {
        if (!current(streaming)) {
            throw new DelegationError("Delegation parent lease is no longer current");
        }

        if (
            !streaming &&
            (registry.getProviderAuthStatus(model.provider)?.source === "runtime" ||
                registry.getRegisteredProviderIds().includes(model.provider) ||
                model.headers !== undefined)
        ) {
            throw new DelegationError("Delegation cannot inherit this parent runtime provider override");
        }
    };

    let initialization;
    const ready = () => {
        check();
        initialization ??= (async () => {
            // Pi owns normal configuration and credential access. No credential object is
            // requested, copied, or exposed. Static catalogs avoid refresh I/O.
            const configured = sdk.SettingsManager.create(ctx.cwd, undefined, { projectTrusted: false });
            if (
                configured.getGlobalSettings().httpProxy ||
                ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].some(
                    (key) => process.env[key],
                )
            ) {
                throw new DelegationError("Delegation SDK sessions do not support startup proxy configuration");
            }

            const settings = {
                transport: configured.getTransport(),
                thinkingBudgets: configured.getThinkingBudgets(),
                images: { blockImages: true },
                compaction: { enabled: false },
                retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
            };
            const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
            check();
            const childModel = runtime.getModel(model.provider, model.id);
            if (
                runtime.getError() ||
                !runtime.getProvider(model.provider) ||
                !childModel ||
                !sameValue(descriptor(childModel), selected)
            ) {
                throw new DelegationError(
                    "The configured child provider or model does not match the selected parent model",
                );
            }

            return { runtime, childModel, settings };
        })();

        const attempt = initialization;

        return attempt.then(
            () => {
                check();
            },
            (error) => {
                if (initialization === attempt) {
                    initialization = undefined;
                }

                throw error;
            },
        );
    };

    return Object.freeze({
        id,
        model: Object.freeze({ id: model.id, provider: model.provider, thinkingLevel }),
        isCurrent: current,
        ready,
        async openSession(input) {
            if (
                !closed(input, ["systemPrompt", "tools"]) ||
                typeof input.systemPrompt !== "string" ||
                !Array.isArray(input.tools)
            ) {
                throw new DelegationError("Invalid closed delegation session options");
            }

            bounded({
                systemPrompt: input.systemPrompt,
                tools: input.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
            });
            await ready();
            const { runtime, childModel, settings } = await initialization;
            check();
            const names = input.tools.map((tool) => tool.name);
            if (
                new Set(names).size !== names.length ||
                names.some((name) => !["list_sources", "read_source", "search_sources"].includes(name))
            ) {
                throw new DelegationError("Delegation tools must be selected snapshot capabilities");
            }

            const { session } = await sdk.createAgentSession({
                cwd: ctx.cwd,
                modelRuntime: runtime,
                model: childModel,
                thinkingLevel,
                sessionManager: sdk.SessionManager.inMemory(ctx.cwd),
                settingsManager: sdk.SettingsManager.inMemory(settings, { projectTrusted: false }),
                resourceLoader: emptyResources(sdk, input.systemPrompt),
                noTools: "builtin",
                tools: names,
                customTools: input.tools,
            });
            let disposed = false;
            const dispose = () => {
                if (disposed) {
                    return;
                }

                disposed = true;
                // Pi cleanup uses the original child ID. Failure in one stage must
                // not retain the transcript or prevent the other stages.
                bestEffort(() => session.dispose());
                bestEffort(() => session.agent.reset());
                bestEffort(() => session.sessionManager.newSession());
            };

            try {
                check();
                session.setAutoCompactionEnabled(false);
                session.setAutoRetryEnabled(false);
                if (
                    session.thinkingLevel !== thinkingLevel ||
                    typeof session.agent.streamFunction !== "function" ||
                    session.getActiveToolNames().some((name) => !names.includes(name))
                ) {
                    throw new DelegationError("Pi could not apply the closed delegation session policy");
                }
            } catch (error) {
                dispose();
                throw error;
            }

            let released = false;
            let active;
            const originalStream = session.agent.streamFunction;
            const beforeToolCall = session.agent.beforeToolCall;
            const assertRun = (streaming = false) => {
                check(streaming);
                if (
                    released ||
                    !active ||
                    active.controller.signal.aborted ||
                    active.controls.signal.aborted ||
                    Date.now() >= active.controls.deadline
                ) {
                    throw new DelegationError("Delegation session was cancelled or expired");
                }

                active.controls.assertLive(streaming);
            };

            const fail = (error) => {
                if (active) {
                    active.failure ??= error;
                    bestEffort(() => active.controller.abort());
                    bestEffort(() => active.controls.abort());
                    bestEffort(() => session.abort());
                }
            };

            session.agent.beforeToolCall = async (call, signal) => {
                try {
                    assertRun();
                    if (!names.includes(call.toolCall.name)) {
                        throw new DelegationError("Delegation requested an unavailable tool");
                    }

                    const result = await beforeToolCall?.call(session.agent, call, signal);
                    assertRun();

                    return result;
                } catch (error) {
                    fail(error);

                    return { block: true, terminate: true, reason: "Delegation tool policy rejected the request" };
                }
            };

            session.agent.streamFunction = async (requestModel, context, options) => {
                try {
                    assertRun();
                    const run = active;
                    if (
                        requestModel !== childModel ||
                        !sameValue(descriptor(requestModel), selected) ||
                        context.tools?.some((tool) => !names.includes(tool.name)) ||
                        context.messages.some((message) => message.role === "toolResult" && message.isError)
                    ) {
                        throw new DelegationError("Delegation inference policy changed");
                    }

                    bounded(context, run.controls.limits.contextBytes);
                    run.controls.admitCall();
                    const requestOptions = {
                        ...options,
                        signal: AbortSignal.any(
                            [options.signal, run.controls.signal, run.controller.signal].filter(Boolean),
                        ),
                        maxTokens: Math.min(MAX_OUTPUT_TOKENS, childModel.maxTokens, run.controls.limits.outputTokens),
                        maxRetries: 0,
                        timeoutMs: Math.max(1, Math.min(120_000, run.controls.deadline - Date.now())),
                        onPayload: async (payload, providerModel) => {
                            assertRun();
                            const result = (await options.onPayload?.(payload, providerModel)) ?? payload;
                            assertRun();
                            bounded(result, run.controls.limits.contextBytes);

                            return result;
                        },
                    };
                    // Register settlement before dispatch. Cancellation and prompt completion
                    // cannot release a slot while a provider still owns an unsettled request.
                    const streamReady = Promise.resolve().then(() => {
                        assertRun();

                        return originalStream.call(session.agent, requestModel, context, requestOptions);
                    });
                    const settlement = streamReady
                        .then((stream) => stream.result())
                        .then(
                            (result) => {
                                run.controls.onUsage(result?.usage);
                                bounded(result, run.controls.limits.retainedResponseBytes);
                                if (
                                    result?.role !== "assistant" ||
                                    !Array.isArray(result.content) ||
                                    result.content.some(
                                        (part) => part.type === "toolCall" && !names.includes(part.name),
                                    )
                                ) {
                                    throw new DelegationError(
                                        "Provider returned an invalid response or unavailable tool",
                                    );
                                }

                                return result;
                            },
                            (error) => {
                                run.controls.onUsage(undefined);
                                throw error;
                            },
                        );
                    void settlement.catch((error) => {
                        fail(error);
                    });
                    run.pending.push(settlement);
                    const stream = await streamReady;
                    const inspectEvent = streamBudget(run.controls.limits.retainedResponseBytes);
                    try {
                        assertRun();
                    } catch (error) {
                        fail(error);
                        await settlement.catch(() => {});
                        throw error;
                    }

                    return {
                        async *[Symbol.asyncIterator]() {
                            try {
                                for await (const event of stream) {
                                    assertRun(event.type?.endsWith("_delta") === true);
                                    inspectEvent(event);

                                    yield event;
                                }
                            } catch (error) {
                                fail(error);
                                throw error;
                            } finally {
                                await settlement.catch((error) => {
                                    fail(error);
                                });
                            }
                        },
                        async result() {
                            const message = await settlement;
                            assertRun();

                            return message;
                        },
                    };
                } catch (error) {
                    fail(error);
                    throw error;
                }
            };

            return Object.freeze({
                async run(prompt, controls) {
                    if (
                        active ||
                        released ||
                        typeof prompt !== "string" ||
                        !closed(controls, [
                            "signal",
                            "deadline",
                            "assertLive",
                            "admitCall",
                            "onUsage",
                            "abort",
                            "limits",
                        ]) ||
                        !(controls.signal instanceof AbortSignal) ||
                        !Number.isFinite(controls.deadline) ||
                        ["assertLive", "admitCall", "onUsage", "abort"].some(
                            (key) => typeof controls[key] !== "function",
                        ) ||
                        !Number.isInteger(controls.limits?.outputTokens) ||
                        controls.limits.outputTokens < 1 ||
                        controls.limits.outputTokens > MAX_OUTPUT_TOKENS ||
                        ["contextBytes", "retainedResponseBytes"].some(
                            (key) =>
                                !Number.isInteger(controls.limits[key]) ||
                                controls.limits[key] < 1 ||
                                controls.limits[key] > MAX_CONTEXT_BYTES,
                        )
                    ) {
                        throw new DelegationError("Invalid bounded delegation session run");
                    }

                    const run = { controls, controller: new AbortController(), pending: [], failure: undefined };
                    active = run;
                    const cancel = () => fail(new DelegationError("Delegation session was cancelled or expired"));
                    controls.signal.addEventListener("abort", cancel, { once: true });
                    const timer = setTimeout(cancel, Math.max(1, Math.min(120_000, controls.deadline - Date.now())));
                    timer.unref?.();
                    try {
                        assertRun();
                        bounded(prompt, controls.limits.contextBytes);
                        await session.prompt(prompt, { expandPromptTemplates: false });
                        await Promise.allSettled(run.pending);
                        if (run.failure) {
                            throw run.failure;
                        }

                        assertRun();
                        const result = session.agent.state.messages.at(-1);
                        if (
                            result?.role !== "assistant" ||
                            !Array.isArray(result.content) ||
                            !["stop", "length"].includes(result.stopReason)
                        ) {
                            throw new DelegationError("Pi worker session did not return a complete assistant response");
                        }

                        bounded(result, controls.limits.retainedResponseBytes);

                        return result;
                    } finally {
                        clearTimeout(timer);
                        controls.signal.removeEventListener("abort", cancel);
                        await Promise.allSettled(run.pending);
                        active = undefined;
                        if (released) {
                            dispose();
                        }
                    }
                },
                release() {
                    if (released) {
                        return;
                    }

                    released = true;
                    if (active) {
                        fail(new DelegationError("Delegation session was released"));
                    } else {
                        dispose();
                    }
                },
            });
        },
    });
}
