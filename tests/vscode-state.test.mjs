import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import stateModule from "../vscode/src/chat-state.js";

const {
    createState,
    applyEvent,
    resetRunState,
    replaceMessages,
    setSessionCost,
    appendNotice,
    enforceBounds,
    MAX_MESSAGES,
    MAX_MESSAGE_CHARS,
    MAX_TRANSCRIPT_CHARS,
    MAX_TOOL_INPUT_CHARS,
    MAX_MESSAGE_IMAGES,
    MAX_TRANSCRIPT_IMAGES,
    MAX_TRANSCRIPT_IMAGE_BYTES,
} = stateModule;

test("reported streaming cost updates the conversation total without counting snapshots twice", () => {
    const state = createState({ cost: 1 });
    const message = (total) => ({ role: "assistant", content: [], usage: { cost: { total } } });
    applyEvent(state, { type: "agent_start" });
    applyEvent(state, { type: "message_start", message: message(0) });
    applyEvent(state, { type: "message_update", message: message(0.125) });
    assert.equal(state.cost, 1.125);
    applyEvent(state, { type: "message_update", message: message(0.125) });
    assert.equal(state.cost, 1.125);
    setSessionCost(state, 1);
    assert.equal(state.cost, 1.125, "refresh retains the unfinished response cost");
    applyEvent(state, { type: "message_end", message: message(0.25) });
    assert.equal(state.cost, 1.25);
    setSessionCost(state, 1.25);
    applyEvent(state, { type: "message_end", message: message(0.25) });
    assert.equal(state.cost, 1.25);
    applyEvent(state, { type: "message_start", message: message(0) });
    applyEvent(state, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi", partial: message(0.5) },
    });
    assert.equal(state.cost, 1.75);
    applyEvent(state, { type: "message_update", message: message(Number.NaN) });
    assert.equal(state.cost, 1.75);
    applyEvent(state, { type: "message_end", message: message(0.5) });
    applyEvent(state, { type: "agent_settled" });
    setSessionCost(state, 1.75);
    assert.equal(state.cost, 1.75);
});

function pngChunk(type, bytes) {
    const name = Buffer.from(type);
    const payload = Buffer.concat([name, bytes]);
    let crc = 0xffffffff;
    for (const byte of payload) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
    }

    const chunk = Buffer.alloc(bytes.length + 12);
    chunk.writeUInt32BE(bytes.length, 0);
    payload.copy(chunk, 4);
    chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);

    return chunk;
}

function pngImage(totalBytes = 0) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 6;
    const chunks = [
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk("IHDR", header),
        pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
        pngChunk("IEND", Buffer.alloc(0)),
    ];
    const minimum = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (totalBytes > minimum + 12) {
        const comment = Buffer.alloc(totalBytes - minimum - 12, 65);
        Buffer.from("note\0").copy(comment);
        chunks.splice(2, 0, pngChunk("tEXt", comment));
    }

    return { type: "image", mimeType: "image/png", data: Buffer.concat(chunks).toString("base64") };
}

test("VS Code state assembles current indexed RPC deltas and accepts authoritative completion", () => {
    const state = createState();
    applyEvent(state, { type: "agent_start" });
    applyEvent(state, { type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } });
    for (const delta of [
        { type: "thinking_delta", contentIndex: 0, delta: "Check carefully" },
        { type: "text_delta", contentIndex: 1, delta: "Hello " },
        { type: "text_delta", contentIndex: 1, delta: "world" },
        { type: "text_delta", contentIndex: 2, delta: "Second block" },
    ]) {
        applyEvent(state, { type: "message_update", assistantMessageEvent: delta });
    }

    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].text, "Hello world\nSecond block");
    assert.equal(state.messages[0].thinking, "Check carefully");
    assert.equal(state.messages[0].isRunning, true);
    applyEvent(state, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Final answer" }], stopReason: "stop" },
    });
    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].text, "Final answer");
    assert.equal(state.messages[0].thinking, undefined);
    assert.equal(state.messages[0].isRunning, false);
    assert.equal(state.status, "busy");
});

test("VS Code state never treats agent_end or an intermediate idle snapshot as settled", () => {
    const state = createState();
    applyEvent(state, { type: "agent_start" });
    applyEvent(state, { type: "queue_update", steering: ["later"], followUp: ["next"] });
    applyEvent(state, { type: "agent_end", willRetry: false, messages: [] });
    assert.equal(state.status, "busy");
    assert.equal(state.queueCount, 2);
    applyEvent(state, { type: "auto_retry_start", attempt: 1 });
    assert.equal(state.status, "retrying");
    applyEvent(state, { type: "response", command: "get_state", success: true, data: { isStreaming: false } });
    assert.equal(state.status, "retrying");
    applyEvent(state, { type: "auto_retry_end", success: false, finalError: "retry failed" });
    assert.equal(state.status, "busy");
    assert.equal(state.error, "retry failed");
    applyEvent(state, { type: "compaction_start" });
    assert.equal(state.status, "compacting");
    applyEvent(state, { type: "compaction_end", willRetry: true });
    assert.equal(state.status, "busy");
    applyEvent(state, { type: "agent_settled" });
    assert.equal(state.status, "ready");
    assert.equal(state.queueCount, 0);
});

test("VS Code tool events update one correlated card using cumulative results", () => {
    const state = createState();
    applyEvent(state, {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "npm test" },
    });
    applyEvent(state, {
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "bash",
        partialResult: { content: [{ type: "text", text: "first" }] },
    });
    applyEvent(state, {
        type: "tool_execution_update",
        toolCallId: "call-1",
        args: { command: "later argument mutation" },
        partialResult: { content: [{ type: "text", text: "first\nsecond" }] },
    });
    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].text, "first\nsecond");
    assert.equal(state.messages[0].isRunning, true);
    assert.equal(state.messages[0].input, JSON.stringify({ command: "npm test" }, null, 2));
    applyEvent(state, {
        type: "tool_execution_end",
        toolCallId: "call-1",
        result: { content: [{ type: "text", text: "Denied" }], details: { private: "omitted" } },
        isError: true,
    });
    applyEvent(state, {
        type: "message_end",
        message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "bash",
            content: [{ type: "text", text: "Denied" }],
            isError: true,
        },
    });
    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].isRunning, false);
    assert.equal(state.messages[0].isError, true);
    assert.equal(state.messages[0].toolName, "bash");
    assert.equal(state.messages[0].input, JSON.stringify({ command: "npm test" }, null, 2));
    assert.equal(state.messages[0].args, undefined);
    assert.doesNotMatch(JSON.stringify(state), /private/u);
});

test("VS Code connection reset releases run metadata while retaining the partial transcript", () => {
    const state = createState();
    applyEvent(state, { type: "agent_start" });
    applyEvent(state, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Interrupted reply" },
    });
    applyEvent(state, { type: "tool_execution_start", toolCallId: "interrupted-tool", toolName: "read" });
    applyEvent(state, { type: "queue_update", steering: ["queued"], followUp: [] });
    const firstId = state.messages[0].id;
    resetRunState(state);
    assert.equal(state.messages[0].text, "Interrupted reply");
    assert.ok(state.messages.every((message) => !message.isRunning));
    assert.equal(state.queueCount, 0);
    state.status = "connecting";
    applyEvent(state, { type: "response", command: "get_state", success: true, data: { isStreaming: false } });
    assert.equal(state.status, "ready");
    applyEvent(state, { type: "agent_start" });
    applyEvent(state, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "New reply" },
    });
    assert.equal(state.messages[0].text, "Interrupted reply");
    assert.notEqual(state.messages.at(-1).id, firstId);
    assert.equal(state.messages.at(-1).text, "New reply");
});

test("VS Code tool inputs are bounded display snapshots included in transcript limits", () => {
    const state = createState();
    const args = { command: "initial command", options: { cwd: "workspace" } };
    applyEvent(state, { type: "tool_execution_start", toolCallId: "snapshot", toolName: "bash", args });
    const displayed = state.messages[0].input;
    args.command = "mutated";
    args.options.cwd = "changed";
    assert.equal(state.messages[0].input, displayed);
    assert.equal(typeof displayed, "string");
    assert.equal(state.messages[0].args, undefined);
    for (let index = 0; index < 100; index += 1) {
        applyEvent(state, {
            type: "tool_execution_start",
            toolCallId: `large-${index}`,
            toolName: "write",
            args: { content: "x".repeat(100_000) },
        });
        applyEvent(state, {
            type: "tool_execution_end",
            toolCallId: `large-${index}`,
            result: { content: [{ type: "text", text: "y".repeat(100_000) }] },
        });
    }

    assert.ok(state.messages.every((message) => message.input.length <= MAX_TOOL_INPUT_CHARS));
    assert.ok(state.messages.every((message) => message.text.length + message.input.length <= MAX_MESSAGE_CHARS));
    assert.ok(
        state.messages.reduce((total, message) => total + message.text.length + message.input.length, 0) <=
            MAX_TRANSCRIPT_CHARS,
    );
    assert.match(state.messages.at(-1).input, /Display truncated/u);
});

test("VS Code restored tool results recover display inputs from matching assistant tool calls", () => {
    const state = createState();
    replaceMessages(state, [
        {
            role: "assistant",
            content: [
                {
                    type: "toolCall",
                    id: "read-call",
                    name: "read",
                    arguments: { path: "source.js" },
                    thoughtSignature: "private-signature",
                },
            ],
        },
        {
            role: "toolResult",
            toolCallId: "read-call",
            toolName: "read",
            content: [{ type: "text", text: "source contents" }],
        },
    ]);
    assert.equal(state.messages[1].input, JSON.stringify({ path: "source.js" }, null, 2));
    assert.equal(state.messages[1].arguments, undefined);
    assert.doesNotMatch(JSON.stringify(state), /private-signature/u);
});

test("VS Code state serializes only public model fields, text, and numeric usage", () => {
    const model = {
        id: "model",
        name: "Model",
        provider: "provider",
        contextWindow: 1234,
        headers: { Authorization: "secret" },
        apiKey: "secret",
        baseUrl: "https://private",
    };
    const state = createState({ model, models: [model] });
    applyEvent(state, {
        type: "response",
        command: "get_available_models",
        success: true,
        data: { models: [model, null, {}] },
    });
    replaceMessages(state, [
        {
            role: "assistant",
            content: [
                { type: "thinking", thinking: "opaque", thinkingSignature: "secret", redacted: true },
                { type: "text", text: "Visible" },
            ],
            diagnostics: "secret",
        },
    ]);
    assert.deepEqual(state.model, { id: "model", name: "Model", provider: "provider", contextWindow: 1234 });
    assert.equal(state.models.length, 1);
    assert.equal(state.messages[0].thinking, undefined);
    applyEvent(state, {
        type: "message_update",
        usage: {
            input: 100,
            output: 2,
            totalTokens: 102,
            providerSecret: "secret",
            cost: { total: 0.001, credentials: "secret" },
        },
    });
    assert.deepEqual(state.tokens, { input: 100, output: 2, totalTokens: 102, total: 102, cost: 0.001 });
    assert.doesNotMatch(JSON.stringify(state), /secret|private|opaque|Signature/u);
});

test("VS Code transcript and streamed partials remain bounded", () => {
    const state = createState();
    replaceMessages(
        state,
        Array.from({ length: 700 }, (_, index) => ({ role: "user", content: `Message ${index}` })),
    );
    assert.equal(state.messages.length, MAX_MESSAGES);
    assert.equal(state.messages.at(-1).text, "Message 699");
    replaceMessages(
        state,
        Array.from({ length: 500 }, () => ({
            role: "assistant",
            content: [
                { type: "text", text: "a".repeat(200_000) },
                { type: "thinking", thinking: "b".repeat(200_000) },
            ],
        })),
    );
    assert.ok(
        state.messages.every((message) => message.text.length + (message.thinking?.length || 0) <= MAX_MESSAGE_CHARS),
    );
    assert.ok(
        state.messages.reduce((total, message) => total + message.text.length + (message.thinking?.length || 0), 0) <=
            MAX_TRANSCRIPT_CHARS,
    );
    applyEvent(state, { type: "message_start", message: { role: "assistant", content: [] } });
    for (let index = 0; index < 100; index += 1) {
        applyEvent(state, {
            type: "message_update",
            assistantMessageEvent: {
                type: index % 2 ? "thinking_delta" : "text_delta",
                contentIndex: index,
                delta: "x".repeat(10_000),
            },
        });
    }

    assert.ok(state.messages.at(-1).text.length + state.messages.at(-1).thinking.length <= MAX_MESSAGE_CHARS);
    appendNotice(state, "n".repeat(200_000));
    enforceBounds(state);
    assert.ok(state.messages.at(-1).text.length <= MAX_MESSAGE_CHARS);
});

test("VS Code restores user, assistant, and tool messages without raw payloads", () => {
    const state = createState();
    replaceMessages(state, [
        { role: "user", content: "Question", timestamp: 123 },
        {
            role: "assistant",
            content: [
                { type: "text", text: "Answer" },
                { type: "thinking", thinking: "Reason" },
            ],
        },
        {
            role: "toolResult",
            toolCallId: "call",
            toolName: "read",
            content: [
                { type: "image", data: "private-image" },
                { type: "text", text: "Text" },
            ],
        },
        { role: "custom", content: "Hidden extension payload" },
    ]);
    assert.deepEqual(
        state.messages.map((message) => message.role),
        ["user", "assistant", "tool"],
    );
    assert.equal(state.messages[1].thinking, "Reason");
    assert.equal(state.messages[2].text, "[Image display omitted: invalid, unsupported, or larger than 5 MiB.]\nText");
    assert.doesNotMatch(JSON.stringify(state), /private-image|Hidden extension/u);
});

test("VS Code state exposes only declared text and image model capabilities", () => {
    const state = createState({
        model: { id: "vision", input: ["text", "image", "audio", "image", null], headers: { private: "secret" } },
    });
    assert.deepEqual(state.model.input, ["text", "image"]);
    applyEvent(state, {
        type: "response",
        command: "get_available_models",
        success: true,
        data: {
            models: [
                { id: "text", input: ["text"] },
                { id: "unknown", input: "image" },
            ],
        },
    });
    assert.deepEqual(state.models[0].input, ["text"]);
    assert.equal(state.models[1].input, undefined);
    assert.doesNotMatch(JSON.stringify(state.model), /secret|audio/u);
});

test("VS Code state restores valid user, assistant, and tool images without placeholder text", () => {
    const state = createState();
    const image = { ...pngImage(), name: "pixel.png", arbitrary: "private-field" };
    replaceMessages(state, [
        { role: "user", content: [{ type: "text", text: "Inspect this" }, image] },
        { role: "assistant", content: [image, { type: "text", text: "A red pixel" }] },
        { role: "toolResult", toolCallId: "screenshot", toolName: "browser", content: [image] },
    ]);
    assert.deepEqual(
        state.messages.map((message) => message.text),
        ["Inspect this", "A red pixel", ""],
    );
    for (const message of state.messages) {
        assert.equal(message.images.length, 1);
        assert.equal(message.images[0].data, image.data);
        assert.equal(message.images[0].mimeType, "image/png");
        assert.equal(message.images[0].width, 1);
        assert.equal(message.images[0].height, 1);
        assert.equal(message.images[0].byteLength, Buffer.from(image.data, "base64").length);
        assert.equal(message.images[0].arbitrary, undefined);
    }

    const snapshot = createState({ messages: state.messages });
    assert.equal(snapshot.messages[0].images[0].data, image.data);
});

test("VS Code state replaces malformed and per-message excess images with explanatory text", () => {
    const state = createState();
    const image = pngImage();
    replaceMessages(state, [
        {
            role: "user",
            content: [
                { type: "text", text: "Preserve my request" },
                { type: "image", data: "private-invalid-image", mimeType: "image/png" },
                { ...image, mimeType: "image/svg+xml" },
                ...Array.from({ length: MAX_MESSAGE_IMAGES + 2 }, () => image),
            ],
        },
    ]);
    assert.equal(state.messages[0].images.length, MAX_MESSAGE_IMAGES);
    assert.match(state.messages[0].text, /^Preserve my request/u);
    assert.match(state.messages[0].text, /invalid, unsupported/u);
    assert.match(state.messages[0].text, /at most eight images/u);
    assert.doesNotMatch(JSON.stringify(state), /private-invalid-image|svg\+xml/u);
});

test("VS Code state reuses validated images through cumulative tool progress and assistant deltas", () => {
    const state = createState();
    const image = pngImage();
    applyEvent(state, { type: "tool_execution_start", toolCallId: "browser", toolName: "browser" });
    applyEvent(state, {
        type: "tool_execution_update",
        toolCallId: "browser",
        partialResult: { content: [{ type: "text", text: "Working" }, image] },
    });
    const normalized = state.messages[0].images[0];
    applyEvent(state, {
        type: "tool_execution_update",
        toolCallId: "browser",
        partialResult: { content: [{ type: "text", text: "Complete" }, { ...image }] },
    });
    assert.strictEqual(state.messages[0].images[0], normalized);
    applyEvent(state, { type: "tool_execution_end", toolCallId: "browser", result: { content: [image] } });
    applyEvent(state, {
        type: "message_end",
        message: { role: "toolResult", toolCallId: "browser", toolName: "browser", content: [image] },
    });
    assert.strictEqual(state.messages[0].images[0], normalized);
    assert.equal(state.messages[0].isRunning, false);
    applyEvent(state, { type: "message_start", message: { role: "assistant", content: [image] } });
    const assistantImage = state.messages.at(-1).images[0];
    applyEvent(state, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Describing it" },
    });
    assert.strictEqual(state.messages.at(-1).images[0], assistantImage);
    assert.equal(state.messages.at(-1).text, "Describing it");
});

test("VS Code state prunes oldest transcript images by count while preserving message text", () => {
    const state = createState();
    const image = pngImage();
    replaceMessages(
        state,
        Array.from({ length: MAX_TRANSCRIPT_IMAGES + 3 }, (_, index) => ({
            role: "user",
            content: [{ type: "text", text: `Request ${index}` }, image],
        })),
    );
    assert.equal(
        state.messages.reduce((sum, message) => sum + (message.images?.length || 0), 0),
        MAX_TRANSCRIPT_IMAGES,
    );
    assert.equal(state.messages[0].images, undefined);
    assert.match(state.messages[0].text, /^Request 0\n\n\[Image display omitted: transcript image limit reached.\]/u);
    assert.equal(state.messages.at(-1).images.length, 1);
    const before = state.messages[0].text;
    enforceBounds(state);
    assert.equal(state.messages[0].text, before);
});

test("VS Code state bounds retained decoded image bytes independently from transcript text", () => {
    const state = createState();
    const image = pngImage(4 * 1024 * 1024);
    replaceMessages(
        state,
        Array.from({ length: 6 }, (_, index) => ({
            role: "toolResult",
            toolCallId: `large-image-${index}`,
            toolName: "browser",
            content: [{ type: "text", text: `Output ${index}` }, image],
        })),
    );
    assert.equal(
        state.messages.reduce(
            (sum, message) => sum + (message.images || []).reduce((bytes, item) => bytes + item.byteLength, 0),
            0,
        ),
        MAX_TRANSCRIPT_IMAGE_BYTES,
    );
    assert.equal(state.messages[0].images, undefined);
    assert.match(state.messages[0].text, /^Output 0/u);
    assert.match(state.messages[0].text, /transcript image limit reached/u);
    assert.equal(state.messages.at(-1).images.length, 1);
    replaceMessages(state, [{ role: "user", content: [pngImage(5 * 1024 * 1024 + 1)] }]);
    assert.equal(state.messages[0].images, undefined);
    assert.match(state.messages[0].text, /larger than 5 MiB/u);
});

test("VS Code omitted image notices survive bounded tool inputs and later assistant text deltas", () => {
    const state = createState();
    const image = pngImage();
    replaceMessages(
        state,
        Array.from({ length: MAX_TRANSCRIPT_IMAGES + 1 }, (_, index) => ({
            role: "tool",
            id: `limit-${index}`,
            toolName: "browser",
            input: "i".repeat(MAX_TOOL_INPUT_CHARS),
            text: "t".repeat(MAX_MESSAGE_CHARS),
            images: [image],
        })),
    );
    // The text window retains only the newest bounded messages, independently of images.
    enforceBounds(state);
    assert.ok(state.messages.every((message) => message.text.length + message.input.length <= MAX_MESSAGE_CHARS));
    const large = pngImage(4 * 1024 * 1024);
    applyEvent(state, {
        type: "message_start",
        message: { role: "assistant", content: Array.from({ length: 6 }, () => large) },
    });
    assert.match(state.messages.at(-1).text, /transcript image limit reached/u);
    applyEvent(state, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 6, delta: "More context" },
    });
    assert.match(
        state.messages.at(-1).text,
        /^More context\n\n\[Image display omitted: transcript image limit reached.\]/u,
    );
});
