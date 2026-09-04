import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-workflow-harness-"));
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
const renderers = new Map<string, any>();
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
    registerEntryRenderer(customType: string, renderer: any) {
        renderers.set(customType, renderer);
    },
    appendEntry(customType: string, data: any) {
        const entry = { type: "custom", customType, data };
        entries.push(entry);
        branch.push(entry);
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

let branch: any[] = [];
let currentCwd = nestedCwd;
let branchReads = 0;
const sessionManager = {
    getBranch: () => {
        branchReads += 1;

        return branch;
    },
    getSessionId: () => "workflow-session",
};
const ctx: any = {
    get cwd() {
        return currentCwd;
    },
    set cwd(value: string) {
        currentCwd = value;
    },
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    get sessionManager() {
        return sessionManager;
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

const scopeState = entries.filter((entry) => entry.customType === "specpi-scope-state").at(-1)?.data;
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
const scopeBeforeAccept = entries.filter((entry) => entry.customType === "specpi-scope-state").at(-1)?.data;
await commands.get("scope").handler("accept outside.txt", ctx);
const scopeAfterAccept = entries.filter((entry) => entry.customType === "specpi-scope-state").at(-1)?.data;
const acceptClearedPending =
    scopeBeforeAccept?.pending?.includes("outside.txt") === true &&
    scopeAfterAccept?.pending?.includes("outside.txt") === false;
const acceptKeptScope = scopeAfterAccept?.entries?.length === scopeBeforeAccept?.entries?.length;

await commands.get("scope").handler("add outside.txt", ctx);
const scopeAfterAdd = entries.filter((entry) => entry.customType === "specpi-scope-state").at(-1)?.data;
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
const scopeBeforePercentAdd = entries.filter((entry) => entry.customType === "specpi-scope-state").at(-1)?.data;
await commands.get("scope").handler("add percent%25.txt", ctx);
const scopeAfterPercentAdd = entries.filter((entry) => entry.customType === "specpi-scope-state").at(-1)?.data;
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
    entries.filter((entry) => entry.customType === "specpi-scope-state").at(-1)?.data?.indeterminate ===
        indeterminateBeforeRead;

// A missing pre-tool baseline makes uncertainty sticky. A later successful Git snapshot must not make a ready
// verdict reachable until the human deliberately re-baselines with `/scope recheck`.
await commands.get("scope").handler("accept another.txt", ctx);
for (const handler of events.get("tool_result") || []) {
    await handler({ toolName: "edit", toolCallId: "missing-baseline", isError: false, content: [] }, ctx);
}

await commands.get("challenge").handler("", ctx);
const challengeTriggered = messages.length === 1 && messages[0].options.triggerTurn === true;
const activation = entries
    .filter((entry) => entry.customType === "specpi-completion-challenge" && entry.data.kind === "active")
    .at(-1)?.data;
const stickyChallengeIndeterminate = activation?.facts?.snapshotIndeterminate === true;
let stickyReadyRejected = false;
try {
    await tools.get("submit_completion_challenge").execute(
        "sticky-ready-tool",
        {
            generation: activation.generation,
            verdict: "ready-for-human-review",
            requirements: [{ requirement: "Harness behavior", status: "proven", evidence: "Scope paths observed" }],
            contradictions: [],
            falsePositiveChecks: [],
            scopeFindings: [],
            validationGaps: [],
            residualRisks: [],
            nextAction: "Human reviews the evidence",
        },
        undefined,
        undefined,
        ctx,
    );
} catch (error) {
    stickyReadyRejected = /snapshot was indeterminate/u.test(String(error));
}

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
await commands.get("scope").handler("recheck", ctx);
const scopeAfterUncertaintyRecheck = entries.filter((entry) => entry.customType === "specpi-scope-state").at(-1)?.data;
const scopeRecheckClearedUncertainty = scopeAfterUncertaintyRecheck?.indeterminate === false;
ctx.hasUI = false;
for (const handler of events.get("tool_call") || []) {
    await handler(headlessCall, ctx);
}

ctx.hasUI = true;
let staleChallengeRejected = false;
try {
    await tools
        .get("submit_completion_challenge")
        .execute("stale-challenge-tool", challengeSubmission, undefined, undefined, ctx);
} catch (error) {
    staleChallengeRejected = /No matching completion challenge/u.test(String(error));
}

// Keep an unanswered legacy challenge armed as well as its completed review. Establishing the first card must retire
// both kinds of generic evidence before the card-bound challenge starts.
await commands.get("challenge").handler("", ctx);
const genericActivation = entries
    .filter((entry) => entry.customType === "specpi-completion-challenge" && entry.data.kind === "active")
    .at(-1)?.data;
const genericChallengeTriggered = genericActivation?.facts?.taskContractDigest === undefined;

// A human can establish a bounded card after a legacy challenge. The new card is written to the same branch entry,
// preserves the old pending scope finding when explicitly imported, and retires the legacy review evidence.
editorValue = [
    "Objective: Keep workflow controls aligned",
    "Hypothesis: A fixed card keeps review tied to the selected work",
    "Requirements:",
    "- R1: Keep the task objective visible",
    "  Acceptance: The task card is rendered in the current conversation",
    "- R2: Keep scope explicit",
    "  Acceptance: Scope import preserves pending findings",
    "Paths:",
    "- src/",
    "Rollback: Clear the task card and restore the prior branch state",
    "Non-goals:",
    "- No automatic scope expansion",
].join("\n");
await commands.get("task").handler("set", ctx);
const taskSet = entries.filter((entry) => entry.customType === "specpi-task-contract").at(-1)?.data;
const taskContract = taskSet?.contract;
const legacyReviewInvalidated =
    entries.filter((entry) => entry.customType === "specpi-completion-challenge").at(-1)?.data?.kind === "cleared";
const pendingBeforeTaskImport =
    entries.filter((entry) => entry.customType === "specpi-scope-state").at(-1)?.data?.pending ?? [];
await commands.get("scope").handler("task", ctx);
const scopeAfterTaskImport = entries.filter((entry) => entry.customType === "specpi-scope-state").at(-1)?.data;
const taskImportPreservedPending =
    pendingBeforeTaskImport.includes("another.txt") && scopeAfterTaskImport?.pending?.includes("another.txt") === true;
const taskImportBoundDigest = scopeAfterTaskImport?.taskDigest === taskContract?.digest;

await commands.get("challenge").handler("", ctx);
const taskActivation = entries
    .filter((entry) => entry.customType === "specpi-completion-challenge" && entry.data.kind === "active")
    .at(-1)?.data;
const genericActiveReviewInvalidated =
    taskActivation?.facts?.taskContractDigest === taskContract?.digest &&
    taskActivation?.generation !== genericActivation?.generation;
const taskChallengeSubmission = {
    generation: taskActivation.generation,
    verdict: "incomplete",
    requirements: [
        { id: "R1", status: "partial", evidence: "Card renderer observed" },
        { id: "R2", status: "partial", evidence: "Pending finding remains" },
    ],
    contradictions: [],
    falsePositiveChecks: [],
    scopeFindings: ["Outside paths remain pending"],
    validationGaps: ["No full runtime test in challenge"],
    residualRisks: ["Model-authored"],
    nextAction: "Run the repository tests",
};
const taskChallengeResult = await tools
    .get("submit_completion_challenge")
    .execute("task-challenge-tool", taskChallengeSubmission, undefined, undefined, ctx);
const taskChallengeExactIds = taskChallengeResult.details.verdict === "incomplete";

fs.writeFileSync(path.join(repository, "src", "inside.txt"), "handoff change\n");
await commands.get("task").handler("handoff", ctx);
const normalHandoff = entries.filter((entry) => entry.customType === "specpi-task-handoff").at(-1)?.data;
const handoffRendered =
    typeof normalHandoff?.markdown === "string" &&
    normalHandoff.markdown.includes("Keep workflow controls aligned") &&
    normalHandoff.markdown.includes("R1") &&
    normalHandoff.markdown.includes("incomplete") &&
    normalHandoff.markdown.includes("type:file;mode:") &&
    normalHandoff.markdown.includes("sha256:");
for (const handler of events.get("tool_result") || []) {
    await handler({ toolName: "edit", toolCallId: "handoff-missing-baseline", isError: false, content: [] }, ctx);
}

await commands.get("task").handler("handoff", ctx);
const handoff = entries.filter((entry) => entry.customType === "specpi-task-handoff").at(-1)?.data;
const handoffStickyUncertainty = handoff?.indeterminate === true && handoff.markdown.includes("Snapshot indeterminate");
const handoffDidNotTriggerTurn = messages.length === 3;
await commands.get("scope").handler("recheck", ctx);

const taskIdBeforeRevision = taskContract?.id;
const taskDigestBeforeRevision = taskContract?.digest;
editorValue = editorValue.replace("Keep workflow controls aligned", "Keep revised workflow controls aligned");
const emittedBeforeTaskRevision = emitted.length;
await commands.get("task").handler("set", ctx);
const revisedTask = entries.filter((entry) => entry.customType === "specpi-task-contract").at(-1)?.data?.contract;
const taskRevisionKeepsId = revisedTask?.id === taskIdBeforeRevision;
const taskRevisionChangedDigest = revisedTask?.digest !== taskDigestBeforeRevision;
const taskRevisionEmittedStaleImmediately = emitted
    .slice(emittedBeforeTaskRevision)
    .some((item) => item.name === "specpi:workflow-status" && item.data?.taskStale === true);
const taskRevisionInvalidatedReview =
    entries.filter((entry) => entry.customType === "specpi-completion-challenge").at(-1)?.data?.kind === "cleared";
await commands.get("scope").handler("status", ctx);
const taskScopeReportedStale = notifications.at(-1)?.message.includes("task binding: stale") === true;
await commands.get("scope").handler("task", ctx);
const scopeAfterTaskRevisionImport = entries.filter((entry) => entry.customType === "specpi-scope-state").at(-1)?.data;
const taskReimportUpdatedDigest = scopeAfterTaskRevisionImport?.taskDigest === revisedTask?.digest;

// A fresh review for the revised card can still be recorded and must survive a later session restart.
await commands.get("challenge").handler("", ctx);
const postRevisionActivation = entries
    .filter((entry) => entry.customType === "specpi-completion-challenge" && entry.data.kind === "active")
    .at(-1)?.data;
await tools.get("submit_completion_challenge").execute(
    "post-revision-challenge-tool",
    {
        generation: postRevisionActivation.generation,
        verdict: "incomplete",
        requirements: [
            { id: "R1", status: "partial", evidence: "Revised card observed" },
            { id: "R2", status: "partial", evidence: "Scope remains explicit" },
        ],
        contradictions: [],
        falsePositiveChecks: [],
        scopeFindings: [],
        validationGaps: [],
        residualRisks: ["Model-authored"],
        nextAction: "Human reviews the revised card",
    },
    undefined,
    undefined,
    ctx,
);

// A challenge the model receives but never answers must expire with the turn instead of steering every later turn.
await commands.get("challenge").handler("", ctx);
const abandoned = entries
    .filter((entry) => entry.customType === "specpi-completion-challenge" && entry.data.kind === "active")
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
for (const handler of events.get("session_start") || []) {
    await handler({}, ctx);
}

const resumedScope = entries.filter((entry) => entry.customType === "specpi-scope-state").at(-1)?.data;
const resumedActive = resumedScope?.active === true && resumedScope.entries.length > 0;
let resumedChallengeArmed = false;
for (const handler of events.get("before_agent_start") || []) {
    const outcome = await handler({ systemPrompt: "base" }, ctx);
    resumedChallengeArmed ||= (outcome?.systemPrompt ?? "").includes("COMPLETION CHALLENGE");
}

// A challenge that expired unanswered must not retire the last completed card the way /challenge clear does.
const displaysBeforeStatus = entries.filter(
    (entry) => entry.customType === "specpi-completion-challenge" && entry.data.kind === "display",
).length;
await commands.get("challenge").handler("status", ctx);
const completedResultSurvivedRestart =
    entries.filter((entry) => entry.customType === "specpi-completion-challenge" && entry.data.kind === "display")
        .length ===
    displaysBeforeStatus + 1;

const emittedBeforeTaskClear = emitted.length;
await commands.get("task").handler("clear", ctx);
const taskClearEmittedStaleImmediately = emitted
    .slice(emittedBeforeTaskClear)
    .some((item) => item.name === "specpi:workflow-status" && item.data?.taskStale === true);

// Scope restored from the branch must be a copy: widening it later cannot rewrite the record it was restored from.
const restoredRecordJson = JSON.stringify(resumedScope);
await commands.get("scope").handler("add docs/", ctx);
const restoredRecordUnchanged = JSON.stringify(resumedScope) === restoredRecordJson;
const addAfterResumeWidened =
    (entries.filter((entry) => entry.customType === "specpi-scope-state").at(-1)?.data?.entries?.length ?? 0) ===
    resumedScope.entries.length + 1;

// A malformed latest task entry must stop a challenge rather than silently reverting to legacy no-card behavior.
const messagesBeforeMalformedTask = messages.length;
branch.push({
    type: "custom",
    customType: "specpi-task-contract",
    data: { kind: "set", contract: {} },
});
await commands.get("challenge").handler("", ctx);
const malformedTaskChallengeBlocked =
    messages.length === messagesBeforeMalformedTask &&
    notifications.at(-1)?.message.includes("Task contract unavailable") === true;
let malformedTaskRendererSafe = false;
try {
    renderers.get("specpi-task-contract")?.({ data: { kind: "set", contract: {} } }, {}, ctx.ui.theme);
    malformedTaskRendererSafe = true;
} catch {
    malformedTaskRendererSafe = false;
}

const headlessPending = entries
    .filter((entry) => entry.customType === "specpi-scope-state")
    .at(-1)
    ?.data?.pending?.includes("another.txt");

async function runHandlers(name: string, event: any = {}) {
    for (const handler of events.get(name) ?? []) {
        await handler(event, ctx);
    }
}

async function currentPrompt() {
    const prompts = [];
    for (const handler of events.get("before_agent_start") ?? []) {
        const outcome = await handler({ systemPrompt: "base" }, ctx);
        prompts.push(outcome?.systemPrompt ?? "");
    }

    return prompts.join("\n");
}

function deferred() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });

    return { promise, release };
}

function delayNextGit(subcommand: string) {
    const started = deferred();
    const completion = deferred();
    const original = pi.exec;
    pi.exec = async (command: string, args: string[], options: any) => {
        if (command === "git" && args[0] === subcommand) {
            pi.exec = original;
            started.release();
            await completion.promise;
        }

        return original(command, args, options);
    };

    return { started: started.promise, release: completion.release };
}

// Pi /tree changes the branch in place. Context getters still point at that live session, including while commands
// await Git or an editor. Same-root branches and shared ancestor cards must not make an old operation transferable.
const sourceLeaf = [
    { type: "custom", customType: "specpi-task-contract", data: { kind: "set", contract: taskContract } },
    {
        type: "custom",
        customType: "specpi-scope-state",
        data: { ...scopeAfterTaskRevisionImport, taskDigest: taskContract.digest, indeterminate: true },
    },
];
branch = [...sourceLeaf];
await runHandlers("session_tree");
await commands.get("challenge").handler("", ctx);
const sourceActivation = entries
    .filter((entry) => entry.customType === "specpi-completion-challenge" && entry.data.kind === "active")
    .at(-1)?.data;
const sourcePrompt = await currentPrompt();
branch = [];
const restoreDelay = delayNextGit("rev-parse");
const restoringEmptyLeaf = runHandlers("session_tree");
await restoreDelay.started;
let treeClearedChallengeBeforeRoot = false;
try {
    await tools
        .get("submit_completion_challenge")
        .execute("old-leaf-submit", { generation: sourceActivation.generation }, undefined, undefined, ctx);
} catch (error) {
    treeClearedChallengeBeforeRoot = /No matching completion challenge/u.test(String(error));
}

const promptDuringRestore = await currentPrompt();
restoreDelay.release();
await restoringEmptyLeaf;
await commands.get("scope").handler("status", ctx);
const treeScopeCleared = notifications.at(-1)?.message === "Scope monitoring is inactive.";
await commands.get("task").handler("status", ctx);
const treeTaskCleared = notifications.at(-1)?.message === "No task contract is active for this project.";
await commands.get("challenge").handler("status", ctx);
const treeChallengeCleared = notifications.at(-1)?.message === "No completed challenge exists on this session branch.";
const treeOldStateCleared =
    sourcePrompt.includes(sourceActivation.generation) &&
    !promptDuringRestore.includes("COMPLETION CHALLENGE") &&
    !promptDuringRestore.includes("SPECPI TASK CONTRACT") &&
    !promptDuringRestore.includes("SPECPI SCOPE") &&
    treeScopeCleared &&
    treeTaskCleared &&
    treeChallengeCleared &&
    branch.length === 0;

branch = [...sourceLeaf];
const olderRestoreDelay = delayNextGit("rev-parse");
const olderRestore = runHandlers("session_tree");
await olderRestoreDelay.started;
branch = [];
await runHandlers("session_tree");
const readsBeforeOlderRestore = branchReads;
const emissionsBeforeOlderRestore = emitted.length;
olderRestoreDelay.release();
await olderRestore;
const olderRestoreDidNotReadOrEmit =
    branchReads === readsBeforeOlderRestore && emitted.length === emissionsBeforeOlderRestore;
const olderRestorePrompt = await currentPrompt();
await commands.get("scope").handler("status", ctx);
const treeOlderRestoreIgnored =
    olderRestoreDidNotReadOrEmit &&
    !olderRestorePrompt.includes("SPECPI TASK CONTRACT") &&
    !olderRestorePrompt.includes("SPECPI SCOPE") &&
    notifications.at(-1)?.message === "Scope monitoring is inactive.";

await commands.get("challenge").handler("", ctx);
const genericBeforeTree = entries
    .filter((entry) => entry.customType === "specpi-completion-challenge" && entry.data.kind === "active")
    .at(-1)?.data;
branch = [];
await runHandlers("session_tree");
let genericTreeSubmitRejected = false;
try {
    await tools
        .get("submit_completion_challenge")
        .execute("old-generic-leaf-submit", { generation: genericBeforeTree.generation }, undefined, undefined, ctx);
} catch (error) {
    genericTreeSubmitRejected = /No matching completion challenge/u.test(String(error));
}

const treeArmedGenericChallengeCleared =
    genericBeforeTree.facts.taskContractDigest === undefined &&
    genericTreeSubmitRejected &&
    !(await currentPrompt()).includes("COMPLETION CHALLENGE") &&
    branch.length === 0;

const delayedChallenges: boolean[] = [];
for (const subcommand of ["rev-parse", "status"]) {
    branch = [];
    await runHandlers("session_tree");
    const delay = delayNextGit(subcommand);
    const entryCount = entries.length;
    const messageCount = messages.length;
    const pending = commands.get("challenge").handler("", ctx);
    await delay.started;
    branch = [];
    await runHandlers("session_tree");
    delay.release();
    await pending;
    delayedChallenges.push(
        entries.length === entryCount &&
            messages.length === messageCount &&
            branch.length === 0 &&
            !(await currentPrompt()).includes("COMPLETION CHALLENGE"),
    );
}

branch = [...sourceLeaf];
await runHandlers("session_tree");
const editorStarted = deferred();
const editorCompletion = deferred();
const originalEditor = ctx.ui.editor;
ctx.ui.editor = async () => {
    editorStarted.release();
    await editorCompletion.promise;

    return editorValue.replace("Keep revised workflow controls aligned", "Old leaf editor result");
};

const entriesBeforeEditor = entries.length;
const pendingEditor = commands.get("task").handler("set", ctx);
await editorStarted.promise;
branch = [...sourceLeaf];
await runHandlers("session_tree");
editorCompletion.release();
await pendingEditor;
ctx.ui.editor = originalEditor;
const treeDelayedTaskEditorIgnored =
    entries.length === entriesBeforeEditor &&
    branch.length === sourceLeaf.length &&
    !(await currentPrompt()).includes("Old leaf editor result");

const handoffDelay = delayNextGit("status");
const entriesBeforeDelayedHandoff = entries.length;
const pendingHandoff = commands.get("task").handler("handoff", ctx);
await handoffDelay.started;
branch = [...sourceLeaf];
await runHandlers("session_tree");
handoffDelay.release();
await pendingHandoff;
const treeDelayedHandoffIgnored = entries.length === entriesBeforeDelayedHandoff && branch.length === sourceLeaf.length;

const recheckDelay = delayNextGit("status");
const entriesBeforeDelayedRecheck = entries.length;
const pendingRecheck = commands.get("scope").handler("recheck", ctx);
await recheckDelay.started;
branch = [...sourceLeaf];
await runHandlers("session_tree");
recheckDelay.release();
await pendingRecheck;
await commands.get("scope").handler("status", ctx);
const treeDelayedRecheckIgnored =
    entries.length === entriesBeforeDelayedRecheck && notifications.at(-1)?.message.includes("indeterminate") === true;

branch = [];
await runHandlers("session_tree");
const shutdownDelay = delayNextGit("status");
const entriesBeforeShutdown = entries.length;
const messagesBeforeShutdown = messages.length;
const pendingShutdownChallenge = commands.get("challenge").handler("", ctx);
await shutdownDelay.started;
await runHandlers("session_shutdown");
shutdownDelay.release();
await pendingShutdownChallenge;
const shutdownDelayedChallengeIgnored =
    entries.length === entriesBeforeShutdown && messages.length === messagesBeforeShutdown;

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
        headlessPending,
        challengeTriggered,
        challengeTerminated: result.terminate === true,
        challengeVerdict: result.details.verdict,
        staleChallengeRejected,
        genericChallengeTriggered,
        legacyReviewInvalidated,
        genericActiveReviewInvalidated,
        taskImportPreservedPending,
        taskImportBoundDigest,
        taskChallengeExactIds,
        handoffRendered,
        handoffDidNotTriggerTurn,
        taskRevisionKeepsId,
        taskRevisionChangedDigest,
        taskRevisionEmittedStaleImmediately,
        taskRevisionInvalidatedReview,
        taskScopeReportedStale,
        taskReimportUpdatedDigest,
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
        malformedTaskChallengeBlocked,
        malformedTaskRendererSafe,
        taskClearEmittedStaleImmediately,
        stickyChallengeIndeterminate,
        stickyReadyRejected,
        scopeRecheckClearedUncertainty,
        handoffStickyUncertainty,
        treeClearedChallengeBeforeRoot,
        treeOldStateCleared,
        treeOlderRestoreIgnored,
        treeArmedGenericChallengeCleared,
        treeDelayedChallengeRootIgnored: delayedChallenges[0],
        treeDelayedChallengeSnapshotIgnored: delayedChallenges[1],
        treeDelayedTaskEditorIgnored,
        treeDelayedHandoffIgnored,
        treeDelayedRecheckIgnored,
        shutdownDelayedChallengeIgnored,
        guardStillUsable,
        emittedScopeStatus: emitted.some((item) => item.name === "specpi:workflow-status"),
    })}\n`,
);

fs.rmSync(root, { recursive: true, force: true });

// The pinned Pi loader treats `-e` sources as extensions and requires a factory export after executing the probe.
export default function workflowControlsHarness() {}
