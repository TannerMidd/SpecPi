import assert from "node:assert/strict";
import registerGuard from "../../extensions/command-guard/index.ts";

const hooks = new Map<string, any[]>();
const bus = new Map<string, Set<any>>();
const commands = new Map<string, any>();
const prompts: string[] = [];
let answer = "Allow exact call for session";
let fingerprint = "a".repeat(64);
let duringPrompt: (() => void) | undefined;
let invalidations = 0;
const pi: any = {
    on(name: string, callback: any) {
        hooks.set(name, [...(hooks.get(name) ?? []), callback]);
    },
    registerCommand(name: string, command: any) {
        commands.set(name, command);
    },
    events: {
        on(name: string, callback: any) {
            const set = bus.get(name) ?? new Set();
            set.add(callback);
            bus.set(name, set);

            return () => set.delete(callback);
        },
        emit(name: string, value: any) {
            for (const callback of bus.get(name) ?? []) {
                callback(value);
            }
        },
    },
};
const context: any = {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
        setStatus() {},
        notify() {},
        async confirm() {
            return true;
        },
        async select(title: string) {
            if (title === "SpecPi command guard") {
                return "Strict";
            }

            prompts.push(title);
            duringPrompt?.();

            return answer;
        },
    },
};
const emit = async (name: string, event: any = {}) => {
    let result;
    for (const callback of hooks.get(name) ?? []) {
        result = await callback(event, context);
    }

    return result;
};

pi.events.on("specpi:guard-policy-changed", () => {
    invalidations += 1;
});
registerGuard(pi);
await emit("session_start");
let guardMode;
pi.events.emit("specpi:guard-state", {
    reply: (state: any) => {
        guardMode = state.mode;
    },
});
assert.equal(guardMode, "strict");
const call = { toolName: "delegate", input: { operation: "status" } };
assert.equal((await emit("tool_call", call)).block, true, "missing capability service must fail closed");
const remove = pi.events.on("specpi:delegation-policy", (request: any) => {
    assert.deepEqual(request.input, call.input);
    request.reply({ fingerprint, summary: "Host policy: exact parent model; no writes; 48 calls; generation bound." });
});
assert.equal((await emit("tool_call", call))?.block, undefined);
assert.match(prompts.at(-1)!, /Host policy: exact parent model; no writes; 48 calls/u);
const initialPrompts = prompts.length;
assert.equal((await emit("tool_call", call))?.block, undefined);
assert.equal(prompts.length, initialPrompts, "identical effective envelope reuses exact-call approval");
fingerprint = "b".repeat(64);
answer = "Deny (Recommended)";
assert.equal((await emit("tool_call", call)).block, true);
assert.equal(prompts.length, initialPrompts + 1, "policy change cannot reuse old approval");
answer = "Allow once";
duringPrompt = () => {
    fingerprint = "c".repeat(64);
};

assert.equal((await emit("tool_call", call)).block, true, "policy change during approval must fail closed");
duringPrompt = undefined;
const other = pi.events.on("specpi:delegation-policy", (request: any) => {
    request.reply({ fingerprint, summary: "ambiguous" });
});
assert.equal((await emit("tool_call", call)).block, true, "ambiguous capability authority must fail closed");
other();
await commands.get("guard").handler("guard", context);
assert.ok(invalidations > 0);
await commands.get("guard").handler("strict", context);
answer = "Lock session";
const beforeLock = invalidations;
await emit("tool_call", call);
assert.ok(invalidations > beforeLock, "locking through approval revokes workers");
assert.equal((await emit("tool_call", call)).block, true);
await emit("session_shutdown");
let replies = 0;
pi.events.emit("specpi:guard-state", {
    reply() {
        replies += 1;
    },
});
assert.equal(replies, 0, "shutdown removes the guard capability service");
remove();
console.log("DELEGATION_GUARD_HARNESS=passed");
