#!/usr/bin/env node
// Logging OpenAI-completions proxy for evals. Every harness points at the
// proxy; the proxy either answers synthetically (Tier 1, $0, offline) or
// forwards to a real provider and logs usage. The log is the single source
// for tokens, tool calls, first-call context and cost math.

import http from "node:http";
import { createHash } from "node:crypto";

function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on("data", (chunk) => {
            chunks.push(chunk);
        });
        request.on("end", () => {
            resolve(Buffer.concat(chunks).toString("utf8"));
        });
        request.on("error", (error) => {
            reject(error);
        });
    });
}

function syntheticStream(model) {
    const event = (choices) => {
        return {
            id: "eval",
            object: "chat.completion.chunk",
            created: 1,
            model,
            choices,
        };
    };

    const first = `data: ${JSON.stringify(event([{ index: 0, delta: { role: "assistant", content: "ok" } }]))}\n\n`;
    const last = `data: ${JSON.stringify(event([{ index: 0, delta: {}, finish_reason: "stop" }]))}\n\n`;

    return `${first}${last}data: [DONE]\n\n`;
}

// Codex CLI speaks only the Responses API, so it gets the synthetic answer in
// that shape: one assistant message, then a completed event carrying zero
// usage — the offline run makes no model call, and the report says so.
function syntheticResponsesStream(model) {
    const response = { id: "eval", object: "response", created_at: 1, model, status: "completed", output: [] };
    const event = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;

    return [
        event("response.created", { response: { ...response, status: "in_progress" } }),
        event("response.output_item.done", {
            output_index: 0,
            item: {
                id: "eval-message",
                type: "message",
                status: "completed",
                role: "assistant",
                content: [{ type: "output_text", text: "ok", annotations: [] }],
            },
        }),
        event("response.completed", {
            response: {
                ...response,
                usage: {
                    input_tokens: 0,
                    output_tokens: 0,
                    total_tokens: 0,
                    input_tokens_details: { cached_tokens: 0 },
                    output_tokens_details: { reasoning_tokens: 0 },
                },
            },
        }),
        "data: [DONE]\n\n",
    ].join("");
}

function contentText(content) {
    if (typeof content === "string") {
        return content;
    }

    if (Array.isArray(content)) {
        return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
    }

    return "";
}

// Requests arrive in two shapes. Chat completions name tools inside a
// `function` field and put the system text in `messages`; the Responses API
// (which Codex CLI speaks) names tools at the top level, carries the system
// text in `instructions`, and puts the conversation in `input`. Both are
// read here so a harness is measured the same way whichever wire protocol
// it needs.
export function summarizeRequest(body) {
    const tools = Array.isArray(body?.tools) ? body.tools : [];
    const items = [
        ...(Array.isArray(body?.messages) ? body.messages : []),
        ...(Array.isArray(body?.input) ? body.input : []),
    ];
    const instructionText = [
        typeof body?.instructions === "string" ? body.instructions : "",
        ...items
            .filter((item) => ["system", "developer"].includes(item?.role))
            .map((item) => contentText(item.content)),
    ].join("");
    const toolNames = tools.map((tool) => tool?.function?.name ?? tool?.name ?? tool?.type ?? "unknown").sort();

    return {
        toolCount: tools.length,
        toolNames,
        toolSchemaChars: JSON.stringify(tools).length,
        instructionChars: instructionText.length,
        requestSha256: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    };
}

// Some harnesses fire auxiliary model calls (session titles) that carry no
// tool schema. The conversation request is the first one offering tools;
// harnesses without auxiliaries are unaffected because their first request
// already carries the schema.
export function conversationSummary(requests) {
    const conversation = requests.find((record) => (record.summary?.toolCount ?? 0) > 0) ?? requests[0];
    if (!conversation) {
        return summarizeRequest({ tools: [], messages: [] });
    }

    return conversation.summary;
}

export function normalizeToolName(name) {
    const lower = String(name ?? "").toLowerCase();
    const aliases = {
        bash: "bash",
        pwsh: "bash",
        shell: "bash",
        exec: "bash",
        exec_command: "bash",
        write_stdin: "bash",
        read: "read",
        read_image: "read",
        view_image: "read",
        write: "write",
        edit: "edit",
        apply_patch: "edit",
        glob: "glob",
        grep: "grep",
        search: "grep",
        web_search: "web_search",
        web_fetch: "web_fetch",
        webfetch: "web_fetch",
        fetch_content: "web_fetch",
        task: "subagent",
        subagent: "subagent",
        delegate: "subagent",
        multi_agent_v1: "subagent",
        spawn_agent: "subagent",
        close_agent: "subagent",
        resume_agent: "subagent",
        send_input: "subagent",
        wait_agent: "subagent",
    };

    return aliases[lower] ?? lower;
}

// Responses API usage names the same quantities differently: input_tokens
// include cache rereads (like prompt_tokens), output_tokens EXCLUDE
// reasoning, and the cached portion sits under input_tokens_details. It is
// folded into the chat-completions field names here so every downstream
// rule — fresh input priced as input, reasoning billed at the output rate —
// applies unchanged to both wire shapes.
function normalizeUsage(usage) {
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

// Usage arrives either as a top-level field on a JSON completion or in
// the final data chunk of an event stream. Returns the usage object or null
// when neither carries one.
export function extractUsage(text) {
    try {
        return normalizeUsage(JSON.parse(text).usage ?? null);
    } catch {
        // Not plain JSON; fall through to the event-stream scan.
    }

    let usage = null;
    for (const line of String(text).split("\n")) {
        const payload = line.startsWith("data:") ? line.slice("data:".length).trim() : "";
        if (!payload || payload === "[DONE]") {
            continue;
        }

        try {
            const event = JSON.parse(payload);
            if (event?.usage && typeof event.usage === "object") {
                usage = event.usage;
            } else if (event?.type === "response.completed" && event?.response?.usage) {
                usage = event.response.usage;
            }
        } catch {
            continue;
        }
    }

    return normalizeUsage(usage);
}

// Responses API function calls arrive as `function_call` items, either in a
// non-streaming body's `output` array or in output_item events. A streaming
// call is announced twice (added, then done) under the same id, so items are
// deduplicated by call id and the name is taken from whichever carries it.
function responseToolCalls(items) {
    const seen = new Set();
    const names = [];
    for (const [index, entry] of (items ?? []).entries()) {
        const item = entry?.item ?? entry;
        if (item?.type !== "function_call") {
            continue;
        }

        const key = item.call_id ?? item.id ?? `item-${index}`;
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        if (typeof item.name === "string" && item.name.length > 0) {
            names.push(item.name);
        }
    }

    return names;
}

// Tool calls arrive either on a JSON completion's message or spread across
// an event stream's deltas, where only the first fragment for a given index
// carries the name and the rest carry argument text. Returns the tools the
// model actually invoked; the request's tool list is what it was offered,
// which is schema weight on every request and never a call.
export function extractToolCalls(text) {
    const named = (calls) => (calls ?? []).map((call) => call?.function?.name).filter((name) => Boolean(name));
    try {
        const body = JSON.parse(text);
        const chatCalls = (body?.choices ?? []).flatMap((choice) => named(choice?.message?.tool_calls));

        return [...chatCalls, ...responseToolCalls(body?.output ?? [])];
    } catch {
        // Not plain JSON; fall through to the event-stream scan.
    }

    const streamed = new Map();
    const responsesItems = [];
    for (const line of String(text).split("\n")) {
        const payload = line.startsWith("data:") ? line.slice("data:".length).trim() : "";
        if (!payload || payload === "[DONE]") {
            continue;
        }

        let event = null;
        try {
            event = JSON.parse(payload);
        } catch {
            continue;
        }

        if (String(event?.type).startsWith("response.output_item.")) {
            responsesItems.push(event);
            continue;
        }

        for (const choice of event?.choices ?? []) {
            for (const call of choice?.delta?.tool_calls ?? []) {
                const name = call?.function?.name;
                // Later fragments for the same index repeat the id without a
                // name, so the first named fragment per slot is the call.
                const key = `${choice?.index ?? 0}:${call?.index ?? 0}`;
                if (name && !streamed.has(key)) {
                    streamed.set(key, name);
                }
            }
        }
    }

    return [...streamed.values(), ...responseToolCalls(responsesItems)];
}

// Tool outcomes. Every request carries the conversation so far, so the
// request holding the most tool results holds the fullest record of the run
// — scanning one request avoids double counting, and taking the max rather
// than the last stays correct when a harness compacts its history.
//
// The OpenAI tool-message shape has no error field: a failed tool returns its
// error as ordinary text. Classification is therefore a signature match, and
// is reported as "results matching an error signature" rather than as ground
// truth. The matched signature is recorded; the tool output never is.
const ERROR_SIGNATURES = [
    ["enoent", /\benoent\b/iu],
    ["no-such-file", /\bno such file or directory\b/iu],
    ["not-found", /\b(?:command not found|could not find)\b/iu],
    ["permission", /\b(?:permission denied|eacces|eperm)\b/iu],
    ["traceback", /\b(?:traceback|unhandled exception)\b/iu],
    ["nonzero-exit", /\bexit(?:ed with)? code [1-9]\d*\b/iu],
    ["error-prefix", /^\s*(?:error|err)\b\s*[:!]/iu],
    ["failed", /\b(?:failed to|failure:)/iu],
];

function toolMessageText(message) {
    if (typeof message?.content === "string") {
        return message.content;
    }

    if (Array.isArray(message?.content)) {
        return message.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join(" ");
    }

    return "";
}

// Responses API tool results travel as `function_call_output` items in the
// request's `input` array, holding the output as a string or content parts.
function functionCallOutputText(item) {
    if (typeof item?.output === "string") {
        return item.output;
    }

    if (Array.isArray(item?.output)) {
        return item.output.map((part) => (typeof part?.text === "string" ? part.text : "")).join(" ");
    }

    return "";
}

function classifyToolResult(text, current, tool = "") {
    const bucket = (current.byTool[tool || "unknown"] ??= { results: 0, errors: 0 });
    bucket.results += 1;
    for (const [name, pattern] of ERROR_SIGNATURES) {
        if (pattern.test(text)) {
            current.errors += 1;
            bucket.errors += 1;
            current.signatures[name] = (current.signatures[name] ?? 0) + 1;

            return;
        }
    }
}

// A request carries the whole conversation, so the assistant's tool_calls and
// the tool messages answering them are both in it: the id joins a result back
// to the tool that produced it. Without that join an error is only ever "a
// tool failed", which cannot separate a harness with a flaky shell from one
// with a flaky editor.
function toolNamesById(messages, inputItems) {
    const names = new Map();
    for (const message of messages) {
        for (const call of message?.tool_calls ?? []) {
            if (call?.id && call?.function?.name) {
                names.set(call.id, call.function.name);
            }
        }
    }

    for (const item of inputItems) {
        if (item?.type === "function_call" && item?.call_id && item?.name) {
            names.set(item.call_id, item.name);
        }
    }

    return names;
}

// Repeats of the same call with the same arguments. One retry after a failure
// is recovery; the same failing command sent ten times is a harness that
// cannot tell it is stuck, and only the count separates them.
function repeatedCalls(messages, inputItems) {
    const seen = new Map();
    const note = (name, args) => {
        if (!name) {
            return;
        }

        const key = `${name} :: ${typeof args === "string" ? args : JSON.stringify(args ?? null)}`;

        seen.set(key, (seen.get(key) ?? 0) + 1);
    };

    for (const message of messages) {
        for (const call of message?.tool_calls ?? []) {
            note(call?.function?.name, call?.function?.arguments);
        }
    }

    for (const item of inputItems) {
        if (item?.type === "function_call") {
            note(item?.name, item?.arguments);
        }
    }

    let repeats = 0;
    for (const count of seen.values()) {
        if (count > 1) {
            repeats += count - 1;
        }
    }

    return repeats;
}

export function summarizeToolResults(requests) {
    let best = { results: 0, errors: 0, signatures: {}, byTool: {}, repeatedCalls: 0 };
    for (const record of requests) {
        const messages = Array.isArray(record?.body?.messages) ? record.body.messages : [];
        const inputItems = Array.isArray(record?.body?.input) ? record.body.input : [];
        const current = {
            results: 0,
            errors: 0,
            signatures: {},
            byTool: {},
            repeatedCalls: repeatedCalls(messages, inputItems),
        };
        const names = toolNamesById(messages, inputItems);
        for (const message of messages) {
            if (message?.role !== "tool") {
                continue;
            }

            current.results += 1;
            classifyToolResult(toolMessageText(message), current, names.get(message?.tool_call_id) ?? "");
        }

        for (const item of inputItems) {
            if (item?.type !== "function_call_output") {
                continue;
            }

            current.results += 1;
            classifyToolResult(functionCallOutputText(item), current, names.get(item?.call_id) ?? "");
        }

        if (current.results > best.results) {
            best = current;
        }
    }

    return best;
}

// A Responses-API request needs the provider's responses endpoint, while the
// configured forward URL names its chat-completions endpoint. The suffix swap
// covers the OpenAI-compatible providers the suite uses; any other URL is
// kept as configured, so a single-endpoint proxy still receives the request.
export function deriveResponsesUrl(forwardUrl) {
    const suffix = "/chat/completions";

    return String(forwardUrl).endsWith(suffix) ? `${forwardUrl.slice(0, -suffix.length)}/responses` : forwardUrl;
}

export function startProxy({
    forwardUrl,
    responsesForwardUrl = process.env.EVAL_FORWARD_RESPONSES_URL || undefined,
    sessionId,
} = {}) {
    // Forwarding credentials travel process-local only: they are read here
    // at request time and never written to the request log or reports.
    // The OpenCode Go endpoint additionally routes on a live session id,
    // minted per attempt and fixed for that attempt's proxy.
    const forwardKey = process.env.EVAL_FORWARD_KEY || undefined;
    const forwardModel = process.env.EVAL_FORWARD_MODEL || undefined;
    const requests = [];
    const server = http.createServer(async (request, response) => {
        try {
            const raw = await readBody(request);
            const body = raw.length > 0 ? JSON.parse(raw) : {};
            const responsesRequest = (request.url ?? "").split("?")[0].endsWith("/responses");
            const summary = summarizeRequest(body);
            const record = {
                at: new Date().toISOString(),
                model: body.model ?? "unknown",
                summary,
                // Kept for the tool-outcome scan; never written to report.json.
                body,
                usage: null,
                toolCalls: [],
                forwarded: Boolean(forwardUrl),
            };
            requests.push(record);
            if (!forwardUrl) {
                response.writeHead(200, { "Content-Type": "text/event-stream" });
                response.end(
                    responsesRequest
                        ? syntheticResponsesStream(body.model ?? "measure-model")
                        : syntheticStream(body.model ?? "measure-model"),
                );

                return;
            }

            const upstreamUrl = responsesRequest ? (responsesForwardUrl ?? deriveResponsesUrl(forwardUrl)) : forwardUrl;

            let payload = raw;
            if (forwardModel) {
                payload = JSON.stringify({ ...body, model: forwardModel });
            }

            const headers = { "Content-Type": "application/json" };
            if (forwardKey) {
                headers.Authorization = `Bearer ${forwardKey}`;
            }

            if (sessionId) {
                headers["x-opencode-session"] = sessionId;
            }

            const upstream = await fetch(upstreamUrl, { method: "POST", headers, body: payload });
            const text = await upstream.text();
            record.usage = extractUsage(text);
            record.toolCalls = extractToolCalls(text);
            // Pass the upstream encoding through untouched: Pi parses event
            // streams itself, and relabelling them breaks its reader.
            response.writeHead(upstream.status, {
                "Content-Type": upstream.headers.get("content-type") ?? "application/json",
            });
            response.end(text);
        } catch (error) {
            response.writeHead(500, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ error: String(error?.message ?? error) }));
        }
    });

    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            resolve({
                requests,
                url: `http://127.0.0.1:${address.port}/v1`,
                close: () => new Promise((done) => server.close(done)),
            });
        });
    });
}

export function proxyTotals(requests) {
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let withUsage = 0;
    const toolCalls = {};
    const toolsOffered = {};
    // Per-request token series. Summing throws away the shape of the run, and
    // the shape is the point: whether context climbs turn over turn, and
    // whether it ever drops, which is what compaction looks like from here.
    const series = [];
    for (const [index, record] of requests.entries()) {
        const usage = record.usage;
        if (usage && Number.isFinite(usage.prompt_tokens)) {
            inputTokens += usage.prompt_tokens;
            withUsage += 1;
        }

        if (usage && Number.isFinite(usage.completion_tokens)) {
            outputTokens += usage.completion_tokens;
        }

        if (usage && Number.isFinite(usage.prompt_cache_hit_tokens)) {
            cachedTokens += usage.prompt_cache_hit_tokens;
        } else if (Number.isFinite(usage?.prompt_tokens_details?.cached_tokens)) {
            cachedTokens += usage.prompt_tokens_details.cached_tokens;
        }

        const usageCached = Number.isFinite(usage?.prompt_cache_hit_tokens)
            ? usage.prompt_cache_hit_tokens
            : (usage?.prompt_tokens_details?.cached_tokens ?? 0);
        series.push({
            request: index + 1,
            promptTokens: Number.isFinite(usage?.prompt_tokens) ? usage.prompt_tokens : null,
            cachedTokens: Number.isFinite(usageCached) ? usageCached : 0,
            completionTokens: Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens : null,
            toolCalls: (record.toolCalls ?? []).length,
        });

        for (const name of record.toolCalls ?? []) {
            const normalized = normalizeToolName(name);
            toolCalls[normalized] = (toolCalls[normalized] ?? 0) + 1;
        }

        // Offers are counted apart from calls: a tool offered on every
        // request is prompt weight paid every turn, which is the opposite
        // of a tool the model reached for once.
        for (const name of record.summary?.toolNames ?? []) {
            const normalized = normalizeToolName(name);
            toolsOffered[normalized] = (toolsOffered[normalized] ?? 0) + 1;
        }
    }

    return {
        inputTokens,
        outputTokens,
        cachedTokens,
        withUsage,
        toolCalls,
        toolsOffered,
        series,
        context: contextShape(series),
    };
}

// Context normally climbs turn over turn, because each request carries the
// conversation so far. A fall means the harness dropped history: compaction,
// a summary step, or a fresh window. How often that happens, and how much it
// reclaims, is a harness property no total can show.
export function contextShape(series) {
    const points = series.filter((point) => Number.isFinite(point.promptTokens));
    if (points.length === 0) {
        return { peakPromptTokens: 0, compactions: 0, reclaimedTokens: 0, growthPerRequest: 0 };
    }

    let compactions = 0;
    let reclaimed = 0;
    for (let index = 1; index < points.length; index += 1) {
        const drop = points[index - 1].promptTokens - points[index].promptTokens;
        // A small dip is ordinary message churn; a real compaction takes a
        // visible bite out of the window.
        if (drop > 0.2 * points[index - 1].promptTokens) {
            compactions += 1;
            reclaimed += drop;
        }
    }

    const peak = Math.max(...points.map((point) => point.promptTokens));
    const span = points.length > 1 ? points.length - 1 : 1;

    return {
        peakPromptTokens: peak,
        compactions,
        reclaimedTokens: reclaimed,
        growthPerRequest: Math.round((points[points.length - 1].promptTokens - points[0].promptTokens) / span),
    };
}
