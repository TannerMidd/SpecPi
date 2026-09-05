import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDelegationExtension, DELEGATE_SCHEMA } from "../extensions/delegation/extension.mjs";

function project(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-delegation-ui-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    return root;
}

function bus() {
    const handlers = new Map();

    return {
        on(name, handler) {
            const selected = handlers.get(name) ?? new Set();
            selected.add(handler);
            handlers.set(name, selected);

            return () => selected.delete(handler);
        },
        emit(name, value) {
            for (const handler of [...(handlers.get(name) ?? [])]) {
                handler(value);
            }
        },
        count: (name) => handlers.get(name)?.size ?? 0,
    };
}

function mockPi() {
    const commands = new Map();
    const tools = new Map();
    const handlers = new Map();
    const events = bus();
    const notices = [];
    const statuses = new Map();
    const context = {
        hasUI: true,
        ui: { notify: (text, kind) => notices.push({ text, kind }), setStatus: (key, text) => statuses.set(key, text) },
    };
    let guard = "guard";
    const removeGuard = events.on("specpi:guard-state", (request) => request.reply({ mode: guard }));

    return {
        events,
        commands,
        tools,
        notices,
        statuses,
        context,
        removeGuard,
        registerCommand: (name, definition) => commands.set(name, definition),
        registerTool: (definition) => tools.set(definition.name, definition),
        on(name, handler) {
            const selected = handlers.get(name) ?? [];
            selected.push(handler);
            handlers.set(name, selected);
        },
        async fire(name, event = {}, ctx = context) {
            const results = [];
            for (const handler of handlers.get(name) ?? []) {
                results.push(await handler(event, ctx));
            }

            return results;
        },
        command: (args, ctx = context) => commands.get("delegate").handler(args, ctx),
        tool: (input, signal) => tools.get("delegate").execute("fixture-tool-call", input, signal, undefined, context),
        setGuard: (mode) => {
            guard = mode;
        },
    };
}

function packet() {
    return {
        objective: "Assess public fixture",
        requirements: [{ id: "r1", text: "Check fixture" }],
        decisions: [],
        nonGoals: ["No file changes"],
        reason: {
            benefit: "independent_review",
            why: "An independent review of the frozen fixture",
            parentWork: "Review integration",
        },
        jobs: [
            {
                id: "j1",
                mode: "review",
                question: "Assess fixture",
                context: "public text",
                sources: [],
                requirements: ["r1"],
            },
        ],
    };
}

function result() {
    return {
        status: "complete",
        answer: "Fixture exists",
        requirements: [{ id: "r1", status: "addressed", evidence: [] }],
        findings: [],
        missing: [],
        nextStep: "Parent checks",
    };
}

function publicHostBridge() {
    let calls = 0;
    const host = {
        id: "fixture-owner",
        model: { provider: "fixture", id: "fixture-parent" },
        isCurrent: () => true,
        async openSession() {
            const terminal = {
                role: "assistant",
                content: [{ type: "text", text: JSON.stringify(result()) }],
                stopReason: "stop",
                usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            };

            return {
                release() {},
                async run(_prompt, controls) {
                    controls.admitCall();
                    calls += 1;
                    controls.onUsage(terminal.usage);

                    return terminal;
                },
            };
        },
    };

    return { host, calls: () => calls };
}

async function fixture(t, controllerOptions = {}) {
    const bridge = publicHostBridge();
    const factory = createDelegationExtension(() => bridge.host, { root: project(t), controllerOptions });
    const pi = mockPi();
    factory(pi);
    await pi.fire("session_start");
    t.after(() => pi.fire("session_shutdown"));

    return { bridge, factory, pi };
}

async function state(pi) {
    return (await pi.tool({ operation: "status" })).details;
}

async function waitFor(predicate, label = "extension state") {
    const deadline = Date.now() + 2500;
    while (!(await predicate())) {
        assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
}

test("extension stays off until a human UI command and exposes closed operations", async (t) => {
    const { pi, bridge } = await fixture(t);
    assert.deepEqual([...pi.commands.keys()], ["delegate"]);
    assert.deepEqual([...pi.tools.keys()], ["delegate"]);
    assert.equal((await state(pi)).enabled, false);
    assert.deepEqual(await pi.fire("before_agent_start"), [undefined]);
    await pi.command("on", { ...pi.context, hasUI: false });
    assert.equal((await state(pi)).enabled, false);
    assert.match(pi.notices.at(-1).text, /human interactive command/);
    assert.equal((await pi.tool({ operation: "on" })).isError, true);
    assert.equal((await pi.tool({ operation: "status", enabled: true })).isError, true);
    assert.equal((await pi.tool({ operation: "run", requestId: "off-run", packet: packet() })).isError, true);
    assert.ok(DELEGATE_SCHEMA.anyOf.every((branch) => branch.additionalProperties === false));
    await pi.command("on");
    assert.equal((await state(pi)).enabled, true);
    assert.match(pi.notices.at(-1).text, /Pi child sessions for review and scout, fixture\/fixture-parent/);
    assert.equal((await pi.fire("before_agent_start"))[0].message.display, false);
    assert.equal(bridge.calls(), 0);
});

test("activation cannot outlive the extension binding that started provider preflight", async (t) => {
    let finish;
    const ready = new Promise((resolve) => {
        finish = resolve;
    });
    const bridge = publicHostBridge();
    bridge.host.ready = () => ready;
    const factory = createDelegationExtension(() => bridge.host, { root: project(t) });
    const oldPi = mockPi();
    factory(oldPi);
    await oldPi.fire("session_start");
    const pendingActivation = oldPi.command("on");
    const currentPi = mockPi();
    factory(currentPi);
    await currentPi.fire("session_start");
    t.after(() => currentPi.fire("session_shutdown"));
    finish();
    await pendingActivation;
    assert.equal((await state(currentPi)).enabled, false);
    assert.match(oldPi.notices.at(-1).text, /changed during delegation setup/);
    await currentPi.command("on");
    assert.equal((await state(currentPi)).enabled, true);
});

test("delegation runs with Command Guard absent or off and retains its own ceilings", async (t) => {
    for (const mode of ["absent", "off"]) {
        const { pi, bridge } = await fixture(t, { limits: { sessionCalls: 1 } });
        if (mode === "absent") {
            pi.removeGuard();
        } else {
            pi.setGuard(mode);
        }

        await pi.command("on");
        assert.equal((await state(pi)).enabled, true, mode);
        assert.equal((await state(pi)).guard, mode);
        const batch = await pi.tool({ operation: "run", requestId: "first", packet: packet() });
        await waitFor(async () => (await state(pi)).active === 0);
        const collected = await pi.tool({ operation: "collect", batchId: batch.details.batchId });
        assert.equal(collected.details.results[0].receipt.state, "complete");
        await pi.command("off");
        await pi.command("on");
        assert.equal((await state(pi)).sessionCalls, 1);
        await pi.tool({ operation: "run", requestId: "second", packet: packet() });
        await waitFor(async () => (await state(pi)).active === 0);
        assert.equal(bridge.calls(), 1, "optional Guard must not remove delegation's call ceiling");
    }
});

test("activation identifies a locked, unready or ambiguous installed Command Guard", async (t) => {
    const { pi, bridge } = await fixture(t);
    for (const [mode, error] of [
        ["locked", /Guard is locked/],
        [undefined, /not reported a ready policy/],
    ]) {
        pi.setGuard(mode);
        await pi.command("on");
        assert.equal((await state(pi)).enabled, false);
        assert.match(pi.notices.at(-1).text, error);
    }

    pi.setGuard("off");
    const detach = pi.events.on("specpi:guard-state", (request) => request.reply({ mode: "off" }));
    await pi.command("on");
    assert.equal((await state(pi)).enabled, false);
    assert.match(pi.notices.at(-1).text, /Multiple Command Guard instances/);
    detach();
    assert.equal(bridge.calls(), 0);
});

test("installing or removing Guard revokes delegation before another worker call", async (t) => {
    const { pi, bridge } = await fixture(t);
    await pi.command("on");
    pi.removeGuard();
    assert.equal((await pi.tool({ operation: "run", requestId: "removed", packet: packet() })).isError, true);
    assert.equal((await state(pi)).enabled, false);
    await pi.command("on");
    pi.events.on("specpi:guard-state", (request) => request.reply({ mode: "strict" }));
    assert.equal((await pi.tool({ operation: "run", requestId: "installed", packet: packet() })).isError, true);
    assert.equal((await state(pi)).enabled, false);
    assert.equal(bridge.calls(), 0);
});

test("ordinary leaf and turn advances preserve a collected result generation", async (t) => {
    const { pi } = await fixture(t);
    await pi.command("on");
    const run = await pi.tool({ operation: "run", requestId: "leaf-run", packet: packet() });
    await waitFor(async () => (await state(pi)).active === 0);
    const generation = (await state(pi)).generation;
    pi.events.emit("specpi:workflow-status", { active: "scope", generation: 1, taskStale: false, leafId: "one" });
    for (const name of ["message_end", "turn_end", "agent_end", "session_update"]) {
        await pi.fire(name, { leafId: "two" });
    }

    pi.events.emit("specpi:workflow-status", { active: "scope", generation: 1, taskStale: false, leafId: "two" });
    assert.equal((await state(pi)).enabled, true);
    assert.equal((await state(pi)).generation, generation);
    const collected = await pi.tool({ operation: "collect", batchId: run.details.batchId });
    assert.equal(collected.isError, undefined);
    assert.equal(collected.details.results[0].receipt.state, "complete");
});

test("actual navigation, session lifecycle, and model selection invalidate delegation", async (t) => {
    const { pi } = await fixture(t);
    for (const event of [
        "session_before_switch",
        "session_before_fork",
        "session_before_tree",
        "session_tree",
        "model_select",
        "thinking_level_select",
        "session_start",
    ]) {
        await pi.command("on");
        const before = (await state(pi)).generation;
        await pi.fire(event);
        assert.equal((await state(pi)).enabled, false, event);
        assert.ok((await state(pi)).generation > before, event);
    }
});

test("task, workflow, and guard state changes revoke policy without ordinary status churn", async (t) => {
    const { pi } = await fixture(t);
    await pi.command("on");
    pi.events.emit("specpi:task-contract-changed", { digest: "same", previousDigest: "same" });
    assert.equal((await state(pi)).enabled, true);
    pi.events.emit("specpi:task-contract-changed", { digest: "new", previousDigest: "old" });
    assert.equal((await state(pi)).enabled, false);
    await pi.command("on");
    pi.events.emit("specpi:workflow-status", { active: "one", generation: 1, taskStale: false });
    pi.events.emit("specpi:workflow-status", { active: "two", generation: 1, taskStale: false });
    assert.equal((await state(pi)).enabled, false);
    await pi.command("on");
    pi.events.emit("specpi:guard-policy-changed", {});
    assert.equal((await state(pi)).enabled, false);
    pi.setGuard("locked");
    await pi.command("on");
    assert.equal((await state(pi)).enabled, false);
    assert.equal(pi.notices.at(-1).kind, "error");
    pi.setGuard("guard");
    const off = pi.events.on("specpi:guard-state", (request) => request.reply({ mode: "guard" }));
    await pi.command("on");
    assert.equal((await state(pi)).enabled, false);
    off();
});

test("policy replies are bound to live state and subscriptions are removed on shutdown", async (t) => {
    const { pi } = await fixture(t);
    let before;
    pi.events.emit("specpi:delegation-policy", {
        input: { operation: "status" },
        reply: (value) => {
            before = value;
        },
    });
    assert.match(before.summary, /enabled=false/);
    await pi.command("on");
    let after;
    pi.events.emit("specpi:delegation-policy", {
        input: { operation: "status" },
        reply: (value) => {
            after = value;
        },
    });
    assert.notEqual(before.fingerprint, after.fingerprint);
    assert.match(after.summary, /enabled=true/);
    assert.match(after.summary, /SDK settlement does not establish remote termination or invoice bounds/);
    let invalid = "unanswered";
    pi.events.emit("specpi:delegation-policy", {
        input: { operation: "status", arbitrary: true },
        reply: (value) => {
            invalid = value;
        },
    });
    assert.equal(invalid, undefined);
    await pi.fire("session_shutdown");
    for (const name of [
        "specpi:delegation-policy",
        "specpi:guard-policy-changed",
        "specpi:task-contract-changed",
        "specpi:workflow-status",
    ]) {
        assert.equal(pi.events.count(name), 0, name);
    }

    assert.equal((await pi.tool({ operation: "status" })).isError, true, "shutdown disables old tool callbacks");
});

test("factory rebinding preserves counters and non-cooperative settlement ownership", async (t) => {
    const pending = [];
    const worker = async ({ admitCall, signal }) => {
        admitCall();
        let resolve;
        const promise = new Promise((done) => {
            resolve = done;
        });
        pending.push({ resolve, signal });
        await promise;

        return result();
    };

    t.after(() => pending.forEach((item) => item.resolve()));
    const { factory, pi } = await fixture(t, {
        worker,
        limits: { concurrency: 1, sessionCalls: 1, sessionBatches: 2 },
    });
    await pi.command("on");
    const first = await pi.tool({ operation: "run", requestId: "first", packet: packet() });
    assert.equal((await state(pi)).active, 1);
    const secondPi = mockPi();
    factory(secondPi);
    t.after(() => secondPi.fire("session_shutdown"));
    await secondPi.fire("session_start");
    assert.equal(pending[0].signal.aborted, true);
    assert.equal((await state(secondPi)).active, 1);
    assert.equal((await state(secondPi)).sessionCalls, 1);
    assert.equal((await state(secondPi)).sessionBatches, 1);
    assert.equal((await state(secondPi)).enabled, false);
    await secondPi.command("on");
    await pi.fire("session_shutdown");
    await pi.fire("model_select");
    assert.equal((await state(secondPi)).enabled, true, "old lifecycle callbacks cannot revoke a new binding");
    assert.equal((await pi.tool({ operation: "status" })).isError, true);
    assert.equal(pi.events.count("specpi:delegation-policy"), 0);
    const second = await secondPi.tool({ operation: "run", requestId: "second", packet: packet() });
    assert.equal(second.details.jobs[0].state, "queued");
    assert.equal((await secondPi.tool({ operation: "collect", batchId: first.details.batchId })).isError, true);
    pending[0].resolve();
    await waitFor(async () => (await state(secondPi)).active === 0);
    assert.equal(pending.length, 1);
    assert.equal((await state(secondPi)).sessionCalls, 1);
    assert.equal((await state(secondPi)).sessionBatches, 2);
    assert.equal(
        (await secondPi.tool({ operation: "collect", batchId: second.details.batchId })).details.results[0].receipt
            .state,
        "failed",
    );
});
