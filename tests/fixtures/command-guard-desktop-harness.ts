import registerCommandGuard from "../../extensions/command-guard/index.ts";

const events = new Map<string, any[]>();
let selects = 0;
let notifications = 0;
let confirms = 0;
let status = "";
let guardCommand: any;
const pi: any = {
    on(name: string, handler: any) {
        events.set(name, [...(events.get(name) || []), handler]);
    },
    registerCommand(name: string, command: any) {
        if (name === "guard") {
            guardCommand = command;
        }
    },
};
registerCommandGuard(pi);
const ctx: any = {
    cwd: process.cwd(),
    mode: "rpc",
    hasUI: true,
    ui: {
        async select() {
            selects += 1;

            return "Off for this session";
        },
        async confirm() {
            confirms += 1;

            return true;
        },
        notify() {
            notifications += 1;
        },
        setStatus(_key: string, value: string) {
            status = value;
        },
    },
};
let genericRpcSelects = 0;
let genericRpcStatus = "";
const genericRpcContext: any = {
    ...ctx,
    ui: {
        ...ctx.ui,
        async select() {
            genericRpcSelects += 1;

            return "Off for this session";
        },
        notify() {},
        setStatus(_key: string, value: string) {
            genericRpcStatus = value;
        },
    },
};
delete process.env.SPECPI_DESKTOP;
for (const handler of events.get("session_start") || []) {
    await handler({ reason: "startup" }, genericRpcContext);
}

process.env.SPECPI_DESKTOP = "1";
for (const handler of events.get("session_start") || []) {
    await handler({ reason: "startup" }, ctx);
}

const startupStatus = status;
await guardCommand.handler("strict", ctx);
const strictStatus = status;
await guardCommand.handler("guard", ctx);
await guardCommand.handler("off", ctx);
const finalStatus = status;

let safeDecision: any;
for (const handler of events.get("tool_call") || []) {
    safeDecision = await handler({ toolName: "bash", input: { command: "printf ok" } }, ctx);
}

process.stdout.write(
    `COMMAND_GUARD_DESKTOP=${JSON.stringify({
        selects,
        notifications,
        confirms,
        genericRpcSelects,
        genericRpcStatus,
        startupStatus,
        strictStatus,
        finalStatus,
        safeAllowed: !safeDecision?.block,
    })}\n`,
);
