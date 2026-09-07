import assert from "node:assert/strict";
import test from "node:test";
import delegates from "../vscode/src/delegates.js";
import stateModule from "../vscode/src/chat-state.js";

const { decodeDelegates, delegateResultText, delegateCompletionText } = delegates;
const { createState, applyEvent } = stateModule;

export function delegateView(overrides = {}) {
    return {
        version: 1,
        enabled: true,
        active: 1,
        concurrency: 2,
        calls: 2,
        callLimit: 256,
        jobs: [
            {
                id: "review-api",
                batchId: "batch-1",
                attemptId: "attempt-1",
                mode: "review",
                state: "running",
                settling: true,
                calls: 2,
                tools: 4,
                elapsedMs: 65000,
                disposition: null,
                task: "Review the public API",
                provider: "fixture",
                model: "local-model",
                error: null,
            },
        ],
        ...overrides,
    };
}

const decode = (value) => decodeDelegates([JSON.stringify(value)]);

test("delegate RPC metadata is bounded, allowlisted and inert", () => {
    const input = delegateView();
    input.secret = "NOT DISPLAY DATA";
    input.jobs[0].context = "NOT DISPLAY DATA";
    input.jobs[0].task = "\u001b[31mReview\u202e <img src=x onerror=alert(1)>";
    const value = decode(input);
    assert.equal(value.jobs[0].task, "Review  <img src=x onerror=alert(1)>");
    assert.ok(!JSON.stringify(value).includes("NOT DISPLAY DATA"));
    assert.ok(!JSON.stringify(value).includes("\\u001b"));
    assert.deepEqual(
        Object.keys(value.jobs[0]).sort(),
        [
            "id",
            "batchId",
            "attemptId",
            "mode",
            "state",
            "settling",
            "calls",
            "tools",
            "elapsedMs",
            "disposition",
            "task",
            "provider",
            "model",
            "error",
        ].sort(),
    );
    for (const broken of [
        { version: 2 },
        { active: -1 },
        { active: 3 },
        { concurrency: 100 },
        { calls: "2" },
        { jobs: {} },
        { jobs: [...input.jobs, ...input.jobs] },
        { jobs: Array.from({ length: 9 }, (_, index) => ({ ...input.jobs[0], id: `job-${index}` })) },
    ]) {
        assert.equal(decode(delegateView(broken)), null);
    }

    for (const broken of [
        { state: "done" },
        { settling: "true" },
        { calls: 1.5 },
        { elapsedMs: -1 },
        { id: "x\n/off" },
        { batchId: "a /new" },
        { attemptId: "" },
        { disposition: "approved" },
    ]) {
        assert.equal(decode(delegateView({ jobs: [{ ...input.jobs[0], ...broken }] })), null);
    }

    const multibyte = JSON.stringify(delegateView({ ignored: "界".repeat(12000) }));
    assert.ok(multibyte.length < 32768 && Buffer.byteLength(multibyte) > 32768);
    for (const lines of [undefined, [], ["{"], ["x".repeat(32769)], [multibyte], ["{}", "{}"]]) {
        assert.equal(decodeDelegates(lines), null);
    }
});

test("delegate tool lifecycle and restored reports use readable advisory text instead of JSON", () => {
    const details = {
        jobs: [{ jobId: "review-api", state: "complete", settling: false, calls: 2 }],
        results: [
            {
                receipt: { jobId: "review-api" },
                result: {
                    status: "complete",
                    answer: "Found a boundary issue.",
                    findings: [{ claim: "Check the empty case." }],
                    nextStep: "Add a regression.",
                },
            },
        ],
    };
    const original = structuredClone(details);
    const content = [{ type: "text", text: JSON.stringify(details) }];
    const state = createState();
    applyEvent(state, {
        type: "tool_execution_start",
        toolCallId: "delegate-call",
        toolName: "delegate",
        args: { operation: "collect" },
    });
    applyEvent(state, {
        type: "tool_execution_end",
        toolCallId: "delegate-call",
        toolName: "delegate",
        result: { content, details },
    });
    assert.match(state.messages[0].text, /Ready for parent review/);
    assert.match(state.messages[0].text, /Advisory report/);
    assert.match(state.messages[0].text, /Check the empty case/);
    assert.ok(!state.messages[0].text.includes('"jobs"'));
    const restored = createState({
        messages: [{ role: "toolResult", toolCallId: "delegate-call", toolName: "delegate", content, details }],
    });
    assert.equal(restored.messages[0].text, state.messages[0].text);
    assert.deepEqual(details, original);
    const normal = createState({ messages: [{ role: "toolResult", toolName: "read", content, details }] });
    assert.equal(normal.messages[0].text, JSON.stringify(details));
    assert.equal(delegateResultText({ error: true }), null);
});

test("delegate completion summaries distinguish logical terminal states from settlement", () => {
    const job = decode(delegateView()).jobs[0];
    for (const [state, label] of [
        ["complete", "Ready for parent review"],
        ["partial", "Partial result"],
        ["needs_context", "Needs context"],
        ["failed", "Failed"],
        ["cancelled", "Stopped"],
        ["expired", "Timed out"],
        ["stale", "Invalidated"],
    ]) {
        const text = delegateCompletionText({ ...job, state, settling: false });
        assert.ok(text.includes(label));
        assert.match(text, /1m 5s · 2 model calls · 4 source-tool calls/);
        assert.match(text, /not verified task completion/);
    }

    assert.match(delegateCompletionText({ ...job, state: "cancelled", settling: true }), /Stopping/);
    assert.match(delegateCompletionText({ ...job, state: "complete", settling: true }), /Finishing/);
});
