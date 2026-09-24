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
let commandNames: string[] | undefined;
let projectTrusted = false;
let confirmAnswer = true;
let confirmPrompts = 0;
// Browser QA is a separate package. Start with it absent so the loader has to report an
// uninstalled capability, then install it to exercise a real activation.
let browserRegistered = false;
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
    // Mirror Pi: the built-ins plus pi-web-access tools start active; setActiveTools replaces the set.
    getActiveTools() {
        return [...activeTools];
    },
    setActiveTools(names: string[]) {
        activeTools = [...names];
    },
    // Mirror Pi: every registered tool is listed whether or not it is active.
    getAllTools() {
        const registered = ["read", "bash", "edit", "write", ...webAccessTools, ...tools.keys()];
        if (browserRegistered) {
            registered.push(...browserTools);
        }

        return [...new Set(registered)].map((name) => ({ name }));
    },
    sendMessage(message: any, options: any) {
        messages.push({ message, options });
    },
    // Mirror Pi: the slash commands every loaded extension registered. Unset means an older Pi
    // without the call, which background admission must treat as unknown.
    get getCommands() {
        return commandNames === undefined ? undefined : () => commandNames!.map((name) => ({ name }));
    },
    events: {
        on() {},
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
registerWorkflowControls(pi);

let branch: any[] = [];
let currentCwd = nestedCwd;
let branchReads = 0;
const webAccessTools = ["web_search", "source_check", "fetch_content", "get_search_content"];
const { BROWSER_TOOL_NAMES: browserTools } = await import("../../extensions/workflow-controls/capabilities.mjs");
let activeTools: string[] = ["read", "bash", "edit", "write", ...webAccessTools];
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
    isProjectTrusted: () => projectTrusted,
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
            confirmPrompts += 1;

            return confirmAnswer;
        },
    },
};

// Web access ships hidden: the first session_start must withdraw its four tools, /webaccess on
// must offer them again, and a saved startup preference must re-offer them on later sessions.
const activeAtLoad = [...activeTools];
for (const handler of events.get("session_start") || []) {
    await handler({}, ctx);
}

const activeAfterFirstStart = [...activeTools];
await commands.get("webaccess").handler("on", ctx);
const activeAfterOn = [...activeTools];
await commands.get("webaccess").handler("off", ctx);
const activeAfterOff = [...activeTools];

// request_capability lets the model ask for a withdrawn group. It must never grant one on its
// own: an unknown name, a headless session, an uninstalled package, and a declined prompt all
// have to leave the active set exactly as it was. Activation must also stay additive, because
// removing a tool in the same call costs Pi's cached prompt prefix.
const requestCapability = tools.get("request_capability");
const requestCapabilityCall = async (capability: unknown, overrides: any = {}) =>
    await requestCapability.execute(
        "capability-call",
        { capability, reason: "harness scenario" },
        undefined,
        undefined,
        { ...ctx, ...overrides },
    );

const unknownCapability = await requestCapabilityCall("telepathy");
const unknownCapabilityRejected = unknownCapability.isError === true && unknownCapability.details?.activated === false;
const activeAfterUnknown = [...activeTools];

const headlessCapability = await requestCapabilityCall("web", { hasUI: false });
const headlessCapabilityRefused =
    headlessCapability.details?.headless === true &&
    headlessCapability.details?.activated === false &&
    headlessCapability.isError !== true;
const activeAfterHeadless = [...activeTools];

const uninstalledCapability = await requestCapabilityCall("browser");
const uninstalledCapabilityReported =
    uninstalledCapability.details?.installed === false &&
    uninstalledCapability.details?.activated === false &&
    uninstalledCapability.isError !== true;

confirmAnswer = false;
const promptsBeforeDecline = confirmPrompts;
const declinedCapability = await requestCapabilityCall("web");
const declinedCapabilityPrompted = confirmPrompts === promptsBeforeDecline + 1;
const declinedCapabilityWithheld =
    declinedCapability.details?.declined === true &&
    declinedCapability.details?.activated === false &&
    declinedCapability.isError !== true;
const activeAfterDecline = [...activeTools];

confirmAnswer = true;
const grantedCapability = await requestCapabilityCall("web");
const activeAfterGrant = [...activeTools];
const grantedCapabilityActivated = grantedCapability.details?.activated === true;

// A granted group must leave SpecPi's own web-access state truthful, not just the tool set.
notifications.length = 0;
await commands.get("webaccess").handler("status", ctx);
const grantedCapabilitySyncedState = notifications.at(-1)?.message?.includes("is offering") === true;

// An already-available group answers without spending another human decision.
const promptsBeforeRepeat = confirmPrompts;
const repeatedCapability = await requestCapabilityCall("web");
const repeatedCapabilitySkippedPrompt =
    confirmPrompts === promptsBeforeRepeat &&
    repeatedCapability.details?.alreadyActive === true &&
    repeatedCapability.isError !== true;

await commands.get("webaccess").handler("off", ctx);

// A standing grant replaces the prompt with a decision the human already made. Recording one
// still needs a human, the grant must be visible when it fires, and revoking it must restore
// the prompt.
let capabilityPolicyRefusedHeadless = false;
try {
    await commands.get("capability").handler("allow web", { ...ctx, hasUI: false });
} catch {
    capabilityPolicyRefusedHeadless = true;
}

const policyFile = path.join(agentDir, "specpi", "capabilities", "settings.json");
const capabilityPolicyUnwrittenWhenHeadless = !fs.existsSync(policyFile);

await commands.get("capability").handler("allow web", ctx);
const capabilityPolicySaved = JSON.parse(fs.readFileSync(policyFile, "utf8"))?.autoAllow?.includes("web") === true;

confirmAnswer = false;
notifications.length = 0;
const promptsBeforeStanding = confirmPrompts;
const standingCapability = await requestCapabilityCall("web");
const standingCapabilitySkippedPrompt = confirmPrompts === promptsBeforeStanding;
const standingCapabilityActivated = standingCapability.details?.standing === true;
const standingCapabilityOffered = webAccessTools.every((name) => activeTools.includes(name));
const standingCapabilityAnnounced = notifications.some((item) => item.message.includes("standing grant"));

await commands.get("webaccess").handler("off", ctx);
await commands.get("capability").handler("ask web", ctx);
const promptsBeforeRevoked = confirmPrompts;
const revokedCapability = await requestCapabilityCall("web");
const revokedCapabilityPromptedAgain =
    confirmPrompts === promptsBeforeRevoked + 1 && revokedCapability.details?.declined === true;
confirmAnswer = true;

// An unknown name must never reach the policy file, which stores tool-group authority.
let capabilityPolicyRejectedUnknown = false;
try {
    await commands.get("capability").handler("allow telepathy", ctx);
} catch {
    capabilityPolicyRejectedUnknown = true;
}

const capabilityPolicyStayedClean =
    JSON.parse(fs.readFileSync(policyFile, "utf8"))?.autoAllow?.length === 0 &&
    !webAccessTools.some((name) => activeTools.includes(name));

// A second capability exercises the generic path: Browser QA's tools belong to another
// package, so the loader can only add them by name and must leave web access alone.
browserRegistered = true;
const activeBeforeBrowser = [...activeTools];
const grantedBrowser = await requestCapabilityCall("browser");
const activeAfterBrowser = [...activeTools];
const grantedBrowserActivated = grantedBrowser.details?.activated === true;

await commands.get("webaccess").handler("startup on", ctx);
const startupPreferenceSaved =
    JSON.parse(fs.readFileSync(path.join(agentDir, "specpi", "web-access", "settings.json"), "utf8"))
        ?.startupActivation === true;

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

const uncertain = entries.at(-1).data.indeterminate;
await commands.get("scope").handler("recheck", ctx);
const rechecked = !entries.at(-1).data.indeterminate;
const { createTaskContract } = await import("../../extensions/workflow-controls/task-contract.mjs");
const contract = createTaskContract(
    {
        objective: "Keep scope bounded",
        hypothesis: "Explicit paths prevent drift",
        requirements: [{ id: "R1", description: "Detect drift", acceptance: "Outside edits are reported" }],
        paths: ["src/"],
        rollback: "Clear scope",
        nonGoals: ["No extra tools"],
    },
    { root: repository, origin: "human" },
);
pi.appendEntry("specpi-task-contract", { kind: "set", contract });
await commands.get("scope").handler("task", ctx);
const taskBound = entries.at(-1).data.taskDigest === contract.digest;
const beforeResume = JSON.stringify(branch);
for (const handler of events.get("session_start") || []) {
    await handler({}, ctx);
}

const activeAfterResumeStart = [...activeTools];

await commands.get("scope").handler("add docs/", ctx);
const restoredRecordUnchanged = JSON.stringify(branch.slice(0, -1)) === beforeResume;
const exec = pi.exec;
let releaseRoot: () => void;
let rootLookupReached: () => void;
// The command reaches its root lookup asynchronously, so hand back the real exec only once the stub is holding it;
// swapping on the next line instead would let the command sail past and leave `releaseRoot` unassigned.
const rootLookupHeld = new Promise<void>((resolve) => {
    rootLookupReached = resolve;
});
pi.exec = async (command: string, args: string[], options: any) => {
    if (args[0] === "rev-parse") {
        await new Promise<void>((resolve) => {
            releaseRoot = resolve;
            rootLookupReached();
        });
    }

    return exec(command, args, options);
};

const pending = commands.get("scope").handler("status", ctx);
await rootLookupHeld;
branch = [];
pi.exec = exec;
for (const handler of events.get("session_tree") || []) {
    await handler({}, ctx);
}

releaseRoot!();
await pending;
await commands.get("scope").handler("status", ctx);
const treeCleared = notifications.at(-1).message === "Scope monitoring is inactive.";

// Restore retires scope immediately but only learns the repository root once `git rev-parse` returns. A human who
// declares scope inside that window must not have it recorded against the session cwd the restore was still guessing
// at, because the replay that follows rejects a foreign root and would silently retire the contract it just confirmed.
ctx.cwd = nestedCwd;
editorValue = "src/";
branch = [];
let releaseRestoreRoot: () => void;
pi.exec = async (command: string, args: string[], options: any) => {
    if (args[0] === "rev-parse") {
        await new Promise<void>((resolve) => {
            releaseRestoreRoot = resolve;
        });
    }

    return exec(command, args, options);
};

for (const handler of events.get("session_start") || []) {
    await handler({}, ctx);
}

const declaredDuringRestore = commands.get("scope").handler("set", ctx);
pi.exec = exec;
releaseRestoreRoot!();
await declaredDuringRestore;
const racedScopeState = entries.filter((entry) => entry.customType === "specpi-scope-state").at(-1)?.data;
const restoreRaceKeptRepositoryRoot =
    racedScopeState?.active === true &&
    racedScopeState.root === fs.realpathSync.native(repository) &&
    racedScopeState.entries.some((entry: any) => entry.path === "src" && entry.directory === true);
await commands.get("scope").handler("status", ctx);
const restoreRaceSurvived = notifications.at(-1).message.startsWith("Scope: src/;");

// request_capability is decided at session start: offered where a human can grant an installed group,
// withdrawn from a headless session, where it could only ever refuse. Run last so the headless
// restore cannot disturb the scope scenarios above.
const capabilityRequestOfferedInteractive = activeAfterFirstStart.includes("request_capability");
for (const handler of events.get("session_start") || []) {
    await handler({}, { ...ctx, hasUI: false });
}

const capabilityRequestWithdrawnHeadless = !activeTools.includes("request_capability");
for (const handler of events.get("session_start") || []) {
    await handler({}, ctx);
}

const capabilityRequestReofferedInteractive = activeTools.includes("request_capability");

// Background jobs. Admission fails closed on every condition, and a started job really runs in
// Pi's own shell runner and reports back as a follow-up message.
const background = tools.get("background");
const startSession = async (context: any = ctx) => {
    for (const handler of events.get("session_start") || []) {
        await handler({}, context);
    }
};

const startJob = async (command: string, context: any = ctx) =>
    await background.execute("background-call", { command, label: "harness" }, undefined, undefined, context);
const waitFor = async (predicate: () => boolean, ms = 20000) => {
    const deadline = Date.now() + ms;
    while (!predicate() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return predicate();
};

const jobMessages = () => messages.filter((item) => item.message?.customType === "specpi-background");
const guardFile = path.join(os.homedir(), ".pi", "jev-guard.json");
const permissionFile = path.join(agentDir, "extensions", "pi-permission-system", "config.json");
const projectPermissionFile = path.join(ctx.cwd, ".pi", "extensions", "pi-permission-system", "config.json");
const writeJson = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
};

commandNames = undefined;
await startSession();
const backgroundWithdrawnWhenCommandsUnknown = !activeTools.includes("background");
const backgroundRefusedWhenCommandsUnknown = (await startJob("echo no")).details?.started === false;

commandNames = ["scope", "jobs"];
await startSession();
const backgroundOfferedWithoutGates = activeTools.includes("background");
const backgroundRefusedHeadless = (await startJob("echo no", { ...ctx, hasUI: false })).details?.started === false;

const started = await startJob("echo background-ok");
const backgroundStarted = started.details?.started === true && started.isError !== true;
const backgroundReported = await waitFor(() => jobMessages().length === 1);
const firstJobReport = jobMessages()[0];
const backgroundReportCarriesOutput =
    /exit code 0/u.test(firstJobReport?.message?.content ?? "") &&
    /background-ok/u.test(firstJobReport?.message?.content ?? "");
const backgroundReportTriggersTurn =
    firstJobReport?.message?.display === true &&
    firstJobReport?.options?.triggerTurn === true &&
    firstJobReport?.options?.deliverAs === "followUp";

// The guard's own default is on; only a saved off lets jobs start while it is installed.
commandNames = ["scope", "jobs", "jev-guard"];
fs.rmSync(guardFile, { force: true });
await startSession();
const backgroundWithdrawnWithDefaultGuard = !activeTools.includes("background");
const backgroundRefusedWithDefaultGuard = /command guard is on/u.test(
    (await startJob("echo no")).content?.[0]?.text ?? "",
);
writeJson(guardFile, { enabled: false });
await startSession();
const backgroundOfferedWithGuardSavedOff = activeTools.includes("background");
writeJson(guardFile, { enabled: true });
const backgroundRefusedWithGuardSavedOn = (await startJob("echo no")).details?.started === false;
writeJson(guardFile, { enabled: false });

// The permission system must apply bash rules to the command, and a trusted project cannot remap it.
commandNames = ["scope", "jobs", "jev-guard", "permission-system"];
fs.rmSync(permissionFile, { force: true });
const backgroundRefusedWithoutMapping = /does not yet apply bash rules/u.test(
    (await startJob("echo no")).content?.[0]?.text ?? "",
);
writeJson(permissionFile, { shellTools: { background: { commandArgument: "command" } } });
await startSession();
const backgroundOfferedWithMapping = activeTools.includes("background");
writeJson(projectPermissionFile, { shellTools: { background: { commandArgument: "label" } } });
const backgroundIgnoresUntrustedProject = (await startJob("echo trusted-scope-ok")).details?.started === true;
projectTrusted = true;
const backgroundRefusedWhenTrustedProjectRemaps = (await startJob("echo no")).details?.started === false;
projectTrusted = false;
fs.rmSync(path.dirname(projectPermissionFile), { recursive: true, force: true });
fs.writeFileSync(
    permissionFile,
    '{ // comments are allowed\n "shellTools": { "background": { "commandArgument": "command" } } }',
);
const backgroundReadsCommentedConfig = (await startJob("echo commented-ok")).details?.started === true;
await waitFor(() => jobMessages().length >= 3);

// A user stop reports without starting a turn; ending the session stops the rest and deletes logs.
const long = await startJob("sleep 30");
const reportsBeforeStop = jobMessages().length;
await commands.get("jobs").handler(`stop ${long.details.id}`, ctx);
const backgroundStopReported = await waitFor(() => jobMessages().length === reportsBeforeStop + 1);
const stopReport = jobMessages().at(-1);
const backgroundStopWaitsForNextTurn =
    stopReport?.options?.deliverAs === "nextTurn" &&
    stopReport?.options?.triggerTurn !== true &&
    /stopped by the user/u.test(stopReport?.message?.content ?? "");
// Long bash waits are refused while background jobs are on offer, and only then.
const bashCall = (command: string) => ({ toolName: "bash", toolCallId: "long-bash", input: { command } });
const runBashHooks = async (command: string, context: any = ctx) => {
    let outcome: any;
    for (const handler of events.get("tool_call") || []) {
        outcome = (await handler(bashCall(command), context)) ?? outcome;
    }

    return outcome;
};

const pollingBlocked = (await runBashHooks("for i in 1 2 3; do gh pr checks 1; sleep 30; done"))?.block === true;
const quickAllowed = (await runBashHooks("git status"))?.block !== true;
const headlessBashAllowed = (await runBashHooks("sleep 120", { ...ctx, hasUI: false }))?.block !== true;
const offered = [...activeTools];
activeTools = activeTools.filter((name) => name !== "background");
const withoutBackgroundAllowed = (await runBashHooks("sleep 120"))?.block !== true;
activeTools = offered;
const longBashSteered = pollingBlocked && quickAllowed && headlessBashAllowed && withoutBackgroundAllowed;
const orphan = await startJob("sleep 30");
const orphanLogDir = path.dirname(orphan.details.logPath);
for (const handler of events.get("session_shutdown") || []) {
    await handler({}, ctx);
}

const backgroundEndsWithSession =
    (await waitFor(() => !fs.existsSync(orphanLogDir))) && jobMessages().length === reportsBeforeStop + 1;

const report = {
    commands: [...commands.keys()].sort(),
    toolNames: [...tools.keys()].sort(),
    webToolsOfferedAtLoad: webAccessTools.every((name) => activeAtLoad.includes(name)),
    webToolsHiddenAtStart:
        !webAccessTools.some((name) => activeAfterFirstStart.includes(name)) &&
        ["read", "bash", "edit", "write"].every((name) => activeAfterFirstStart.includes(name)),
    webToolsOfferedAfterOn: webAccessTools.every((name) => activeAfterOn.includes(name)),
    webToolsWithdrawnAfterOff: !webAccessTools.some((name) => activeAfterOff.includes(name)),
    startupPreferenceSaved,
    startupPreferenceReofferedOnResume: webAccessTools.every((name) => activeAfterResumeStart.includes(name)),
    unknownCapabilityRejected,
    unknownCapabilityChangedNothing: JSON.stringify(activeAfterUnknown) === JSON.stringify(activeAfterOff),
    headlessCapabilityRefused,
    headlessCapabilityChangedNothing: JSON.stringify(activeAfterHeadless) === JSON.stringify(activeAfterOff),
    uninstalledCapabilityReported,
    declinedCapabilityPrompted,
    declinedCapabilityWithheld,
    declinedCapabilityChangedNothing: JSON.stringify(activeAfterDecline) === JSON.stringify(activeAfterOff),
    grantedCapabilityActivated,
    grantedCapabilityOffered: webAccessTools.every((name) => activeAfterGrant.includes(name)),
    grantedCapabilityStayedAdditive: activeAfterOff.every((name) => activeAfterGrant.includes(name)),
    grantedCapabilitySyncedState,
    repeatedCapabilitySkippedPrompt,
    grantedBrowserActivated,
    grantedBrowserOffered: browserTools.every((name) => activeAfterBrowser.includes(name)),
    grantedBrowserStayedAdditive: activeBeforeBrowser.every((name) => activeAfterBrowser.includes(name)),
    grantedBrowserLeftWebWithdrawn: !webAccessTools.some((name) => activeAfterBrowser.includes(name)),
    capabilityPolicyRefusedHeadless,
    capabilityPolicyUnwrittenWhenHeadless,
    capabilityPolicySaved,
    standingCapabilitySkippedPrompt,
    standingCapabilityActivated,
    standingCapabilityOffered,
    standingCapabilityAnnounced,
    revokedCapabilityPromptedAgain,
    capabilityPolicyRejectedUnknown,
    capabilityPolicyStayedClean,
    nestedCwdOutOfScopeDenied,
    nestedCwdInScopeAllowed,
    denied,
    allowed,
    pendingRecorded: scopeState.pending.includes("outside.txt"),
    headlessAllowed,
    acceptClearedPending,
    acceptKeptScope,
    addWidenedScope,
    percentPathStayedCanonical,
    readSkippedSnapshots,
    uncertain,
    rechecked,
    taskBound,
    restoredRecordUnchanged,
    treeCleared,
    restoreRaceKeptRepositoryRoot,
    restoreRaceSurvived,
    capabilityRequestOfferedInteractive,
    capabilityRequestWithdrawnHeadless,
    capabilityRequestReofferedInteractive,
    backgroundWithdrawnWhenCommandsUnknown,
    backgroundRefusedWhenCommandsUnknown,
    backgroundOfferedWithoutGates,
    backgroundRefusedHeadless,
    backgroundStarted,
    backgroundReported,
    backgroundReportCarriesOutput,
    backgroundReportTriggersTurn,
    backgroundWithdrawnWithDefaultGuard,
    backgroundRefusedWithDefaultGuard,
    backgroundOfferedWithGuardSavedOff,
    backgroundRefusedWithGuardSavedOn,
    backgroundRefusedWithoutMapping,
    backgroundOfferedWithMapping,
    backgroundIgnoresUntrustedProject,
    backgroundRefusedWhenTrustedProjectRemaps,
    backgroundReadsCommentedConfig,
    backgroundStopReported,
    backgroundStopWaitsForNextTurn,
    backgroundEndsWithSession,
    longBashSteered,
    emittedScopeStatus: emitted.some((item) => item.name === "specpi:workflow-status"),
};
console.log("WORKFLOW_CONTROLS_HARNESS=" + JSON.stringify(report));
// On Windows a background job's process tree is killed asynchronously, and a dying `sleep` can hold
// the temporary tree for a moment after session end. The report above is already written, so
// cleanup retries and then gives up quietly rather than failing a passing harness over a temp dir.
try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
} catch {
    // The OS temp cleanup removes it later.
}

export default function workflowControlsHarness() {}
