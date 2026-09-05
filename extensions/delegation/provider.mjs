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
        throw new Error(`Delegation ${label} exceeds the 256 KiB retained data limit`);
    }

    return serialized;
}

function recordWithKeys(value, keys) {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Reflect.ownKeys(value).every((key) => keys.includes(key))
    );
}

function validContext(value) {
    return (
        recordWithKeys(value, ["systemPrompt", "messages", "tools"]) &&
        typeof value.systemPrompt === "string" &&
        Array.isArray(value.messages) &&
        Array.isArray(value.tools)
    );
}

function abortError() {
    return new DOMException("Delegation request was cancelled", "AbortError");
}

/** Native registry calls keep credentials in Pi; they do not inherit parent inference hooks or settings. */
export function createNativePiHost(ctx, { id, isCurrent } = {}) {
    const registry = ctx?.modelRegistry;
    const model = ctx?.model;
    if (
        typeof id !== "string" ||
        !id ||
        typeof isCurrent !== "function" ||
        !model ||
        typeof model.id !== "string" ||
        !model.id ||
        typeof model.provider !== "string" ||
        !model.provider ||
        typeof registry?.complete !== "function"
    ) {
        throw new Error("Delegation requires a compatible native Pi model registry");
    }

    const modelId = model.id;
    const providerId = model.provider;
    const complete = registry.complete;
    const current = () => {
        try {
            return (
                isCurrent() === true &&
                ctx.modelRegistry === registry &&
                ctx.model === model &&
                registry.complete === complete &&
                model.id === modelId &&
                model.provider === providerId
            );
        } catch {
            return false;
        }
    };

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
        isCurrent: current,
        async stream(context, options = {}) {
            if (!recordWithKeys(options, ["signal", "maxTokens", "timeoutMs", "sessionId"])) {
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
                !/^[a-zA-Z0-9_-]{1,128}$/u.test(sessionId)
            ) {
                throw new Error("Invalid bounded delegation inference options");
            }

            const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
            assertCurrent(requestSignal);
            if (!validContext(context)) {
                throw new Error("Invalid delegation context");
            }

            const input = JSON.parse(boundedJson(context, "context"));
            if (!validContext(input)) {
                throw new Error("Invalid delegation context");
            }

            assertCurrent(requestSignal);
            // One invocation of Pi's registry. Common options request limits where adapters
            // support them; no parent thinking, transport, context, or request hooks are copied.
            const pending = Promise.resolve(
                complete.call(registry, model, input, {
                    signal: requestSignal,
                    maxTokens,
                    timeoutMs,
                    sessionId,
                    maxRetries: 0,
                }),
            ).then((result) => {
                // Never race cancellation or revocation against settlement: the caller keeps
                // its slot until the original registry promise finishes, even after abort.
                assertCurrent(requestSignal);
                // The registry exposes only the final parsed response. This limit cannot
                // prevent allocations made earlier by Pi, its provider, or the transport.
                boundedJson(result, "response");
                if (
                    result?.role !== "assistant" ||
                    !Array.isArray(result.content) ||
                    !["stop", "length", "toolUse", "deferred", "error", "aborted"].includes(result.stopReason)
                ) {
                    throw new Error("Pi returned an invalid delegation response");
                }

                // Keep all original assistant fields, including provider signatures and
                // opaque metadata needed when a later tool turn replays this message.
                return result;
            });
            // A caller may consume the stream later. Keep rejection handling attached while
            // preserving the original rejection for both public consumers below.
            void pending.catch(() => {});

            return {
                async *[Symbol.asyncIterator]() {
                    const result = await pending;
                    assertCurrent(requestSignal);
                    if (["error", "aborted"].includes(result.stopReason)) {
                        yield { type: "error", reason: result.stopReason, error: result };
                    } else {
                        yield { type: "done", reason: result.stopReason, message: result };
                    }
                },
                async result() {
                    const result = await pending;
                    assertCurrent(requestSignal);

                    return result;
                },
            };
        },
    });
}
