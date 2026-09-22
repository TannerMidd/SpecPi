// Seven of the eight harnesses reach a Responses-only model through this translation, and a
// translation bug does not look like a bug: it looks like a harness that scores badly. These are
// the cases where a wrong conversion would be recorded as a harness failing the task rather than
// as the suite losing the harness's work.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
    collectResponsesReply,
    normalizeUsage,
    toChatBody,
    toChatStream,
    toResponsesRequest,
} from "../scripts/eval-responses.mjs";
import { collectChatReply } from "../scripts/eval-anthropic.mjs";
import { extractToolCalls, extractUsage, startProxy } from "../scripts/eval-proxy.mjs";

/** A Responses event stream, as the provider sends one. */
function stream(events) {
    return `${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

function chatFrames(text) {
    return text
        .split("\n\n")
        .filter((block) => block.startsWith("data: ") && !block.includes("[DONE]"))
        .map((block) => JSON.parse(block.slice("data: ".length)));
}

/** A stand-in provider that records what it was sent and replies with what the test wants. */
async function stubUpstream(handler) {
    const seen = [];
    const server = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) {
            chunks.push(chunk);
        }

        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        seen.push({ path: request.url, body });
        const reply = handler(body, request.url);
        response.writeHead(reply.status ?? 200, { "Content-Type": reply.type ?? "application/json" });
        response.end(reply.text);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    return {
        seen,
        url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
        close: () => new Promise((done) => server.close(done)),
    };
}

test("a chat conversation becomes ordered Responses input items", () => {
    const out = toResponsesRequest({
        model: "muse",
        max_tokens: 512,
        messages: [
            { role: "system", content: "Be brief." },
            { role: "user", content: "read notes.txt" },
            {
                role: "assistant",
                content: "on it",
                tool_calls: [
                    { id: "c1", type: "function", function: { name: "read", arguments: '{"path":"notes.txt"}' } },
                ],
            },
            { role: "tool", tool_call_id: "c1", content: "hello world" },
        ],
    });

    assert.deepEqual(out.input, [
        { role: "system", content: [{ type: "input_text", text: "Be brief." }] },
        { role: "user", content: [{ type: "input_text", text: "read notes.txt" }] },
        { role: "assistant", content: [{ type: "output_text", text: "on it" }] },
        { type: "function_call", call_id: "c1", name: "read", arguments: '{"path":"notes.txt"}' },
        { type: "function_call_output", call_id: "c1", output: "hello world" },
    ]);
    // Both names cap everything the model emits, reasoning included, so the harness's budget
    // has to survive the crossing or a reasoning model is silently given a different one.
    assert.equal(out.max_output_tokens, 512);
});

test("an assistant turn that is only tool calls contributes no empty message item", () => {
    const out = toResponsesRequest({
        model: "muse",
        messages: [
            {
                role: "assistant",
                content: "",
                tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
            },
        ],
    });

    assert.deepEqual(
        out.input.map((item) => item.type ?? item.role),
        ["function_call"],
    );
});

test("tools are flattened out of their function wrapper and tool_choice follows", () => {
    const out = toResponsesRequest({
        model: "muse",
        messages: [],
        tools: [
            {
                type: "function",
                function: { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } },
            },
        ],
        tool_choice: { type: "function", function: { name: "read" } },
    });

    assert.deepEqual(out.tools, [
        { type: "function", name: "read", description: "Read a file", parameters: { type: "object", properties: {} } },
    ]);
    assert.deepEqual(out.tool_choice, { type: "function", name: "read" });
});

test("reasoning tokens are billed, not lost, when usage crosses the wire", () => {
    const usage = normalizeUsage({
        input_tokens: 600,
        output_tokens: 40,
        input_tokens_details: { cached_tokens: 497 },
        output_tokens_details: { reasoning_tokens: 260 },
    });

    // The provider excludes reasoning from output_tokens. Carrying it across as-is would price a
    // heavy reasoner as if it had thought for free.
    assert.equal(usage.prompt_tokens, 600);
    assert.equal(usage.completion_tokens, 300);
    assert.equal(usage.prompt_tokens_details.cached_tokens, 497);
});

test("a whole-body reply yields its text, its calls and its finish reason", () => {
    const reply = collectResponsesReply(
        JSON.stringify({
            id: "resp_1",
            model: "muse",
            status: "completed",
            output: [
                { type: "reasoning", encrypted_content: "opaque" },
                { type: "message", content: [{ type: "output_text", text: "Reading it." }] },
                { type: "function_call", call_id: "call_9", name: "read", arguments: '{"path":"notes.txt"}' },
            ],
            usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } },
        }),
    );

    assert.equal(reply.text, "Reading it.");
    assert.deepEqual(reply.calls, [
        { id: "call_9", name: "read", input: { path: "notes.txt" }, arguments: '{"path":"notes.txt"}' },
    ]);
    assert.equal(reply.usage.completion_tokens, 7);
});

test("a streamed reply says its text once, not once per channel", () => {
    // The provider sends the assistant's text twice -- as deltas and again whole on the finished
    // item. Reading both concatenates the reply to itself, which reaches the harness as a model
    // that stutters and, in a tool-calling loop, as an instruction repeated.
    const reply = collectResponsesReply(
        stream([
            { type: "response.created", response: { id: "resp_2", model: "muse" } },
            { type: "response.output_text.delta", item_id: "msg_1", delta: "Reading " },
            { type: "response.output_text.delta", item_id: "msg_1", delta: "it." },
            {
                type: "response.output_item.done",
                item: { id: "msg_1", type: "message", content: [{ type: "output_text", text: "Reading it." }] },
            },
            { type: "response.completed", response: { id: "resp_2", usage: { input_tokens: 10, output_tokens: 5 } } },
        ]),
    );

    assert.equal(reply.text, "Reading it.");
});

test("a streamed call whose arguments only ever arrive as deltas is still a call", () => {
    const reply = collectResponsesReply(
        stream([
            {
                type: "response.output_item.added",
                item: { id: "fc_1", type: "function_call", call_id: "call_7", name: "bash", arguments: "" },
            },
            { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"cmd":"ls ' },
            { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '-la"}' },
            { type: "response.completed", response: { id: "resp_3" } },
        ]),
    );

    assert.deepEqual(reply.calls, [
        { id: "call_7", name: "bash", input: { cmd: "ls -la" }, arguments: '{"cmd":"ls -la"}' },
    ]);
});

test("a truncated reply reaches the harness as length, not as a finished turn", () => {
    const reply = collectResponsesReply(
        JSON.stringify({
            id: "resp_4",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output: [],
        }),
    );

    assert.equal(toChatBody(reply, { model: "muse" }).choices[0].finish_reason, "length");
});

test("the finished message survives the round trip to the chat wire and back", () => {
    const reply = collectResponsesReply(
        JSON.stringify({
            id: "resp_5",
            model: "muse",
            output: [
                { type: "message", content: [{ type: "output_text", text: "Looking." }] },
                // Shell metacharacters are where a translation that re-encodes rather than
                // carries the argument string would come apart.
                {
                    type: "function_call",
                    call_id: "call_5",
                    name: "bash",
                    arguments: '{"cmd":"cat a.txt 2>&1 | head"}',
                },
            ],
            usage: { input_tokens: 607, output_tokens: 100, input_tokens_details: { cached_tokens: 497 } },
        }),
    );

    for (const wire of [toChatStream(reply, { model: "muse" }), JSON.stringify(toChatBody(reply, { model: "muse" }))]) {
        const back = collectChatReply(wire);
        assert.equal(back.text, "Looking.");
        assert.deepEqual(back.calls, [{ id: "call_5", name: "bash", input: { cmd: "cat a.txt 2>&1 | head" } }]);
        assert.equal(back.finish, "tool_calls");
        // The proxy's own accounting reads the client-facing bytes in other suites, so the
        // numbers have to be readable there too.
        assert.equal(extractUsage(wire).prompt_tokens, 607);
        assert.equal(extractUsage(wire).prompt_tokens_details.cached_tokens, 497);
        assert.deepEqual(extractToolCalls(wire), ["bash"]);
    }
});

test("usage rides the final chat chunk, where a streaming client looks for it", () => {
    const reply = collectResponsesReply(
        JSON.stringify({ id: "resp_6", output: [], usage: { input_tokens: 3, output_tokens: 4 } }),
    );
    const frames = chatFrames(toChatStream(reply, { model: "muse" }));

    assert.equal(frames.at(-1).usage.prompt_tokens, 3);
    assert.equal(frames.at(-1).choices[0].finish_reason, "stop");
});

test("with the responses wire declared, a chat request is translated and answered in chat", async () => {
    const upstream = await stubUpstream(() => ({
        text: JSON.stringify({
            id: "resp_7",
            model: "muse",
            output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
            usage: { input_tokens: 11, output_tokens: 2 },
        }),
    }));
    process.env.EVAL_FORWARD_WIRE = "responses";
    const proxy = await startProxy({ forwardUrl: upstream.url });
    try {
        const response = await fetch(`${proxy.url}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "muse", messages: [{ role: "user", content: "hi" }] }),
        });
        const body = await response.json();

        assert.equal(upstream.seen[0].path, "/v1/responses", "a bridged call goes to the responses endpoint");
        assert.deepEqual(upstream.seen[0].body.input, [
            { role: "user", content: [{ type: "input_text", text: "hi" }] },
        ]);
        assert.equal(body.object, "chat.completion", "the harness asked in chat and must be answered in chat");
        assert.equal(body.choices[0].message.content, "ok");
        // The log is the single source for cost, and it is written from the upstream bytes.
        assert.equal(proxy.requests[0].usage.prompt_tokens, 11);
    } finally {
        delete process.env.EVAL_FORWARD_WIRE;
        await proxy.close();
        await upstream.close();
    }
});

test("a harness that already speaks Responses is not translated twice", async () => {
    // Codex sends the Responses shape itself. Putting it through the bridge would rewrite its
    // request into a shape it never sent, and the report would describe the wrong thing.
    const upstream = await stubUpstream(() => ({ text: JSON.stringify({ id: "resp_8", output: [] }) }));
    process.env.EVAL_FORWARD_WIRE = "responses";
    const proxy = await startProxy({ forwardUrl: upstream.url });
    try {
        await fetch(`${proxy.url}/responses`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "muse",
                input: [{ role: "user", content: "hi" }],
                instructions: "Be brief.",
            }),
        });

        assert.equal(upstream.seen[0].path, "/v1/responses");
        assert.equal(upstream.seen[0].body.instructions, "Be brief.", "the original request is forwarded as sent");
    } finally {
        delete process.env.EVAL_FORWARD_WIRE;
        await proxy.close();
        await upstream.close();
    }
});

test("an upstream error keeps its status instead of becoming an empty answer", async () => {
    // A 503 folded into a finished message would reach the harness as the model choosing to say
    // nothing, and the attempt would be scored as the harness giving up.
    const upstream = await stubUpstream(() => ({
        status: 503,
        text: JSON.stringify({ error: { message: "Endpoint is unavailable." } }),
    }));
    process.env.EVAL_FORWARD_WIRE = "responses";
    const proxy = await startProxy({ forwardUrl: upstream.url });
    try {
        const response = await fetch(`${proxy.url}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "muse", messages: [{ role: "user", content: "hi" }] }),
        });

        assert.equal(response.status, 503);
        assert.match(await response.text(), /Endpoint is unavailable/u);
    } finally {
        delete process.env.EVAL_FORWARD_WIRE;
        await proxy.close();
        await upstream.close();
    }
});

test("without the switch nothing is translated and the original bytes are forwarded", async () => {
    const upstream = await stubUpstream(() => ({
        text: JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
    }));
    const proxy = await startProxy({ forwardUrl: upstream.url });
    try {
        await fetch(`${proxy.url}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "deepseek", messages: [{ role: "user", content: "hi" }] }),
        });

        assert.equal(upstream.seen[0].path, "/v1/chat/completions");
        assert.deepEqual(upstream.seen[0].body.messages, [{ role: "user", content: "hi" }]);
    } finally {
        await proxy.close();
        await upstream.close();
    }
});

test("a failed response on a 200 is a failure, not an empty answer", () => {
    // The Responses API reports some failures in-band: HTTP is 200, the stream is well formed, and
    // `response.failed` carries the reason. Read only the status line and a provider outage is
    // published as a harness that answered with nothing.
    const stream = [
        `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_1", model: "m", status: "in_progress" } })}`,
        `data: ${JSON.stringify({
            type: "response.failed",
            response: {
                id: "resp_1",
                model: "m",
                status: "failed",
                error: { code: "server_error", message: "upstream capacity exceeded" },
                output: [],
            },
        })}`,
        "data: [DONE]",
    ].join("\n\n");

    const reply = collectResponsesReply(stream);
    assert.equal(reply.error.code, "server_error");
    assert.equal(reply.error.message, "upstream capacity exceeded");
});

test("a status of failed is a failure even with no error object", () => {
    const body = JSON.stringify({ id: "r", model: "m", status: "failed", output: [] });
    assert.equal(collectResponsesReply(body).error.code, "failed");
});

test("running out of output room is a finish reason, not a failure", () => {
    const body = JSON.stringify({
        id: "r",
        model: "m",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }],
    });
    const reply = collectResponsesReply(body);

    assert.equal(reply.error, null);
    assert.equal(reply.finish, "length");
    assert.equal(reply.text, "partial");
});

test("an ordinary completed response carries no error", () => {
    const body = JSON.stringify({
        id: "r",
        model: "m",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
    });
    assert.equal(collectResponsesReply(body).error, null);
});

test("a 200 that carries response.failed reaches the harness as a failure", async () => {
    // The sibling case to the 503 above, and the harder one: the status line says the request
    // succeeded and the failure is inside the stream. Folded into a finished message it becomes an
    // empty assistant turn with `stop`, which is scored as the harness answering with nothing.
    const upstream = await stubUpstream(() => ({
        status: 200,
        type: "text/event-stream",
        text: [
            `data: ${JSON.stringify({ type: "response.created", response: { id: "r", model: "m", status: "in_progress" } })}`,
            `data: ${JSON.stringify({
                type: "response.failed",
                response: {
                    id: "r",
                    model: "m",
                    status: "failed",
                    error: { code: "server_error", message: "upstream capacity exceeded" },
                    output: [],
                },
            })}`,
            "data: [DONE]",
        ].join("\n\n"),
    }));
    process.env.EVAL_FORWARD_WIRE = "responses";
    const proxy = await startProxy({ forwardUrl: upstream.url });
    try {
        const response = await fetch(`${proxy.url}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "muse", messages: [{ role: "user", content: "hi" }] }),
        });
        const text = await response.text();

        assert.equal(response.status, 502);
        assert.match(text, /upstream capacity exceeded/u);
        // The failure must not arrive dressed as a finished turn.
        assert.doesNotMatch(text, /"finish_reason":\s*"stop"/u);
    } finally {
        delete process.env.EVAL_FORWARD_WIRE;
        await proxy.close();
        await upstream.close();
    }
});
