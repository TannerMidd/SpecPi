import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import registerSpec from "../../extensions/spec.ts";
import { createTaskContract } from "../../extensions/workflow-controls/task-contract.mjs";

type Handler = (...args: any[]) => any;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-spec-task-harness-"));
const projectA = path.join(root, "project-a");
const projectB = path.join(root, "project-b");
fs.mkdirSync(path.join(projectA, "src"), { recursive: true });
fs.mkdirSync(path.join(projectB, "src"), { recursive: true });
fs.writeFileSync(path.join(projectA, "src", "app.ts"), "export const project = 'a';\n");
fs.writeFileSync(path.join(projectB, "src", "app.ts"), "export const project = 'b';\n");

const eventHandlers = new Map<string, Handler[]>();
const commands = new Map<string, any>();
const branches = {
    a: [] as any[],
    b: [] as any[],
};
let currentBranch = branches.a;
let deferRootLookups = false;
const deferredRootLookups: Array<{
    cwd: string;
    resolve: (result: { code: number; stdout: string; stderr: string }) => void;
}> = [];

const renderRequests: number[] = [];
const notifications: Array<{ message: string; level: string }> = [];
const statuses = new Map<string, string | undefined>();
let header: any;
let footer: any;
let widget: any;
let markdownTransformer: Handler | undefined;

const theme = {
    fg(_color: string, text: string) {
        return text;
    },
    bg(_color: string, text: string) {
        return text;
    },
    bold(text: string) {
        return text;
    },
};
const tui = {
    requestRender() {
        renderRequests.push(Date.now());
    },
};
const footerData = {
    onBranchChange() {
        return () => {};
    },
    getGitBranch() {
        return "fixture-branch";
    },
};

const ui: any = {
    theme,
    setStatus(key: string, value: string | undefined) {
        statuses.set(key, value);
    },
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    getToolsExpanded() {
        return true;
    },
    setToolsExpanded() {},
    setHeader(factory: any) {
        header = factory ? factory(tui, theme) : undefined;
    },
    setFooter(factory: any) {
        footer = factory ? factory(tui, theme, footerData) : undefined;
    },
    setWidget(key: string, factory: any) {
        if (key !== "spec-mode") {
            return;
        }

        widget = factory ? factory(tui, theme) : undefined;
    },
    notify(message: string, level: string) {
        notifications.push({ message, level });
    },
};

const pi: any = {
    on(name: string, handler: Handler) {
        const handlers = eventHandlers.get(name) ?? [];
        handlers.push(handler);
        eventHandlers.set(name, handlers);
    },
    registerCommand(name: string, command: any) {
        commands.set(name, command);
    },
    registerShortcut() {},
    registerMarkdownTransformer(transformer: Handler) {
        markdownTransformer = transformer;
    },
    appendEntry(customType: string, data: any) {
        currentBranch.push({ type: "custom", customType, data });
    },
    async exec(command: string, _args: string[], options: { cwd: string }) {
        if (command !== "git") {
            return { code: 1, stdout: "", stderr: "unsupported fixture command" };
        }

        if (deferRootLookups) {
            return new Promise((resolve) => {
                deferredRootLookups.push({
                    cwd: options.cwd,
                    resolve,
                });
            });
        }

        return { code: 0, stdout: `${options.cwd}\n`, stderr: "" };
    },
    events: {
        on(name: string, handler: Handler) {
            const handlers = eventHandlers.get(name) ?? [];
            handlers.push(handler);
            eventHandlers.set(name, handlers);
        },
        async emit(name: string, data?: any) {
            const handlers = eventHandlers.get(name) ?? [];
            const results = [];
            for (const handler of handlers) {
                results.push(await handler(data));
            }

            return results;
        },
    },
};

registerSpec(pi);

function context(branch: any[], cwd: string, sessionId: string) {
    return {
        cwd,
        mode: "tui",
        hasUI: true,
        model: { id: "spec-task-fixture-model" },
        getContextUsage: () => ({ percent: 22 }),
        sessionManager: {
            getBranch: () => branch,
            getSessionId: () => sessionId,
        },
        ui,
    } as any;
}

const ctxA = context(branches.a, projectA, "spec-task-session-a");
const ctxB = context(branches.b, projectB, "spec-task-session-b");

function appendTask(branch: any[], contract: any) {
    branch.push({
        type: "custom",
        customType: "specpi-task-contract",
        data: { kind: "set", contract },
    });
}

function appendClearedTask(branch: any[]) {
    branch.push({
        type: "custom",
        customType: "specpi-task-contract",
        data: { kind: "cleared", reason: "fixture cleared the current task" },
    });
}

function appendReview(branch: any[], contract: any, digest: string, statusesForRequirements: string[]) {
    branch.push({
        type: "custom",
        customType: "specpi-completion-challenge",
        data: {
            kind: "result",
            generation: "fixture-challenge-generation",
            facts: { taskContractDigest: digest },
            result: {
                requirements: contract.requirements.map((requirement: any, index: number) => ({
                    id: requirement.id,
                    status: statusesForRequirements[index] ?? "partial",
                })),
            },
        },
    });
}

function makeContract(rootPath: string, id: string, objective: string, requirementCount: number) {
    return createTaskContract(
        {
            objective,
            hypothesis: `The ${id} task can be displayed from the current branch`,
            requirements: Array.from({ length: requirementCount }, (_, index) => ({
                id: `R${index + 1}`,
                description: `Requirement ${index + 1} for ${id}`,
                acceptance: `Requirement ${index + 1} has direct evidence`,
            })),
            paths: ["src/app.ts"],
            rollback: "Remove the task card and restore the branch state",
        },
        { origin: "human", root: rootPath, id },
    );
}

function visibleDisplay() {
    const lines: string[] = [];
    if (header?.render) {
        lines.push(...header.render(120));
    }

    if (widget?.render) {
        lines.push(...widget.render(120));
    }

    if (footer?.render) {
        lines.push(...footer.render(120));
    }

    return lines.join("\n");
}

function latestStatusNotification() {
    return notifications.at(-1)?.message ?? "";
}

async function runHandlers(name: string, event: any, ctx: any) {
    for (const handler of eventHandlers.get(name) ?? []) {
        await handler(event, ctx);
    }
}

async function settle() {
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
}

function resolveDeferredLookup(cwd: string, newest = false) {
    const index = newest
        ? deferredRootLookups.findLastIndex((item) => item.cwd === cwd)
        : deferredRootLookups.findIndex((item) => item.cwd === cwd);
    if (index < 0) {
        throw new Error(`No deferred root lookup exists for ${cwd}`);
    }

    const [lookup] = deferredRootLookups.splice(index, 1);
    lookup.resolve({ code: 0, stdout: `${cwd}\n`, stderr: "" });
}

const spec = commands.get("spec");
if (!spec || !markdownTransformer) {
    throw new Error("Spec extension did not register its command and transformer");
}

let report;
try {
    currentBranch = branches.a;
    await runHandlers("session_start", {}, ctxA);
    await spec.handler("on", ctxA);
    const noCardDisplay = visibleDisplay();
    await spec.handler("status", ctxA);
    const noCardStatus = latestStatusNotification();

    const firstContract = makeContract(projectA, "task-card-a1", "Prove the first task contract", 2);
    appendTask(branches.a, firstContract);
    await pi.events.emit("specpi:task-contract-changed", { reason: "set" });
    await settle();
    const setDisplay = visibleDisplay();

    appendReview(branches.a, firstContract, firstContract.digest, ["proven", "partial"]);
    await pi.events.emit("specpi:workflow-status", { active: true, pending: 0, taskBound: true });
    await settle();
    const matchingReviewDisplay = visibleDisplay();

    appendReview(branches.a, firstContract, "f".repeat(64), ["proven", "proven"]);
    await pi.events.emit("specpi:workflow-status", { active: true, pending: 0, taskBound: true });
    await settle();
    const staleReviewDisplay = visibleDisplay();

    const revisedContract = makeContract(projectA, "task-card-a2", "Revise the first task card", 3);
    appendTask(branches.a, revisedContract);
    await pi.events.emit("specpi:task-contract-changed", { reason: "revise" });
    await settle();
    const revisedDisplay = visibleDisplay();

    appendReview(branches.a, revisedContract, revisedContract.digest, ["proven", "partial", "partial"]);
    await pi.events.emit("specpi:workflow-status", { active: true, pending: 0, taskBound: true });
    await settle();
    const revisedReviewDisplay = visibleDisplay();

    appendClearedTask(branches.a);
    await pi.events.emit("specpi:task-contract-changed", { reason: "clear" });
    await settle();
    const clearedDisplay = visibleDisplay();

    const staleContract = makeContract(projectA, "task-card-old-session", "Old session objective", 1);
    appendTask(branches.a, staleContract);
    appendTask(branches.b, makeContract(projectB, "task-card-b", "Session B objective", 1));
    deferRootLookups = true;
    currentBranch = branches.a;
    const pendingRefresh = pi.events.emit("specpi:task-contract-changed", { reason: "delayed-old-session" });
    await settle();
    currentBranch = branches.b;
    const sessionB = runHandlers("session_start", {}, ctxB);
    await settle();
    resolveDeferredLookup(projectB);
    await sessionB;
    resolveDeferredLookup(projectA);
    await pendingRefresh;
    await settle();
    await spec.handler("on", ctxB);
    const sessionSwitchDisplay = visibleDisplay();
    deferRootLookups = false;

    const treeSource: any[] = [{ type: "custom", customType: "spec-mode", data: { enabled: true } }];
    const treeDestination: any[] = [{ type: "custom", customType: "spec-mode", data: { enabled: true } }];
    const treeDisabled: any[] = [{ type: "custom", customType: "spec-mode", data: { enabled: false } }];
    const sourceContract = makeContract(projectB, "tree-source", "Tree source objective", 2);
    const destinationContract = makeContract(projectB, "tree-destination", "Tree destination objective", 3);
    appendTask(treeSource, sourceContract);
    appendReview(treeSource, sourceContract, sourceContract.digest, ["proven", "proven"]);
    appendTask(treeDestination, destinationContract);
    appendReview(treeDestination, destinationContract, destinationContract.digest, ["partial", "proven", "partial"]);
    const treeState = { branch: treeSource, cwd: projectB };
    let treeBranchReads = 0;
    const ctxTree: any = {
        ...context(treeSource, projectB, "spec-task-tree-session"),
        get cwd() {
            return treeState.cwd;
        },
        get sessionManager() {
            return {
                getBranch() {
                    treeBranchReads += 1;

                    return treeState.branch;
                },
                getSessionId: () => "spec-task-tree-session",
            };
        },
    };
    currentBranch = treeSource;
    await runHandlers("session_start", {}, ctxTree);
    await pi.events.emit("specpi:workflow-status", { active: true, pending: 1, taskBound: true });
    await settle();
    const treeSourceDisplay = visibleDisplay();
    const treeBranchSizes = [treeSource.length, treeDestination.length, treeDisabled.length];

    deferRootLookups = true;
    const pendingTreeRefresh = pi.events.emit("specpi:task-contract-changed", { reason: "delayed-old-tree" });
    await settle();
    treeState.branch = treeDestination;
    currentBranch = treeDestination;
    const pendingTreeRestore = runHandlers("session_tree", { oldLeafId: "source", newLeafId: "destination" }, ctxTree);
    const treeImmediateDisplay = visibleDisplay();
    await settle();
    resolveDeferredLookup(projectB, true);
    await pendingTreeRestore;
    const treeDestinationDisplay = visibleDisplay();
    const treeDestinationMode = markdownTransformer("tree response", {
        messageType: "assistant",
        isStreaming: true,
    });
    await pi.events.emit("specpi:workflow-status", { active: true, pending: 0 });
    const treeScopeDisplay = visibleDisplay();
    const treeReadsAfterRestore = treeBranchReads;
    resolveDeferredLookup(projectB);
    await pendingTreeRefresh;
    await settle();
    const treeAfterOldRefreshDisplay = visibleDisplay();
    const treeOldRefreshIgnored = treeBranchReads === treeReadsAfterRestore;
    deferRootLookups = false;

    treeState.branch = treeDisabled;
    currentBranch = treeDisabled;
    const pendingDisabledRestore = runHandlers(
        "session_tree",
        { oldLeafId: "destination", newLeafId: "disabled" },
        ctxTree,
    );
    const treeDisabledImmediateDisplay = visibleDisplay();
    await pendingDisabledRestore;
    const treeDisabledDisplay = visibleDisplay();
    const treeDisabledMode = markdownTransformer("tree response", {
        messageType: "assistant",
        isStreaming: true,
    });
    const treeDisabledStatusCleared = statuses.get("spec-mode") === undefined;

    treeState.branch = treeDestination;
    currentBranch = treeDestination;
    await runHandlers("session_tree", { oldLeafId: "disabled", newLeafId: "destination" }, ctxTree);
    const treeReenabledDisplay = visibleDisplay();
    const treeRestoreDidNotPersist = [treeSource.length, treeDestination.length, treeDisabled.length].every(
        (size, index) => size === treeBranchSizes[index],
    );

    appendTask(treeDestination, makeContract(projectB, "task-after-shutdown", "Unapplied shutdown objective", 1));
    deferRootLookups = true;
    const pendingShutdownRefresh = pi.events.emit("specpi:task-contract-changed", { reason: "delayed-shutdown" });
    await settle();
    await runHandlers("session_shutdown", {}, ctxTree);
    const branchReadsAfterShutdown = treeBranchReads;
    const rendersAfterShutdown = renderRequests.length;
    resolveDeferredLookup(projectB);
    await pendingShutdownRefresh;
    await settle();
    const shutdownRefreshIgnored = treeBranchReads === branchReadsAfterShutdown;
    const shutdownUiStayedClear =
        renderRequests.length === rendersAfterShutdown &&
        visibleDisplay() === "" &&
        statuses.get("spec-mode") === undefined;
    deferRootLookups = false;

    report = {
        noCardDisplay,
        noCardStatus,
        setDisplay,
        matchingReviewDisplay,
        staleReviewDisplay,
        revisedDisplay,
        revisedReviewDisplay,
        clearedDisplay,
        sessionSwitchDisplay,
        treeSourceDisplay,
        treeImmediateDisplay,
        treeDestinationDisplay,
        treeDestinationMode,
        treeScopeDisplay,
        treeAfterOldRefreshDisplay,
        treeOldRefreshIgnored,
        treeDisabledImmediateDisplay,
        treeDisabledDisplay,
        treeDisabledMode,
        treeDisabledStatusCleared,
        treeReenabledDisplay,
        treeRestoreDidNotPersist,
        shutdownRefreshIgnored,
        shutdownUiStayedClear,
        status: statuses.get("spec-mode"),
        renderRequests: renderRequests.length,
        branchSizes: {
            a: branches.a.length,
            b: branches.b.length,
        },
    };
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write(`SPEC_TASK_HARNESS=${JSON.stringify(report)}\n`);

export default function specTaskHarness() {}
