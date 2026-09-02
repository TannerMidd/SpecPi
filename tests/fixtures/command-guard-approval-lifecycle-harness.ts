import registerCommandGuard from "../../extensions/command-guard/index.ts";
type Harness = ReturnType<typeof createHarness>;
function createHarness(decisions: string[]) {
    const events = new Map<string, any[]>();
    const commands = new Map<string, any>();
    let prompts = 0;
    const pi: any = {
        on(name: string, handler: any) {
            events.set(name, [...(events.get(name) || []), handler]);
        },
        registerCommand(name: string, command: any) {
            commands.set(name, command);
        },
    };
    registerCommandGuard(pi);
    const ctx: any = {
        cwd: process.cwd(),
        hasUI: true,
        ui: {
            async select(title: string) {
                if (title === "SpecPi command guard") {
                    return "Strict";
                }

                prompts += 1;

                return decisions.shift() || "Deny (Recommended)";
            },
            async confirm() {
                return true;
            },
            notify() {},
            setStatus() {},
        },
    };
    async function emit(name: string, event: any = {}) {
        let result: any;
        for (const handler of events.get(name) || []) {
            result = await handler(event, ctx);
        }

        return result;
    }

    async function startup() {
        return emit("session_start", { reason: "startup" });
    }

    return {
        ctx,
        commands,
        prompts: () => prompts,
        startup,
        shutdown: () => emit("session_shutdown", {}),
        call: (command: string) => emit("tool_call", { toolName: "bash", input: { command } }),
    };
}

const command = "npm install inert-lifecycle-package";

const once: Harness = createHarness(["Allow once", "Deny (Recommended)"]);
await once.startup();
const onceFirst = await once.call(command);
const onceRepeat = await once.call(command);

const restarted: Harness = createHarness(["Allow exact call for session", "Deny (Recommended)"]);
await restarted.startup();
await restarted.call(command);
await restarted.shutdown();
await restarted.startup();
const afterRestart = await restarted.call(command);

const off: Harness = createHarness(["Allow exact call for session", "Deny (Recommended)"]);
await off.startup();
await off.call(command);
await off.commands.get("guard").handler("off", off.ctx);
await off.commands.get("guard").handler("strict", off.ctx);
const afterOff = await off.call(command);

const lock: Harness = createHarness(["Allow exact call for session", "Deny (Recommended)"]);
await lock.startup();
await lock.call(command);
await lock.call("rm -rf /");
await lock.commands.get("guard").handler("unlock", lock.ctx);
const afterUnlock = await lock.call(command);

const concurrent: Harness = createHarness(["Allow exact call for session", "Deny (Recommended)"]);
await concurrent.startup();
const [concurrentAllowed, concurrentDenied] = await Promise.all([concurrent.call(command), concurrent.call(command)]);

process.stdout.write(
    `COMMAND_GUARD_APPROVAL_LIFECYCLE=${JSON.stringify({
        allowOnceDoesNotRepeat: !onceFirst?.block && onceRepeat?.block === true && once.prompts() === 2,
        restartClears: afterRestart?.block === true && restarted.prompts() === 2,
        offClears: afterOff?.block === true && off.prompts() === 2,
        lockAndUnlockClear: afterUnlock?.block === true && lock.prompts() === 2,
        concurrentIsolated: !concurrentAllowed?.block && concurrentDenied?.block === true && concurrent.prompts() === 2,
    })}\n`,
);
