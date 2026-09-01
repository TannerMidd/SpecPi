import registerCommandGuard from "../../extensions/command-guard/index.ts";

const events = new Map<string, any[]>();
const commands = new Map<string, any>();
const notifications: any[] = [];
const approvalTitles: string[] = [];
const statuses = new Map<string, string | undefined>();
let releaseMutatedApproval!: () => void;
let signalMutatedApproval!: () => void;
const mutatedApprovalGate = new Promise<void>((resolve) => {
    releaseMutatedApproval = resolve;
});
const mutatedApprovalEntered = new Promise<void>((resolve) => {
    signalMutatedApproval = resolve;
});
let releaseLockedApproval!: () => void;
let signalLockedApproval!: () => void;
const lockedApprovalGate = new Promise<void>((resolve) => {
    releaseLockedApproval = resolve;
});
const lockedApprovalEntered = new Promise<void>((resolve) => {
    signalLockedApproval = resolve;
});
const fakePi: any = {
    on(name: string, handler: any) {
        events.set(name, [...(events.get(name) || []), handler]);
    },
    registerCommand(name: string, command: any) {
        commands.set(name, command);
    },
};
registerCommandGuard(fakePi, { promptTimeoutMs: 100 });
const ctx: any = {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
        async select(title: string, options: string[]) {
            if (title.startsWith("Path mutation approval")) {
                return new Promise(() => {});
            }

            if (title.includes("approval-race-input.invalid")) {
                signalMutatedApproval();
                await mutatedApprovalGate;

                return "Allow once";
            }

            if (title.includes("approval-race-lock.invalid")) {
                signalLockedApproval();
                await lockedApprovalGate;

                return "Allow once";
            }

            if (title.includes("approval")) {
                approvalTitles.push(title);
                throw new Error("synthetic prompt failure");
            }

            return options[0];
        },
        async confirm() {
            return true;
        },
        notify(message: string, level: string) {
            notifications.push({ message, level });
        },
        setStatus(key: string, value: string | undefined) {
            statuses.set(key, value);
        },
    },
};
for (const handler of events.get("session_start") || []) {
    await handler({ reason: "startup" }, ctx);
}

const nonLatchingCleanup: any =
    process.platform === "win32"
        ? { toolName: "bash", input: { command: "rmdir /s /q F:\\Temp\\zenpi-test-123" } }
        : { toolName: "powershell", input: { command: "rm -rf /" } };
let nonLatchingCleanupResult: any;
for (const handler of events.get("tool_call") || []) {
    nonLatchingCleanupResult = await handler(nonLatchingCleanup, ctx);
}

const safeAfterNonLatchingCleanup: any = { toolName: "bash", input: { command: "printf cleanup-safe" } };
let safeAfterNonLatchingCleanupResult: any;
for (const handler of events.get("tool_call") || []) {
    safeAfterNonLatchingCleanupResult = await handler(safeAfterNonLatchingCleanup, ctx);
}

let guardUnknownResult: any;
for (const handler of events.get("tool_call") || []) {
    guardUnknownResult = await handler({ toolName: "neutral-mcp", input: { command: "inert" } }, ctx);
}

await commands.get("guard").handler("strict", ctx);
const timedPath: any = { toolName: "write", input: { path: "/tmp/inert-timeout-fixture/file.txt", content: "inert" } };
let timedPathResult: any;
for (const handler of events.get("tool_call") || []) {
    timedPathResult = await handler(timedPath, ctx);
}

const unknownTerminal: any = { toolName: "neutral-mcp", input: { command: "inert" } };
let unknownTerminalResult: any;
for (const handler of events.get("tool_call") || []) {
    unknownTerminalResult = await handler(unknownTerminal, ctx);
}

const mutatedApprovalCall: any = {
    toolName: "bash",
    input: { command: "git reset --hard approval-race-input.invalid" },
};
const mutatedApprovalPromise = Promise.all(
    (events.get("tool_call") || []).map((handler) => handler(mutatedApprovalCall, ctx)),
);
await mutatedApprovalEntered;
mutatedApprovalCall.input.command = "rm -rf /";
releaseMutatedApproval();
const mutatedApprovalBlocked = (await mutatedApprovalPromise).some((result) => result?.block === true);
const approvable: any = { toolName: "bash", input: { command: "git reset --hard" } };
let promptFailureResult: any;
for (const handler of events.get("tool_call") || []) {
    promptFailureResult = await handler(approvable, ctx);
}

await commands.get("guard").handler("status", ctx);
const statusNotice = notifications.find(
    (entry) => typeof entry.message === "string" && entry.message.startsWith("Mode:"),
);
const statusInspectable = Boolean(
    statusNotice &&
    /Mode: strict/.test(statusNotice.message) &&
    /blocks:/.test(statusNotice.message) &&
    /session approvals:/.test(statusNotice.message) &&
    /rules:/.test(statusNotice.message) &&
    !statusNotice.message.includes("git reset --hard"),
);
const lockedApprovalCall: any = { toolName: "bash", input: { command: "git reset --hard approval-race-lock.invalid" } };
const lockedApprovalPromise = Promise.all(
    (events.get("tool_call") || []).map((handler) => handler(lockedApprovalCall, ctx)),
);
await lockedApprovalEntered;
const dangerous: any = { toolName: "bash", input: { command: "rm -rf /" } };
const safe: any = { toolName: "bash", input: { command: "printf safe" } };
let dangerousResult: any;
let safeResult: any;
for (const handler of events.get("tool_call") || []) {
    dangerousResult = await handler(dangerous, ctx);
}

releaseLockedApproval();
const lockedApprovalBlocked = (await lockedApprovalPromise).some((result) => result?.block === true);

for (const handler of events.get("tool_call") || []) {
    safeResult = await handler(safe, ctx);
}

await commands.get("guard").handler("unlock", ctx);
const unlockRestoredStrict = statuses.get("zenpi-command-guard") === "🛡 Strict";
for (const handler of events.get("session_shutdown") || []) {
    await handler({}, ctx);
}

for (const handler of events.get("session_start") || []) {
    await handler({ reason: "resume" }, ctx);
}

const sessionResetGuard = statuses.get("zenpi-command-guard") === "🛡 Guard";
await commands.get("guard").handler("off", ctx);
let offResult: any;
for (const handler of events.get("tool_call") || []) {
    offResult = await handler({ toolName: "bash", input: { command: "rm -rf /" } }, ctx);
}

const confirmedOffAllows = !offResult?.block && statuses.get("zenpi-command-guard") === "Guard Off";
for (const handler of events.get("session_start") || []) {
    await handler({ reason: "resume", previousSessionFile: "inert" }, ctx);
}

const startOnlyReset = statuses.get("zenpi-command-guard") === "🛡 Guard";
process.stdout.write(
    `COMMAND_GUARD_HARNESS=${JSON.stringify({ dangerousBlocked: dangerousResult?.block === true, mutatedApprovalBlocked, lockedApprovalBlocked, safeBlockedAfterLock: safeResult?.block === true, nonLatchingCleanupBlocked: nonLatchingCleanupResult?.block === true, nonLatchingCleanupDidNotLock: !safeAfterNonLatchingCleanupResult?.block, guardUnknownAllowed: !guardUnknownResult?.block, unknownTerminalBlocked: unknownTerminalResult?.block === true, promptTimeoutBlocked: timedPathResult?.block === true, promptFailureBlocked: promptFailureResult?.block === true, promptHasContext: approvalTitles.some((title) => title.includes("Severity:") && title.includes("category:") && title.includes("cwd:") && title.includes("reason:") && title.includes("safer:")), commandRegistered: commands.has("guard"), statusInspectable, unlockRestoredStrict, sessionResetGuard, confirmedOffAllows, startOnlyReset, status: statuses.get("zenpi-command-guard"), notificationCount: notifications.length })}\n`,
);
