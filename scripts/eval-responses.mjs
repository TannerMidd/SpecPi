// OpenAI chat-completions <-> the Responses API, for the models that serve only the latter.
//
// The suite's provider serves most of its catalogue on /chat/completions, and the harnesses were
// measured against that wire. A few models -- muse-spark-*, gpt-5.6-luna, grok-4.6 -- answer only
// on /responses: a chat-completions request to them returns 503 "Endpoint is unavailable", which
// is not an outage but the shape of the endpoint. Codex already speaks Responses and reaches them
// unaided; every other harness in the suite speaks chat-completions and cannot, so measuring a
// model like that at all means translating both directions.
//
// TRANSLATE AT THE EDGE, NOT THROUGHOUT -- the same rule as the Messages bridge next door. The
// proxy records the chat-completions request it was given, translates on the way out, and
// translates the reply back on the way in. `summarizeRequest`, `toolOutcomeOf`, `extractUsage`,
// `extractToolCalls` and the cost pipeline keep reading the one shape they have always read.
//
// The stream is rebuilt rather than piped, for the reason eval-anthropic.mjs gives: the proxy
// already buffers the whole upstream reply before answering, so there is no streaming fidelity
// left to preserve by translating incrementally.
//
// WHAT IS DROPPED, AND WHY IT IS SAFE. A reasoning model returns `reasoning` items carrying
// encrypted content, and chat-completions has nowhere to put them, so they do not survive the
// translation -- exactly as `reasoning_content` does not survive the chat path. Their tokens are
// not lost: the provider counts them in `output_tokens_details.reasoning_tokens`, and
// `normalizeUsage` folds that into `completion_tokens` so they are billed at the output rate.

/** Chat-completions carries content as a string or as typed parts; the Responses API wants parts. */
function textOf(content) {
    if (typeof content === "string") {
        return content;
    }

    return (Array.isArray(content) ? content : [])
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("");
}

// An assistant turn holding tool calls is one chat message but several Responses items: the text,
// then one `function_call` per call. A turn with no text contributes no message item at all, which
// is what the API expects -- an empty assistant message is rejected by some providers and means
// nothing to any of them.
function expandAssistant(message) {
    const items = [];
    const text = textOf(message?.content);
    if (text.length > 0) {
        items.push({ role: "assistant", content: [{ type: "output_text", text }] });
    }

    for (const call of message?.tool_calls ?? []) {
        items.push({
            type: "function_call",
            call_id: String(call?.id ?? ""),
            name: String(call?.function?.name ?? ""),
            // Arguments are already a JSON string on this wire and stay one on the other.
            arguments: typeof call?.function?.arguments === "string" ? call.function.arguments : "{}",
        });
    }

    return items;
}

// System text stays an `input` item rather than being hoisted into `instructions`. Both are
// accepted and the endpoint answers the same either way, but hoisting reorders a conversation
// whose system message is not first, and splits the prefix in two. Keeping every message in one
// append-only array is what the provider's prompt cache is matching on.
function toInputItem(message) {
    const role = message?.role;
    if (role === "assistant") {
        return expandAssistant(message);
    }

    if (role === "tool") {
        return [
            {
                type: "function_call_output",
                call_id: String(message?.tool_call_id ?? ""),
                output: textOf(message?.content),
            },
        ];
    }

    return [
        {
            role: role === "system" || role === "developer" ? "system" : "user",
            content: [{ type: "input_text", text: textOf(message?.content) }],
        },
    ];
}

// Chat-completions nests a tool under `function`; the Responses API names it at the top level.
function toResponsesTool(tool) {
    const declared = tool?.function ?? tool;

    return {
        type: "function",
        name: String(declared?.name ?? ""),
        description: String(declared?.description ?? ""),
        parameters: declared?.parameters ?? { type: "object", properties: {} },
    };
}

function toResponsesToolChoice(choice) {
    if (typeof choice === "string") {
        return choice;
    }

    if (choice?.type === "function" && choice?.function?.name) {
        return { type: "function", name: String(choice.function.name) };
    }

    return undefined;
}

/** Chat-completions request -> Responses request. */
export function toResponsesRequest(body) {
    const out = {
        model: body?.model ?? "unknown",
        input: (Array.isArray(body?.messages) ? body.messages : []).flatMap(toInputItem),
        stream: body?.stream === true,
    };
    // Both names cap the same quantity -- everything the model emits, reasoning included -- so the
    // harness's budget carries over unchanged. A reasoning model can spend the whole of it before
    // it writes a visible word, which is the model's behaviour and not something to correct here.
    const cap = Number.isFinite(body?.max_completion_tokens) ? body.max_completion_tokens : body?.max_tokens;
    if (Number.isFinite(cap)) {
        out.max_output_tokens = cap;
    }

    if (Number.isFinite(body?.temperature)) {
        out.temperature = body.temperature;
    }

    if (Number.isFinite(body?.top_p)) {
        out.top_p = body.top_p;
    }

    if (typeof body?.parallel_tool_calls === "boolean") {
        out.parallel_tool_calls = body.parallel_tool_calls;
    }

    const tools = Array.isArray(body?.tools) ? body.tools : [];
    if (tools.length > 0) {
        out.tools = tools.map(toResponsesTool);
    }

    const choice = toResponsesToolChoice(body?.tool_choice);
    if (choice !== undefined) {
        out.tool_choice = choice;
    }

    return out;
}

// Responses API usage names the same quantities differently: input_tokens include cache rereads
// (like prompt_tokens), output_tokens EXCLUDE reasoning, and the cached portion sits under
// input_tokens_details. It is folded into the chat-completions field names here so every
// downstream rule -- fresh input priced as input, reasoning billed at the output rate -- applies
// unchanged to both wire shapes.
export function normalizeUsage(usage) {
    if (!usage || typeof usage !== "object" || !Number.isFinite(usage.input_tokens)) {
        return usage;
    }

    const reasoning = usage.output_tokens_details?.reasoning_tokens ?? 0;

    return {
        prompt_tokens: usage.input_tokens,
        completion_tokens: (usage.output_tokens ?? 0) + reasoning,
        prompt_tokens_details: { cached_tokens: usage.input_tokens_details?.cached_tokens ?? 0 },
        reasoning_tokens: reasoning,
    };
}

/**
 * Fold a Responses reply -- streamed or whole -- into the same finished-message shape
 * `collectChatReply` returns, so the emitters downstream need not know which wire it came from.
 *
 * A streamed function call is announced twice under one id, once on `output_item.added` without
 * arguments and again on `.done` with them, and its arguments also arrive as their own delta
 * stream. Calls are therefore keyed by id and the longest argument string seen wins, which is
 * correct whether the provider sends deltas, the finished item, or both.
 */
export function collectResponsesReply(text) {
    const parts = { text: "", calls: new Map(), usage: null, finish: null, model: null, id: null };
    const noteCall = (key, { name, args }) => {
        const held = parts.calls.get(key) ?? { id: key, name: "", arguments: "" };
        if (name) {
            held.name = String(name);
        }

        if (typeof args === "string" && args.length >= held.arguments.length) {
            held.arguments = args;
        }

        parts.calls.set(key, held);
    };

    const takeItem = (item) => {
        if (item?.type === "message") {
            parts.text += (item.content ?? [])
                .filter((part) => part?.type === "output_text")
                .map((part) => part.text ?? "")
                .join("");

            return;
        }

        if (item?.type === "function_call") {
            noteCall(String(item.call_id ?? item.id ?? ""), { name: item.name, args: item.arguments });
        }
    };

    const takeResponse = (response) => {
        if (response?.id) {
            parts.id = String(response.id);
        }

        if (response?.model) {
            parts.model = String(response.model);
        }

        if (response?.usage && typeof response.usage === "object") {
            parts.usage = response.usage;
        }

        if (response?.incomplete_details?.reason === "max_output_tokens") {
            parts.finish = "length";
        }

        for (const item of response?.output ?? []) {
            takeItem(item);
        }
    };

    try {
        takeResponse(JSON.parse(text));
    } catch {
        // Not a whole body; read it as the event stream it must be.
        //
        // A stream says the assistant's text twice: once as `output_text.delta` fragments and
        // again whole on the finished message item. Accumulating both concatenates the reply to
        // itself, so the two are collected apart and the finished item wins -- it is the
        // provider's own final word, and the deltas are only needed when the stream was cut off
        // before one arrived.
        const streamedArguments = new Map();
        const streamedText = { delta: "", item: "" };
        // Arguments are keyed by item id and calls by call id, and the two are only ever joined by
        // an output_item event, so the association has to be kept as those go past.
        const callOfItem = new Map();
        for (const line of String(text).split("\n")) {
            const payload = line.startsWith("data:") ? line.slice("data:".length).trim() : "";
            if (!payload || payload === "[DONE]") {
                continue;
            }

            let event = null;
            try {
                event = JSON.parse(payload);
            } catch {
                // A malformed frame mid-stream is not a reason to lose the rest.
                continue;
            }

            if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
                streamedText.delta += event.delta;
                continue;
            }

            if (event?.type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
                const key = String(event.item_id ?? "");
                streamedArguments.set(key, (streamedArguments.get(key) ?? "") + event.delta);
                continue;
            }

            if (String(event?.type).startsWith("response.output_item.")) {
                // The item id is what the argument deltas are keyed by, while call_id is what the
                // next request has to quote back, so both are needed to join the two together.
                const item = event.item ?? {};
                if (item.type === "function_call") {
                    const key = String(item.call_id ?? item.id ?? "");
                    callOfItem.set(String(item.id ?? key), key);
                    noteCall(key, { name: item.name, args: item.arguments });
                } else if (item.type === "message" && event.type === "response.output_item.done") {
                    streamedText.item += (item.content ?? [])
                        .filter((part) => part?.type === "output_text")
                        .map((part) => part.text ?? "")
                        .join("");
                }

                continue;
            }

            if (event?.response) {
                // The terminal event repeats the whole output, which the deltas above already
                // built, so only the envelope -- id, model, usage, truncation -- is taken from it.
                const { output, ...envelope } = event.response;
                takeResponse(envelope);
            }
        }

        // The call is announced before its arguments are streamed, so at announcement time there
        // is nothing to attach. Reconciling here rather than there is what keeps a call whole when
        // the stream ends without the finished item that would otherwise have carried the
        // arguments -- a tool call the harness receives with empty arguments is not a lost byte,
        // it is a turn that does nothing, and it reads downstream as the harness failing.
        for (const [itemId, args] of streamedArguments) {
            noteCall(callOfItem.get(itemId) ?? itemId, { name: "", args });
        }

        parts.text = streamedText.item.length > 0 ? streamedText.item : streamedText.delta;
    }

    const calls = [...parts.calls.values()]
        .map((call, position) => {
            let input = {};
            try {
                input = call.arguments.length > 0 ? JSON.parse(call.arguments) : {};
            } catch {
                input = {};
            }

            return { id: call.id || `call_eval_${position}`, name: call.name, input, arguments: call.arguments };
        })
        .filter((call) => call.name.length > 0);

    return {
        text: parts.text,
        calls,
        usage: normalizeUsage(parts.usage),
        finish: parts.finish,
        model: parts.model,
        id: parts.id,
    };
}

function chatToolCalls(reply) {
    return reply.calls.map((call, index) => ({
        index,
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments ?? JSON.stringify(call.input ?? {}) },
    }));
}

function finishReason(reply) {
    if (reply.calls.length > 0) {
        return "tool_calls";
    }

    return reply.finish ?? "stop";
}

function chatUsage(reply) {
    if (!reply.usage) {
        return null;
    }

    const prompt = reply.usage.prompt_tokens ?? 0;
    const completion = reply.usage.completion_tokens ?? 0;

    return {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        prompt_tokens_details: reply.usage.prompt_tokens_details ?? { cached_tokens: 0 },
    };
}

/** The finished message as a chat-completions event stream. */
export function toChatStream(reply, { model }) {
    const id = reply.id ? `chatcmpl_${reply.id}` : `chatcmpl_eval_${Date.now()}`;
    const chunk = (choices, extra = {}) => {
        const event = {
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: reply.model ?? model,
            choices,
            ...extra,
        };

        return `data: ${JSON.stringify(event)}\n\n`;
    };

    let out = chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
    if (reply.text.length > 0) {
        out += chunk([{ index: 0, delta: { content: reply.text }, finish_reason: null }]);
    }

    const calls = chatToolCalls(reply);
    if (calls.length > 0) {
        out += chunk([{ index: 0, delta: { tool_calls: calls }, finish_reason: null }]);
    }

    // Usage rides the final chunk, which is where `extractUsage` and every harness look for it.
    out += chunk([{ index: 0, delta: {}, finish_reason: finishReason(reply) }], { usage: chatUsage(reply) });

    return `${out}data: [DONE]\n\n`;
}

/** The same finished message as a whole body, for a client that did not ask to stream. */
export function toChatBody(reply, { model }) {
    const calls = chatToolCalls(reply);
    const message = { role: "assistant", content: reply.text.length > 0 ? reply.text : null };
    if (calls.length > 0) {
        message.tool_calls = calls.map(({ index, ...call }) => call);
    }

    const usage = chatUsage(reply);

    return {
        id: reply.id ? `chatcmpl_${reply.id}` : `chatcmpl_eval_${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: reply.model ?? model,
        choices: [{ index: 0, message, finish_reason: finishReason(reply), logprobs: null }],
        ...(usage ? { usage } : {}),
    };
}
