"use strict";

const { normalizeImage } = require("./images.js");
const { projectFileContext, MAX_ATTACHMENTS } = require("./context.js");
const { delegateResultText } = require("./delegates.js");

const MAX_MESSAGES = 500;
const MAX_MESSAGE_CHARS = 100_000;
const MAX_TRANSCRIPT_CHARS = 1_000_000;
const MAX_TOOL_INPUT_CHARS = 12_000;
const MAX_MESSAGE_IMAGES = 8;
const MAX_TRANSCRIPT_IMAGES = 32;
const MAX_TRANSCRIPT_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_LIMIT_NOTICE = "[Image display omitted: transcript image limit reached.]";
const normalizedImages = new WeakSet();
const internal = new WeakMap();

function bounded(value, limit = MAX_MESSAGE_CHARS) {
    if (typeof value !== "string") {
        return "";
    }

    return value.length > limit ? `${value.slice(0, limit - 24)}\n[Display truncated]` : value;
}

function safeModel(model) {
    if (!model || typeof model !== "object" || typeof model.id !== "string") {
        return null;
    }

    const result = {
        id: bounded(model.id, 256),
        name: bounded(model.name || model.id, 256),
        provider: bounded(model.provider, 256),
    };
    if (Number.isFinite(model.contextWindow) && model.contextWindow >= 0) {
        result.contextWindow = model.contextWindow;
    }

    if (Array.isArray(model.input)) {
        result.input = [...new Set(model.input.filter((kind) => kind === "text" || kind === "image"))];
    }

    return result;
}

function toolInput(args) {
    try {
        return bounded(JSON.stringify(args, null, 2), MAX_TOOL_INPUT_CHARS);
    } catch {
        return "[Tool input could not be displayed]";
    }
}

function createState(overrides = {}) {
    const state = {
        status: "disconnected",
        workspace: "",
        title: "New chat",
        model: null,
        thinkingLevel: "off",
        models: [],
        commands: [],
        messages: [],
        attachments: [],
        queueCount: 0,
        ...overrides,
    };
    state.model = safeModel(state.model);
    state.models = Array.isArray(state.models) ? state.models.map(safeModel).filter(Boolean).slice(0, 1_000) : [];
    internal.set(state, { nextId: 0, activeId: null, runActive: false, blocks: new Map() });
    replaceMessages(state, state.messages);

    return state;
}

function metadata(state) {
    if (!internal.has(state)) {
        internal.set(state, { nextId: 0, activeId: null, runActive: false, blocks: new Map() });
    }

    return internal.get(state);
}

function nextId(state, prefix = "message") {
    const value = metadata(state);
    value.nextId += 1;

    return `${prefix}-${value.nextId}`;
}

function displayImage(part, previousImages = []) {
    if (part && normalizedImages.has(part)) {
        return part;
    }

    const previous = previousImages.find(
        (candidate) =>
            normalizedImages.has(candidate) &&
            candidate.data === part?.data &&
            candidate.mimeType === part?.mimeType &&
            candidate.name === part?.name,
    );
    if (previous) {
        return previous;
    }

    const image = normalizeImage(part);
    Object.freeze(image);
    normalizedImages.add(image);

    return image;
}

function projectContent(content, previousImages = []) {
    if (typeof content === "string") {
        return { text: bounded(content), images: [] };
    }

    if (!Array.isArray(content)) {
        return { text: "", images: [] };
    }

    let text = "";
    const images = [];
    let imageLimitNoted = false;
    for (const part of content.slice(0, 1_000)) {
        if (part?.type === "text" && typeof part.text === "string") {
            text = bounded(`${text}${text ? "\n" : ""}${bounded(part.text)}`);
        } else if (part?.type === "image") {
            if (images.length >= MAX_MESSAGE_IMAGES) {
                if (!imageLimitNoted) {
                    text = bounded(
                        `${text}${text ? "\n" : ""}[Image display omitted: at most eight images per message.]`,
                    );
                    imageLimitNoted = true;
                }

                continue;
            }

            try {
                images.push(displayImage(part, previousImages));
            } catch {
                text = bounded(
                    `${text}${text ? "\n" : ""}[Image display omitted: invalid, unsupported, or larger than 5 MiB.]`,
                );
            }
        }
    }

    return { text, images };
}

function thinkingContent(content) {
    if (!Array.isArray(content)) {
        return "";
    }

    let thinking = "";
    for (const part of content.slice(0, 1_000)) {
        if (part?.type === "thinking" && !part.redacted && typeof part.thinking === "string") {
            thinking = bounded(`${thinking}${thinking ? "\n" : ""}${bounded(part.thinking)}`);
        }
    }

    return thinking;
}

function projectMessage(state, message, id) {
    if (!message || typeof message !== "object") {
        return null;
    }

    const role = message.role === "toolResult" ? "tool" : message.role;
    if (!["user", "assistant", "tool", "notice"].includes(role)) {
        return null;
    }

    const messageId = bounded(id || message.id || (role === "tool" && message.toolCallId) || nextId(state), 256);
    const previousImages = state.messages.find((candidate) => candidate.id === messageId)?.images || [];
    const files = [];
    function displayText(text) {
        const context = role === "user" ? projectFileContext(text) : null;
        if (!context || files.length + context.files.length > MAX_ATTACHMENTS) {
            return text;
        }

        files.push(...context.files);

        return context.text;
    }

    // Separate attached source before the normal display truncation; otherwise
    // large snapshots lose their closing envelope and flood the transcript.
    const content = message.content ?? message.text;
    const displayContent = Array.isArray(content)
        ? content
              .slice(0, 1_000)
              .map((part) => (part?.type === "text" ? { ...part, text: displayText(part.text) } : part))
        : displayText(content);
    const projectedContent = projectContent(displayContent, previousImages);
    if (role === "tool" && message.toolName === "delegate") {
        projectedContent.text = delegateResultText(message.details) ?? projectedContent.text;
    }

    if (!Array.isArray(message.content) && Array.isArray(message.images)) {
        const projectedImages = projectContent(
            message.images
                .slice(0, MAX_MESSAGE_IMAGES + 1)
                .map((image) => ({ data: image?.data, mimeType: image?.mimeType, name: image?.name, type: "image" })),
            previousImages,
        );
        projectedContent.images = projectedImages.images;
        projectedContent.text = bounded(
            `${projectedContent.text}${projectedContent.text && projectedImages.text ? "\n" : ""}${projectedImages.text}`,
        );
    }

    const result = {
        id: messageId,
        role,
        text: projectedContent.text,
    };
    if (projectedContent.images.length) {
        result.images = projectedContent.images;
    }

    if (files.length) {
        result.files = files;
    }

    if (role === "assistant") {
        const thinking = thinkingContent(message.content) || bounded(message.thinking);
        if (thinking) {
            result.thinking = bounded(thinking, Math.max(24, MAX_MESSAGE_CHARS - result.text.length));
        }

        if (message.stopReason === "error" || message.stopReason === "aborted") {
            result.isError = message.stopReason === "error";
            result.text = bounded(
                `${result.text}${result.text ? "\n\n" : ""}${bounded(message.errorMessage || (message.stopReason === "aborted" ? "Response stopped." : "The model could not complete this response."))}`,
            );
        }
    }

    if (role === "tool") {
        result.toolName = bounded(message.toolName || "tool", 128);
        result.isError = Boolean(message.isError);
        if (typeof message.input === "string") {
            result.input = bounded(message.input, MAX_TOOL_INPUT_CHARS);
        }
    }

    if (message.isRunning !== undefined) {
        result.isRunning = Boolean(message.isRunning);
    }

    if (result.text.length + (result.thinking?.length || 0) > MAX_MESSAGE_CHARS) {
        result.thinking = (result.thinking || "").slice(0, Math.max(0, MAX_MESSAGE_CHARS - result.text.length));
    }

    return result;
}

function trimMessages(state) {
    let imageBytes = 0;
    let imageCount = 0;
    for (let index = state.messages.length - 1; index >= 0; index -= 1) {
        const message = state.messages[index];
        if (!Array.isArray(message.images)) {
            continue;
        }

        const retained = [];
        let omitted = message.images.length > MAX_MESSAGE_IMAGES;
        for (const candidate of message.images.slice(-MAX_MESSAGE_IMAGES).reverse()) {
            let image;
            try {
                image = displayImage(candidate);
            } catch {
                omitted = true;

                continue;
            }

            if (imageCount >= MAX_TRANSCRIPT_IMAGES || imageBytes + image.byteLength > MAX_TRANSCRIPT_IMAGE_BYTES) {
                omitted = true;

                continue;
            }

            retained.unshift(image);
            imageBytes += image.byteLength;
            imageCount += 1;
        }

        if (retained.length) {
            message.images = retained;
        } else {
            delete message.images;
        }

        if (omitted && !message.text.includes(IMAGE_LIMIT_NOTICE)) {
            message.text = bounded(
                `${bounded(message.text, MAX_MESSAGE_CHARS - IMAGE_LIMIT_NOTICE.length - 2)}\n\n${IMAGE_LIMIT_NOTICE}`,
            );
        }
    }

    for (const message of state.messages) {
        if (message.input !== undefined) {
            message.input = bounded(message.input, MAX_TOOL_INPUT_CHARS);
        }

        const fileChars = (message.files || []).reduce(
            (total, file) => total + file.label.length + file.detail.length,
            0,
        );
        const textBudget = MAX_MESSAGE_CHARS - (message.input?.length || 0) - fileChars;
        if (message.text.endsWith(IMAGE_LIMIT_NOTICE)) {
            message.text = `${bounded(message.text.slice(0, -IMAGE_LIMIT_NOTICE.length).trimEnd(), textBudget - IMAGE_LIMIT_NOTICE.length - 2)}\n\n${IMAGE_LIMIT_NOTICE}`;
        } else {
            message.text = bounded(message.text, textBudget);
        }

        if (message.thinking) {
            message.thinking = bounded(message.thinking).slice(0, Math.max(0, textBudget - message.text.length));
        }
    }

    let size = 0;
    let start = state.messages.length;
    while (start > 0 && state.messages.length - start < MAX_MESSAGES) {
        const message = state.messages[start - 1];
        const fileChars = (message.files || []).reduce(
            (total, file) => total + file.label.length + file.detail.length,
            0,
        );
        const length = message.text.length + (message.thinking?.length || 0) + (message.input?.length || 0) + fileChars;
        if (size + length > MAX_TRANSCRIPT_CHARS) {
            break;
        }

        size += length;
        start -= 1;
    }

    if (start > 0) {
        state.messages.splice(0, start);
    }
}

function appendNotice(state, text, isError = false, id = nextId(state, "notice")) {
    upsert(state, { id: bounded(id, 256), role: "notice", text: bounded(text), isError: Boolean(isError) });

    return state;
}

function replaceMessages(state, messages) {
    const value = metadata(state);
    value.activeId = null;
    value.blocks.clear();
    state.messages = [];
    if (Array.isArray(messages)) {
        let toolCalls = [];
        for (const message of messages.slice(-MAX_MESSAGES)) {
            if (message?.role === "assistant") {
                toolCalls = Array.isArray(message.content)
                    ? message.content.slice(0, 1_000).filter((part) => part?.type === "toolCall")
                    : [];
            }

            const projected = projectMessage(state, message);
            if (projected) {
                if (projected.role === "tool") {
                    const call = toolCalls.find((part) => part.id === message.toolCallId);
                    if (call) {
                        projected.input = toolInput(call.arguments);
                    }
                }

                projected.isRunning = false;
                state.messages.push(projected);
                trimMessages(state);
            }
        }
    }

    trimMessages(state);

    return state;
}

function upsert(state, message) {
    if (!message) {
        return;
    }

    const index = state.messages.findIndex((candidate) => candidate.id === message.id);
    if (index === -1) {
        state.messages.push(message);
    } else {
        if (message.role === "tool" && message.input === undefined && state.messages[index].input !== undefined) {
            message.input = state.messages[index].input;
        }

        state.messages[index] = message;
    }

    trimMessages(state);
}

function setUsage(state, usage) {
    if (!usage || typeof usage !== "object") {
        return;
    }

    const result = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "reasoning"]) {
        if (Number.isFinite(usage[key]) && usage[key] >= 0) {
            result[key] = usage[key];
        }
    }

    if (Number.isFinite(usage.cost?.total) && usage.cost.total >= 0) {
        result.cost = usage.cost.total;
    }

    if (result.totalTokens !== undefined) {
        result.total = result.totalTokens;
    }

    state.tokens = result;
}

function applyDelta(state, delta) {
    if (!delta || typeof delta.type !== "string") {
        return;
    }

    const value = metadata(state);
    if (!value.activeId) {
        value.activeId = nextId(state);
        value.blocks.clear();
    }

    const index =
        Number.isInteger(delta.contentIndex) && delta.contentIndex >= 0 && delta.contentIndex < 1_000
            ? delta.contentIndex
            : 0;
    const kind = delta.type.startsWith("thinking_") ? "thinking" : delta.type.startsWith("text_") ? "text" : null;
    if (!kind) {
        return;
    }

    const existing = value.blocks.get(index);
    const part = existing?.kind === kind ? existing : { kind, text: "" };
    const otherSize = [...value.blocks].reduce(
        (total, [key, block]) => total + (key === index ? 0 : block.text.length),
        0,
    );
    const budget = Math.max(0, MAX_MESSAGE_CHARS - otherSize);
    if (delta.type.endsWith("_delta")) {
        part.text = bounded(part.text + bounded(delta.delta)).slice(0, budget);
    } else if (delta.type.endsWith("_end") && typeof delta.content === "string") {
        part.text = bounded(delta.content).slice(0, budget);
    }

    value.blocks.set(index, part);
    const parts = [...value.blocks].sort(([left], [right]) => left - right).map(([, part]) => part);
    const currentMessage = state.messages.find((message) => message.id === value.activeId);
    const images = currentMessage?.images;
    const imageNotice = currentMessage?.text.includes(IMAGE_LIMIT_NOTICE) ? `\n\n${IMAGE_LIMIT_NOTICE}` : "";
    upsert(state, {
        id: value.activeId,
        role: "assistant",
        text:
            bounded(
                parts
                    .filter((part) => part.kind === "text")
                    .map((part) => part.text)
                    .join("\n"),
                MAX_MESSAGE_CHARS - imageNotice.length,
            ) + imageNotice,
        thinking: bounded(
            parts
                .filter((part) => part.kind === "thinking")
                .map((part) => part.text)
                .join("\n"),
        ),
        ...(images?.length ? { images } : {}),
        isRunning: true,
    });
}

function applyResponse(state, event) {
    if (event.success === false) {
        state.error = bounded(event.error || "Pi could not complete this request.", 2_000);

        return;
    }

    const data = event.data || {};
    if (event.command === "get_state") {
        state.model = safeModel(data.model);
        state.thinkingLevel = bounded(data.thinkingLevel || "off", 32);
        state.title = bounded(data.sessionName || state.title || "New chat", 160);
        state.queueCount = Number.isInteger(data.pendingMessageCount) ? Math.max(0, data.pendingMessageCount) : 0;
        state.status = data.isCompacting
            ? "compacting"
            : data.isStreaming
              ? "busy"
              : metadata(state).runActive
                ? state.status
                : "ready";
    } else if (event.command === "get_available_models") {
        state.models = Array.isArray(data.models) ? data.models.slice(0, 1_000).map(safeModel).filter(Boolean) : [];
    } else if (event.command === "get_commands") {
        state.commands = Array.isArray(data.commands)
            ? data.commands
                  .slice(0, 200)
                  .filter((command) => typeof command?.name === "string")
                  .map((command) => ({
                      name: bounded(command.name, 128),
                      description: bounded(command.description, 512),
                  }))
            : [];
    } else if (event.command === "get_messages") {
        replaceMessages(state, data.messages);
    } else if (event.command === "set_model") {
        state.model = safeModel(data);
    } else if (event.command === "cycle_model") {
        state.model = safeModel(data.model);
        state.thinkingLevel = bounded(data.thinkingLevel || state.thinkingLevel, 32);
    }
}

function resetRunState(state) {
    const value = metadata(state);
    value.runActive = false;
    value.activeId = null;
    value.blocks.clear();
    state.queueCount = 0;
    for (const message of state.messages) {
        message.isRunning = false;
    }
}

function applyEvent(state, event) {
    if (!event || typeof event.type !== "string") {
        return state;
    }

    const value = metadata(state);
    if (event.type === "response") {
        applyResponse(state, event);
    } else if (event.type === "agent_start") {
        value.runActive = true;
        state.status = "busy";
        state.error = undefined;
    } else if (event.type === "agent_settled") {
        resetRunState(state);
        state.status = "ready";
    } else if (
        event.type === "message_start" ||
        event.type === "message_end" ||
        (event.type === "message_update" && event.message)
    ) {
        const message = event.message;
        if (message?.role === "assistant" && event.type === "message_start") {
            value.activeId = nextId(state);
            value.blocks.clear();
            if (Array.isArray(message.content)) {
                let remaining = MAX_MESSAGE_CHARS;
                for (const [index, part] of message.content.slice(0, 1_000).entries()) {
                    const kind =
                        part?.type === "text"
                            ? "text"
                            : part?.type === "thinking" && !part.redacted
                              ? "thinking"
                              : null;
                    if (kind) {
                        const text = bounded(part[kind]).slice(0, remaining);
                        value.blocks.set(index, { kind, text });
                        remaining -= text.length;
                    }
                }
            }
        }

        const id =
            message?.role === "assistant"
                ? value.activeId || nextId(state)
                : message?.role === "toolResult"
                  ? message.toolCallId
                  : message?.timestamp !== undefined
                    ? `user-${message.timestamp}`
                    : undefined;
        const projected = projectMessage(state, message, id);
        if (projected) {
            projected.isRunning = event.type !== "message_end" && projected.role === "assistant";
            upsert(state, projected);
        }

        setUsage(state, message?.usage);
        if (event.type === "message_end" && message?.role === "assistant") {
            value.activeId = null;
            value.blocks.clear();
        }
    } else if (event.type === "message_update") {
        applyDelta(state, event.assistantMessageEvent);
        setUsage(state, event.usage);
    } else if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(event.type)) {
        const id = typeof event.toolCallId === "string" ? bounded(event.toolCallId, 256) : nextId(state, "tool");
        const existing = state.messages.find((message) => message.id === id);
        const projectedContent = projectContent(
            event.type === "tool_execution_start" ? [] : (event.partialResult || event.result)?.content,
            existing?.images,
        );
        if ((event.toolName || existing?.toolName) === "delegate") {
            projectedContent.text =
                delegateResultText((event.partialResult || event.result)?.details) ?? projectedContent.text;
        }

        upsert(state, {
            id,
            role: "tool",
            toolName: bounded(event.toolName || existing?.toolName || "tool", 128),
            input:
                event.type === "tool_execution_start"
                    ? toolInput(event.args)
                    : (existing?.input ?? (event.args === undefined ? undefined : toolInput(event.args))),
            text: projectedContent.text,
            ...(projectedContent.images.length ? { images: projectedContent.images } : {}),
            isError: Boolean(event.isError),
            isRunning: event.type !== "tool_execution_end",
        });
    } else if (event.type === "queue_update") {
        state.queueCount =
            (Array.isArray(event.steering) ? event.steering.length : 0) +
            (Array.isArray(event.followUp) ? event.followUp.length : 0);
    } else if (
        ["compaction_start", "auto_compaction_start", "summarization_retry_attempt_start"].includes(event.type)
    ) {
        state.status = "compacting";
    } else if (["compaction_end", "auto_compaction_end"].includes(event.type)) {
        state.status = "busy";
        if (event.errorMessage) {
            state.error = bounded(event.errorMessage, 2_000);
        }
    } else if (["auto_retry_start", "summarization_retry_scheduled"].includes(event.type)) {
        state.status = "retrying";
    } else if (["auto_retry_end", "summarization_retry_finished"].includes(event.type)) {
        state.status = "busy";
        if (event.success === false) {
            state.error = bounded(event.finalError || "Automatic retry failed.", 2_000);
        }
    } else if (event.type === "extension_error") {
        state.error = bounded(event.error || "A Pi extension reported an error.", 2_000);
    }

    return state;
}

module.exports = {
    createState,
    applyEvent,
    resetRunState,
    replaceMessages,
    safeModel,
    appendNotice,
    enforceBounds: trimMessages,
    MAX_MESSAGES,
    MAX_MESSAGE_CHARS,
    MAX_TRANSCRIPT_CHARS,
    MAX_TOOL_INPUT_CHARS,
    MAX_MESSAGE_IMAGES,
    MAX_TRANSCRIPT_IMAGES,
    MAX_TRANSCRIPT_IMAGE_BYTES,
};
