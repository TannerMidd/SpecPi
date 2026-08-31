import registerCommandGuard from "../../extensions/command-guard/index.ts";

const events = new Map<string, any[]>();
const commands = new Map<string, any>();
const notices: string[] = [];
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
            if (title === "ZenPi command guard") {
                return "Strict";
            }

            prompts += 1;
            if (prompts === 1 || prompts === 5) {
                return "Allow exact call for session";
            }

            return prompts === 8 ? "Allow once" : "Deny (Recommended)";
        },
        async confirm() {
            return true;
        },
        notify(message: string) {
            notices.push(message);
        },
        setStatus() {},
    },
};
for (const handler of events.get("session_start") || []) {
    await handler({ reason: "startup" }, ctx);
}

async function callEvent(event: any) {
    let result: any;
    for (const handler of events.get("tool_call") || []) {
        result = await handler(event, ctx);
    }

    return result;
}

const call = (command: string) => callEvent({ toolName: "bash", input: { command } });
const command = "npm install inert-package";
const first = await call(command);
const repeat = await call(command);
const originalCwd = ctx.cwd;
ctx.cwd = `${originalCwd}/other-cwd`;
const changedCwd = await call(command);
ctx.cwd = originalCwd;
const changed = await call("npm install other-inert-package");
await commands.get("guard").handler("status", ctx);
const statusBeforeClear = notices.find((message) => message.startsWith("Mode:"));
await commands.get("guard").handler("clear-approvals", ctx);
const afterClear = await call(command);
const writePath = `${ctx.cwd}/inert-session-approval.txt`;
const writeFirst = await callEvent({ toolName: "write", input: { path: writePath, content: "a" } });
const writeRepeat = await callEvent({ toolName: "write", input: { path: writePath, content: "a" } });
const writeChanged = await callEvent({ toolName: "write", input: { path: writePath, content: "b" } });
await commands.get("guard").handler("guard", ctx);
await commands.get("guard").handler("strict", ctx);
const afterModeChange = await callEvent({ toolName: "write", input: { path: writePath, content: "a" } });
const largeWrite = await callEvent({
    toolName: "write",
    input: { path: writePath, content: "x".repeat(1024 * 1024 + 1) },
});
const promptsBeforeCritical = prompts;
const critical = await call("rm -rf /");
process.stdout.write(
    `COMMAND_GUARD_SESSION_APPROVAL=${JSON.stringify({
        firstAllowed: !first?.block,
        repeatAllowed: !repeat?.block,
        repeatSkippedPrompt: prompts === 8,
        changedCwdBlocked: changedCwd?.block === true,
        changedBlocked: changed?.block === true,
        statusCountedApproval: /session approvals: 1/.test(statusBeforeClear || ""),
        afterClearBlocked: afterClear?.block === true,
        writeFirstAllowed: !writeFirst?.block,
        writeRepeatAllowed: !writeRepeat?.block,
        writeChangedBlocked: writeChanged?.block === true,
        modeChangeCleared: afterModeChange?.block === true,
        largeWriteApprovable: !largeWrite?.block,
        criticalBlocked: critical?.block === true,
        criticalWasNotPrompted: prompts === promptsBeforeCritical,
    })}\n`,
);
