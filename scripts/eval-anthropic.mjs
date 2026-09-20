// Anthropic Messages API <-> OpenAI chat-completions, for the one harness that speaks the other
// protocol.
//
// Every other harness in this suite talks chat-completions, or in Codex's case the Responses API,
// and the provider the whole suite runs against is chat-completions only. Claude Code speaks the
// Messages API and nothing else, so measuring it at all means translating both directions.
//
// TRANSLATE AT THE EDGE, NOT THROUGHOUT. The request is converted to the OpenAI shape before the
// proxy records anything, and the upstream reply is converted back only on the way out. That is the
// whole reason this file exists as a boundary rather than as a second set of branches inside
// eval-proxy: `summarizeRequest`, `toolOutcomeOf`, `extractUsage`, `extractToolCalls` and the cost
// pipeline all parse the OpenAI shape, and teaching each of them a second one would be six places
// to drift instead of one place to read.
//
// The stream is rebuilt rather than piped. `startProxy` already buffers the whole upstream reply
// before answering, so no streaming fidelity exists to lose: this collects the OpenAI deltas into
// one finished message and emits a well-formed Anthropic event sequence for it. Incremental
// translation would be more code for a property this proxy does not have.

/** A Messages request carries content as blocks; chat-completions wants strings and tool_calls. */
function textOf(content) {
    if (typeof content === "string") {
        return content;
    }

    return (Array.isArray(content) ? content : [])
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("");
}

/**
 * One Messages `user` turn can carry several tool results, and chat-completions has no way to say
 * that in one message: each result is its own `role: "tool"` message keyed by call id. So a turn
 * expands to zero or more tool messages followed by whatever text remained.
 */
function expandUser(message) {
    const blocks = Array.isArray(message.content) ? message.content : [];
    const out = [];
    for (const block of blocks) {
        if (block?.type !== "tool_result") {
            continue;
        }

        out.push({
            role: "tool",
            tool_call_id: String(block.tool_use_id ?? ""),
            // A tool result is itself a block list when the tool returned structured content, and
            // an error result is still a result: the model has to see what failed, so `is_error`
            // becomes visible text rather than a dropped message.
            content: block.is_error === true ? `Error: ${textOf(block.content)}` : textOf(block.content),
        });
    }

    const text = textOf(message.content);
    if (text.length > 0 || out.length === 0) {
        out.push({ role: "user", content: text });
    }

    return out;
}

function expandAssistant(message) {
    const blocks = Array.isArray(message.content) ? message.content : [];
    const calls = blocks
        .filter((block) => block?.type === "tool_use")
        .map((block) => ({
            id: String(block.id ?? ""),
            type: "function",
            function: { name: String(block.name ?? ""), arguments: JSON.stringify(block.input ?? {}) },
        }));
    const text = textOf(message.content);
    const out = { role: "assistant", content: text };
    if (calls.length > 0) {
        out.tool_calls = calls;
    }

    return [out];
}

function toolChoice(choice) {
    if (!choice || typeof choice !== "object") {
        return undefined;
    }

    if (choice.type === "tool" && choice.name) {
        return { type: "function", function: { name: String(choice.name) } };
    }

    // `any` means "a tool, your pick", which chat-completions spells `required`.
    return choice.type === "any" ? "required" : choice.type === "auto" ? "auto" : undefined;
}

/** Messages request -> chat-completions request. */
export function toChatCompletions(body) {
    const messages = [];
    const system = textOf(body?.system);
    if (system.length > 0) {
        messages.push({ role: "system", content: system });
    }

    for (const message of Array.isArray(body?.messages) ? body.messages : []) {
        if (typeof message?.content === "string") {
            messages.push({ role: message.role === "assistant" ? "assistant" : "user", content: message.content });
            continue;
        }

        messages.push(...(message?.role === "assistant" ? expandAssistant(message) : expandUser(message)));
    }

    const out = {
        model: body?.model ?? "unknown",
        messages,
        stream: body?.stream !== false,
    };
    if (Number.isFinite(body?.max_tokens)) {
        out.max_tokens = body.max_tokens;
    }

    if (Number.isFinite(body?.temperature)) {
        out.temperature = body.temperature;
    }

    const tools = Array.isArray(body?.tools) ? body.tools : [];
    if (tools.length > 0) {
        out.tools = tools.map((tool) => ({
            type: "function",
            function: {
                name: String(tool?.name ?? ""),
                description: String(tool?.description ?? ""),
                parameters: tool?.input_schema ?? { type: "object", properties: {} },
            },
        }));
    }

    const choice = toolChoice(body?.tool_choice);
    if (choice !== undefined) {
        out.tool_choice = choice;
    }

    return out;
}

/**
 * Fold a chat-completions reply -- streamed or whole -- into the finished assistant message.
 *
 * Tool-call arguments arrive as string fragments keyed by index, so they are concatenated in
 * arrival order and parsed once at the end. A fragment set that never parses is surfaced as an
 * empty object rather than dropped: a tool call the model made and the harness never saw would read
 * downstream as a turn that did nothing.
 */
export function collectChatReply(text) {
    const parts = { text: "", calls: new Map(), usage: null, finish: null, model: null, id: null };
    const takeChoice = (choice) => {
        const delta = choice?.delta ?? choice?.message ?? {};
        if (typeof delta.content === "string") {
            parts.text += delta.content;
        }

        for (const [index, call] of (delta.tool_calls ?? []).entries()) {
            const key = Number.isFinite(call?.index) ? call.index : index;
            const held = parts.calls.get(key) ?? { id: "", name: "", arguments: "" };
            if (call?.id) {
                held.id = String(call.id);
            }

            if (call?.function?.name) {
                held.name = String(call.function.name);
            }

            if (typeof call?.function?.arguments === "string") {
                held.arguments += call.function.arguments;
            }

            parts.calls.set(key, held);
        }

        if (choice?.finish_reason) {
            parts.finish = choice.finish_reason;
        }
    };

    const takeBody = (body) => {
        if (body?.usage && typeof body.usage === "object") {
            parts.usage = body.usage;
        }

        if (body?.model) {
            parts.model = String(body.model);
        }

        if (body?.id) {
            parts.id = String(body.id);
        }

        for (const choice of body?.choices ?? []) {
            takeChoice(choice);
        }
    };

    try {
        takeBody(JSON.parse(text));
    } catch {
        for (const line of String(text).split("\n")) {
            const payload = line.startsWith("data:") ? line.slice("data:".length).trim() : "";
            if (!payload || payload === "[DONE]") {
                continue;
            }

            try {
                takeBody(JSON.parse(payload));
            } catch {
                // A malformed frame in the middle of a stream is not a reason to lose the rest.
            }
        }
    }

    const calls = [...parts.calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, call], position) => {
            let input = {};
            try {
                input = call.arguments.length > 0 ? JSON.parse(call.arguments) : {};
            } catch {
                input = {};
            }

            return { id: call.id || `toolu_eval_${position}`, name: call.name, input };
        })
        .filter((call) => call.name.length > 0);

    return { text: parts.text, calls, usage: parts.usage, finish: parts.finish, model: parts.model, id: parts.id };
}

const STOP = { tool_calls: "tool_use", length: "max_tokens", stop: "end_turn", content_filter: "end_turn" };

function frame(type, payload) {
    return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** The finished message as an Anthropic event stream. */
export function toMessagesStream(reply, { model }) {
    const id = reply.id ? `msg_${reply.id}` : `msg_eval_${Date.now()}`;
    const stopReason = reply.calls.length > 0 ? "tool_use" : (STOP[reply.finish] ?? "end_turn");
    const inputTokens = reply.usage?.prompt_tokens ?? 0;
    const outputTokens = reply.usage?.completion_tokens ?? 0;
    let out = frame("message_start", {
        type: "message_start",
        message: {
            id,
            type: "message",
            role: "assistant",
            model: reply.model ?? model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
    });

    let index = 0;
    if (reply.text.length > 0) {
        out += frame("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
        });
        out += frame("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: reply.text },
        });
        out += frame("content_block_stop", { type: "content_block_stop", index });
        index += 1;
    }

    for (const call of reply.calls) {
        out += frame("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
        });
        // The input arrives whole, but the client's parser expects it through the delta channel, so
        // it ships as one fragment rather than on the start frame.
        out += frame("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input ?? {}) },
        });
        out += frame("content_block_stop", { type: "content_block_stop", index });
        index += 1;
    }

    out += frame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
    });
    out += frame("message_stop", { type: "message_stop" });

    return out;
}

/** The same finished message as a whole-body reply, for a client that did not ask to stream. */
export function toMessagesBody(reply, { model }) {
    const content = [];
    if (reply.text.length > 0) {
        content.push({ type: "text", text: reply.text });
    }

    for (const call of reply.calls) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input ?? {} });
    }

    return {
        id: reply.id ? `msg_${reply.id}` : `msg_eval_${Date.now()}`,
        type: "message",
        role: "assistant",
        model: reply.model ?? model,
        content,
        stop_reason: reply.calls.length > 0 ? "tool_use" : (STOP[reply.finish] ?? "end_turn"),
        stop_sequence: null,
        usage: {
            input_tokens: reply.usage?.prompt_tokens ?? 0,
            output_tokens: reply.usage?.completion_tokens ?? 0,
        },
    };
}

/** Offline stand-in, matching what `syntheticStream` does for the chat-completions harnesses. */
export function syntheticMessagesStream(model) {
    return toMessagesStream({ text: "ok", calls: [], usage: null, finish: "stop", model, id: null }, { model });
}
