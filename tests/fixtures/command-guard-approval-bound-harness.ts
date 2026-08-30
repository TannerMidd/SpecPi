import registerCommandGuard from "../../extensions/command-guard/index.ts";

const events = new Map<string, any[]>();
const commands = new Map<string, any>();
const notices: string[] = [];
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
      return prompts <= 129 ? "Allow exact call for session" : "Deny (Recommended)";
    },
    async confirm() { return true; },
    notify(message: string) { notices.push(message); },
    setStatus() {},
  },
};
for (const handler of events.get("session_start") || []) await handler({ reason: "startup" }, ctx);
async function call(id: number) {
  let result: any;
  for (const handler of events.get("tool_call") || []) result = await handler({ toolName: "neutral-mcp", input: { id } }, ctx);
  return result;
}
for (let id = 0; id < 129; id += 1) await call(id);
await commands.get("guard").handler("status", ctx);
const status = notices.find((message) => message.startsWith("Mode:"));
const evicted = await call(0);
process.stdout.write(`COMMAND_GUARD_APPROVAL_BOUND=${JSON.stringify({
  bounded: /session approvals: 128/.test(status || ""),
  oldestEvicted: evicted?.block === true,
  promptedAgain: prompts === 130,
})}\n`);
