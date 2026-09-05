import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDelegationController } from "../extensions/delegation/core.mjs";
import { createSnapshot } from "../extensions/delegation/snapshot.mjs";
import { LIMITS, validatePacket } from "../extensions/delegation/protocol.mjs";

const usage = { input: 3, output: 5, cacheRead: 0, cacheWrite: 0 };

test("failed requests and repeated cancellation cannot exhaust admission or evict spending receipts", async (t) => {
    const value = controller(t, project(t));
    const input = { operation: "run", requestId: "retry-after-enable", packet: packet() };
    for (let index = 0; index < 300; index += 1) {
        await assert.rejects(value.execute({ ...input, requestId: `failed-${index}` }), /disabled/);
    }

    await assert.rejects(value.execute(input), /disabled/);
    value.enable();
    const first = await value.execute(input);
    await waitFor(() => value.status().active === 0);
    for (let index = 0; index < 300; index += 1) {
        await value.execute({ operation: "cancel", requestId: `cancel-${index}`, batchId: first.batchId });
    }

    assert.deepEqual(await value.execute(input), first, "admitted run receipt survives cancellation churn");
    await assert.rejects(
        value.execute({ ...input, packet: { ...packet(), objective: "changed" } }),
        /different payload/,
    );
    const second = await complete(value, packet(), "second-run");
    assert.equal(second.results[0].receipt.state, "complete");
    assert.equal(value.status().sessionCalls, 2);
    assert.equal(value.status().sessionBatches, 2);
    await assert.rejects(value.execute(input), /retired/);
});

test("nonfinal assessment churn preserves follow-up and final-disposition receipts", async (t) => {
    const value = controller(t, project(t));
    value.enable();
    const first = await complete(value);
    const receipt = binding(first.results[0].receipt);
    for (let index = 0; index < 300; index += 1) {
        await value.execute({
            operation: "resolve",
            requestId: `check-${index}`,
            ...receipt,
            decision: "needs_check",
            findings: [],
        });
    }

    const follow = {
        operation: "follow_up",
        requestId: "follow",
        ...receipt,
        prompt: "Check the fixture against the additional requirement: confirm the answer is supported.",
    };
    const accepted = await value.execute(follow);
    await waitFor(() => value.status().active === 0);
    assert.deepEqual(await value.execute(follow), accepted);
    const collected = await value.execute({ operation: "collect", batchId: first.batchId });
    const resolve = {
        operation: "resolve",
        requestId: "final",
        ...binding(collected.results[0].receipt),
        decision: "accept",
        findings: [],
    };
    const finalized = await value.execute(resolve);
    assert.deepEqual(await value.execute(resolve), finalized);
    assert.equal(value.status().sessionCalls, 2);
});

test("source listing paginates long Unicode metadata without consuming the tool allowance in one call", async (t) => {
    const sources = Array.from({ length: 100 }, (_, index) => ({
        id: `s${index + 1}`,
        path: `${"界".repeat(170)}-${index}.md`,
        digest: "a".repeat(64),
        bytes: 1,
        lineCount: 1,
    }));
    let observed = [];
    const bridge = hostBridge((context) => {
        const outputs = context.messages.filter((item) => item.role === "toolResult");
        if (!outputs.length) {
            return message([{ type: "toolCall", id: "page-1", name: "list_sources", arguments: {} }], {
                stopReason: "toolUse",
            });
        }

        const page = JSON.parse(outputs.at(-1).content[0].text);
        assert.ok(Buffer.byteLength(outputs.at(-1).content[0].text) <= 16 * 1024);
        assert.ok(page.sources.length > 0 && page.sources.length < sources.length);
        if (outputs.length === 1) {
            observed = page.sources.map((source) => source.id);

            return message(
                [{ type: "toolCall", id: "page-2", name: "list_sources", arguments: { offset: page.nextOffset } }],
                { stopReason: "toolUse" },
            );
        }

        assert.equal(page.sources[0].id, sources[observed.length].id);
        assert.ok(page.sources.every((source) => !observed.includes(source.id)));

        return message(JSON.stringify(result()));
    });
    const value = controller(t, project(t), bridge, {
        snapshotFactory: () => ({ sources, assertFresh() {}, assertBindings() {}, destroy() {} }),
    });
    value.enable();
    const output = await complete(
        value,
        packet([{ ...packet().jobs[0], mode: "scout", sources: sources.map((source) => source.path) }]),
    );
    assert.equal(output.results[0].receipt.state, "complete");
    assert.equal(output.results[0].receipt.toolCalls, 2);
    assert.ok(output.results[0].receipt.toolBytes <= 32 * 1024);
});

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
    jobs = [{ id: "j1", mode: "review", question: "Assess the fixture", context: "ordinary fixture", sources: [] }],
) {
    return {
        objective: "Assess a public fixture",
        requirements: [{ id: "r1", text: "Explain the fixture" }],
        decisions: ["Use only the supplied sources"],
        nonGoals: ["Do not modify files"],
        reason: {
            benefit: jobs.every((job) => job.mode === "review") ? "independent_review" : "context_isolation",
            why: "A separate evidence question with an independently checkable answer",
            parentWork: "Inspect integration boundaries",
        },
        jobs: jobs.map((job) => ({
            ...job,
            question: `${job.question} (${job.id})`,
            requirements: job.requirements ?? ["r1"],
        })),
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

// A scripted session double exercises the controller. Real Pi's loop is verified
// separately by the provider and ordinary-startup integration fixtures.
function hostBridge(respond = () => message(JSON.stringify(result()))) {
    const calls = [];
    const host = {
        id: "fixture-host",
        model: { provider: "fixture", id: "exact-parent-model" },
        isCurrent: () => true,
        async openSession({ systemPrompt, tools }) {
            const messages = [];

            return {
                release() {},
                async run(prompt, controls) {
                    messages.push({ role: "user", content: [{ type: "text", text: prompt }] });
                    for (;;) {
                        controls.assertLive();
                        const context = {
                            systemPrompt,
                            messages,
                            tools: tools.map(({ name, description, parameters }) => ({
                                name,
                                description,
                                parameters,
                            })),
                        };
                        if (Buffer.byteLength(JSON.stringify(context)) > controls.limits.contextBytes) {
                            throw new Error("Context limit");
                        }

                        controls.admitCall();
                        calls.push({ context: structuredClone(context), options: controls });
                        const response = await respond(context, controls, calls.length);
                        const events = response?.[Symbol.asyncIterator] ? response : stream(response);
                        let terminal;
                        try {
                            for await (const event of events) {
                                controls.assertLive();
                                if (
                                    Buffer.byteLength(JSON.stringify(event.partial ?? event.message ?? {})) >
                                    controls.limits.retainedResponseBytes
                                ) {
                                    throw new Error("Response limit");
                                }
                            }

                            terminal = await events.result();
                            controls.onUsage(terminal.usage);
                            controls.assertLive();
                        } catch (error) {
                            controls.abort();
                            await events.result();
                            throw error;
                        }

                        messages.push(terminal);
                        const requested = terminal.content.filter((part) => part.type === "toolCall");
                        if (!requested.length) {
                            return terminal;
                        }

                        for (const call of requested) {
                            const tool = tools.find((item) => item.name === call.name);
                            if (!tool) {
                                throw new Error("Unavailable tool");
                            }

                            const output = await tool.execute(call.id, call.arguments, controls.signal);
                            messages.push({
                                role: "toolResult",
                                toolCallId: call.id,
                                toolName: call.name,
                                content: output.content,
                                isError: false,
                            });
                        }
                    }
                },
            };
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

function trackedSnapshot() {
    let snapshot;
    let destroyed = 0;

    return {
        factory(root, paths) {
            snapshot = createSnapshot(root, paths);

            return {
                ...snapshot,
                destroy() {
                    destroyed += 1;
                    snapshot.destroy();
                },
            };
        },
        get snapshot() {
            return snapshot;
        },
        get destroyed() {
            return destroyed;
        },
    };
}

test("deadline cleanup drops captured text and inputs but keeps verifiable receipts", async (t) => {
    const root = project(t, { "demo.md": "ordinary selected text" });
    const tracking = trackedSnapshot();
    let ownedJob;
    const value = controller(t, root, hostBridge(), {
        snapshotFactory: tracking.factory,
        limits: { jobMs: 250, batchMs: 100 },
        worker: async ({ job, admitCall }) => {
            ownedJob = job;
            admitCall();

            return result();
        },
    });
    value.enable();
    const initial = await complete(value, packet([{ ...packet().jobs[0], sources: ["demo.md"] }]));
    assert.equal(tracking.destroyed, 0, "eligible follow-up still owns its inputs");
    await waitFor(() => tracking.destroyed === 1, "input expiry");
    assert.deepEqual(ownedJob.spec, { id: "j1" });
    assert.equal(ownedJob.child, undefined);
    assert.throws(() => tracking.snapshot.read("s1"), /closed/);
    const collected = await value.execute({ operation: "collect", batchId: initial.batchId });
    assert.equal(collected.results[0].result.status, "complete");
    await assert.rejects(
        value.execute({
            operation: "follow_up",
            requestId: "late",
            ...binding(collected.results[0].receipt),
            prompt: "Late input",
        }),
        /unavailable/,
    );
    fs.writeFileSync(path.join(root, "demo.md"), "different selected text");
    await assert.rejects(value.execute({ operation: "collect", batchId: initial.batchId }), /source bindings changed/);
});

test("one resolved sibling cannot destroy another job's follow-up snapshot", async (t) => {
    const root = project(t, { "demo.md": "shared selected text" });
    const tracking = trackedSnapshot();
    const value = controller(t, root, hostBridge(), { snapshotFactory: tracking.factory });
    value.enable();
    const original = await complete(
        value,
        packet([
            { ...packet().jobs[0], sources: ["demo.md"] },
            { ...packet().jobs[0], id: "j2", sources: ["demo.md"] },
        ]),
    );
    const resolve = {
        operation: "resolve",
        requestId: "resolve-first",
        ...binding(original.results[0].receipt),
        decision: "discard",
        findings: [],
    };
    const first = await value.execute(resolve);
    assert.equal(tracking.destroyed, 0);
    assert.equal(tracking.snapshot.read("s1").text, "shared selected text");
    await value.execute({
        operation: "follow_up",
        requestId: "follow-sibling",
        ...binding(original.results[1].receipt),
        prompt: "Check the same evidence again",
    });
    await waitFor(() => value.status().active === 0);
    assert.equal(tracking.destroyed, 1, "no further follow-up remains after the second attempt");
    assert.deepEqual(await value.execute(resolve), first, "replay remains metadata-only and idempotent");
    const current = await value.execute({ operation: "collect", batchId: original.batchId });
    await value.execute({
        operation: "resolve",
        requestId: "resolve-sibling",
        ...binding(current.results[1].receipt),
        decision: "discard",
        findings: [],
    });
    assert.equal(tracking.destroyed, 1);
});

test("retired batches release content while quotas, summaries and replay fingerprints survive", async (t) => {
    const root = project(t);
    const value = controller(t, root, hostBridge(), { limits: { sessionBatches: 2 } });
    value.enable();
    const firstInput = { operation: "run", requestId: "first", packet: packet() };
    const first = await complete(value, firstInput.packet, firstInput.requestId);
    await value.execute({
        operation: "resolve",
        requestId: "discard-first",
        ...binding(first.results[0].receipt),
        decision: "discard",
        findings: [],
    });
    const second = await complete(value, packet(), "second");
    assert.equal(value.status().batches.find((batch) => batch.batchId === first.batchId).retired, true);
    await assert.rejects(value.execute({ operation: "collect", batchId: first.batchId }), /retired/);
    await assert.rejects(value.execute(firstInput), /retired/);
    await assert.rejects(
        value.execute({ ...firstInput, packet: { ...firstInput.packet, objective: "Changed payload" } }),
        /different payload/,
    );
    await value.execute({ operation: "cancel", requestId: "cancel-second", batchId: second.batchId });
    value.invalidate();
    value.enable();
    assert.equal(value.status().sessionBatches, 2);
    assert.equal(value.status().sessionCalls, 2);
    await assert.rejects(value.execute({ operation: "run", requestId: "third", packet: packet() }), /batch limits/);
});

test("cancellation destroys snapshots without freeing an uncooperative worker's slot", async (t) => {
    const root = project(t, { "demo.md": "cancelled selected text" });
    const tracking = trackedSnapshot();
    const gate = deferred();
    t.after(() => gate.resolve());
    let ownedJob;
    let releases = 0;
    const value = controller(t, root, hostBridge(), {
        snapshotFactory: tracking.factory,
        worker: async ({ job, admitCall }) => {
            ownedJob = job;
            admitCall();
            job.release = () => {
                releases += 1;
                throw new Error("private cancellation teardown failure");
            };

            await gate.promise;

            return result();
        },
    });
    value.enable();
    const batch = await value.execute({
        operation: "run",
        requestId: "cancel-inputs",
        packet: packet([{ ...packet().jobs[0], sources: ["demo.md"] }]),
    });
    value.invalidate();
    assert.equal(tracking.destroyed, 1);
    assert.throws(() => tracking.snapshot.read("s1"), /closed/);
    assert.equal(value.status().active, 1);
    assert.equal(value.status().sessionCalls, 1);
    assert.equal(releases, 1);
    gate.resolve();
    await waitFor(() => value.status().active === 0);
    assert.deepEqual(ownedJob.spec, { id: "j1" });
    assert.equal(value.status().batches.find((item) => item.batchId === batch.batchId).retired, true);
    assert.equal(tracking.destroyed, 1);
});

test("throwing and rejecting teardown cannot escape deadline or cancellation cleanup", async (t) => {
    for (const asyncFailure of [false, true]) {
        await t.test(asyncFailure ? "rejected teardown" : "synchronous teardown", async (t) => {
            const root = project(t);
            const tracking = trackedSnapshot();
            let releases = 0;
            let ownedJob;
            const value = controller(t, root, hostBridge(), {
                snapshotFactory: tracking.factory,
                limits: { jobMs: 80 },
                worker: async ({ job, admitCall }) => {
                    ownedJob = job;
                    admitCall();
                    job.child = { fixture: true };
                    job.release = () => {
                        releases += 1;
                        assert.equal(job.release, undefined);
                        assert.equal(job.child, undefined);
                        if (asyncFailure) {
                            return Promise.reject(new Error("private SDK teardown error"));
                        }

                        throw new Error("private SDK teardown error");
                    };

                    return result();
                },
            });
            value.enable();
            const batch = await complete(value);
            await waitFor(() => tracking.destroyed === 1, "deadline teardown");
            assert.equal(releases, 1);
            assert.equal(ownedJob.release, undefined);
            assert.equal(value.status().active, 0);
            await value.execute({ operation: "cancel", requestId: "cancel-after-teardown", batchId: batch.batchId });
            assert.equal(releases, 1);
        });
    }
});

test("failed attempts still expire retained follow-up inputs under the original timer", async (t) => {
    const root = project(t);
    const tracking = trackedSnapshot();
    const value = controller(t, root, hostBridge(), {
        snapshotFactory: tracking.factory,
        limits: { jobMs: 80 },
        worker: async () => {
            throw new Error("private failure");
        },
    });
    value.enable();
    await complete(value);
    assert.equal(tracking.destroyed, 0);
    await waitFor(() => tracking.destroyed === 1, "failed-attempt expiry");
    assert.equal(value.status().active, 0);
});

test("usage preserves partial token fields and distinguishes unknown values from reported zero", async (t) => {
    const root = project(t);
    const value = controller(t, root, hostBridge(), {
        worker: async ({ admitCall, onUsage }) => {
            admitCall();
            onUsage({ input: 3, output: 5 });
            admitCall();
            onUsage({ input: 7, output: -1, cacheRead: 0, cacheWrite: NaN });

            return result();
        },
    });
    value.enable();
    const receipt = (await complete(value)).results[0].receipt;
    assert.deepEqual(receipt.usage, { input: 10, output: 5, cacheRead: 0, cacheWrite: null });
    assert.deepEqual(receipt.usageReportedCalls, { input: 2, output: 1, cacheRead: 1, cacheWrite: 0 });
    assert.equal(receipt.usageComplete, false);
});

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
        {
            operation: "run",
            requestId: "empty-evidence",
            packet: packet([{ ...packet().jobs[0], context: "", sources: [] }]),
        },
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

test("admission permits only evidenced review and scoped analysis with valid requirement assignments", () => {
    const review = packet();
    review.reason.parentWork = "";
    assert.deepEqual(validatePacket(review), review, "final review need not invent concurrent parent work");
    const scout = packet([{ ...review.jobs[0], mode: "scout", sources: ["public.md"] }]);
    scout.reason.benefit = "parallel_analysis";
    assert.deepEqual(validatePacket(scout), scout);
    const invalid = [
        (value) => {
            value.jobs[0].mode = "consult";
        },
        (value) => {
            value.jobs[0].requirements = [];
        },
        (value) => {
            value.jobs[0].requirements = ["unknown"];
        },
        (value) => {
            value.jobs[0].requirements = ["r1", "r1"];
        },
        (value) => {
            value.reason.benefit = "faster";
        },
        (value) => {
            value.reason.benefit = "context_isolation";
        },
        (value) => {
            value.jobs.push({ ...value.jobs[0], id: "j2", question: ` ${value.jobs[0].question.toUpperCase()} ` });
        },
        (value) => {
            value.jobs.push(...["j2", "j3"].map((id) => ({ ...value.jobs[0], id, question: id })));
        },
    ];
    for (const mutate of invalid) {
        const value = structuredClone(review);
        mutate(value);
        assert.throws(() => validatePacket(value));
    }

    const ungrounded = structuredClone(scout);
    ungrounded.jobs[0].sources = [];
    assert.throws(() => validatePacket(ungrounded), /selected source files/);
    scout.reason.parentWork = "";
    assert.throws(() => validatePacket(scout), /text/);
});

test("each child sees and answers only its assigned requirements", async (t) => {
    const selected = packet();
    selected.requirements.push({ id: "r2", text: "A separate parent-owned requirement" });
    const bridge = hostBridge((context) => {
        const handoff = JSON.parse(context.messages[0].content[0].text);
        assert.deepEqual(handoff.requirements, [selected.requirements[0]]);

        return message(JSON.stringify(result()));
    });
    const value = controller(t, project(t), bridge);
    value.enable();
    const collected = await complete(value, selected);
    assert.equal(collected.results[0].receipt.state, "complete");
    assert.equal(bridge.calls.length, 1);
});

test("completed child sessions release at disposition or the original deadline while reports remain collectable", async (t) => {
    for (const action of ["accept", "discard", "deadline", "invalidate"]) {
        let releases = 0;
        const worker = async ({ job, admitCall }) => {
            admitCall();
            job.release = () => {
                releases += 1;
            };

            return result();
        };

        const value = controller(t, project(t), hostBridge(), { worker, limits: { jobMs: 80 } });
        value.enable();
        const collected = await complete(value);
        assert.equal(releases, 0, `${action}: keep a successful session for one follow-up`);
        const receipt = collected.results[0].receipt;
        if (action === "deadline") {
            await waitFor(() => releases === 1);
            const retained = await value.execute({ operation: "collect", batchId: receipt.batchId });
            assert.equal(retained.results[0].receipt.state, "complete");
            await assert.rejects(
                value.execute({
                    operation: "follow_up",
                    requestId: "late",
                    ...binding(receipt),
                    prompt: "New evidence",
                }),
                /unavailable/,
            );
        } else if (action === "invalidate") {
            value.invalidate();
        } else {
            await value.execute({
                operation: "resolve",
                requestId: "final",
                ...binding(receipt),
                decision: action,
                findings: [],
            });
        }

        assert.equal(releases, 1, action);
        value.invalidate();
        assert.equal(releases, 1, `${action}: release remains idempotent`);
    }
});

test("cancellation while Pi opens a child releases the late session without inference", async (t) => {
    const opened = deferred();
    let releases = 0;
    let runs = 0;
    const bridge = hostBridge();
    bridge.host.openSession = () => opened.promise;
    const value = controller(t, project(t), bridge);
    value.enable();
    const batch = await value.execute({ operation: "run", requestId: "opening", packet: packet() });
    value.invalidate();
    assert.equal(value.status().active, 1);
    opened.resolve({
        release: () => {
            releases += 1;
        },
        run: () => {
            runs += 1;
        },
    });
    await waitFor(() => value.status().active === 0);
    assert.equal(releases, 1);
    assert.equal(runs, 0);
    assert.equal(value.status().batches.find((item) => item.batchId === batch.batchId).jobs[0].state, "stale");
});

test("a failed child follow-up restores the original handoff while preserving spent calls", async (t) => {
    const bridge = hostBridge((context, _options, number) => {
        if (number === 1) {
            return message("malformed report");
        }

        const prompt = context.messages[0].content[0].text;
        assert.match(prompt, /Assess a public fixture/);
        assert.match(prompt, /Explain the fixture/);
        assert.match(prompt, /ordinary fixture/);
        assert.match(prompt, /New evidence: fixture is documented/);

        return message(JSON.stringify(result()));
    });
    const value = controller(t, project(t), bridge);
    value.enable();
    const failed = await complete(value);
    assert.equal(failed.results[0].receipt.state, "failed");
    const receipt = failed.results[0].receipt;
    await value.execute({
        operation: "follow_up",
        requestId: "corrected",
        ...binding(receipt),
        prompt: "New evidence: fixture is documented",
    });
    await waitFor(() => value.status().active === 0);
    const collected = await value.execute({ operation: "collect", batchId: receipt.batchId });
    assert.equal(collected.results[0].receipt.state, "complete");
    assert.equal(collected.results[0].receipt.calls, 2);
    assert.equal(bridge.calls.length, 2);
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
    const jobs = Array.from({ length: 2 }, (_, index) => ({ ...packet().jobs[0], id: `j${index}` }));
    const batch = await value.execute({ operation: "run", requestId: "concurrent", packet: packet(jobs) });
    assert.equal(value.status().active, 2);
    assert.equal(pending.length, 2);
    assert.deepEqual(
        batch.jobs.map((job) => job.state),
        ["running", "running"],
    );
    await value.execute({ operation: "cancel", requestId: "cancel1", batchId: batch.batchId, jobId: "j0" });
    const cancelled = await value.execute({ operation: "collect", batchId: batch.batchId });
    assert.equal(cancelled.results[0].receipt.state, "cancelled");
    assert.equal(cancelled.results[0].receipt.settling, true);
    assert.equal(pending[0].signal.aborted, true);
    assert.equal(pending.length, 2);
    pending[0].gate.resolve();
    await waitFor(() => value.status().active === 1);
    pending[1].gate.resolve();
    await waitFor(() => value.status().active === 0);
    assert.equal(value.status().sessionCalls, 2);
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
        packet: packet([{ ...packet().jobs[0], mode: "scout", sources: ["demo.md"] }]),
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
        assert.equal(outputs[0].sources.length, 1);
        assert.equal(outputs[0].sources[0].id, selectedId);
        assert.equal(outputs[0].nextOffset, null);
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
                mode: "scout",
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
                mode: "scout",
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
        ["review", "list_sources"],
        ["review", "read_source"],
        ["scout", "delegate"],
        ["scout", "bash"],
    ]) {
        await t.test(`${mode} rejects ${name}`, async (child) => {
            const root = project(child, { "demo.md": "selected evidence" });
            const bridge = hostBridge(() => message([{ type: "toolCall", id: "bad", name, arguments: {} }]));
            const value = controller(child, root, bridge);
            value.enable();
            const output = await complete(
                value,
                packet([{ ...packet().jobs[0], mode, sources: mode === "scout" ? ["demo.md"] : [] }]),
            );
            assert.equal(output.results[0].receipt.state, "failed");
            assert.equal(bridge.calls.length, 1);
            if (mode === "review") {
                assert.deepEqual(bridge.calls[0].context.tools, []);
            }
        });
    }
});

test("tool conversations consume call bounds and never recurse past four calls", async (t) => {
    const root = project(t, { "demo.md": "selected evidence" });
    const bridge = hostBridge((_context, _options, call) =>
        message([{ type: "toolCall", id: `list${call}`, name: "list_sources", arguments: {} }]),
    );
    const value = controller(t, root, bridge);
    value.enable();
    const output = await complete(value, packet([{ ...packet().jobs[0], mode: "scout", sources: ["demo.md"] }]));
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
                packet([{ ...packet().jobs[0], mode: "scout", sources: ["demo.md"] }]),
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
