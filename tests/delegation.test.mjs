import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDelegationController } from "../extensions/delegation/core.mjs";
import { LIMITS } from "../extensions/delegation/protocol.mjs";

const usage = { input: 3, output: 5, cacheRead: 0, cacheWrite: 0 };

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });

    return { promise, resolve };
}

function project(t, files = {}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-delegation-")));
    for (const [relative, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative), content);
    }

    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    return root;
}

function packet(
    jobs = [{ id: "j1", mode: "consult", question: "Assess the fixture", context: "ordinary fixture", sources: [] }],
) {
    return {
        objective: "Assess a public fixture",
        requirements: [{ id: "r1", text: "Explain the fixture" }],
        decisions: ["Use only the supplied sources"],
        nonGoals: ["Do not modify files"],
        reason: {
            deliverable: "A bounded assessment",
            consumer: "Parent reviewer",
            independence: "Separate source analysis",
            parentWork: "Inspect integration boundaries",
        },
        jobs,
    };
}

function result(overrides = {}) {
    return {
        status: "complete",
        answer: "The fixture is present.",
        requirements: [{ id: "r1", status: "addressed", evidence: [{ sourceId: "p1", lineStart: 1, lineEnd: 1 }] }],
        findings: [],
        missing: [],
        nextStep: "Parent should check the cited fixture.",
        ...overrides,
    };
}

function findingResult() {
    return result({
        findings: [
            {
                id: "f1",
                claim: "Fixture text exists.",
                confidence: "observed",
                evidence: [{ sourceId: "p1", lineStart: 1, lineEnd: 1 }],
                contraryEvidence: [],
            },
        ],
    });
}

function message(content, options = {}) {
    return {
        role: "assistant",
        content: typeof content === "string" ? [{ type: "text", text: content }] : content,
        stopReason: "stop",
        usage: { ...usage },
        ...options,
    };
}

function stream(terminal, events = [{ type: "done", message: terminal }], settled = Promise.resolve(terminal)) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const event of events) {
                yield event;
            }
        },
        result: () => settled,
    };
}

// This synthetic public host bridge has no credentials, session data, or network.
function hostBridge(respond = () => message(JSON.stringify(result()))) {
    const calls = [];
    const host = {
        id: "fixture-host",
        model: { provider: "fixture", id: "exact-parent-model" },
        isCurrent: () => true,
        async stream(context, options) {
            calls.push({ context: structuredClone(context), options });
            const response = await respond(context, options, calls.length);

            return response?.[Symbol.asyncIterator] ? response : stream(response);
        },
    };

    return { host, calls };
}

function controller(t, root, bridge = hostBridge(), options = {}) {
    const value = createDelegationController({ getHost: () => bridge.host, root, ...options });
    t.after(() => value.invalidate("fixture cleanup"));

    return value;
}

async function waitFor(predicate, label = "fixture state", timeout = 2500) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
}

async function complete(value, selectedPacket = packet(), requestId = "run1") {
    const batch = await value.execute({ operation: "run", requestId, packet: selectedPacket });
    await waitFor(
        () =>
            value
                .status()
                .batches.find((item) => item.batchId === batch.batchId)
                .jobs.every((job) => !job.settling && job.state !== "queued"),
        "worker settlement",
    );

    return value.execute({ operation: "collect", batchId: batch.batchId });
}

function binding(receipt) {
    return Object.fromEntries(
        ["batchId", "jobId", "attemptId", "packetDigest", "generation", "resultRevision"].map((key) => [
            key,
            receipt[key],
        ]),
    );
}

test("controller defaults off, validates closed inputs, and rejects raised ceilings", async (t) => {
    const root = project(t);
    const bridge = hostBridge();
    const value = controller(t, root, bridge);
    assert.equal(value.status().enabled, false);
    await assert.rejects(value.execute({ operation: "run", requestId: "off", packet: packet() }), /disabled/);
    for (const input of [
        { operation: "on" },
        { operation: "status", enable: true },
        { operation: "run", requestId: "extra", packet: { ...packet(), tools: ["bash"] } },
        { operation: "run", requestId: "jobextra", packet: packet([{ ...packet().jobs[0], tools: ["read"] }]) },
        { operation: "collect", batchId: "unknown", waitMs: 30001 },
        { operation: "run", requestId: "wrongmode", packet: packet([{ ...packet().jobs[0], mode: "write" }]) },
        { operation: "run", requestId: "inlineonly", packet: packet([{ ...packet().jobs[0], sources: ["demo.md"] }]) },
    ]) {
        await assert.rejects(value.execute(input));
    }

    assert.equal(bridge.calls.length, 0);
    assert.throws(
        () => createDelegationController({ root, getHost: () => bridge.host, limits: { concurrency: 3 } }),
        /lower/,
    );
    const locked = controller(t, root, bridge, { getGuard: () => "locked" });
    assert.throws(() => locked.enable(), /Guard/);
});

test("equal run requests are immutable idempotent receipts and changed payloads cannot spend calls", async (t) => {
    const root = project(t);
    const bridge = hostBridge();
    const value = controller(t, root, bridge);
    value.enable();
    const input = { operation: "run", requestId: "once", packet: packet() };
    const first = await value.execute(input);
    const original = structuredClone(first);
    first.jobs[0].state = "corrupted";
    first.batchId = "corrupted";
    assert.deepEqual(await value.execute(structuredClone(input)), original);
    await assert.rejects(
        value.execute({ ...input, packet: { ...packet(), objective: "Changed question" } }),
        /different payload/,
    );
    await waitFor(() => value.status().active === 0);
    assert.equal(bridge.calls.length, 1);
    assert.equal(value.status().sessionCalls, 1);
});

test("collected result, usage, and disposition data cannot mutate retained receipts", async (t) => {
    const root = project(t);
    const value = controller(
        t,
        root,
        hostBridge(() => message(JSON.stringify(findingResult()))),
    );
    value.enable();
    const first = await complete(value);
    const expected = structuredClone(first.results[0]);
    first.results[0].result.findings[0].claim = "corrupted";
    first.results[0].receipt.usage.input = 9999;
    const second = await value.execute({ operation: "collect", batchId: first.batchId });
    assert.deepEqual(second.results[0], expected);
    const resolved = await value.execute({
        operation: "resolve",
        requestId: "resolve1",
        ...binding(expected.receipt),
        decision: "accept",
        findings: [{ id: "f1", decision: "confirmed" }],
    });
    assert.match(resolved.disposition.authority, /parent assessment only/);
    const third = await value.execute({ operation: "collect", batchId: first.batchId });
    third.results[0].disposition.findings[0].decision = "rejected";
    const fourth = await value.execute({ operation: "collect", batchId: first.batchId });
    assert.equal(fourth.results[0].disposition.findings[0].decision, "confirmed");
});

test("lowered batch job quota is enforced before opening workers", async (t) => {
    const root = project(t);
    const bridge = hostBridge();
    const value = controller(t, root, bridge, { limits: { batchJobs: 1 } });
    value.enable();
    await assert.rejects(
        value.execute({
            operation: "run",
            requestId: "too-many",
            packet: packet([packet().jobs[0], { ...packet().jobs[0], id: "j2" }]),
        }),
    );
    assert.equal(bridge.calls.length, 0);
});

test("two worker slots stay occupied until non-cooperative cancellation settles", async (t) => {
    const root = project(t);
    const pending = [];
    const worker = async ({ admitCall, signal }) => {
        admitCall();
        const gate = deferred();
        pending.push({ gate, signal });
        await gate.promise;

        return result();
    };

    t.after(() => pending.forEach((item) => item.gate.resolve()));
    const value = controller(t, root, hostBridge(), { worker });
    value.enable();
    const jobs = Array.from({ length: 4 }, (_, index) => ({ ...packet().jobs[0], id: `j${index}` }));
    const batch = await value.execute({ operation: "run", requestId: "concurrent", packet: packet(jobs) });
    assert.equal(value.status().active, 2);
    assert.equal(pending.length, 2);
    assert.deepEqual(
        batch.jobs.map((job) => job.state),
        ["running", "running", "queued", "queued"],
    );
    await value.execute({ operation: "cancel", requestId: "cancel1", batchId: batch.batchId, jobId: "j0" });
    const cancelled = await value.execute({ operation: "collect", batchId: batch.batchId });
    assert.equal(cancelled.results[0].receipt.state, "cancelled");
    assert.equal(cancelled.results[0].receipt.settling, true);
    assert.equal(pending[0].signal.aborted, true);
    assert.equal(pending.length, 2);
    pending[0].gate.resolve();
    await waitFor(() => pending.length === 3);
    assert.equal(value.status().active, 2);
    pending[1].gate.resolve();
    await waitFor(() => pending.length === 4);
    pending[2].gate.resolve();
    pending[3].gate.resolve();
    await waitFor(() => value.status().active === 0);
    assert.equal(value.status().sessionCalls, 4);
});

test("off/on and host rebind preserve consumed calls, batch counts, and held worker slots", async (t) => {
    const root = project(t);
    const pending = [];
    const bridge = hostBridge();
    const worker = async ({ admitCall }) => {
        admitCall();
        const gate = deferred();
        pending.push(gate);
        await gate.promise;

        return result();
    };

    t.after(() => pending.forEach((gate) => gate.resolve()));
    const value = controller(t, root, bridge, { worker, limits: { sessionCalls: 3, sessionBatches: 2 } });
    const jobs = [packet().jobs[0], { ...packet().jobs[0], id: "j2" }];
    value.enable();
    const old = await value.execute({ operation: "run", requestId: "old", packet: packet(jobs) });
    value.invalidate("off and host replaced");
    bridge.host = { ...bridge.host, id: "second-host" };
    value.enable();
    const fresh = await value.execute({ operation: "run", requestId: "new", packet: packet(jobs) });
    assert.equal(value.status().active, 2);
    assert.equal(value.status().sessionCalls, 2);
    assert.equal(value.status().sessionBatches, 2);
    assert.ok(fresh.jobs.every((job) => job.state === "queued"));
    await assert.rejects(value.execute({ operation: "collect", batchId: old.batchId }), /stale generation/);
    pending[0].resolve();
    pending[1].resolve();
    await waitFor(() => pending.length === 3 && value.status().active === 1);
    assert.equal(value.status().sessionCalls, 3);
    pending[2].resolve();
    await waitFor(() => value.status().active === 0);
    const collected = await value.execute({ operation: "collect", batchId: fresh.batchId });
    assert.deepEqual(collected.results.map((item) => item.receipt.state).sort(), ["complete", "failed"]);
    await value.execute({ operation: "cancel", requestId: "cancel-new", batchId: fresh.batchId });
    await assert.rejects(value.execute({ operation: "run", requestId: "third", packet: packet() }), /batch limits/);
});

test("one follow-up preserves its original deadline, call budget, and stale receipt rejection", async (t) => {
    const root = project(t);
    const second = deferred();
    const attempts = [];
    const worker = async ({ admitCall, job }) => {
        admitCall();
        attempts.push({ deadline: job.deadline, calls: job.calls, attemptId: job.attemptId });
        if (attempts.length === 2) {
            await second.promise;
        }

        return result({ status: "needs_context", missing: ["More precise question"] });
    };

    t.after(() => second.resolve());
    const value = controller(t, root, hostBridge(), { worker, limits: { jobMs: 300, batchMs: 700 } });
    value.enable();
    const original = await complete(value);
    const receipt = binding(original.results[0].receipt);
    await value.execute({
        operation: "follow_up",
        requestId: "follow",
        ...receipt,
        prompt: "Assess only the first sentence.",
    });
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].deadline, attempts[1].deadline);
    assert.deepEqual(
        attempts.map((attempt) => attempt.calls),
        [1, 2],
    );
    assert.notEqual(attempts[0].attemptId, attempts[1].attemptId);
    await assert.rejects(
        value.execute({
            operation: "resolve",
            requestId: "old-receipt",
            ...receipt,
            decision: "discard",
            findings: [],
        }),
        /receipt/,
    );
    await waitFor(() => value.status().batches[0].jobs[0].state === "expired", "original deadline");
    assert.equal(value.status().active, 1);
    second.resolve();
    await waitFor(() => value.status().active === 0);
    const expired = await value.execute({ operation: "collect", batchId: original.batchId });
    assert.equal(expired.results[0].receipt.calls, 2);
    await assert.rejects(
        value.execute({
            operation: "follow_up",
            requestId: "follow-again",
            ...binding(expired.results[0].receipt),
            prompt: "Another question",
        }),
        /unavailable/,
    );
});

test("successful follow-up can happen once and acceptance requires checked finding dispositions", async (t) => {
    const root = project(t);
    const bridge = hostBridge(() => message(JSON.stringify(findingResult())));
    const value = controller(t, root, bridge);
    value.enable();
    const initial = await complete(value);
    await value.execute({
        operation: "follow_up",
        requestId: "one-follow",
        ...binding(initial.results[0].receipt),
        prompt: "Consider contrary evidence explicitly.",
    });
    await waitFor(() => value.status().active === 0);
    const current = await value.execute({ operation: "collect", batchId: initial.batchId });
    const receipt = binding(current.results[0].receipt);
    assert.equal(receipt.resultRevision, 2);
    for (const [field, changed] of [
        ["resultRevision", 1],
        ["attemptId", "old-attempt"],
        ["generation", receipt.generation + 1],
        ["packetDigest", "0".repeat(64)],
    ]) {
        await assert.rejects(
            value.execute({
                operation: "resolve",
                requestId: `stale-${field}`,
                ...receipt,
                [field]: changed,
                decision: "discard",
                findings: [{ id: "f1", decision: "rejected" }],
            }),
            /receipt/,
        );
    }

    await assert.rejects(
        value.execute({ operation: "follow_up", requestId: "two-follow", ...receipt, prompt: "One more" }),
        /unavailable/,
    );
    await assert.rejects(
        value.execute({
            operation: "resolve",
            requestId: "missing-disposition",
            ...receipt,
            decision: "accept",
            findings: [],
        }),
        /each returned finding/,
    );
    await assert.rejects(
        value.execute({
            operation: "resolve",
            requestId: "duplicate-disposition",
            ...receipt,
            decision: "accept",
            findings: [
                { id: "f1", decision: "confirmed" },
                { id: "f1", decision: "rejected" },
            ],
        }),
        /each returned finding/,
    );
    await assert.rejects(
        value.execute({
            operation: "resolve",
            requestId: "unchecked",
            ...receipt,
            decision: "accept",
            findings: [{ id: "f1", decision: "needs_check" }],
        }),
        /checked/,
    );
    await value.execute({
        operation: "resolve",
        requestId: "review-again",
        ...receipt,
        decision: "needs_check",
        findings: [{ id: "f1", decision: "needs_check" }],
    });
    await value.execute({
        operation: "resolve",
        requestId: "checked",
        ...receipt,
        decision: "accept",
        findings: [{ id: "f1", decision: "confirmed" }],
    });
    assert.equal(bridge.calls.length, 2);
    const final = await value.execute({
        operation: "collect",
        batchId: initial.batchId,
        afterCursor: current.collectionCursor,
    });
    assert.deepEqual(final.results, []);
});

test("source edits reject collect and resolve and stale generations reject replay", async (t) => {
    const root = project(t, { "demo.md": "ordinary fixture\n" });
    const value = controller(t, root);
    value.enable();
    const input = {
        operation: "run",
        requestId: "source-run",
        packet: packet([{ ...packet().jobs[0], mode: "investigate", sources: ["demo.md"] }]),
    };
    const batch = await value.execute(input);
    await waitFor(() => value.status().active === 0);
    const before = await value.execute({ operation: "collect", batchId: batch.batchId });
    fs.writeFileSync(path.join(root, "demo.md"), "changed fixture\n");
    await assert.rejects(value.execute({ operation: "collect", batchId: batch.batchId }), /source bindings changed/i);
    await assert.rejects(
        value.execute({
            operation: "resolve",
            requestId: "edited",
            ...binding(before.results[0].receipt),
            decision: "accept",
            findings: [],
        }),
        /source bindings changed/i,
    );
    assert.equal(value.status().batches[0].jobs[0].state, "stale");
    value.invalidate("new task");
    value.enable();
    await assert.rejects(value.execute(input), /stale generation/);
});

test("collect cancellation stops waiting while the owned worker keeps running", async (t) => {
    const root = project(t);
    const gate = deferred();
    t.after(() => gate.resolve());
    const value = controller(t, root, hostBridge(), {
        worker: async ({ admitCall }) => {
            admitCall();
            await gate.promise;

            return result();
        },
    });
    value.enable();
    const batch = await value.execute({ operation: "run", requestId: "wait-run", packet: packet() });
    const waiting = new AbortController();
    const collection = value.execute(
        { operation: "collect", batchId: batch.batchId, afterCursor: 0, waitMs: 1000 },
        waiting.signal,
    );
    waiting.abort();
    assert.deepEqual((await collection).results, []);
    assert.equal(value.status().active, 1);
    assert.equal(value.status().batches[0].jobs[0].state, "running");
    gate.resolve();
    await waitFor(() => value.status().active === 0);
});

test("batch deadline expires queued jobs without starting them and keeps settling ownership", async (t) => {
    const root = project(t);
    const gate = deferred();
    t.after(() => gate.resolve());
    let started = 0;
    const value = controller(t, root, hostBridge(), {
        limits: { concurrency: 1, batchMs: 150, jobMs: 500 },
        worker: async ({ admitCall }) => {
            admitCall();
            started += 1;
            await gate.promise;

            return result();
        },
    });
    value.enable();
    const batch = await value.execute({
        operation: "run",
        requestId: "deadline-run",
        packet: packet([packet().jobs[0], { ...packet().jobs[0], id: "j2" }]),
    });
    await waitFor(() => value.status().batches[0].jobs.every((job) => job.state === "expired"), "batch deadline");
    assert.equal(started, 1);
    assert.equal(value.status().active, 1);
    const collected = await value.execute({ operation: "collect", batchId: batch.batchId });
    assert.deepEqual(
        collected.results.map((item) => item.receipt.calls),
        [1, 0],
    );
    gate.resolve();
    await waitFor(() => value.status().active === 0);
});

test("host lease and guard changes invalidate a generation before another call", async (t) => {
    const root = project(t);
    let current = true;
    let guard = "guard";
    const bridge = hostBridge();
    bridge.host.isCurrent = () => current;
    const value = controller(t, root, bridge, { getGuard: () => guard });
    value.enable();
    current = false;
    assert.equal((await value.execute({ operation: "status" })).enabled, false);
    current = true;
    value.enable();
    guard = "strict";
    await assert.rejects(value.execute({ operation: "run", requestId: "guard-change", packet: packet() }), /stale/);
    assert.equal(value.status().enabled, false);
    assert.equal(bridge.calls.length, 0);
});

test("actual workers normalize selected paths and use only their selected literal snapshot tools", async (t) => {
    const root = project(t, { "sources/a.md": "needle A\n.* literal A\n", "sources/b.md": "needle B\n.* literal B\n" });
    const bridge = hostBridge((context) => {
        const supplied = JSON.parse(context.messages[0].content[0].text);
        const selectedId = supplied.sources[0].id;
        if (context.messages.length === 1) {
            return message(
                [
                    { type: "toolCall", id: "list", name: "list_sources", arguments: {} },
                    {
                        type: "toolCall",
                        id: "read",
                        name: "read_source",
                        arguments: { sourceId: selectedId, startLine: 1, maxLines: 2 },
                    },
                    {
                        type: "toolCall",
                        id: "search",
                        name: "search_sources",
                        arguments: { query: "needle", limit: 1 },
                    },
                    { type: "toolCall", id: "literal", name: "search_sources", arguments: { query: ".*", limit: 1 } },
                ],
                { stopReason: "toolUse" },
            );
        }

        const outputs = context.messages
            .filter((item) => item.role === "toolResult")
            .map((item) => JSON.parse(item.content[0].text));
        assert.equal(outputs[0].length, 1);
        assert.equal(outputs[0][0].id, selectedId);
        assert.equal(outputs[1].sourceId, selectedId);
        assert.deepEqual(
            outputs[2].map((item) => item.sourceId),
            [selectedId],
        );
        assert.equal(outputs[3][0].line, 2);

        return message(JSON.stringify(result()));
    });
    const value = controller(t, root, bridge);
    value.enable();
    const output = await complete(
        value,
        packet(
            ["sources\\a.md", "sources/b.md"].map((source, index) => ({
                ...packet().jobs[0],
                id: `j${index}`,
                mode: "investigate",
                sources: [source],
            })),
        ),
    );
    assert.ok(
        output.results.every(
            (item) => item.receipt.state === "complete" && item.receipt.calls === 2 && item.receipt.toolCalls === 4,
        ),
    );
    for (const call of bridge.calls) {
        assert.deepEqual(
            call.context.tools.map((tool) => tool.name),
            ["list_sources", "read_source", "search_sources"],
        );
        assert.ok(call.options.maxTokens <= LIMITS.outputTokens);
        assert.ok(call.options.timeoutMs <= LIMITS.jobMs);
        assert.match(call.options.sessionId, /^specpi-delegation-/);
    }
});

test("foreign source IDs fail before returning sibling content", async (t) => {
    const root = project(t, { "a.md": "A selected text", "b.md": "B selected text" });
    const bridge = hostBridge((context) => {
        const supplied = JSON.parse(context.messages[0].content[0].text);
        if (supplied.sources[0].path === "a.md") {
            return message([
                {
                    type: "toolCall",
                    id: "foreign",
                    name: "read_source",
                    arguments: { sourceId: "s2", startLine: 1, maxLines: 1 },
                },
            ]);
        }

        return message(JSON.stringify(result()));
    });
    const value = controller(t, root, bridge);
    value.enable();
    const output = await complete(
        value,
        packet(
            ["a.md", "b.md"].map((source, index) => ({
                ...packet().jobs[0],
                id: `j${index}`,
                mode: "investigate",
                sources: [source],
            })),
        ),
    );
    assert.equal(output.results.find((item) => item.receipt.jobId === "j0").receipt.state, "failed");
    assert.equal(bridge.calls.length, 2);
    assert.ok(bridge.calls.every((call) => call.context.messages.length === 1));
});

test("invalid final JSON, coverage, confidence, and source evidence fail without retries", async (t) => {
    const invalid = [
        "not JSON",
        "```json\n{}\n```",
        JSON.stringify({ ...result(), extra: true }),
        JSON.stringify(result({ requirements: [] })),
        JSON.stringify(result({ requirements: [{ id: "r2", status: "addressed", evidence: [] }] })),
        JSON.stringify(
            result({
                requirements: [
                    { id: "r1", status: "addressed", evidence: [{ sourceId: "s999", lineStart: 1, lineEnd: 1 }] },
                ],
            }),
        ),
        JSON.stringify(
            result({
                requirements: [
                    { id: "r1", status: "addressed", evidence: [{ sourceId: "p1", lineStart: 2, lineEnd: 2 }] },
                ],
            }),
        ),
        JSON.stringify(
            result({
                findings: [
                    { id: "f1", claim: "Unsupported", confidence: "observed", evidence: [], contraryEvidence: [] },
                ],
            }),
        ),
    ];
    for (const [index, answer] of invalid.entries()) {
        await t.test(`invalid final case ${index + 1}`, async (child) => {
            const root = project(child);
            const bridge = hostBridge(() => message(answer));
            const value = controller(child, root, bridge);
            value.enable();
            const output = await complete(value);
            assert.equal(output.results[0].receipt.state, "failed");
            assert.equal(output.results[0].result, null);
            assert.equal(bridge.calls.length, 1);
        });
    }
});

test("tool-free profiles and unavailable recursive tools fail without a retry", async (t) => {
    for (const [mode, name] of [
        ["consult", "list_sources"],
        ["review", "read_source"],
        ["research", "delegate"],
        ["investigate", "bash"],
    ]) {
        await t.test(`${mode} rejects ${name}`, async (child) => {
            const root = project(child);
            const bridge = hostBridge(() => message([{ type: "toolCall", id: "bad", name, arguments: {} }]));
            const value = controller(child, root, bridge);
            value.enable();
            const output = await complete(value, packet([{ ...packet().jobs[0], mode }]));
            assert.equal(output.results[0].receipt.state, "failed");
            assert.equal(bridge.calls.length, 1);
            if (["consult", "review"].includes(mode)) {
                assert.deepEqual(bridge.calls[0].context.tools, []);
            }
        });
    }
});

test("tool conversations consume call bounds and never recurse past four calls", async (t) => {
    const root = project(t);
    const bridge = hostBridge((_context, _options, call) =>
        message([{ type: "toolCall", id: `list${call}`, name: "list_sources", arguments: {} }]),
    );
    const value = controller(t, root, bridge);
    value.enable();
    const output = await complete(value, packet([{ ...packet().jobs[0], mode: "research" }]));
    assert.equal(bridge.calls.length, 4);
    assert.equal(output.results[0].receipt.calls, 4);
    assert.equal(output.results[0].receipt.state, "failed");
});

test("provider errors are redacted and failed calls retain unknown usage", async (t) => {
    const root = project(t);
    const sensitiveFixture = "synthetic-error-token-url-do-not-return";
    const bridge = hostBridge(() => {
        throw new Error(sensitiveFixture);
    });
    const value = controller(t, root, bridge);
    value.enable();
    const output = await complete(value);
    assert.equal(output.results[0].receipt.state, "failed");
    assert.equal(output.results[0].receipt.calls, 1);
    assert.equal(output.results[0].receipt.usageComplete, false);
    assert.equal(output.results[0].receipt.cost, null);
    assert.equal(JSON.stringify(output).includes(sensitiveFixture), false);
    assert.equal(bridge.calls.length, 1);
});

test("lowered context, final-result, and batch-call limits fail without extra provider attempts", async (t) => {
    for (const [name, limits, expectedCalls] of [
        ["context", { contextBytes: 100 }, 0],
        ["result", { resultBytes: 128 }, 1],
        ["batch", { batchCalls: 1 }, 1],
    ]) {
        await t.test(`${name} quota`, async (child) => {
            const root = project(child);
            const bridge = hostBridge();
            const value = controller(child, root, bridge, { limits });
            value.enable();
            const jobs = name === "batch" ? [packet().jobs[0], { ...packet().jobs[0], id: "j2" }] : [packet().jobs[0]];
            const output = await complete(value, packet(jobs));
            assert.equal(bridge.calls.length, expectedCalls);
            assert.ok(output.results.some((item) => item.receipt.state === "failed"));
        });
    }
});

test("tool count and serialized output quotas stop the conversation before another model call", async (t) => {
    for (const kind of ["count", "bytes"]) {
        await t.test(`${kind} quota`, async (child) => {
            const root = project(child, { "demo.md": "ordinary fixture" });
            const bridge = hostBridge(() =>
                message([
                    {
                        type: "toolCall",
                        id: "one",
                        name: "read_source",
                        arguments: { sourceId: "s1", startLine: 1, maxLines: 1 },
                    },
                    ...(kind === "count" ? [{ type: "toolCall", id: "two", name: "list_sources", arguments: {} }] : []),
                ]),
            );
            const value = controller(child, root, bridge, {
                limits: kind === "count" ? { toolCalls: 1 } : { toolBytes: 32 },
            });
            value.enable();
            const output = await complete(
                value,
                packet([{ ...packet().jobs[0], mode: "investigate", sources: ["demo.md"] }]),
            );
            assert.equal(output.results[0].receipt.state, "failed");
            assert.equal(bridge.calls.length, 1);
        });
    }
});

test("oversized observed output aborts but retains its slot until provider result settlement", async (t) => {
    const root = project(t);
    const settled = deferred();
    const terminal = message(JSON.stringify(result()));
    t.after(() => settled.resolve(terminal));
    const bridge = hostBridge(() =>
        stream(terminal, [{ type: "text_delta", partial: { text: "x".repeat(2048) } }], settled.promise),
    );
    const value = controller(t, root, bridge, { limits: { retainedResponseBytes: 1024 } });
    value.enable();
    const batch = await value.execute({ operation: "run", requestId: "oversized", packet: packet() });
    await waitFor(() => bridge.calls[0]?.options.signal.aborted === true, "stream abort");
    assert.equal(value.status().active, 1);
    assert.equal(value.status().batches[0].jobs[0].settling, true);
    await value.execute({ operation: "cancel", requestId: "cancel-oversized", batchId: batch.batchId });
    const pending = await value.execute({ operation: "collect", batchId: batch.batchId });
    assert.equal(pending.results[0].receipt.state, "cancelled");
    assert.equal(pending.results[0].receipt.settling, true);
    assert.equal(pending.results[0].receipt.usageComplete, false);
    settled.resolve(terminal);
    await waitFor(() => value.status().active === 0);
    assert.equal(bridge.calls.length, 1);
    assert.equal(value.status().batches[0].jobs[0].state, "cancelled");
});
