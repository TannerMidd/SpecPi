import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import subagents from "../vscode/src/subagents.js";
import stateModule from "../vscode/src/chat-state.js";
import bridge from "../vscode/src/subagents-bridge.mjs";

const { projectFleet, decodeFleet, projectSubagentDetails, SUBAGENT_WIDGET } = subagents;
const { createState, applyEvent, MAX_TRANSCRIPT_CHARS } = stateModule;
const fleet = () => ({
    version: 1,
    totalActive: 1,
    omitted: 0,
    entries: [
        {
            key: "fleet-1",
            agent: "reviewer",
            model: "fixture",
            effort: "high",
            goal: "Review the diff",
            startedAt: 1000,
            tokens: { input: 100, output: 50, total: 150 },
        },
    ],
});
const details = () => ({
    mode: "parallel",
    runId: "run-1",
    results: [
        { index: 7, agent: "reviewer", task: "Check the API", exitCode: -1 },
        { index: 2, agent: "scout", task: "Find the implementation", exitCode: 0 },
    ],
    progress: [
        { index: 2, agent: "scout", status: "completed", tokens: 80, toolCount: 2, durationMs: 3000 },
        {
            index: 7,
            agent: "reviewer",
            status: "running",
            tokens: 150,
            toolCount: 4,
            durationMs: 5000,
            currentTool: "read",
            model: "fixture",
        },
    ],
});

test("Chat observer does not register itself in a pi-subagents child runtime", () => {
    const previous = process.env.PI_SUBAGENT_CHILD;
    process.env.PI_SUBAGENT_CHILD = "1";
    try {
        bridge({});
    } finally {
        if (previous === undefined) {
            delete process.env.PI_SUBAGENT_CHILD;
        } else {
            process.env.PI_SUBAGENT_CHILD = previous;
        }
    }
});

test("pi-subagents fleet metadata is bounded, inert, and separate from control identities", () => {
    const input = fleet();
    input.entries[0].goal = "\u001b[31mReview\u202e <img src=x onerror=alert(1)>";
    input.entries[0].sessionFile = "PRIVATE_SESSION";
    input.entries[0].runId = "NOT_A_CONTROL_TARGET";
    const projected = decodeFleet([JSON.stringify(input)]);
    assert.equal(projected.entries[0].goal, "Review  <img src=x onerror=alert(1)>");
    assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_SESSION|NOT_A_CONTROL_TARGET/u);
    for (const malformed of [
        { ...input, version: 2 },
        { ...input, totalActive: -1 },
        { ...input, omitted: 1 },
        { ...input, entries: [...input.entries, ...input.entries], totalActive: 2 },
        { ...input, entries: [{ ...input.entries[0], startedAt: NaN }] },
        { ...input, entries: [{ ...input.entries[0], tokens: { input: 0, output: -1, total: 0 } }] },
    ]) {
        assert.equal(projectFleet(malformed), null);
    }

    assert.equal(decodeFleet(["x".repeat(32769)]), null);
    assert.equal(decodeFleet([JSON.stringify({ ignored: "界".repeat(12000) })]), null);
    assert.equal(decodeFleet(["{}", "{}"]), null);
    const large = {
        ...fleet(),
        totalActive: 20,
        omitted: 4,
        entries: Array.from({ length: 16 }, (_, index) => ({
            ...fleet().entries[0],
            key: `fleet-${index}`,
            agent: "界".repeat(96),
            role: "界".repeat(96),
            model: "界".repeat(128),
            goal: "界".repeat(512),
        })),
    };
    const bounded = projectFleet(large);
    assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 32768);
    assert.equal(bounded.entries.length + bounded.omitted, 20);
    assert.deepEqual(decodeFleet([JSON.stringify(bounded)]), bounded);
});

test("subagent cards follow child indices through progress, failure, history, and background handoff", () => {
    const state = createState();
    const input = details();
    input.results[0].messages = [{ content: "PRIVATE_CHILD_TRANSCRIPT" }];
    input.results[0].sessionFile = "PRIVATE_PATH";
    input.progress[1].currentToolArgs = "PRIVATE_TOOL_ARGS";
    const snapshot = structuredClone(input);
    applyEvent(state, {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "subagent",
        args: { agent: "reviewer" },
    });
    applyEvent(state, {
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "subagent",
        partialResult: { content: [{ type: "text", text: "Working" }], details: input },
    });
    const rows = state.messages[0].subagents.rows;
    assert.deepEqual(
        rows.map((row) => [row.index, row.state, row.tokens]),
        [
            [7, "running", 150],
            [2, "completed", 80],
        ],
    );
    assert.doesNotMatch(JSON.stringify(state), /PRIVATE_CHILD_TRANSCRIPT|PRIVATE_PATH|PRIVATE_TOOL_ARGS/u);
    assert.deepEqual(input, snapshot);
    input.results[0].exitCode = 1;
    input.results[0].error = "Model request failed";
    const content = [{ type: "text", text: "The review failed; scout found the implementation." }];
    applyEvent(state, {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "subagent",
        isError: true,
        result: { content, details: input },
    });
    assert.deepEqual(
        state.messages[0].subagents.rows.map((row) => row.state),
        ["failed", "completed"],
    );
    const restored = createState({
        messages: [
            { role: "toolResult", toolCallId: "call-1", toolName: "subagent", content, details: input, isError: true },
        ],
    });
    assert.deepEqual(restored.messages[0].subagents, state.messages[0].subagents);
    assert.equal(restored.messages[0].text, content[0].text);
    const background = projectSubagentDetails({ mode: "single", asyncId: "background-1", results: [] });
    assert.equal(background.background, true);
    assert.deepEqual(background.rows, []);
    assert.equal(projectSubagentDetails({ mode: "management", results: [] }), null);
    for (const flag of ["timedOut", "stopped", "interrupted", "detached"]) {
        const value = projectSubagentDetails({
            mode: "single",
            results: [{ index: 0, agent: "worker", exitCode: 0, [flag]: true }],
        });
        assert.notEqual(value.rows[0].state, "completed");
    }

    const unknown = projectSubagentDetails({ mode: "single", results: [{ index: 0, agent: "worker" }] });
    assert.equal(unknown.rows[0].tokens, null);
    assert.equal(unknown.rows[0].state, "unknown");
});

test("visible subagent completion notices survive streaming and history without exposing hidden messages", () => {
    const notice = {
        role: "custom",
        customType: "subagent-notify",
        display: true,
        timestamp: 123,
        content: "Subagent failed: **reviewer**\nRequest failed",
        details: { sessionFile: "PRIVATE_NOTICE_PATH" },
    };
    const state = createState();
    applyEvent(state, { type: "message_start", message: notice });
    applyEvent(state, { type: "message_end", message: notice });
    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].role, "notice");
    assert.equal(state.messages[0].text, notice.content);
    const restored = createState({
        messages: [notice, { ...notice, display: false }, { ...notice, customType: "unrelated-custom-message" }],
    });
    assert.equal(restored.messages.length, 2);
    assert.equal(restored.messages[0].text, notice.content);
    assert.doesNotMatch(JSON.stringify(restored), /PRIVATE_NOTICE_PATH/u);
});

test("subagent card metadata counts toward the transcript display budget", () => {
    const results = Array.from({ length: 30 }, (_, index) => ({
        index,
        agent: "worker",
        task: "x".repeat(240),
        error: "x".repeat(512),
        exitCode: 1,
    }));
    const state = createState({
        messages: Array.from({ length: 500 }, (_, index) => ({
            role: "toolResult",
            toolCallId: `call-${index}`,
            toolName: "subagent",
            content: [],
            details: { mode: "parallel", results },
        })),
    });
    assert.ok(state.messages.length < 500);
    assert.equal(state.messages[0].subagents.rows.length, 16);
    assert.equal(state.messages[0].subagents.omitted, 14);
    assert.ok(
        state.messages.reduce(
            (size, message) => size + message.text.length + JSON.stringify(message.subagents).length,
            0,
        ) <= MAX_TRANSCRIPT_CHARS,
    );
});

function bridgeFixture(t, respond) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const bus = new EventEmitter();
    const handlers = new Map();
    const widgets = [];
    const requests = [];
    const events = {
        on(name, handler) {
            bus.on(name, handler);

            return () => bus.off(name, handler);
        },
        emit: (name, data) => bus.emit(name, data),
    };
    const context = { ui: { setWidget: (key, lines) => widgets.push({ key, lines }) } };
    events.on("subagents:rpc:v1:request", (request) => {
        requests.push(request);
        respond?.(request, (data) =>
            events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
                version: 1,
                requestId: request.requestId,
                success: true,
                data,
            }),
        );
    });
    bridge({ events, on: (name, handler) => handlers.set(name, handler) });
    t.after(() => handlers.get("session_shutdown")());
    const tick = async (ms) => {
        t.mock.timers.tick(ms);
        for (let step = 0; step < 6; step += 1) {
            await Promise.resolve();
        }
    };

    handlers.get("session_start")({}, context);

    return { handlers, widgets, requests, events, tick, context };
}

test("Chat bridge discovers the fleet capability and only polls public status", async (t) => {
    let live = fleet();
    const fixture = bridgeFixture(t, (request, reply) =>
        reply(
            request.method === "ping"
                ? { capabilities: { fleetStatus: { version: 1 } } }
                : { fleet: live, asyncSnapshot: { private: "DO_NOT_FORWARD" } },
        ),
    );
    await fixture.tick(0);
    assert.deepEqual(
        fixture.requests.map((item) => item.method),
        ["ping", "status"],
    );
    assert.equal(fixture.widgets.at(-1).key, SUBAGENT_WIDGET);
    assert.deepEqual(decodeFleet(fixture.widgets.at(-1).lines), projectFleet(live));
    assert.doesNotMatch(JSON.stringify(fixture.widgets), /DO_NOT_FORWARD/u);
    live.entries[0].tokens.total += 50;
    await fixture.tick(1000);
    assert.equal(decodeFleet(fixture.widgets.at(-1).lines).entries[0].tokens.total, 200);
    live = { version: 1, entries: [], totalActive: 0, omitted: 0 };
    await fixture.tick(1000);
    assert.equal(decodeFleet(fixture.widgets.at(-1).lines).totalActive, 0);
    const before = fixture.requests.length;
    fixture.handlers.get("session_shutdown")();
    await fixture.tick(10000);
    assert.equal(fixture.requests.length, before);
    assert.equal(fixture.widgets.at(-1).lines, undefined);
});

test("Chat bridge stays dormant without pi-subagents and discards replies across session changes", async (t) => {
    let lateReply;
    const fixture = bridgeFixture(t, (request, reply) => {
        lateReply = reply;
    });
    await fixture.tick(0);
    await fixture.tick(2000);
    await fixture.tick(10000);
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(fixture.widgets, []);
    fixture.handlers.get("session_start")({}, fixture.context);
    await fixture.tick(0);
    const oldReply = lateReply;
    fixture.handlers.get("session_start")({}, fixture.context);
    oldReply({ capabilities: { fleetStatus: { version: 1 } } });
    await fixture.tick(0);
    assert.ok(fixture.requests.every((request) => request.method === "ping"));
    assert.deepEqual(fixture.widgets, []);
});
