const MAX_CONTEXT_BYTES = 256 * 1024;
const MAX_OUTPUT_TOKENS = 2048;
const MAX_TIMEOUT_MS = 120_000;

function boundedJson(value, label) {
    let serialized;
    try {
        serialized = JSON.stringify(value);
    } catch {
        throw new Error(`Delegation ${label} is not serializable`);
    }

    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_CONTEXT_BYTES) {
        throw new Error(`Delegation ${label} exceeds the 256 KiB retained input limit`);
    }

    return JSON.parse(serialized);
}

function abortError() {
    return new DOMException("Delegation request was cancelled", "AbortError");
}

/** A credential-blind capability over the public request pipeline of an owned Pi parent. */
export function createPiHost(session, { id, isCurrent }) {
    const owner = session?.agent;
    const model = owner?.state?.model;
    const thinkingLevel = owner?.state?.thinkingLevel;
    if (
        typeof id !== "string" ||
        !id ||
        typeof isCurrent !== "function" ||
        !model ||
        typeof model.id !== "string" ||
        typeof model.provider !== "string" ||
        typeof owner.streamFunction !== "function" ||
        typeof owner.convertToLlm !== "function"
    ) {
        throw new Error("Delegation requires a compatible owned Pi parent");
    }

    const modelId = model.id;
    const providerId = model.provider;
    const streamFunction = owner.streamFunction;
    const transformContext = owner.transformContext;
    const convertToLlm = owner.convertToLlm;
    const onPayload = owner.onPayload;
    const onResponse = owner.onResponse;
    const parentSessionId = owner.sessionId;
    const current = () =>
        isCurrent() === true &&
        session.agent === owner &&
        owner.state.model === model &&
        model.id === modelId &&
        model.provider === providerId &&
        owner.state.thinkingLevel === thinkingLevel &&
        owner.streamFunction === streamFunction &&
        owner.transformContext === transformContext &&
        owner.convertToLlm === convertToLlm &&
        owner.onPayload === onPayload &&
        owner.onResponse === onResponse &&
        owner.sessionId === parentSessionId;

    function assertCurrent(signal) {
        if (signal?.aborted) {
            throw abortError();
        }

        if (!current()) {
            throw new Error("Delegation parent lease is no longer current");
        }
    }

    return Object.freeze({
        id,
        model: Object.freeze({ id: modelId, provider: providerId }),
        thinkingLevel,
        isCurrent: current,
        async stream(context, options = {}) {
            const allowedOptions = new Set(["signal", "maxTokens", "timeoutMs", "sessionId"]);
            if (Object.keys(options).some((key) => !allowedOptions.has(key))) {
                throw new Error("Unsupported delegation inference option");
            }

            const { signal, maxTokens = MAX_OUTPUT_TOKENS, timeoutMs = 60_000, sessionId } = options;
            if (
                !(signal instanceof AbortSignal) ||
                !Number.isInteger(maxTokens) ||
                maxTokens < 1 ||
                maxTokens > MAX_OUTPUT_TOKENS ||
                !Number.isInteger(timeoutMs) ||
                timeoutMs < 1 ||
                timeoutMs > MAX_TIMEOUT_MS ||
                typeof sessionId !== "string" ||
                !/^[a-zA-Z0-9_-]{1,128}$/u.test(sessionId) ||
                sessionId === parentSessionId
            ) {
                throw new Error("Invalid bounded delegation inference options");
            }

            const requestController = new AbortController();
            const requestSignal = AbortSignal.any([signal, requestController.signal, AbortSignal.timeout(timeoutMs)]);
            assertCurrent(requestSignal);
            if (
                !context ||
                typeof context !== "object" ||
                Object.keys(context).some((key) => !["systemPrompt", "messages", "tools"].includes(key)) ||
                typeof context.systemPrompt !== "string" ||
                !Array.isArray(context.messages) ||
                !Array.isArray(context.tools)
            ) {
                throw new Error("Invalid delegation context");
            }

            const input = boundedJson(context, "context");
            let messages = input.messages;
            if (transformContext) {
                messages = await transformContext.call(owner, messages, requestSignal);
                assertCurrent(requestSignal);
                boundedJson({ ...input, messages }, "transformed context");
            }

            messages = await convertToLlm.call(owner, messages);
            assertCurrent(requestSignal);
            const converted = boundedJson({ ...input, messages }, "converted context");
            if (!Array.isArray(converted.messages)) {
                throw new Error("Delegation context conversion did not return messages");
            }

            const stream = await streamFunction.call(owner, model, converted, {
                signal: requestSignal,
                maxTokens,
                timeoutMs,
                sessionId,
                reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
                transport: owner.transport,
                thinkingBudgets: owner.thinkingBudgets,
                maxRetryDelayMs: owner.maxRetryDelayMs,
                maxRetries: 0,
                onPayload: async (payload, requestModel) => {
                    assertCurrent(requestSignal);
                    boundedJson(payload, "provider payload");
                    const replacement = onPayload ? await onPayload.call(owner, payload, requestModel) : undefined;
                    assertCurrent(requestSignal);
                    boundedJson(replacement ?? payload, "provider payload");

                    return replacement;
                },
                onResponse: async (response, requestModel) => {
                    assertCurrent(requestSignal);
                    if (onResponse) {
                        await onResponse.call(owner, response, requestModel);
                    }

                    assertCurrent(requestSignal);
                },
            });
            try {
                assertCurrent(requestSignal);
                if (
                    !stream ||
                    typeof stream[Symbol.asyncIterator] !== "function" ||
                    typeof stream.result !== "function"
                ) {
                    throw new Error("Pi did not return a supported inference stream");
                }
            } catch (error) {
                requestController.abort();
                // Dispatch already happened. Keep the caller's slot occupied until the
                // provider settles, even when it ignores cancellation or returns late.
                if (typeof stream?.result === "function") {
                    try {
                        await stream.result();
                    } catch {
                        // Preserve the original lease/validation error after settlement.
                    }
                }

                throw error;
            }

            // This bounds our inputs, not provider buffers or raw transport bytes. The worker
            // separately limits retained output and aborts when it observes oversized events.
            return {
                async *[Symbol.asyncIterator]() {
                    for await (const event of stream) {
                        assertCurrent(requestSignal);
                        yield event;
                    }
                },
                async result() {
                    const result = await stream.result();
                    assertCurrent(requestSignal);

                    return result;
                },
            };
        },
    });
}
