import os from "node:os";
import path from "node:path";
import registerCommandGuard from "../../extensions/command-guard/index.ts";

const events = new Map<string, any[]>();
const commands = new Map<string, any>();
const notifications: any[] = [];
const approvalTitles: string[] = [];
const statuses = new Map<string, string | undefined>();
let releaseDelayed!: () => void;
let signalDelayedEntered!: () => void;
let mutateDuringPreflight = () => {};
const delayedGate = new Promise<void>((resolve) => { releaseDelayed = resolve; });
const delayedEntered = new Promise<void>((resolve) => { signalDelayedEntered = resolve; });
let releaseMutatedApproval!: () => void; let signalMutatedApproval!: () => void;
const mutatedApprovalGate = new Promise<void>((resolve) => { releaseMutatedApproval = resolve; });
const mutatedApprovalEntered = new Promise<void>((resolve) => { signalMutatedApproval = resolve; });
let releaseLockedApproval!: () => void; let signalLockedApproval!: () => void;
const lockedApprovalGate = new Promise<void>((resolve) => { releaseLockedApproval = resolve; });
const lockedApprovalEntered = new Promise<void>((resolve) => { signalLockedApproval = resolve; });
const fakePi: any = {
  on(name: string, handler: any) { events.set(name, [...(events.get(name) || []), handler]); },
  registerCommand(name: string, command: any) { commands.set(name, command); },
};
const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
registerCommandGuard(fakePi, {
  promptTimeoutMs: 100,
  async resolveSubagentLaunchContract(input: any) {
    if (input.agent === "delayed") { signalDelayedEntered(); await delayedGate; }
    if (input.agent === "mutating") mutateDuringPreflight();
    return {
      ok: true,
      contract: {
        version: 2,
        protocol: { packageVersion: "0.58.0" },
        tools: { extensionArgs: input.agent === "naked" ? [] : [path.join(agentDir, "extensions", "command-guard", "index.ts")] },
        receivedBindings: input.extensionBindings,
      },
    };
  },
});
const ctx: any = {
  cwd: process.cwd(), hasUI: true,
  ui: {
    async select(title: string, options: string[]) { if (title.startsWith("Path mutation approval")) return new Promise(() => {}); if (title.includes("approval-race-input.invalid")) { signalMutatedApproval(); await mutatedApprovalGate; return "Allow once"; } if (title.includes("approval-race-lock.invalid")) { signalLockedApproval(); await lockedApprovalGate; return "Allow once"; } if (title.includes("approval")) { approvalTitles.push(title); throw new Error("synthetic prompt failure"); } return options[0]; },
    async confirm() { return true; },
    notify(message: string, level: string) { notifications.push({ message, level }); },
    setStatus(key: string, value: string | undefined) { statuses.set(key, value); },
  },
};
for (const handler of events.get("session_start") || []) await handler({ reason: "startup" }, ctx);
const executorCalls: any[] = [];
const launch: any = { toolName: "subagent", input: { agent: "worker", task: "inert", extensionBindings: { "other.extension/1": { kept: true } } } };
let launchResult: any;
for (const handler of events.get("tool_call") || []) launchResult = await handler(launch, ctx);
const unprotectedLaunch: any = { toolName: "subagent", input: { agent: "naked", task: "inert" } };
let unprotectedLaunchResult: any;
for (const handler of events.get("tool_call") || []) unprotectedLaunchResult = await handler(unprotectedLaunch, ctx);
const spoofedLaunch: any = { toolName: "subagent", input: { agent: "worker", task: "inert", extensionBindings: { "zenpi.command-guard/1": { mode: "off" } } } };
let spoofedLaunchResult: any;
for (const handler of events.get("tool_call") || []) spoofedLaunchResult = await handler(spoofedLaunch, ctx);
const mutatingLaunch: any = { toolName: "subagent", input: { agent: "mutating", task: "inert" } };
mutateDuringPreflight = () => { mutatingLaunch.input.model = "tampered/model"; };
let mutatingLaunchResult: any;
for (const handler of events.get("tool_call") || []) mutatingLaunchResult = await handler(mutatingLaunch, ctx);
const workflow: any = { toolName: "subagent", input: { workflowScript: "return runs.run('x', { agent: 'worker', task: 'x' })" } };
let workflowResult: any;
for (const handler of events.get("tool_call") || []) workflowResult = await handler(workflow, ctx);
const timedPath: any = { toolName: "write", input: { path: "/tmp/inert-timeout-fixture/file.txt", content: "inert" } };
let timedPathResult: any;
for (const handler of events.get("tool_call") || []) timedPathResult = await handler(timedPath, ctx);
const unknownTerminal: any = { toolName: "neutral-mcp", input: { command: "inert" } };
let unknownTerminalResult: any;
for (const handler of events.get("tool_call") || []) unknownTerminalResult = await handler(unknownTerminal, ctx);
const mutatedApprovalCall: any = { toolName: "bash", input: { command: "git reset --hard approval-race-input.invalid" } };
const mutatedApprovalPromise = Promise.all((events.get("tool_call") || []).map((handler) => handler(mutatedApprovalCall, ctx)));
await mutatedApprovalEntered;
mutatedApprovalCall.input.command = "rm -rf /";
releaseMutatedApproval();
const mutatedApprovalBlocked = (await mutatedApprovalPromise).some((result) => result?.block === true);
const approvable: any = { toolName: "bash", input: { command: "git reset --hard" } };
let promptFailureResult: any;
for (const handler of events.get("tool_call") || []) promptFailureResult = await handler(approvable, ctx);
await commands.get("guard").handler("status", ctx);
const statusNotice = notifications.find((entry) => typeof entry.message === "string" && entry.message.startsWith("Mode:"));
const statusInspectable = Boolean(statusNotice && /Mode: guard/.test(statusNotice.message) && /blocks:/.test(statusNotice.message) && /rules:/.test(statusNotice.message) && !statusNotice.message.includes("git reset --hard"));
await commands.get("guard").handler("strict", ctx);
const lockedApprovalCall: any = { toolName: "bash", input: { command: "git reset --hard approval-race-lock.invalid" } };
const lockedApprovalPromise = Promise.all((events.get("tool_call") || []).map((handler) => handler(lockedApprovalCall, ctx)));
await lockedApprovalEntered;
const delayedLaunch: any = { toolName: "subagent", input: { agent: "delayed", task: "inert" } };
const delayedPromise = Promise.all((events.get("tool_call") || []).map((handler) => handler(delayedLaunch, ctx)));
await delayedEntered;
const dangerous: any = { toolName: "bash", input: { command: "rm -rf /" } };
const safe: any = { toolName: "bash", input: { command: "printf safe" } };
let dangerousResult: any;
let safeResult: any;
for (const handler of events.get("tool_call") || []) dangerousResult = await handler(dangerous, ctx);
releaseLockedApproval(); releaseDelayed();
const lockedApprovalBlocked = (await lockedApprovalPromise).some((result) => result?.block === true);
const delayedResults = await delayedPromise;
const racedPreflightBlocked = delayedResults.some((result) => result?.block === true);
let lockedLaunchResult: any;
for (const handler of events.get("tool_call") || []) lockedLaunchResult = await handler({ toolName: "subagent", input: { agent: "worker", task: "inert" } }, ctx);
for (const handler of events.get("tool_call") || []) safeResult = await handler(safe, ctx);
await commands.get("guard").handler("unlock", ctx);
const unlockRestoredStrict = statuses.get("zenpi-command-guard") === "🛡 Strict";
for (const handler of events.get("session_shutdown") || []) await handler({}, ctx);
for (const handler of events.get("session_start") || []) await handler({ reason: "resume" }, ctx);
const sessionResetGuard = statuses.get("zenpi-command-guard") === "🛡 Guard";
const relaunched: any = { toolName: "subagent", input: { agent: "worker", task: "inert" } };
for (const handler of events.get("tool_call") || []) await handler(relaunched, ctx);
const nonceReset = launch.input.extensionBindings["zenpi.command-guard/1"].nonce !== relaunched.input.extensionBindings["zenpi.command-guard/1"].nonce;
await commands.get("guard").handler("off", ctx);
let offResult: any;
for (const handler of events.get("tool_call") || []) offResult = await handler({ toolName: "bash", input: { command: "rm -rf /" } }, ctx);
const confirmedOffAllows = !offResult?.block && statuses.get("zenpi-command-guard") === "Guard Off";
for (const handler of events.get("session_start") || []) await handler({ reason: "resume", previousSessionFile: "inert" }, ctx);
const startOnlyReset = statuses.get("zenpi-command-guard") === "🛡 Guard";
process.stdout.write(`COMMAND_GUARD_HARNESS=${JSON.stringify({ dangerousBlocked: dangerousResult?.block === true, mutatedApprovalBlocked, lockedApprovalBlocked, racedPreflightBlocked, lockedLaunchBlocked: lockedLaunchResult?.block === true, safeBlockedAfterLock: safeResult?.block === true, directLaunchAllowed: !launchResult?.block, workflowBlocked: workflowResult?.block === true, bindingInjected: Boolean(launch.input?.extensionBindings?.["zenpi.command-guard/1"]), bindingMode: launch.input?.extensionBindings?.["zenpi.command-guard/1"]?.mode, unrelatedBindingKept: launch.input?.extensionBindings?.["other.extension/1"]?.kept === true, spoofedLaunchBlocked: spoofedLaunchResult?.block === true, mutatedPreflightBlocked: mutatingLaunchResult?.block === true, unprotectedLaunchBlocked: unprotectedLaunchResult?.block === true, unknownTerminalBlocked: unknownTerminalResult?.block === true, promptTimeoutBlocked: timedPathResult?.block === true, promptFailureBlocked: promptFailureResult?.block === true, promptHasContext: approvalTitles.some((title) => title.includes("Severity:") && title.includes("category:") && title.includes("cwd:") && title.includes("reason:") && title.includes("safer:")), executorCalls: executorCalls.length, commandRegistered: commands.has("guard"), statusInspectable, unlockRestoredStrict, sessionResetGuard, nonceReset, confirmedOffAllows, startOnlyReset, status: statuses.get("zenpi-command-guard"), notificationCount: notifications.length })}\n`);
