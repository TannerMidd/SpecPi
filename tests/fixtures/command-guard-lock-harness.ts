import os from "node:os";
import path from "node:path";
import registerCommandGuard from "../../extensions/command-guard/index.ts";

// A refused read must not strand the session: the guard should keep answering later calls on their own merits.
const events = new Map<string, any[]>();
const pi: any = {
    on(name: string, handler: any) {
        events.set(name, [...(events.get(name) || []), handler]);
    },
    registerCommand() {},
};
registerCommandGuard(pi, { startupTimeoutMs: 20, approvalTimeoutMs: 20 });
const ctx: any = {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
        async select() {
            return undefined;
        },
        async confirm() {
            return false;
        },
        notify() {},
        setStatus() {},
    },
};
for (const handler of events.get("session_start") || []) {
    await handler({ reason: "startup" }, ctx);
}

async function call(event: any) {
    let result: any;
    for (const handler of events.get("tool_call") || []) {
        result = await handler(event, ctx);
    }

    return result;
}

const secret = path.join(os.homedir(), ".ssh", "id_rsa");
const readDenied = await call({ toolName: "read", input: { path: secret } });
// A safe command afterwards proves the session did not latch the critical lock.
const safeAfterRead = await call({ toolName: "bash", input: { command: "printf ok" } });

// A host-system mutation still latches the lock, and everything after it is refused.
const systemTarget = process.platform === "win32" ? "C:\\Windows\\System32\\config\\SAM" : "/etc/passwd";
const writeDenied = await call({ toolName: "write", input: { path: systemTarget, content: "x" } });
const safeAfterWrite = await call({ toolName: "bash", input: { command: "printf ok" } });

process.stdout.write(
    `COMMAND_GUARD_LOCK=${JSON.stringify({
        readDenied: readDenied?.block === true,
        readDidNotLock: !safeAfterRead?.block,
        writeDenied: writeDenied?.block === true,
        writeLatchedLock: safeAfterWrite?.block === true,
    })}\n`,
);
