import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDelegationExtension, DELEGATE_SCHEMA } from "../extensions/delegation/extension.mjs";
import { createToolRenderers, panelLines } from "../extensions/delegation/presentation.mjs";

const presentation = {
    truncateToWidth: (text, width) => [...text].slice(0, width).join(""),
    wrapTextWithAnsi: (text) => [text],
};
const plainTheme = { fg: (_color, text) => text };

test("unchanged tool cards reuse wrapped lines until a resize or theme invalidation", () => {
    let wraps = 0;
    const renderers = createToolRenderers({
        ...presentation,
        wrapTextWithAnsi(text) {
            wraps += 1;

            return [text];
        },
    });
    const card = renderers.renderCall({ operation: "status" }, plainTheme);
    const initial = card.render(80);
    for (let index = 0; index < 1000; index += 1) {
        assert.equal(card.render(80), initial);
    }

    assert.equal(wraps, 1);
    card.render(40);
    assert.equal(wraps, 2);
    card.invalidate();
    card.render(40);
    assert.equal(wraps, 3);
});

test("human status is readable and limits retains every fixed ceiling", async (t) => {
    const { pi } = await fixture(t);
    await pi.command("on");
    await pi.command("status");
    assert.match(pi.notices.at(-1).text, /0\/2 workers active/);
    assert.match(pi.notices.at(-1).text, /fixture\/fixture-parent/);
    assert.match(pi.notices.at(-1).text, /Command Guard: guard/);
    assert.doesNotMatch(pi.notices.at(-1).text, /\{"/);
    await pi.command("limits");
    const state = (await pi.tool({ operation: "status" })).details;
    for (const value of Object.values(state.limits)) {
        assert.ok(pi.notices.at(-1).text.includes(String(value)));
    }
});

test("live panel samples counters, keeps cancelled slots visible and stops refreshing after settlement", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
    let settle;
    const held = new Promise((resolve) => {
        settle = resolve;
    });
    const bridge = publicHostBridge();
    const factory = createDelegationExtension(() => bridge.host, {
        root: project(t),
        presentation,
        controllerOptions: {
            async worker({ job, admitCall }) {
                admitCall();
                job.toolCalls = 2;
                await held;

                return result();
            },
        },
    });
    const pi = mockPi();
    pi.context.mode = "tui";
    factory(pi);
    await pi.fire("session_start");
    t.after(() => pi.fire("session_shutdown"));
    await pi.command("on");
    assert.equal(pi.widgets.size, 0);
    await pi.tool({ operation: "run", requestId: "panel-run", packet: packet() });
    const widget = pi.widgets.get("specpi-delegation-workers");
    assert.ok(widget);
    assert.match(widget.render(100).join("\n"), /j1 · review · running · 0s · 1 model · 2 tools/);
    const before = pi.renders();
    t.mock.timers.tick(1000);
    assert.equal(pi.renders(), before + 1);
    assert.match(widget.render(60).join("\n"), /1s · 1 model · 2 tools/);
    await pi.command("off");
    assert.match(widget.render(100).join("\n"), /stopping/);
    assert.equal((await pi.tool({ operation: "status" })).details.active, 1);
    settle();
    await new Promise(setImmediate);
    assert.equal(pi.widgets.size, 0);
    const done = pi.renders();
    t.mock.timers.tick(5000);
    assert.equal(pi.renders(), done);
});

test("completed results stay visible without a timer until parent resolution", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const bridge = publicHostBridge();
    const factory = createDelegationExtension(() => bridge.host, { root: project(t), presentation });
    const pi = mockPi();
    pi.context.mode = "tui";
    factory(pi);
    await pi.fire("session_start");
    t.after(() => pi.fire("session_shutdown"));
    await pi.command("on");
    const started = await pi.tool({ operation: "run", requestId: "ready-run", packet: packet() });
    await new Promise(setImmediate);
    assert.match(pi.widgets.get("specpi-delegation-workers").render(100).join("\n"), /ready for review/);
    const before = pi.renders();
    t.mock.timers.tick(1000);
    assert.equal(pi.renders(), before);
    const collected = await pi.tool({ operation: "collect", batchId: started.details.batchId });
    const receipt = collected.details.results[0].receipt;
    await pi.tool({
        operation: "resolve",
        requestId: "ready-resolve",
        decision: "accept",
        findings: [],
        ...Object.fromEntries(
            ["batchId", "jobId", "attemptId", "packetDigest", "generation", "resultRevision"].map((key) => [
                key,
                receipt[key],
            ]),
        ),
    });
    assert.equal(pi.widgets.size, 0);
});

test("panel shutdown detaches its timer and a reload cannot render into the old session", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let settle;
    const held = new Promise((resolve) => {
        settle = resolve;
    });
    const bridge = publicHostBridge();
    const factory = createDelegationExtension(() => bridge.host, {
        root: project(t),
        presentation,
        controllerOptions: {
            worker: async () => {
                await held;

                return result();
            },
        },
    });
    const first = mockPi();
    first.context.mode = "tui";
    factory(first);
    await first.fire("session_start");
    await first.command("on");
    await first.tool({ operation: "run", requestId: "reload-panel", packet: packet() });
    const second = mockPi();
    second.context.mode = "tui";
    factory(second);
    await second.fire("session_start");
    assert.equal(first.widgets.size, 0);
    assert.match(second.widgets.get("specpi-delegation-workers").render(100).join("\n"), /stopping/);
    await first.fire("session_shutdown");
    t.mock.timers.tick(1000);
    assert.equal(first.widgets.size, 0);
    assert.equal(second.widgets.size, 1);
    await second.fire("session_shutdown");
    const before = second.renders();
    t.mock.timers.tick(1000);
    assert.equal(second.widgets.size, 0);
    assert.equal(second.renders(), before);
    settle();
    await new Promise(setImmediate);
});

test("RPC and print sessions never mount terminal widgets", async (t) => {
    const bridge = publicHostBridge();
    for (const mode of ["rpc", "print"]) {
        const factory = createDelegationExtension(() => bridge.host, { root: project(t), presentation });
        const pi = mockPi();
        pi.context.mode = mode;
        factory(pi);
        await pi.fire("session_start");
        await pi.command("on");
        await pi.tool({ operation: "run", requestId: `headless-${mode}`, packet: packet() });
        await new Promise(setImmediate);
        assert.equal(pi.widgets.size, 0);
        await pi.fire("session_shutdown");
    }
});

test("tool cards keep structured results intact and strip terminal controls from expanded evidence", () => {
    const renderers = createToolRenderers(presentation);
    const output = {
        content: [{ type: "text", text: "unchanged structured JSON" }],
        details: {
            jobs: [{ jobId: "j1", state: "complete", calls: 2 }],
            results: [
                {
                    receipt: { jobId: "j1" },
                    result: {
                        ...result(),
                        answer: "\u001b[2JVisible\u202e text",
                        findings: [
                            {
                                id: "f1",
                                confidence: "observed",
                                claim: "A claim",
                                evidence: [{ sourceId: "s1", lineStart: 3, lineEnd: 5 }],
                                contraryEvidence: [],
                            },
                        ],
                    },
                },
            ],
        },
    };
    const before = JSON.stringify(output);
    const compact = renderers.renderResult(output, { expanded: false }, plainTheme).render(200).join("\n");
    assert.match(compact, /1 findings · advisory/);
    assert.doesNotMatch(compact, /A claim|Visible/);
    const expanded = renderers.renderResult(output, { expanded: true }, plainTheme).render(200).join("\n");
    assert.match(expanded, /Visible text/);
    assert.match(expanded, /f1 \[observed\] A claim/);
    assert.match(expanded, /s1:3–5/);
    assert.equal(expanded.includes("\u001b"), false);
    assert.equal(expanded.includes("\u202e"), false);
    assert.equal(JSON.stringify(output), before);
    assert.match(
        renderers.renderCall({ operation: "run", packet: packet() }, plainTheme).render(100).join("\n"),
        /Delegate · run · j1 \(review\)/,
    );
    assert.match(renderers.renderResult({}, { isPartial: true }, plainTheme).render(100).join("\n"), /Waiting/);
});

test("narrow worker rows retain separate metrics and status explains occupied slots", () => {
    const view = {
        active: 1,
        concurrency: 2,
        calls: 3,
        callLimit: 32,
        jobs: [
            {
                id: "review-api",
                mode: "review",
                state: "running",
                settling: true,
                elapsedMs: 65000,
                calls: 2,
                tools: 4,
            },
        ],
    };
    assert.equal(panelLines(view, 60, plainTheme, presentation.truncateToWidth).length, 3);
    assert.match(
        panelLines(view, 60, plainTheme, presentation.truncateToWidth).join("\n"),
        /1m 5s · 2 model · 4 tools/,
    );
    assert.match(panelLines(view, 100, plainTheme, presentation.truncateToWidth).join("\n"), /1\/2 workers/);
});

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
    const widgets = new Map();
    let renders = 0;
    const context = {
        hasUI: true,
        ui: {
            notify: (text, kind) => notices.push({ text, kind }),
            setStatus: (key, text) => statuses.set(key, text),
            setWidget(key, value) {
                if (value) {
                    widgets.set(
                        key,
                        value(
                            {
                                requestRender: () => {
                                    renders += 1;
                                },
                            },
                            { fg: (_color, text) => text },
                        ),
                    );
                } else {
                    widgets.delete(key);
                }
            },
        },
    };
    let guard = "guard";
    const removeGuard = events.on("specpi:guard-state", (request) => request.reply({ mode: guard }));

    return {
        events,
        commands,
        tools,
        notices,
        statuses,
        widgets,
        renders: () => renders,
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

test("SDK setup failures never expose messages, causes or non-Error thrown values", async (t) => {
    for (const thrown of [
        new Error("secret-token https://private.example/prompt", { cause: "private cause" }),
        "secret-token",
        { message: "secret-token" },
        null,
    ]) {
        const { pi, bridge } = await fixture(t);
        bridge.host.ready = async () => {
            throw thrown;
        };

        await pi.command("on");
        const paused = await state(pi);
        assert.equal(paused.enabled, false);
        assert.equal(paused.requested, true);
        assert.equal(paused.pauseReason, "Delegation operation failed. Retry after checking Pi configuration.");
        await pi.command("status");
        await pi.fire("model_select");
        assert.doesNotMatch(
            JSON.stringify({ paused, notices: pi.notices }),
            /secret-token|private\.example|private cause/,
        );
    }
});

test("unexpected context setup failures are redacted for activation, status and tool calls", async (t) => {
    const bridge = publicHostBridge();
    let broken = false;
    const factory = createDelegationExtension(() => bridge.host, {
        root: project(t),
        prepareContext() {
            if (broken) {
                throw new Error("secret-context canary");
            }
        },
    });
    const pi = mockPi();
    factory(pi);
    await pi.fire("session_start");
    t.after(() => {
        broken = false;

        return pi.fire("session_shutdown");
    });
    broken = true;
    await pi.command("on");
    const failed = await pi.tool({ operation: "status" });
    assert.equal(failed.isError, true);
    broken = false;
    const paused = await state(pi);
    assert.match(paused.pauseReason, /Delegation operation failed/);
    assert.doesNotMatch(JSON.stringify({ failed, paused, notices: pi.notices }), /secret-context/);
});

test("startup setup failures revoke old work, redact SDK errors and allow later activation", async (t) => {
    const bridge = publicHostBridge();
    let broken = false;
    const factory = createDelegationExtension(() => bridge.host, {
        root: project(t),
        prepareContext(ctx) {
            if (ctx && broken) {
                throw new Error("private-startup-canary", { cause: "private-startup-cause" });
            }
        },
    });
    const pi = mockPi();
    factory(pi);
    await pi.fire("session_start");
    t.after(() => pi.fire("session_shutdown"));
    await pi.command("on");
    assert.equal((await state(pi)).enabled, true);
    broken = true;
    await pi.fire("session_start");
    broken = false;
    const paused = await state(pi);
    assert.equal(paused.enabled, false);
    assert.equal(paused.requested, false);
    assert.match(paused.pauseReason, /Delegation operation failed/);
    assert.doesNotMatch(JSON.stringify({ paused, notices: pi.notices }), /private-startup/);
    await pi.command("on");
    assert.equal((await state(pi)).enabled, true);
    assert.equal((await state(pi)).pauseReason, null);
});

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

test("model and thinking changes follow the parent without resetting workers or quotas", async (t) => {
    const executions = [];
    const worker = async ({ host, signal, admitCall }) => {
        admitCall();
        await new Promise((resolve) => executions.push({ host, signal, resolve }));

        return result();
    };

    t.after(() => executions.forEach((entry) => entry.resolve()));
    const { pi, bridge } = await fixture(t, { worker, limits: { concurrency: 1, sessionCalls: 2 } });
    await pi.command("on");
    const first = await pi.tool({ operation: "run", requestId: "old-model", packet: packet() });
    const oldGeneration = (await state(pi)).generation;
    bridge.host = {
        ...bridge.host,
        id: "new-owner",
        model: { provider: "other", id: "new-model", thinkingLevel: "high" },
    };
    await pi.fire("model_select");
    assert.equal((await state(pi)).enabled, true);
    assert.equal((await state(pi)).requested, true);
    assert.deepEqual((await state(pi)).model, bridge.host.model);
    assert.ok((await state(pi)).generation > oldGeneration);
    assert.equal(executions[0].signal.aborted, true);
    assert.equal((await state(pi)).active, 1, "old request owns its slot until settlement");
    assert.equal((await state(pi)).sessionCalls, 1);
    assert.equal((await pi.tool({ operation: "collect", batchId: first.details.batchId })).isError, true);
    const second = await pi.tool({ operation: "run", requestId: "new-model", packet: packet() });
    assert.equal(second.details.jobs[0].state, "queued");
    executions[0].resolve();
    await waitFor(() => executions.length === 2);
    assert.equal(executions[1].host, bridge.host);
    executions[1].resolve();
    await waitFor(async () => (await state(pi)).active === 0);
    bridge.host = { ...bridge.host, id: "new-thinking", model: { ...bridge.host.model, thinkingLevel: "low" } };
    await pi.fire("thinking_level_select");
    assert.equal((await state(pi)).enabled, true);
    assert.equal((await state(pi)).model.thinkingLevel, "low");
    assert.equal((await state(pi)).sessionCalls, 2);
    assert.equal((await state(pi)).sessionBatches, 2);
    await pi.tool({ operation: "run", requestId: "exhausted", packet: packet() });
    await waitFor(async () => (await state(pi)).active === 0);
    assert.equal(executions.length, 2);
    await pi.command("off");
    await pi.fire("model_select");
    assert.equal((await state(pi)).requested, false);
    assert.equal((await state(pi)).enabled, false);
});

test("an unsupported selected model pauses delegation and a compatible selection resumes it", async (t) => {
    const { pi, bridge } = await fixture(t);
    await pi.command("on");
    const supported = bridge.host;
    bridge.host = {
        ...supported,
        id: "unsupported",
        ready: async () => {
            throw new Error("Unsupported fixture provider");
        },
    };
    await pi.fire("model_select");
    assert.equal((await state(pi)).enabled, false);
    assert.equal((await state(pi)).requested, true);
    assert.equal((await state(pi)).updating, false);
    assert.match((await state(pi)).pauseReason, /Delegation operation failed/);
    assert.equal(bridge.calls(), 0);
    bridge.host = { ...supported, id: "compatible" };
    await pi.fire("model_select");
    assert.equal((await state(pi)).enabled, true);
    assert.equal((await state(pi)).pauseReason, null);
    assert.equal(bridge.calls(), 0);
});

test("rapid selections coalesce the same setup and a late setup cannot restore an old model", async (t) => {
    const { pi, bridge } = await fixture(t);
    await pi.command("on");
    let finish;
    let setups = 0;
    const readiness = new Promise((resolve) => {
        finish = resolve;
    });
    bridge.host = {
        ...bridge.host,
        id: "slow",
        ready: () => {
            setups += 1;

            return readiness;
        },
    };
    const slow = pi.fire("model_select");
    const duplicate = pi.fire("thinking_level_select");
    assert.equal(setups, 1);
    assert.equal((await state(pi)).updating, true);
    bridge.host = {
        ...bridge.host,
        id: "fast",
        model: { provider: "fixture", id: "fast-model" },
        ready: async () => {},
    };
    await pi.fire("model_select");
    finish();
    await Promise.all([slow, duplicate]);
    assert.equal((await state(pi)).enabled, true);
    assert.equal((await state(pi)).updating, false);
    assert.equal((await state(pi)).model.id, "fast-model");
});

test("off, guard changes and new sessions cannot be undone by pending model setup", async (t) => {
    for (const change of ["off", "guard", "session_start"]) {
        const { pi, bridge } = await fixture(t);
        await pi.command("on");
        let finish;
        const readiness = new Promise((resolve) => {
            finish = resolve;
        });
        bridge.host = { ...bridge.host, id: "pending", ready: () => readiness };
        const selection = pi.fire("model_select");
        if (change === "off") {
            await pi.command("off");
        } else if (change === "guard") {
            pi.events.emit("specpi:guard-policy-changed", {});
        } else {
            await pi.fire(change);
        }

        finish();
        await selection;
        assert.equal((await state(pi)).requested, false, change);
        assert.equal((await state(pi)).enabled, false, change);
        assert.equal(bridge.calls(), 0);
    }
});

test("the next turn refreshes a changed host when no selection notification was observed", async (t) => {
    const { pi, bridge } = await fixture(t);
    await pi.command("on");
    bridge.host = { ...bridge.host, id: "unannounced", model: { provider: "fixture", id: "unannounced" } };
    const events = await pi.fire("before_agent_start");
    assert.equal(events[0].message.display, false);
    assert.equal((await state(pi)).enabled, true);
    assert.equal((await state(pi)).model.id, "unannounced");
});

test("actual navigation and session lifecycle invalidate delegation", async (t) => {
    const { pi } = await fixture(t);
    for (const event of [
        "session_before_switch",
        "session_before_fork",
        "session_before_tree",
        "session_tree",
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
