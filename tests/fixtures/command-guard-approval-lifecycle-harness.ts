import registerCommandGuard from "../../extensions/command-guard/index.ts";
import { bindingForChild } from "../../extensions/command-guard/core.mjs";

type Harness = ReturnType<typeof createHarness>;
function createHarness(decisions: string[], child = false) {
  const events = new Map<string, any[]>();
  const commands = new Map<string, any>();
  let prompts = 0;
  const pi: any = {
    on(name: string, handler: any) { events.set(name, [...(events.get(name) || []), handler]); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
  };
  registerCommandGuard(pi);
  const ctx: any = {
    cwd: process.cwd(), hasUI: true,
    ui: {
      async select(title: string) {
        if (title === "ZenPi command guard") return "Strict";
        prompts += 1;
        return decisions.shift() || "Deny (Recommended)";
      },
      async confirm() { return true; },
      notify() {}, setStatus() {},
    },
  };
  async function emit(name: string, event: any = {}) {
    let result: any;
    for (const handler of events.get(name) || []) result = await handler(event, ctx);
    return result;
  }
  async function startup() {
    const previousChild = process.env.PI_SUBAGENT_CHILD;
    const previousBindings = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
    if (child) {
      process.env.PI_SUBAGENT_CHILD = "1";
      process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({ "zenpi.command-guard/1": bindingForChild("strict", "approval_child") });
    } else {
      delete process.env.PI_SUBAGENT_CHILD;
      delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
    }
    try { return await emit("session_start", { reason: "startup" }); }
    finally {
      if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = previousChild;
      if (previousBindings === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS; else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = previousBindings;
    }
  }
  return {
    ctx, commands, prompts: () => prompts,
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

const parent: Harness = createHarness(["Allow exact call for session"]);
await parent.startup();
await parent.call(command);
const child: Harness = createHarness(["Deny (Recommended)"], true);
await child.startup();
const childRepeat = await child.call(command);

const concurrent: Harness = createHarness(["Allow exact call for session", "Deny (Recommended)"]);
await concurrent.startup();
const [concurrentAllowed, concurrentDenied] = await Promise.all([concurrent.call(command), concurrent.call(command)]);

process.stdout.write(`COMMAND_GUARD_APPROVAL_LIFECYCLE=${JSON.stringify({
  allowOnceDoesNotRepeat: !onceFirst?.block && onceRepeat?.block === true && once.prompts() === 2,
  restartClears: afterRestart?.block === true && restarted.prompts() === 2,
  offClears: afterOff?.block === true && off.prompts() === 2,
  lockAndUnlockClear: afterUnlock?.block === true && lock.prompts() === 2,
  childIsolated: childRepeat?.block === true && child.prompts() === 1,
  concurrentIsolated: !concurrentAllowed?.block && concurrentDenied?.block === true && concurrent.prompts() === 2,
})}\n`);
