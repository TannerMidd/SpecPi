import assert from "node:assert/strict";
import path from "node:path";
import registerBackgroundTasks from "../../extensions/background-tasks/index.ts";
import registerCommandGuard from "../../extensions/command-guard/index.ts";

function harness(guard = true) {
    const handlers = new Map<string, any[]>();
    const bus = new Map<string, Set<any>>();
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    let starts = 0;
    let prompts = 0;
    let stops = 0;
    let confirm: any = async () => true;
    const runner: any = {
        list: () => [],
        async start() {
            starts += 1;

            return { id: "fixture", status: "running" };
        },
        async stop() {
            stops += 1;

            return { id: "fixture", cleanup: "confirmed" };
        },
        async shutdown() {
            stops += 1;

            return [];
        },
    };
    const pi: any = {
        on(name: string, handler: any) {
            handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        },
        registerTool(tool: any) {
            tools.set(tool.name, tool);
        },
        registerCommand(name: string, value: any) {
            commands.set(name, value);
        },
        events: {
            on(name: string, handler: any) {
                if (!bus.has(name)) {
                    bus.set(name, new Set());
                }

                bus.get(name)!.add(handler);

                return () => bus.get(name)!.delete(handler);
            },
            emit(name: string, data: unknown) {
                for (const handler of bus.get(name) ?? []) {
                    handler(data);
                }
            },
        },
    };
    const ctx: any = {
        cwd: process.cwd(),
        hasUI: true,
        ui: {
            async select() {
                return "Guard (Recommended)";
            },
            async confirm(...args: any[]) {
                prompts += 1;

                return confirm(...args);
            },
            notify() {},
            setStatus() {},
        },
    };
    if (guard) {
        registerCommandGuard(pi);
    }

    registerBackgroundTasks(pi, { runner, approvalMs: 30 });
    async function event(name: string, value: any = {}) {
        for (const handler of handlers.get(name) ?? []) {
            const outcome = await handler(value, ctx);
            if (outcome?.block) {
                return outcome;
            }
        }
    }

    const call = (name: string, input: any, signal?: AbortSignal) =>
        tools.get(name).execute("test", input, signal, undefined, ctx);

    return {
        pi,
        ctx,
        tools,
        commands,
        runner,
        event,
        call,
        setConfirm(value: any) {
            confirm = value;
        },
        get starts() {
            return starts;
        },
        get prompts() {
            return prompts;
        },
        get stops() {
            return stops;
        },
    };
}

const h = harness();
assert.equal(h.tools.size, 4);
assert.equal(h.tools.get("background_start").parameters.additionalProperties, false);
await assert.rejects(h.call("background_start", { command: "echo safe" }), /active session/);
await h.event("session_start");
await h.call("background_start", { command: "echo safe" });
await h.call("background_start", { command: "echo safe" });
assert.equal(h.prompts, 1);
h.ctx.hasUI = false;
await assert.rejects(h.call("background_start", { command: "echo safe" }), /approval UI/);
h.ctx.hasUI = true;
h.setConfirm(async () => false);
await assert.rejects(h.call("background_start", { command: "echo changed" }), /not approved/);
const changed = { command: "echo mutate" };
h.setConfirm(async () => {
    changed.command = "echo replacement";

    return true;
});
await assert.rejects(h.call("background_start", changed), /changed during approval/);
h.setConfirm(async () => {
    h.pi.events.emit("specpi:guard-policy-changed", {});

    return true;
});
await assert.rejects(h.call("background_start", { command: "echo stale" }));
h.setConfirm(async () => new Promise(() => {}));
await assert.rejects(h.call("background_start", { command: "echo timeout" }), /not approved/);
h.setConfirm(async () => {
    throw new Error("prompt failed");
});
await assert.rejects(h.call("background_start", { command: "echo failure" }), /prompt failed/);
const controller = new AbortController();
h.setConfirm(async () => {
    controller.abort();

    return true;
});
await assert.rejects(h.call("background_start", { command: "echo abort" }, controller.signal));
assert.equal(h.starts, 2);
h.setConfirm(async () => true);
await h.commands.get("guard").handler("strict", h.ctx);
await h.call("background_start", { command: "echo safe" });
assert.equal(h.starts, 3);
await h.commands.get("guard").handler("off", h.ctx);
await h.call("background_start", { command: "echo off" });
await h.commands.get("guard").handler("guard", h.ctx);
const catastrophic = process.platform === "win32" ? "rd /s /q C:\\" : "rm -rf /";
await assert.rejects(h.call("background_start", { command: catastrophic }));
await assert.rejects(h.call("background_start", { command: "echo locked" }), /locked/);
await h.call("background_stop", { id: "fixture" });
await h.call("background_list", {});
await assert.rejects(h.call("background_list", { extra: true }));
assert.equal(h.stops, 1);
await h.event("session_shutdown", { reason: "reload" });
await assert.rejects(h.call("background_start", { command: "echo safe" }), /active session/);
await h.event("session_start", { reason: "reload" });
await h.call("background_start", { command: "echo safe" });
await h.event("session_tree");
h.setConfirm(async () => false);
await assert.rejects(h.call("background_start", { command: "echo safe" }), /not approved/);

const absent = harness(false);
await absent.event("session_start");
await absent.call("background_start", { command: "echo safe" });
await assert.rejects(absent.call("background_start", { command: catastrophic }));
const old = absent.pi.events.on("specpi:guard-state", (request: any) => request.reply({ mode: "guard" }));
await assert.rejects(absent.call("background_start", { command: "echo old" }), /unavailable/);
old();
const duplicate = h.pi.events.on("specpi:guard-state", (request: any) => request.reply({ mode: "guard" }));
await assert.rejects(h.call("background_start", { command: "echo ambiguous" }), /ambiguous/);
duplicate();

const races = harness();
await races.event("session_start");
for (const mutation of ["cwd", "timeoutSeconds"]) {
    const input: any = { command: "echo field-race", timeoutSeconds: 1 };
    races.setConfirm(async () => {
        input[mutation] = mutation === "cwd" ? path.dirname(process.cwd()) : 2;

        return true;
    });
    await assert.rejects(races.call("background_start", input), /changed during approval/);
}

races.setConfirm(async () => {
    await races.commands.get("guard").handler("strict", races.ctx);

    return true;
});
await assert.rejects(races.call("background_start", { command: "echo mode-race" }));
races.setConfirm(async () => {
    await races.event("session_shutdown", { reason: "new" });

    return true;
});
await assert.rejects(races.call("background_start", { command: "echo session-race" }));
assert.equal(races.starts, 0);
await races.event("session_start");
assert.equal((await races.event("tool_call", { toolName: "bash", input: { command: catastrophic } }))?.block, true);
await assert.rejects(races.call("background_start", { command: catastrophic }));
assert.equal(races.starts, 0);

const bounded = harness(false);
await bounded.event("session_start");
for (let index = 0; index < 129; index += 1) {
    await bounded.call("background_start", { command: `echo ${index}` });
}

assert.equal(bounded.prompts, 129);
await bounded.call("background_start", { command: "echo 0" });
assert.equal(bounded.prompts, 130);
console.log("BACKGROUND_EXTENSION=passed");
