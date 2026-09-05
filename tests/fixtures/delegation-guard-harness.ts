import assert from "node:assert/strict";
import registerGuard from "../../extensions/command-guard/index.ts";
import { createDelegationExtension } from "../../extensions/delegation/extension.mjs";

function eventBus() {
    const handlers = new Map<string, Set<any>>();

    return {
        on(name: string, handler: any) {
            const selected = handlers.get(name) ?? new Set();
            selected.add(handler);
            handlers.set(name, selected);

            return () => selected.delete(handler);
        },
        emit(name: string, value: any) {
            for (const handler of [...(handlers.get(name) ?? [])]) {
                handler(value);
            }
        },
    };
}

function api(events = eventBus()) {
    const hooks = new Map<string, any[]>();
    const commands = new Map<string, any>();
    const tools = new Map<string, any>();

    return {
        events,
        commands,
        tools,
        on(name: string, callback: any) {
            hooks.set(name, [...(hooks.get(name) ?? []), callback]);
        },
        registerCommand: (name: string, command: any) => commands.set(name, command),
        registerTool: (tool: any) => tools.set(tool.name, tool),
        async emit(name: string, context: any, event: any = {}) {
            let result;
            for (const handler of hooks.get(name) ?? []) {
                result = await handler(event, context);
            }

            return result;
        },
    };
}

function harness(events = eventBus()) {
    const pi = api(events);
    const prompts: string[] = [];
    const notices: string[] = [];
    const decisions: any = { startup: "Strict", answer: "Allow exact call for session", confirm: true };
    let invalidations = 0;
    events.on("specpi:guard-policy-changed", () => {
        invalidations += 1;
    });
    const context: any = {
        cwd: process.cwd(),
        hasUI: true,
        ui: {
            setStatus() {},
            notify(message: string) {
                notices.push(message);
            },
            async confirm() {
                return typeof decisions.confirm === "function" ? decisions.confirm() : decisions.confirm;
            },
            async select(title: string) {
                if (title === "SpecPi command guard") {
                    return typeof decisions.startup === "function" ? decisions.startup() : decisions.startup;
                }

                prompts.push(title);
                decisions.duringPrompt?.();

                return decisions.answer;
            },
        },
    };
    registerGuard(pi as any);

    return {
        pi,
        context,
        decisions,
        prompts,
        notices,
        invalidations: () => invalidations,
        start: () => pi.emit("session_start", context),
        shutdown: () => pi.emit("session_shutdown", context),
        command: (value: string) => pi.commands.get("guard").handler(value, context),
        call: (toolName: string, input: any) => pi.emit("tool_call", context, { toolName, input }),
        modes() {
            const modes: any[] = [];
            events.emit("specpi:guard-state", { reply: (state: any) => modes.push(state.mode) });

            return modes;
        },
    };
}

async function delegationProbe(events: any, context: any) {
    const pi = api(events);
    const host = { id: "guard-probe", model: { provider: "fixture", id: "fixture" }, isCurrent: () => true };
    createDelegationExtension(() => host)(pi);
    await pi.emit("session_start", context);
    const state = async () => {
        const result = await pi.tools
            .get("delegate")
            .execute("guard-probe-status", { operation: "status" }, undefined, undefined, context);
        assert.notEqual(result.isError, true);

        return result.details;
    };

    return {
        state,
        async enable() {
            await pi.commands.get("delegate").handler("on", context);

            return (await state()).enabled;
        },
        shutdown: () => pi.emit("session_shutdown", context),
    };
}

function deferred() {
    let resolve!: (value?: any) => void;
    const promise = new Promise<any>((done) => {
        resolve = done;
    });

    return { promise, resolve };
}

async function policyProof() {
    const h = harness();
    await h.start();
    assert.deepEqual(h.modes(), ["strict"]);
    const input = { operation: "status" };
    const call = () => h.call("delegate", input);
    assert.equal((await call()).block, true, "missing capability service must fail closed");
    let fingerprint = "a".repeat(64);
    const remove = h.pi.events.on("specpi:delegation-policy", (request: any) => {
        assert.deepEqual(request.input, input);
        request.reply({
            fingerprint,
            summary: "Host policy: exact parent model; no writes; bounded calls; generation bound.",
        });
    });
    assert.equal((await call())?.block, undefined);
    assert.match(h.prompts.at(-1)!, /Host policy: exact parent model; no writes; bounded calls/u);
    const initialPrompts = h.prompts.length;
    assert.equal((await call())?.block, undefined);
    assert.equal(h.prompts.length, initialPrompts, "identical effective envelope reuses exact-call approval");
    fingerprint = "b".repeat(64);
    h.decisions.answer = "Deny (Recommended)";
    assert.equal((await call()).block, true);
    assert.equal(h.prompts.length, initialPrompts + 1, "policy change cannot reuse old approval");
    h.decisions.answer = "Allow once";
    h.decisions.duringPrompt = () => {
        fingerprint = "c".repeat(64);
    };

    assert.equal((await call()).block, true, "policy change during approval must fail closed");
    h.decisions.duringPrompt = undefined;
    const other = h.pi.events.on("specpi:delegation-policy", (request: any) => {
        request.reply({ fingerprint, summary: "ambiguous" });
    });
    assert.equal((await call()).block, true, "ambiguous capability authority must fail closed");
    other();
    h.decisions.answer = "Lock session";
    const beforeLock = h.invalidations();
    await call();
    assert.equal(h.invalidations(), beforeLock + 1, "locking through approval revokes workers");
    assert.equal((await call()).block, true);
    await h.shutdown();
    assert.deepEqual(h.modes(), [], "shutdown removes the guard capability service");
    remove();
}

async function lifecycleProof() {
    const h = harness();
    await h.start();
    await h.start();
    assert.deepEqual(h.modes(), ["strict"], "repeated start does not duplicate the responder");
    await h.shutdown();
    await h.shutdown();
    assert.deepEqual(h.modes(), []);
    const choice = deferred();
    h.decisions.startup = () => choice.promise;
    const restarting = h.start();
    assert.deepEqual(h.modes(), [undefined], "restarting Guard must report unready, not absent");
    const probe = await delegationProbe(h.pi.events, h.context);
    assert.equal(await probe.enable(), false, "unready Guard must not receive optional-Guard admission");
    choice.resolve("Strict");
    await restarting;
    assert.deepEqual(h.modes(), ["strict"]);
    assert.equal(await probe.enable(), true);
    h.decisions.answer = "Deny (Recommended)";
    assert.equal((await h.call("delegate", { operation: "status" })).block, true);
    assert.equal(h.prompts.length, 1, "the second Strict session still requires exact-call policy approval");
    assert.equal((await h.call("bash", { command: "rm -rf /" })).block, true);
    assert.deepEqual(h.modes(), ["locked"]);
    assert.equal(await probe.enable(), false, "second-session lock must not be interpreted as absent Guard");
    await h.shutdown();
    const fresh = harness(h.pi.events);
    await fresh.start();
    assert.deepEqual(fresh.modes(), ["strict"], "reload replaces the old responder rather than retaining it");
    assert.equal(await probe.enable(), true);
    const duplicate = harness(h.pi.events);
    await duplicate.start();
    assert.deepEqual(duplicate.modes(), ["strict", "strict"]);
    assert.equal(await probe.enable(), false, "separate Guard instances must remain ambiguous and fail closed");
    await duplicate.shutdown();
    assert.deepEqual(fresh.modes(), ["strict"], "one instance may detach only its own responder");
    assert.equal(await probe.enable(), true);
    await fresh.shutdown();
    await probe.shutdown();
    const absent = await delegationProbe(eventBus(), h.context);
    assert.equal(await absent.enable(), true, "a genuinely absent optional Guard remains supported");
    await absent.shutdown();
}

async function mutationProof() {
    const h = harness();
    await h.start();
    const probe = await delegationProbe(h.pi.events, h.context);
    assert.equal(await probe.enable(), true);
    for (const command of ["staus", "status", "", "unlock", "strict"]) {
        await h.command(command);
        assert.equal(h.invalidations(), 0, command);
        assert.equal((await probe.state()).enabled, true, command);
    }

    h.decisions.confirm = false;
    for (const command of ["guard", "off"]) {
        await h.command(command);
        assert.equal(h.invalidations(), 0, `declined ${command}`);
        assert.equal((await probe.state()).enabled, true);
    }

    h.decisions.confirm = true;
    for (const command of ["guard", "clear-approvals", "off", "strict"]) {
        assert.equal(await probe.enable(), true);
        const before = h.invalidations();
        await h.command(command);
        assert.equal(h.invalidations(), before + 1, command);
        assert.equal((await probe.state()).enabled, false, command);
        if (command === "guard" || command === "off") {
            assert.equal(await probe.enable(), true, `optional Guard supports ${command}`);
            await h.command(command);
            assert.equal(h.invalidations(), before + 1, `already ${command}`);
            assert.equal((await probe.state()).enabled, true);
        }
    }

    assert.equal(await probe.enable(), true);
    const beforeLock = h.invalidations();
    assert.equal((await h.call("bash", { command: "rm -rf /" })).block, true);
    assert.equal(h.invalidations(), beforeLock + 1);
    assert.equal((await probe.state()).enabled, false);
    for (const command of ["status", "staus", "guard", "strict", "off", "clear-approvals"]) {
        await h.command(command);
        assert.deepEqual(h.modes(), ["locked"]);
        assert.equal(h.invalidations(), beforeLock + 1, `locked ${command}`);
    }

    h.decisions.confirm = false;
    await h.command("unlock");
    assert.deepEqual(h.modes(), ["locked"]);
    assert.equal(h.invalidations(), beforeLock + 1);
    h.decisions.confirm = true;
    await h.command("unlock");
    assert.deepEqual(h.modes(), ["strict"]);
    assert.equal(h.invalidations(), beforeLock + 2);
    await probe.shutdown();
    await h.shutdown();
}

async function dialogProof() {
    const h = harness();
    const oldChoice = deferred();
    h.decisions.startup = () => oldChoice.promise;
    const oldStartup = h.start();
    await h.shutdown();
    h.decisions.startup = "Strict";
    await h.start();
    oldChoice.resolve("Off for this session");
    await oldStartup;
    assert.deepEqual(h.modes(), ["strict"], "old startup choice cannot downgrade the next session");

    const oldOff = deferred();
    const offEntered = deferred();
    h.decisions.startup = "Off for this session";
    h.decisions.confirm = () => {
        offEntered.resolve();

        return oldOff.promise;
    };

    const oldOffStartup = h.start();
    await offEntered.promise;
    await h.shutdown();
    h.decisions.startup = "Strict";
    await h.start();
    oldOff.resolve(true);
    await oldOffStartup;
    assert.deepEqual(h.modes(), ["strict"], "old startup confirmation cannot downgrade the next session");

    for (const command of ["off", "guard", "unlock"]) {
        for (const reset of [false, true]) {
            await h.start();
            if (command === "unlock") {
                await h.call("bash", { command: "rm -rf /" });
            }

            const approval = deferred();
            const entered = deferred();
            h.decisions.confirm = () => {
                entered.resolve();

                return approval.promise;
            };

            const pending = h.command(command);
            await entered.promise;
            if (reset || command === "unlock") {
                await h.shutdown();
                await h.start();
            }

            if (!reset) {
                await h.call("bash", { command: "rm -rf /" });
            }

            const beforeAnswer = h.invalidations();
            approval.resolve(true);
            await pending;
            assert.deepEqual(h.modes(), [reset ? "strict" : "locked"], `${command}; reset=${reset}`);
            assert.equal(h.invalidations(), beforeAnswer, "a stale confirmation must not emit a policy mutation");
        }
    }

    await h.shutdown();
}

const proofs: Record<string, () => Promise<void>> = {
    policy: policyProof,
    lifecycle: lifecycleProof,
    mutations: mutationProof,
    dialogs: dialogProof,
};
const selected = process.argv[2] ?? "policy";
proofs["lock-order"] = async () => {
    for (const [name, input] of [
        ["bash", { command: "git reset --hard" }],
        ["write", { path: "guard-order-fixture.md", content: "fixture" }],
        ["unknown_fixture_tool", {}],
    ] as const) {
        const h = harness();
        await h.start();
        await h.call("remember_fixture_tool", {});
        await h.command("status");
        assert.match(h.notices.at(-1)!, /session approvals: 1;/);
        const observed: string[] = [];
        const off = h.pi.events.on("specpi:guard-policy-changed", () => {
            // Event dispatch is synchronous: inspect the policy inside the notification.
            void h.command("status");
            observed.push(h.notices.at(-1)!);
        });
        h.decisions.answer = "Lock session";
        const denied = await h.call(name, input);
        assert.equal(denied?.block, true);
        assert.equal(observed.length, 1, name);
        assert.match(observed[0], /Mode: locked;/);
        assert.match(observed[0], /session approvals: 0;/);
        off();
        await h.shutdown();
    }
};

assert.ok(proofs[selected], "Unknown delegation Guard proof");
await proofs[selected]();
console.log(`DELEGATION_GUARD_HARNESS=${selected}:passed`);
