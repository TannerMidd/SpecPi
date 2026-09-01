import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-workflow-harness-"));
const agentDir = path.join(root, "agent");
const repository = path.join(root, "repo");
fs.mkdirSync(repository, { recursive: true });
const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error(result.stderr);
    }
};

git("init");
git("config", "user.email", "harness@example.invalid");
git("config", "user.name", "Workflow Harness");
fs.mkdirSync(path.join(repository, "src"));
const nestedCwd = path.join(repository, "packages", "app");
fs.mkdirSync(path.join(nestedCwd, "src"), { recursive: true });
fs.writeFileSync(path.join(repository, "src", "inside.txt"), "inside\n");
fs.writeFileSync(path.join(nestedCwd, "src", "inside.txt"), "nested inside\n");
fs.writeFileSync(path.join(repository, "outside.txt"), "outside\n");
git("add", ".");
git("commit", "-m", "base");
process.env.PI_CODING_AGENT_DIR = agentDir;
const { default: registerWorkflowControls } = await import("../../extensions/workflow-controls/index.ts");
const { default: registerCommandGuard } = await import("../../extensions/command-guard/index.ts");

const events = new Map<string, any[]>();
const commands = new Map<string, any>();
const tools = new Map<string, any>();
const entries: any[] = [];
const messages: any[] = [];
const notifications: any[] = [];
const emitted: any[] = [];
const selectAnswers: string[] = [];
let editorValue = "src/";
const pi: any = {
    on(name: string, handler: any) {
        events.set(name, [...(events.get(name) || []), handler]);
    },
    registerCommand(name: string, command: any) {
        commands.set(name, command);
    },
    registerTool(tool: any) {
        tools.set(tool.name, tool);
    },
    registerEntryRenderer() {},
    appendEntry(customType: string, data: any) {
        entries.push({ type: "custom", customType, data });
    },
    sendMessage(message: any, options: any) {
        messages.push({ message, options });
    },
    events: {
        emit(name: string, data: any) {
            emitted.push({ name, data });
        },
    },
    async exec(command: string, args: string[], options: any = {}) {
        const result = spawnSync(command, args, {
            cwd: options.cwd,
            env: options.env,
            encoding: "utf8",
            timeout: options.timeout,
            maxBuffer: 40 * 1024 * 1024,
        });

        return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
};
registerCommandGuard(pi, { startupTimeoutMs: 100, approvalTimeoutMs: 100 });
registerWorkflowControls(pi);

const branch: any[] = [];
const ctx: any = {
    cwd: nestedCwd,
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    sessionManager: {
        getBranch: () => branch,
        getSessionId: () => "workflow-session",
    },
    ui: {
        theme: {
            fg(_color: string, text: string) {
                return text;
            },
            bg(_color: string, text: string) {
                return text;
            },
        },
        notify(message: string, level: string) {
            notifications.push({ message, level });
        },
        setStatus() {},
        setWidget() {},
        async editor() {
            return editorValue;
        },
        async select(_title: string, options: string[]) {
            return selectAnswers.shift() ?? options[0];
        },
        async confirm() {
            return true;
        },
    },
};

for (const handler of events.get("session_start") || []) {
    await handler({}, ctx);
}

await commands.get("scope").handler("set", ctx);

// Tool paths are relative to the session cwd, while declared scope remains relative to the Git root. Exercise both
// directions so a nested session cannot silently allow root scope or reject the matching nested scope.
const nestedCall = { toolName: "write", toolCallId: "nested-cwd", input: { path: "src/new.ts", content: "x" } };
let nestedCwdOutOfScopeDenied = false;
for (const handler of events.get("tool_call") || []) {
    const outcome = await handler(nestedCall, ctx);
    nestedCwdOutOfScopeDenied ||= outcome?.block === true;
}

editorValue = "packages/app/src/";
await commands.get("scope").handler("set", ctx);
let nestedCwdInScopeAllowed = true;
for (const handler of events.get("tool_call") || []) {
    const outcome = await handler(nestedCall, ctx);
    nestedCwdInScopeAllowed &&= outcome?.block !== true;
}

ctx.cwd = repository;
editorValue = "src/";
await commands.get("scope").handler("set", ctx);

const outsideCall = { toolName: "write", toolCallId: "outside-deny", input: { path: "outside.txt", content: "x" } };
let denied = false;
for (const handler of events.get("tool_call") || []) {
    const result = await handler(outsideCall, ctx);
    denied ||= result?.block === true;
}

selectAnswers.push("Allow once without expanding scope");
const allowedCall = { toolName: "write", toolCallId: "outside-allow", input: { path: "outside.txt", content: "x" } };
let allowed = true;
for (const handler of events.get("tool_call") || []) {
    const result = await handler(allowedCall, ctx);
    allowed &&= result?.block !== true;
}

const scopeState = entries.filter((entry) => entry.customType === "zenpi-scope-state").at(-1)?.data;
const safeCall = { toolName: "bash", toolCallId: "safe-after-scope-denial", input: { command: "printf safe" } };
let guardStillUsable = true;
for (const handler of events.get("tool_call") || []) {
    const result = await handler(safeCall, ctx);
    guardStillUsable &&= result?.block !== true;
}

ctx.hasUI = false;
const headlessCall = {
    toolName: "edit",
    toolCallId: "headless",
    input: { path: "another.txt", edits: [{ oldText: "before", newText: "after" }] },
};
let headlessAllowed = true;
for (const handler of events.get("tool_call") || []) {
    const result = await handler(headlessCall, ctx);
    headlessAllowed &&= result?.block !== true;
}

ctx.hasUI = true;

// `accept` acknowledges the finding without widening the contract; `add` is the verb that widens it.
const scopeBeforeAccept = entries.filter((entry) => entry.customType === "zenpi-scope-state").at(-1)?.data;
await commands.get("scope").handler("accept outside.txt", ctx);
const scopeAfterAccept = entries.filter((entry) => entry.customType === "zenpi-scope-state").at(-1)?.data;
const acceptClearedPending =
    scopeBeforeAccept?.pending?.includes("outside.txt") === true &&
    scopeAfterAccept?.pending?.includes("outside.txt") === false;
const acceptKeptScope = scopeAfterAccept?.entries?.length === scopeBeforeAccept?.entries?.length;

await commands.get("scope").handler("add outside.txt", ctx);
const scopeAfterAdd = entries.filter((entry) => entry.customType === "zenpi-scope-state").at(-1)?.data;
const addWidenedScope = scopeAfterAdd?.entries?.length === (scopeAfterAccept?.entries?.length ?? 0) + 1;

// Display escaping must not replace the canonical path used for matching. A literal percent sign is encoded in UI
// labels, but `/scope add` still has to widen scope to the real file and retire its pending finding in one operation.
ctx.hasUI = false;
const percentCall = {
    toolName: "edit",
    toolCallId: "percent-path",
    input: { path: "percent%.txt", edits: [{ oldText: "before", newText: "after" }] },
};
for (const handler of events.get("tool_call") || []) {
    await handler(percentCall, ctx);
}

ctx.hasUI = true;
const scopeBeforePercentAdd = entries.filter((entry) => entry.customType === "zenpi-scope-state").at(-1)?.data;
await commands.get("scope").handler("add percent%25.txt", ctx);
const scopeAfterPercentAdd = entries.filter((entry) => entry.customType === "zenpi-scope-state").at(-1)?.data;
const percentPathStayedCanonical =
    scopeBeforePercentAdd?.pending?.includes("percent%.txt") === true &&
    scopeAfterPercentAdd?.pending?.includes("percent%.txt") === false &&
    scopeAfterPercentAdd?.entries?.some((item: any) => item.path === "percent%.txt") === true;

// A `read` call must not cost a snapshot pair, and must not be mistaken for unobserved drift.
const indeterminateBeforeRead = scopeAfterAdd?.indeterminate === true;
let execCallsDuringRead = 0;
const countingExec = pi.exec;
pi.exec = async (command: string, args: string[], options: any = {}) => {
    execCallsDuringRead += 1;

    return countingExec(command, args, options);
};

const readCall = { toolName: "read", toolCallId: "read-only", input: { path: "src/inside.txt" } };
for (const handler of events.get("tool_execution_start") || []) {
    await handler(readCall, ctx);
}

for (const handler of events.get("tool_result") || []) {
    await handler({ ...readCall, isError: false, content: [] }, ctx);
}

pi.exec = countingExec;
const readSkippedSnapshots =
    execCallsDuringRead === 0 &&
    entries.filter((entry) => entry.customType === "zenpi-scope-state").at(-1)?.data?.indeterminate ===
        indeterminateBeforeRead;

await commands.get("challenge").handler("", ctx);
const challengeTriggered = messages.length === 1 && messages[0].options.triggerTurn === true;
const activation = entries
    .filter((entry) => entry.customType === "zenpi-completion-challenge" && entry.data.kind === "active")
    .at(-1)?.data;
const challengeSubmission = {
    generation: activation.generation,
    verdict: "incomplete",
    requirements: [{ requirement: "Harness behavior", status: "partial", evidence: "Scope paths observed" }],
    contradictions: [],
    falsePositiveChecks: [],
    scopeFindings: ["Outside paths remain pending"],
    validationGaps: ["No full runtime test in challenge"],
    residualRisks: ["Model-authored"],
    nextAction: "Run the repository tests",
};
const result = await tools
    .get("submit_completion_challenge")
    .execute("challenge-tool", challengeSubmission, undefined, undefined, ctx);
let staleChallengeRejected = false;
try {
    await tools
        .get("submit_completion_challenge")
        .execute("stale-challenge-tool", challengeSubmission, undefined, undefined, ctx);
} catch (error) {
    staleChallengeRejected = /No matching completion challenge/u.test(String(error));
}

// A challenge the model receives but never answers must expire with the turn instead of steering every later turn.
await commands.get("challenge").handler("", ctx);
const abandoned = entries
    .filter((entry) => entry.customType === "zenpi-completion-challenge" && entry.data.kind === "active")
    .at(-1)?.data;
let promptWhileArmed = "";
for (const handler of events.get("before_agent_start") || []) {
    const outcome = await handler({ systemPrompt: "base" }, ctx);
    promptWhileArmed += outcome?.systemPrompt ?? "";
}

for (const handler of events.get("agent_settled") || []) {
    await handler({}, ctx);
}

let promptAfterSettle = "";
for (const handler of events.get("before_agent_start") || []) {
    const outcome = await handler({ systemPrompt: "base" }, ctx);
    promptAfterSettle += outcome?.systemPrompt ?? "";
}

const abandonedChallengeExpired =
    promptWhileArmed.includes(abandoned.generation) && !promptAfterSettle.includes(abandoned.generation);

// Resuming the session must restore the declared contract from the branch rather than starting unmonitored.
branch.push(...entries);
for (const handler of events.get("session_start") || []) {
    await handler({}, ctx);
}

const resumedScope = entries.filter((entry) => entry.customType === "zenpi-scope-state").at(-1)?.data;
const resumedActive = resumedScope?.active === true && resumedScope.entries.length > 0;
let resumedChallengeArmed = false;
for (const handler of events.get("before_agent_start") || []) {
    const outcome = await handler({ systemPrompt: "base" }, ctx);
    resumedChallengeArmed ||= (outcome?.systemPrompt ?? "").includes("COMPLETION CHALLENGE");
}

// A challenge that expired unanswered must not retire the last completed card the way /challenge clear does.
const displaysBeforeStatus = entries.filter(
    (entry) => entry.customType === "zenpi-completion-challenge" && entry.data.kind === "display",
).length;
await commands.get("challenge").handler("status", ctx);
const completedResultSurvivedRestart =
    entries.filter((entry) => entry.customType === "zenpi-completion-challenge" && entry.data.kind === "display")
        .length ===
    displaysBeforeStatus + 1;

// Scope restored from the branch must be a copy: widening it later cannot rewrite the record it was restored from.
const restoredRecordJson = JSON.stringify(resumedScope);
await commands.get("scope").handler("add docs/", ctx);
const restoredRecordUnchanged = JSON.stringify(resumedScope) === restoredRecordJson;
const addAfterResumeWidened =
    (entries.filter((entry) => entry.customType === "zenpi-scope-state").at(-1)?.data?.entries?.length ?? 0) ===
    resumedScope.entries.length + 1;

process.stdout.write(
    `WORKFLOW_CONTROLS_HARNESS=${JSON.stringify({
        commands: [...commands.keys()].sort(),
        toolRegistered: tools.has("submit_completion_challenge"),
        nestedCwdOutOfScopeDenied,
        nestedCwdInScopeAllowed,
        denied,
        allowed,
        pendingRecorded: scopeState?.pending?.includes("outside.txt") === true,
        headlessAllowed,
        headlessPending: entries
            .filter((entry) => entry.customType === "zenpi-scope-state")
            .at(-1)
            ?.data?.pending?.includes("another.txt"),
        challengeTriggered,
        challengeTerminated: result.terminate === true,
        challengeVerdict: result.details.verdict,
        staleChallengeRejected,
        acceptClearedPending,
        acceptKeptScope,
        addWidenedScope,
        percentPathStayedCanonical,
        readSkippedSnapshots,
        abandonedChallengeExpired,
        resumedActive,
        resumedChallengeArmed,
        completedResultSurvivedRestart,
        restoredRecordUnchanged,
        addAfterResumeWidened,
        guardStillUsable,
        emittedScopeStatus: emitted.some((item) => item.name === "zenpi:workflow-status"),
    })}\n`,
);

fs.rmSync(root, { recursive: true, force: true });
