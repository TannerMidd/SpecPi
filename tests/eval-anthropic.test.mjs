// The Claude Code row exists only if this translation is faithful, and a translation bug does not
// look like a bug: it looks like a harness that scores badly. These cases are the ones where a
// wrong conversion would be scored as a harness failing the task rather than as the suite losing
// the harness's work.

import test from "node:test";
import assert from "node:assert/strict";

import { collectChatReply, toChatCompletions, toMessagesBody, toMessagesStream } from "../scripts/eval-anthropic.mjs";
import { modelRequests, startProxy } from "../scripts/eval-proxy.mjs";

function frames(stream) {
    return stream
        .split("\n\n")
        .filter(Boolean)
        .map((block) => JSON.parse(block.split("\ndata: ")[1]));
}

test("a system prompt and plain turns convert to chat-completions", () => {
    const out = toChatCompletions({
        model: "claude-x",
        system: "Be brief.",
        max_tokens: 512,
        messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi" },
        ],
    });

    assert.deepEqual(out.messages, [
        { role: "system", content: "Be brief." },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
    ]);
    assert.equal(out.max_tokens, 512);
    assert.equal(out.stream, true);
});

test("a system prompt given as blocks is still a system message", () => {
    const out = toChatCompletions({
        system: [
            { type: "text", text: "One. " },
            { type: "text", text: "Two." },
        ],
        messages: [],
    });

    assert.deepEqual(out.messages, [{ role: "system", content: "One. Two." }]);
});

test("tool definitions carry their schema across", () => {
    const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
    const out = toChatCompletions({
        messages: [],
        tools: [{ name: "read", description: "Read a file", input_schema: schema }],
        tool_choice: { type: "any" },
    });

    assert.deepEqual(out.tools, [
        { type: "function", function: { name: "read", description: "Read a file", parameters: schema } },
    ]);
    assert.equal(out.tool_choice, "required");
});

test("an assistant tool_use becomes a tool_call with stringified arguments", () => {
    const out = toChatCompletions({
        messages: [
            {
                role: "assistant",
                content: [
                    { type: "text", text: "Reading it." },
                    { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.js" } },
                ],
            },
        ],
    });

    assert.deepEqual(out.messages, [
        {
            role: "assistant",
            content: "Reading it.",
            tool_calls: [{ id: "toolu_1", type: "function", function: { name: "read", arguments: '{"path":"a.js"}' } }],
        },
    ]);
});

test("several tool results in one user turn become several tool messages", () => {
    // The case that has no direct equivalent: Messages packs every result into one turn, and
    // chat-completions needs one message per call id. Collapsing them would silently drop results.
    const out = toChatCompletions({
        messages: [
            {
                role: "user",
                content: [
                    { type: "tool_result", tool_use_id: "toolu_1", content: "first" },
                    { type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "second" }] },
                ],
            },
        ],
    });

    assert.deepEqual(out.messages, [
        { role: "tool", tool_call_id: "toolu_1", content: "first" },
        { role: "tool", tool_call_id: "toolu_2", content: "second" },
    ]);
});

test("a failed tool result stays visible to the model", () => {
    const out = toChatCompletions({
        messages: [
            {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "no such file", is_error: true }],
            },
        ],
    });

    assert.equal(out.messages[0].content, "Error: no such file");
});

test("a streamed reply folds into text, calls and usage", () => {
    const stream = [
        'data: {"id":"c1","model":"m","choices":[{"delta":{"content":"Che"}}]}',
        'data: {"choices":[{"delta":{"content":"cking."}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":"{\\"cmd\\":"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]}}]}',
        'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":40,"completion_tokens":9}}',
        "data: [DONE]",
    ].join("\n");

    const reply = collectChatReply(stream);
    assert.equal(reply.text, "Checking.");
    assert.deepEqual(reply.calls, [{ id: "call_1", name: "bash", input: { cmd: "ls" } }]);
    assert.equal(reply.usage.prompt_tokens, 40);
    assert.equal(reply.finish, "tool_calls");
});

test("a whole-body reply folds the same way as a streamed one", () => {
    const reply = collectChatReply(
        JSON.stringify({
            id: "c2",
            model: "m",
            choices: [{ message: { content: "done" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
    );

    assert.equal(reply.text, "done");
    assert.deepEqual(reply.calls, []);
    assert.equal(reply.finish, "stop");
});

test("tool arguments that never parse still yield the call", () => {
    // Dropping it would read downstream as a turn in which the model did nothing, which is a
    // different and much more misleading failure than a call with empty input.
    const reply = collectChatReply(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"bash","arguments":"{oops"}}]}}]}',
    );

    assert.deepEqual(reply.calls, [{ id: "c", name: "bash", input: {} }]);
});

test("the emitted Anthropic stream is a well-formed event sequence", () => {
    const stream = toMessagesStream(
        {
            text: "Checking.",
            calls: [{ id: "toolu_1", name: "bash", input: { cmd: "ls" } }],
            usage: { prompt_tokens: 40, completion_tokens: 9 },
            finish: "tool_calls",
            model: "m",
            id: "c1",
        },
        { model: "claude-x" },
    );

    const types = frames(stream).map((event) => event.type);
    assert.deepEqual(types, [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
    ]);

    const events = frames(stream);
    assert.equal(events[0].message.usage.input_tokens, 40);
    assert.equal(events[4].content_block.type, "tool_use");
    assert.equal(events[4].content_block.name, "bash");
    assert.deepEqual(JSON.parse(events[5].delta.partial_json), { cmd: "ls" });
    assert.equal(events[7].delta.stop_reason, "tool_use");
    assert.equal(events[7].usage.output_tokens, 9);
});

test("a text-only reply emits exactly one content block", () => {
    const events = frames(
        toMessagesStream(
            { text: "done", calls: [], usage: null, finish: "stop", model: "m", id: null },
            { model: "claude-x" },
        ),
    );

    assert.equal(events.filter((event) => event.type === "content_block_start").length, 1);
    assert.equal(events.at(-2).delta.stop_reason, "end_turn");
});

test("a length-capped reply reports max_tokens rather than a normal stop", () => {
    const body = toMessagesBody(
        { text: "half", calls: [], usage: null, finish: "length", model: "m", id: null },
        { model: "claude-x" },
    );

    assert.equal(body.stop_reason, "max_tokens");
});

test("the whole-body shape carries the same content as the stream", () => {
    const reply = {
        text: "Checking.",
        calls: [{ id: "toolu_1", name: "bash", input: { cmd: "ls" } }],
        usage: { prompt_tokens: 40, completion_tokens: 9 },
        finish: "tool_calls",
        model: "m",
        id: "c1",
    };
    const body = toMessagesBody(reply, { model: "claude-x" });

    assert.deepEqual(body.content, [
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "toolu_1", name: "bash", input: { cmd: "ls" } },
    ]);
    assert.equal(body.stop_reason, "tool_use");
    assert.deepEqual(body.usage, { input_tokens: 40, output_tokens: 9 });
});

test("a round trip through both directions preserves a tool exchange", () => {
    // The property that matters end to end: what Claude Code sent, and what it gets back, describe
    // the same conversation after passing through a protocol that has neither shape.
    const chat = toChatCompletions({
        model: "claude-x",
        messages: [
            { role: "user", content: "list the files" },
            {
                role: "assistant",
                content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: { cmd: "ls" } }],
            },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.js" }] },
        ],
    });

    assert.deepEqual(
        chat.messages.map((message) => message.role),
        ["user", "assistant", "tool"],
    );
    assert.equal(chat.messages[1].tool_calls[0].function.arguments, '{"cmd":"ls"}');
    assert.equal(chat.messages[2].tool_call_id, "toolu_1");

    const back = toMessagesBody(collectChatReply(JSON.stringify({ choices: [{ message: { content: "a.js" } }] })), {
        model: "claude-x",
    });
    assert.deepEqual(back.content, [{ type: "text", text: "a.js" }]);
});

// Proxy-level behaviour that only this harness exercises. Both cases are measurement bugs rather
// than crashes: they would have produced a plausible-looking row that was simply wrong.

test("the reachability probe is answered without being recorded or forwarded", async () => {
    // Claude Code checks the endpoint before it starts. It carries no body and names no model, so
    // recording it would add a turn with no tokens, and forwarding it would post an empty payload
    // to the provider's completions endpoint and bill for the reply.
    const proxy = await startProxy({});
    const base = proxy.url.replace(/\/v1$/u, "");
    const probe = await fetch(`${base}/api/hello`, { method: "HEAD" });

    assert.equal(probe.status, 200);
    assert.equal(proxy.requests.length, 0, "a reachability probe is not model traffic");
    await proxy.close();
});

test("a Messages request with no tools is costed but not counted as a turn", async () => {
    // The session-title call. Its spend is real and stays in the log; counting it as a turn would
    // report every attempt as having taken one more turn than it did.
    const proxy = await startProxy({});
    const base = proxy.url.replace(/\/v1$/u, "");
    const send = (tools) =>
        fetch(`${base}/v1/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "claude-x",
                max_tokens: 32,
                messages: [{ role: "user", content: "hi" }],
                tools,
            }),
        });

    await send([]);
    await send([{ name: "bash", description: "run", input_schema: { type: "object" } }]);

    assert.equal(proxy.requests.length, 2, "both calls are logged, so neither disappears from cost");
    assert.equal(proxy.requests[0].kind, "auxiliary");
    assert.equal(proxy.requests[1].kind, undefined);
    assert.equal(modelRequests(proxy.requests).length, 1, "only the tool-carrying call is a turn");
    await proxy.close();
});

test("a Messages request is recorded in the chat-completions shape it was translated into", async () => {
    // The seam this whole module exists for: everything downstream of the record reads one shape.
    const proxy = await startProxy({});
    const base = proxy.url.replace(/\/v1$/u, "");
    await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: "claude-x",
            max_tokens: 32,
            system: "Be brief.",
            messages: [{ role: "user", content: "hi" }],
            tools: [{ name: "bash", description: "run", input_schema: { type: "object" } }],
        }),
    });

    const summary = proxy.requests[0].summary;
    assert.deepEqual(summary.toolNames, ["bash"], "tools are counted by their chat-completions names");
    assert.equal(summary.instructionChars, "Be brief.".length, "the Messages system block became a system message");
    await proxy.close();
});
