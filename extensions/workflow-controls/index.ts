import path from "node:path";
import {
    SettingsManager,
    createLocalBashOperations,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
    CAPABILITY_NAMES,
    CAPABILITY_REQUEST_TOOL,
    capabilityActive,
    capabilityInstalled,
    capabilityRequestOffered,
    describeCapabilities,
    findCapability,
    missingTools,
} from "./capabilities.mjs";
import { allowCapability, askCapability, autoAllowed, loadAutoAllowed, policyPath } from "./capability-policy.mjs";
import {
    BACKGROUND_MESSAGE,
    BACKGROUND_STATUS,
    BACKGROUND_TOOL,
    BACKGROUND_WIDGET,
    admission as backgroundAdmissionFor,
    agentDirectory as backgroundAgentDirectory,
    completionText,
    createJobManager,
    effectiveShellMapping,
    guardEnabled,
    listText,
    pruneStaleLogs,
    sessionLogDir,
    startedText,
    statusText,
    tailOf,
    widgetPayload,
    blockingShellCall,
    blockingShellReason,
} from "./background.mjs";
import {
    canonicalRoot,
    compareWorktreeSnapshots,
    createWorktreeSnapshot,
    normalizeScopeEntries,
    relativeMutationPath,
    sanitizePathLabel,
    scopeMatches,
} from "./scope.mjs";

import { readTaskContract, renderTaskContract } from "./task-contract.mjs";
import {
    WEB_TOOL_NAMES,
    loadStartupActivation,
    saveStartupActivation,
    settingsPath,
    syncActiveTools as syncToolGroup,
} from "./web-access.mjs";
const SCOPE_ENTRY = "specpi-scope-state";
const SCOPE_STATUS = "specpi-scope";
const MAX_PENDING_SCOPE = 40;
const READ_ONLY_TOOLS = new Set(["read"]);
interface ScopeItem {
    path: string;
    directory: boolean;
}

interface ScopeState {
    active: boolean;
    root: string;
    entries: ScopeItem[];
    pending: string[];
    observed: string[];
    indeterminate: boolean;
    generation: number;
    taskDigest?: string;
}

function validScopeEntry(value: any): value is ScopeItem {
    return (
        value &&
        typeof value.path === "string" &&
        value.path.length > 0 &&
        typeof value.directory === "boolean" &&
        !path.isAbsolute(value.path) &&
        !value.path.split(/[\\/]/u).includes("..")
    );
}

function emptyScope(root: string): ScopeState {
    return {
        active: false,
        root,
        entries: [],
        pending: [],
        observed: [],
        indeterminate: false,
        generation: 0,
        taskDigest: undefined,
    };
}

function safeMessage(error: unknown) {
    return (error instanceof Error ? error.message : String(error))
        .replace(/[\u0000-\u001f\u007f]+/gu, " ")
        .slice(0, 500);
}

export default function workflowControls(pi: ExtensionAPI) {
    let scope = emptyScope(canonicalRoot(process.cwd()));
    let latestTaskContract: any | undefined;
    let taskContractError: string | undefined;
    let latestSnapshot: any;
    let sessionGeneration = 0;
    const snapshots = new Map<string, any>();

    const resolveRoot = async (cwd: string) => {
        try {
            const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 15_000 });
            if (result.code === 0 && typeof result.stdout === "string" && result.stdout.trim()) {
                return canonicalRoot(path.resolve(cwd, result.stdout.trim()));
            }
        } catch {
            /* A non-Git session still supports direct write/edit scope checks. */
        }

        return canonicalRoot(cwd);
    };

    const branchEntries = (ctx: ExtensionContext) => ctx.sessionManager.getBranch?.() ?? [];

    // Pi contexts expose the live session through getters. Retaining `ctx` across an await does not retain its
    // original branch, and /tree can change that branch without reloading this extension or changing its session ID.
    const captureSession = (ctx: ExtensionContext) => ({
        generation: sessionGeneration,
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
    });
    const sessionIsCurrent = (origin: ReturnType<typeof captureSession>, ctx: ExtensionContext) =>
        origin.generation === sessionGeneration &&
        origin.cwd === ctx.cwd &&
        origin.sessionId === ctx.sessionManager.getSessionId();

    const readCurrentTaskContract = (ctx: ExtensionContext, root: string) => {
        const current = readTaskContract(branchEntries(ctx), root);
        taskContractError = undefined;

        return current;
    };

    const refreshTaskContract = (ctx: ExtensionContext, root: string) => {
        latestTaskContract = readCurrentTaskContract(ctx, root);
        emitScopeStatus(ctx);

        return latestTaskContract;
    };

    const emitScopeStatus = (ctx: ExtensionContext, { taskReviewChanged = false } = {}) => {
        const taskStale = scope.taskDigest !== undefined && latestTaskContract?.digest !== scope.taskDigest;
        const summary = scope.active
            ? {
                  active: true,
                  pending: scope.pending.length,
                  entries: scope.entries.length,
                  indeterminate: scope.indeterminate,
                  taskBound: scope.taskDigest !== undefined,
                  taskStale,
              }
            : { active: false, pending: 0, entries: 0, indeterminate: false, taskBound: false, taskStale: false };
        pi.events.emit("specpi:workflow-status", {
            ...summary,
            generation: scope.generation,
            ...(taskReviewChanged ? { taskReviewChanged: true } : {}),
        });
        if (!scope.active) {
            ctx.ui.setStatus(SCOPE_STATUS, undefined);
            ctx.ui.setWidget(SCOPE_STATUS, undefined);

            return;
        }

        const label = scope.pending.length > 0 || scope.indeterminate || taskStale ? "scope: review" : "scope: clean";
        ctx.ui.setStatus(SCOPE_STATUS, label);
        ctx.ui.setWidget(SCOPE_STATUS, (_tui, theme) => ({
            invalidate() {},
            render(width: number): string[] {
                const pending = scope.pending.length > 0 ? ` · ${scope.pending.length} pending` : "";
                const uncertain = scope.indeterminate ? " · snapshot uncertain" : "";
                const stale = taskStale ? " · task stale" : "";

                return [
                    truncateToWidth(
                        theme.fg(
                            scope.pending.length > 0 || scope.indeterminate ? "warning" : "dim",
                            `scope · ${scope.entries.length} paths · ${scope.observed.length} changed${pending}${uncertain}${stale}`,
                        ),
                        width,
                        "",
                    ),
                ];
            },
        }));
    };

    // A branch entry is a record of what scope looked like at one moment. Handing `appendEntry` the live arrays would
    // let a later `push` or in-place edit rewrite entries that were already appended, so every array is copied here.
    const persistScope = (ctx: ExtensionContext) => {
        pi.appendEntry(SCOPE_ENTRY, {
            active: scope.active,
            root: scope.root,
            entries: scope.entries.map((item) => ({ ...item })),
            pending: [...scope.pending],
            observed: [...scope.observed],
            indeterminate: scope.indeterminate,
            generation: scope.generation,
            taskDigest: scope.taskDigest,
        });
        emitScopeStatus(ctx);
    };

    const addPending = (rawPaths: string[], ctx: ExtensionContext) => {
        let changed = false;
        // Keep canonical Git paths internally so matching, acknowledgement, and scope expansion refer to the real file.
        // Escape only at a display boundary; storing the escaped label would turn `100%.md` into a different path.
        for (const relativePath of rawPaths) {
            if (scopeMatches(scope.entries, relativePath) || scope.pending.includes(relativePath)) {
                continue;
            }

            if (scope.pending.length < MAX_PENDING_SCOPE) {
                scope.pending.push(relativePath);
                changed = true;
            } else if (!scope.indeterminate) {
                // Dropping a finding on the floor is itself uncertainty, so it has to reach the branch record and not
                // just the widget; otherwise a resumed session looks cleaner than the observation actually was.
                scope.indeterminate = true;
                changed = true;
            }
        }

        if (changed) {
            scope.pending.sort();
            scope.generation += 1;
            persistScope(ctx);
        } else {
            emitScopeStatus(ctx);
        }
    };

    const takeSnapshot = async () => {
        if (!scope.active) {
            return undefined;
        }

        const generation = sessionGeneration;
        const root = scope.root;
        try {
            const result = await pi.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
                cwd: root,
                timeout: 30_000,
            });
            if (generation !== sessionGeneration) {
                return undefined;
            }

            if (result.code !== 0 || typeof result.stdout !== "string") {
                // A failed status leaves no trustworthy baseline, so the next tool must observe the worktree afresh
                // rather than diffing against a snapshot taken before the gap.
                latestSnapshot = undefined;

                return { root, paths: [], fingerprints: {}, indeterminate: true };
            }

            const snapshot = createWorktreeSnapshot(root, result.stdout);
            latestSnapshot = snapshot;

            return snapshot;
        } catch {
            if (generation !== sessionGeneration) {
                return undefined;
            }

            latestSnapshot = undefined;

            return { root, paths: [], fingerprints: {}, indeterminate: true };
        }
    };

    // Each snapshot hashes every changed file, so recomputing a "before" that is byte-for-byte the "after" of the tool
    // that just finished doubles the cost of an already expensive check for nothing. Nothing but a tool runs in
    // between, so the previous result is the current baseline until scope itself changes.
    const baselineSnapshot = async () => {
        if (latestSnapshot && latestSnapshot.root === scope.root) {
            return latestSnapshot;
        }

        return takeSnapshot();
    };

    const setScopeEntries = (entries: ScopeItem[], ctx: ExtensionContext, options: { taskDigest?: string } = {}) => {
        if (entries.length === 0 || entries.length > 40) {
            throw new Error("Scope must contain between 1 and 40 paths");
        }

        scope.active = true;
        scope.entries = entries;
        if (options.taskDigest !== undefined) {
            scope.taskDigest = options.taskDigest;
        } else {
            scope.taskDigest = undefined;
            scope.pending = scope.pending.filter((item) => !scopeMatches(entries, item));
        }

        scope.generation += 1;
        latestSnapshot = undefined;
        persistScope(ctx);
    };

    // Restore empties scope first and only learns the real root once `git rev-parse` returns, so between those two
    // moments `scope.root` is a guess at the session cwd: not yet canonical, and not yet the enclosing repository.
    // A human command that declared scope in that gap recorded it under the guessed root, and the replay below then
    // rejected its own branch entry as belonging elsewhere, silently retiring a contract the human was told was set.
    // Scope commands therefore wait for `sessionRestore` rather than racing it.
    const restoreSession = async (ctx: ExtensionContext) => {
        sessionGeneration += 1;
        const origin = captureSession(ctx);
        // Retire armed prompts synchronously, before root lookup can yield to a tool call or another branch change.
        scope = emptyScope(path.resolve(origin.cwd));
        latestTaskContract = undefined;
        taskContractError = undefined;
        latestSnapshot = undefined;
        snapshots.clear();
        emitScopeStatus(ctx);

        const root = await resolveRoot(origin.cwd);
        if (!sessionIsCurrent(origin, ctx)) {
            return;
        }

        scope = emptyScope(root);

        for (const entry of ctx.sessionManager.getBranch?.() ?? []) {
            if (entry.type !== "custom") {
                continue;
            }

            if (entry.customType === SCOPE_ENTRY) {
                const data = entry.data as any;
                if (
                    data?.active === true &&
                    data.root === root &&
                    Array.isArray(data.entries) &&
                    data.entries.length > 0 &&
                    data.entries.length <= 40 &&
                    data.entries.every(validScopeEntry)
                ) {
                    scope = {
                        active: true,
                        root,
                        // Copy on the way in as well as on the way out: a later `push` from /scope add would otherwise
                        // mutate the branch entry this state was restored from.
                        entries: data.entries.map((item: ScopeItem) => ({ ...item })),
                        pending: Array.isArray(data.pending)
                            ? data.pending.filter((item: any) => typeof item === "string").slice(0, MAX_PENDING_SCOPE)
                            : [],
                        observed: Array.isArray(data.observed)
                            ? data.observed.filter((item: any) => typeof item === "string").slice(0, 256)
                            : [],
                        indeterminate: Boolean(data.indeterminate),
                        generation: Number.isInteger(data.generation) ? data.generation : 0,
                        taskDigest: typeof data.taskDigest === "string" ? data.taskDigest : undefined,
                    };
                } else if (data?.active === false) {
                    scope = emptyScope(root);
                }
            }
        }

        try {
            latestTaskContract = readCurrentTaskContract(ctx, root);
        } catch (error) {
            taskContractError = safeMessage(error);
            ctx.ui.notify(`Task contract unavailable: ${taskContractError}`, "error");
        }

        emitScopeStatus(ctx);
    };

    let sessionRestore: Promise<void> = Promise.resolve();
    const beginRestore = (ctx: ExtensionContext) => {
        // Waiters only need to know the restore is over; restoreSession reports its own failures.
        sessionRestore = restoreSession(ctx).catch(() => {});
    };

    // Serve the active contract structurally, independent of before_agent_start load order.
    // The advisor receives only the objective, never a branch transcript or rendered headings.
    pi.events.on("specpi:task-objective", (request: any) => {
        request.reply(
            (async () => {
                const ctx = request.ctx as ExtensionContext;
                const origin = captureSession(ctx);
                await sessionRestore;
                if (!sessionIsCurrent(origin, ctx)) {
                    return undefined;
                }

                try {
                    const contract = readCurrentTaskContract(ctx, scope.root);

                    return contract ? { objective: contract.objective, digest: contract.digest } : undefined;
                } catch {
                    return undefined;
                }
            })(),
        );
    });

    // Decided once per session, before the first request, so the cached prompt prefix is never
    // disturbed. See capabilityRequestOffered for why a session may not need the tool at all.
    const applyCapabilityRequest = (ctx: ExtensionContext) => {
        const allToolNames = typeof pi.getAllTools === "function" ? pi.getAllTools().map((tool) => tool.name) : [];
        syncToolGroup(
            pi,
            [CAPABILITY_REQUEST_TOOL],
            capabilityRequestOffered({ interactive: ctx.hasUI, allToolNames }),
        );
    };

    // Web access ships hidden. A missing or unreadable preference means off, and the
    // gate only ever touches its own four tool names.
    let webAccessEnabled = loadStartupActivation();
    const applyWebAccess = () => syncToolGroup(pi, WEB_TOOL_NAMES, webAccessEnabled);

    // Background jobs. The admission rules live in background.mjs and are re-checked at every start;
    // the tool is only offered to a session where a start could succeed, decided before the first
    // request so the cached prompt prefix is never disturbed.
    let jobs: ReturnType<typeof createJobManager> | undefined;
    let jobsContext: ExtensionContext | undefined;
    const hasCommand = (names: string[] | undefined, name: string) =>
        names?.some((entry) => entry === name || entry.startsWith(`${name}:`)) === true;
    const backgroundAdmission = (ctx: ExtensionContext, running = 0) => {
        let names: string[] | undefined;
        try {
            names =
                typeof pi.getCommands === "function" ? pi.getCommands().map((command: any) => command.name) : undefined;
        } catch {
            names = undefined;
        }

        const trusted = typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted() === true;
        const permissionInstalled = hasCommand(names, "permission-system");
        let mapping;
        let mappingError;
        if (permissionInstalled) {
            try {
                mapping = effectiveShellMapping({ agentDir: backgroundAgentDirectory(), cwd: ctx.cwd, trusted });
            } catch (error) {
                mappingError = safeMessage(error);
            }
        }

        return backgroundAdmissionFor({
            interactive: ctx.hasUI === true,
            commandsKnown: names !== undefined,
            guardInstalled: hasCommand(names, "jev-guard"),
            guard: guardEnabled({ cwd: ctx.cwd, trusted }),
            permissionInstalled,
            mapping,
            mappingError,
            running,
        });
    };

    const publishJobStatus = () => {
        try {
            const all = jobs?.list() ?? [];
            jobsContext?.ui.setStatus(BACKGROUND_STATUS, statusText(all));
            // Chat's jobs panel. A terminal would draw a widget as text above the editor, so only RPC gets it.
            if (jobsContext?.mode === "rpc") {
                jobsContext.ui.setWidget(BACKGROUND_WIDGET, all.length > 0 ? [widgetPayload(all)] : undefined);
            }
        } catch {
            // A status line is a courtesy; a closed UI must not fail the job.
        }
    };

    const reportJob = (job: any) => {
        publishJobStatus();
        // A job the user stopped is news for the next prompt, not a reason to start a turn.
        const stoppedByUser = job.state === "stopped" && job.stoppedBy === "user";
        pi.sendMessage(
            {
                customType: BACKGROUND_MESSAGE,
                content: completionText(job),
                display: true,
                details: { id: job.id, state: job.state, exitCode: job.exitCode, logPath: job.logPath },
            },
            stoppedByUser ? { deliverAs: "nextTurn" } : { triggerTurn: true, deliverAs: "followUp" },
        );
    };

    // Pi's own local runner, with the session's shell settings, so a job starts exactly as `bash`
    // would run it and its process tree is cleaned up the same way when Pi exits.
    const runJob = (command: string, cwd: string, options: any) => {
        const settings = SettingsManager.create(cwd, backgroundAgentDirectory());
        const prefix = settings.getShellCommandPrefix();

        return createLocalBashOperations({ shellPath: settings.getShellPath() }).exec(
            prefix ? `${prefix}\n${command}` : command,
            cwd,
            options,
        );
    };

    const endJobs = () => {
        jobs?.close();
        jobs = undefined;
        publishJobStatus();
    };

    pi.on("session_start", (_event, ctx) => {
        webAccessEnabled = loadStartupActivation();
        applyWebAccess();
        applyCapabilityRequest(ctx);
        endJobs();
        jobsContext = ctx;
        pruneStaleLogs();
        syncToolGroup(pi, [BACKGROUND_TOOL], backgroundAdmission(ctx).ok);
        beginRestore(ctx);
    });

    pi.on("session_tree", (_event, ctx) => beginRestore(ctx));

    pi.on("session_shutdown", (_event, ctx) => {
        endJobs();
        jobsContext = undefined;
        sessionGeneration += 1;
        snapshots.clear();
        latestSnapshot = undefined;
        latestTaskContract = undefined;
        taskContractError = undefined;
        ctx.ui.setStatus(SCOPE_STATUS, undefined);
        ctx.ui.setWidget(SCOPE_STATUS, undefined);
    });

    pi.on("tool_execution_start", async (event: any) => {
        if (!scope.active || READ_ONLY_TOOLS.has(event.toolName)) {
            return;
        }

        const generation = sessionGeneration;
        const snapshot = await baselineSnapshot();
        if (generation === sessionGeneration) {
            snapshots.set(event.toolCallId, snapshot);
        }
    });

    // A bash call that would hold the conversation while it waits is refused whenever a background job
    // could run it instead, so the user can keep talking. Guidance alone was not enough: the agent
    // kept polling CI with sleep loops in bash while the background tool sat unused.
    pi.on("tool_call", async (event: any, ctx) => {
        if (event.toolName !== "bash" || ctx.hasUI !== true) {
            return;
        }

        const active = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
        if (!active.includes(BACKGROUND_TOOL)) {
            return;
        }

        const why = blockingShellCall(event.input);

        return why ? { block: true, reason: blockingShellReason(why) } : undefined;
    });

    pi.on("tool_call", async (event: any, ctx) => {
        if (!scope.active || (event.toolName !== "write" && event.toolName !== "edit")) {
            return;
        }

        if (!event.input || typeof event.input.path !== "string") {
            return;
        }

        let relativePath;
        try {
            relativePath = relativeMutationPath(scope.root, event.input.path, { cwd: ctx.cwd });
        } catch (error) {
            return { block: true, reason: `Scope path rejected: ${safeMessage(error)}` };
        }

        if (scopeMatches(scope.entries, relativePath)) {
            return;
        }

        const originalPath = event.input.path;
        const generation = scope.generation;
        const origin = captureSession(ctx);
        if (!ctx.hasUI) {
            addPending([relativePath], ctx);

            return;
        }

        const answer = await ctx.ui.select(`Outside declared scope: ${relativePath}`, [
            "Deny this call (Recommended)",
            "Allow once without expanding scope",
            "Add this path to scope and allow",
        ]);
        if (!sessionIsCurrent(origin, ctx) || generation !== scope.generation || event.input.path !== originalPath) {
            return { block: true, reason: "Scope state or tool input changed during acknowledgement" };
        }

        if (answer === "Allow once without expanding scope") {
            addPending([relativePath], ctx);

            return;
        }

        if (answer === "Add this path to scope and allow") {
            if (scope.entries.length >= 40) {
                return { block: true, reason: "Scope already contains the maximum of 40 paths" };
            }

            const entry = normalizeScopeEntries(scope.root, [relativePath])[0];
            setScopeEntries([...scope.entries, entry], ctx);

            return;
        }

        return { block: true, reason: `Mutation outside declared scope denied: ${relativePath}` };
    });

    pi.on("tool_result", async (event: any, ctx) => {
        if (!scope.active) {
            return;
        }

        if (READ_ONLY_TOOLS.has(event.toolName)) {
            return;
        }

        const before = snapshots.get(event.toolCallId);
        snapshots.delete(event.toolCallId);
        if (!before) {
            scope.indeterminate = true;
            persistScope(ctx);

            return;
        }

        const origin = captureSession(ctx);
        const after = await takeSnapshot();
        if (!sessionIsCurrent(origin, ctx)) {
            return;
        }

        const comparison = compareWorktreeSnapshots(before, after, scope.entries);
        if (comparison.indeterminate) {
            scope.indeterminate = true;
            persistScope(ctx);

            return;
        }

        const observed = [...new Set([...scope.observed, ...comparison.changed])].sort().slice(0, 256);
        const observedGrew = observed.length !== scope.observed.length;
        scope.observed = observed;
        if (comparison.outside.length === 0) {
            if (observedGrew) {
                persistScope(ctx);
            } else {
                emitScopeStatus(ctx);
            }

            return;
        }

        addPending(comparison.outside, ctx);
        const warning = `SpecPi scope warning: mutation outside declared scope is pending acknowledgement: ${comparison.outside.slice(0, 8).map(sanitizePathLabel).join(", ")}. The human can run /scope accept <path> to acknowledge it without widening scope, /scope add <path> to widen scope, or /scope clear.`;

        return { content: [...event.content, { type: "text", text: warning }] };
    });

    pi.on("before_agent_start", async (event, ctx) => {
        const origin = captureSession(ctx);
        const guidance = [];
        let currentTask;
        try {
            const root = await resolveRoot(origin.cwd);
            if (!sessionIsCurrent(origin, ctx)) {
                return;
            }

            currentTask = refreshTaskContract(ctx, root);
        } catch (error) {
            if (!sessionIsCurrent(origin, ctx)) {
                return;
            }

            taskContractError = safeMessage(error);
        }

        if (currentTask) {
            guidance.push(`[SPECPI TASK CONTRACT]\n${renderTaskContract(currentTask)}`);
        } else if (taskContractError) {
            guidance.push(`[SPECPI TASK CONTRACT]\nUnavailable: ${taskContractError}`);
        }

        if (scope.active) {
            const taskStale = scope.taskDigest !== undefined && currentTask?.digest !== scope.taskDigest;
            guidance.push(
                `[SPECPI SCOPE]\nDeclared paths: ${scope.entries.map((item) => `${sanitizePathLabel(item.path)}${item.directory ? "/" : ""}`).join(", ")}\nPending outside-scope paths: ${scope.pending.map(sanitizePathLabel).join(", ") || "none"}. Keep outside-scope findings pending until the human allows once, acknowledges them with /scope accept, expands scope with /scope add, or clears it. Acknowledgement does not widen scope, and pending paths are not accepted scope.${taskStale ? "\nTask-bound scope is stale; do not widen it automatically." : ""}`,
            );
        }

        if (guidance.length === 0) {
            return;
        }

        return { systemPrompt: `${event.systemPrompt}\n\n${guidance.join("\n\n")}` };
    });

    pi.registerCommand("scope", {
        description: "Declare expected project paths and review scope drift",
        getArgumentCompletions: (prefix: string) =>
            ["set", "task", "add", "remove", "accept", "recheck", "status", "clear"]
                .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
                .map((value) => ({ value, label: value })),
        handler: async (args, ctx) => {
            // Read scope only after any restore in flight has settled: before that, both the default action and the
            // root every branch below records are taken from a provisional, pre-Git-lookup guess.
            await sessionRestore;
            const origin = captureSession(ctx);
            const [actionRaw, ...rest] = args.trim().split(/\s+/u).filter(Boolean);
            const action = actionRaw?.toLowerCase() || (scope.active ? "status" : "set");
            const requestedPath = rest.join(" ");
            try {
                if (action === "task") {
                    const root = await resolveRoot(origin.cwd);
                    if (!sessionIsCurrent(origin, ctx)) {
                        return;
                    }

                    const contract = refreshTaskContract(ctx, root);
                    if (!contract) {
                        ctx.ui.notify("No task contract is active for this project.", "error");

                        return;
                    }

                    if (contract.paths.length === 0) {
                        ctx.ui.notify("The active task contract declares no importable paths.", "error");

                        return;
                    }

                    const entries = normalizeScopeEntries(root, contract.paths);
                    setScopeEntries(entries, ctx, { taskDigest: contract.digest });
                    ctx.ui.notify(
                        `Scope imported from task ${contract.id.slice(0, 8)}. Existing pending findings were preserved; run /scope status to review them.`,
                        scope.pending.length > 0 ? "warning" : "info",
                    );

                    return;
                }

                if (action === "status") {
                    const root = await resolveRoot(origin.cwd);
                    if (!sessionIsCurrent(origin, ctx)) {
                        return;
                    }

                    refreshTaskContract(ctx, root);
                    const taskStale = scope.taskDigest !== undefined && latestTaskContract?.digest !== scope.taskDigest;
                    ctx.ui.notify(
                        scope.active
                            ? `Scope: ${scope.entries.map((item) => `${sanitizePathLabel(item.path)}${item.directory ? "/" : ""}`).join(", ")}; pending: ${scope.pending.map(sanitizePathLabel).join(", ") || "none"}; snapshot: ${scope.indeterminate ? "indeterminate" : "observed"}; task binding: ${scope.taskDigest ? (taskStale ? "stale" : "current") : "manual"}.`
                            : "Scope monitoring is inactive.",
                        scope.pending.length > 0 || scope.indeterminate || taskStale ? "warning" : "info",
                    );

                    return;
                }

                if (action === "clear") {
                    const root = await resolveRoot(origin.cwd);
                    if (!sessionIsCurrent(origin, ctx)) {
                        return;
                    }

                    scope = emptyScope(root);
                    scope.generation += 1;
                    // Nothing is observed while scope is off, so the cached baseline is stale the moment it is cleared;
                    // reactivating later must start from a fresh snapshot rather than blame the unmonitored gap on the
                    // first tool that runs afterwards.
                    latestSnapshot = undefined;
                    persistScope(ctx);
                    ctx.ui.notify("Scope monitoring cleared.", "info");

                    return;
                }

                if (action === "set") {
                    if (!ctx.hasUI || typeof ctx.ui.editor !== "function") {
                        ctx.ui.notify("/scope set requires interactive editor support.", "error");

                        return;
                    }

                    const initial = scope.entries
                        .map((item) => `${sanitizePathLabel(item.path)}${item.directory ? "/" : ""}`)
                        .join("\n");
                    const edited = await ctx.ui.editor("Scope paths — one project-relative path per line", initial);
                    if (!sessionIsCurrent(origin, ctx) || edited === undefined) {
                        return;
                    }

                    const inputs = edited
                        .split("\n")
                        .map((line) => line.trim())
                        .filter(Boolean)
                        .map((input) => {
                            const existing = scope.entries.find(
                                (item) => `${sanitizePathLabel(item.path)}${item.directory ? "/" : ""}` === input,
                            );

                            return existing ? `${existing.path}${existing.directory ? "/" : ""}` : input;
                        });
                    setScopeEntries(normalizeScopeEntries(scope.root, inputs), ctx);
                    ctx.ui.notify("Scope contract updated.", "info");

                    return;
                }

                if (action === "recheck") {
                    if (!scope.active) {
                        ctx.ui.notify("Scope monitoring is inactive.", "error");

                        return;
                    }

                    // Uncertainty is sticky on purpose, so clearing it has to be a deliberate human act rather than a
                    // side effect of the next successful comparison. Re-baselining here is that act.
                    latestSnapshot = undefined;
                    const rebaselined = await takeSnapshot();
                    if (!sessionIsCurrent(origin, ctx)) {
                        return;
                    }

                    scope.indeterminate = Boolean(rebaselined?.indeterminate);
                    scope.generation += 1;
                    persistScope(ctx);
                    ctx.ui.notify(
                        scope.indeterminate
                            ? "Scope re-baselined but the worktree snapshot is still indeterminate."
                            : "Scope re-baselined; snapshot uncertainty cleared. Pending findings are unchanged.",
                        scope.indeterminate ? "warning" : "info",
                    );

                    return;
                }

                if (!["add", "accept", "remove"].includes(action) || !requestedPath) {
                    ctx.ui.notify(
                        "Usage: /scope [set|add <path>|remove <path>|accept <path>|recheck|status|clear]",
                        "error",
                    );

                    return;
                }

                const displayedPending = scope.pending.find((item) => sanitizePathLabel(item) === requestedPath);
                const displayedEntry = scope.entries.find(
                    (item) => `${sanitizePathLabel(item.path)}${item.directory ? "/" : ""}` === requestedPath,
                );
                const sourcePath =
                    action === "remove" && displayedEntry
                        ? `${displayedEntry.path}${displayedEntry.directory ? "/" : ""}`
                        : (displayedPending ?? requestedPath);
                const normalized =
                    action === "accept" && displayedPending !== undefined
                        ? { path: displayedPending, directory: false }
                        : normalizeScopeEntries(scope.root, [sourcePath])[0];
                if (action === "remove") {
                    const before = scope.entries.length;
                    scope.entries = scope.entries.filter(
                        (item) => item.path !== normalized.path || item.directory !== normalized.directory,
                    );
                    if (before === scope.entries.length) {
                        ctx.ui.notify(`${sanitizePathLabel(normalized.path)} is not a declared scope path.`, "error");

                        return;
                    }

                    const deactivated = scope.entries.length === 0;
                    if (deactivated) {
                        scope = emptyScope(scope.root);
                    } else {
                        scope.taskDigest = undefined;
                    }

                    scope.generation += 1;
                    latestSnapshot = undefined;
                    persistScope(ctx);
                    ctx.ui.notify(
                        deactivated
                            ? `${sanitizePathLabel(normalized.path)} removed; it was the last declared path, so scope monitoring is now off and pending findings were discarded.`
                            : `${sanitizePathLabel(normalized.path)} removed from declared scope.`,
                        deactivated ? "warning" : "info",
                    );

                    return;
                }

                // `accept` acknowledges one observed finding and nothing more. Widening the contract is what `add` is
                // for, and conflating them would expand scope on the very gesture meant to review a drift report.
                if (action === "accept") {
                    if (!scope.active) {
                        ctx.ui.notify("Scope monitoring is inactive.", "error");

                        return;
                    }

                    const before = scope.pending.length;
                    scope.pending = scope.pending.filter((item) => !scopeMatches([normalized], item));
                    if (before === scope.pending.length) {
                        ctx.ui.notify(`${sanitizePathLabel(normalized.path)} has no pending scope finding.`, "error");

                        return;
                    }

                    scope.generation += 1;
                    persistScope(ctx);
                    ctx.ui.notify(
                        `${sanitizePathLabel(normalized.path)} acknowledged. The declared scope is unchanged, so a later change there is reported again.`,
                        "info",
                    );

                    return;
                }

                if (
                    !scope.entries.some(
                        (item) => item.path === normalized.path && item.directory === normalized.directory,
                    )
                ) {
                    if (scope.entries.length >= 40) {
                        throw new Error("Scope already contains the maximum of 40 paths");
                    }

                    scope.entries.push(normalized);
                }

                scope.active = true;
                scope.taskDigest = undefined;
                scope.pending = scope.pending.filter((item) => !scopeMatches([normalized], item));
                scope.generation += 1;
                persistScope(ctx);
                ctx.ui.notify(`${sanitizePathLabel(normalized.path)} added to declared scope.`, "info");
            } catch (error) {
                ctx.ui.notify(safeMessage(error), "error");
            }
        },
    });

    pi.registerCommand("webaccess", {
        description: "Offer or withdraw the web access tools, or choose whether they start offered",
        getArgumentCompletions: (prefix: string) =>
            ["on", "off", "status", "startup", "startup on", "startup off"]
                .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
                .map((value) => ({ value, label: value })),
        handler: async (args: string, ctx: ExtensionContext) => {
            const [action = "status", choice, ...rest] = args.trim().split(/\s+/u).filter(Boolean);
            if (rest.length || (choice && action.toLowerCase() !== "startup")) {
                throw new Error("Usage: /webaccess [on|off|status|startup [on|off]]");
            }

            const verb = action.toLowerCase();
            if (verb === "on" || verb === "off") {
                webAccessEnabled = verb === "on";
                applyWebAccess();
                ctx.ui.notify(
                    webAccessEnabled
                        ? `Web access offered ${WEB_TOOL_NAMES.length} tools to this session (web_search, source_check, fetch_content, get_search_content). They add about 11 KB of tool schema to each request until /webaccess off.`
                        : "Web access withdrew its tools from this session. Search and fetch now require /webaccess on.",
                    "info",
                );

                return;
            }

            if (verb === "startup") {
                if (!choice) {
                    ctx.ui.notify(
                        `Web access starts ${loadStartupActivation() ? "offered" : "withdrawn"}. Preference: ${settingsPath()}`,
                        "info",
                    );

                    return;
                }

                if (!ctx.hasUI) {
                    throw new Error("Startup changes require a human interactive command");
                }

                if (!["on", "off"].includes(choice.toLowerCase())) {
                    throw new Error("Usage: /webaccess startup [on|off]");
                }

                saveStartupActivation(choice.toLowerCase() === "on");
                ctx.ui.notify(
                    choice.toLowerCase() === "on"
                        ? "Web access tools will be offered in new Pi sessions, adding their schemas to every request. This session is unchanged."
                        : "Web access tools will start withdrawn in new Pi sessions and their schemas will not be sent. This session is unchanged.",
                    "info",
                );

                return;
            }

            if (verb !== "status") {
                throw new Error("Usage: /webaccess [on|off|status|startup [on|off]]");
            }

            ctx.ui.notify(
                `Web access is ${webAccessEnabled ? "offering" : "not offering"} its ${WEB_TOOL_NAMES.length} tools to this session, and starts ${loadStartupActivation() ? "offered" : "withdrawn"}.`,
                "info",
            );
        },
    });

    // Withdrawn tool groups are invisible to the model, so a session that turns out to need
    // one has no way to say so. This tool names the withdrawn groups and asks the human to
    // restore one. It grants nothing on its own: without an interactive human it refuses, and
    // a declined prompt leaves the session exactly as it was.
    //
    // Pi records tools added during a tool call and offers them from the next assistant
    // message, so activation must be additive; removing here would cost the cached prefix.
    const activateCapability = (capabilityId: string) => {
        const capability = findCapability(capabilityId);
        if (!capability) {
            return;
        }

        if (capability.id === "web") {
            webAccessEnabled = true;
            applyWebAccess();

            return;
        }

        syncToolGroup(pi, capability.tools, true);
    };

    pi.registerTool({
        name: CAPABILITY_REQUEST_TOOL,
        label: "Request Capability",
        description: `Ask the user to restore a withdrawn tool group for this session — ${describeCapabilities()}. Hidden tools cannot be called until restored. Ask only when the task needs one: restoring mid-session discards the cached prompt prefix, about 20% of a mid-length task's cost. Restored tools work from your next message; if the user declines, continue without them. Delegation is not requestable; ask the user to run /delegate on.`,
        parameters: Type.Object(
            {
                capability: StringEnum(CAPABILITY_NAMES, {
                    description: "Withdrawn tool group to request",
                }),
                reason: Type.String({
                    minLength: 5,
                    maxLength: 200,
                    description: "What in the current task needs this group; shown to the user in the prompt",
                }),
            },
            { additionalProperties: false },
        ),
        async execute(_toolCallId, params: any, _signal, _onUpdate, ctx: ExtensionContext) {
            const capability = findCapability(params.capability);
            if (!capability) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Unknown capability. Available: ${CAPABILITY_NAMES.join(", ")}.`,
                        },
                    ],
                    isError: true,
                    details: { activated: false, capability: String(params.capability ?? "") },
                };
            }

            const active = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
            if (capabilityActive(active, capability)) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `${capability.label} is already available. Use its tools directly.`,
                        },
                    ],
                    details: { activated: false, capability: capability.id, alreadyActive: true },
                };
            }

            const registered = typeof pi.getAllTools === "function" ? pi.getAllTools().map((tool) => tool.name) : [];
            if (registered.length > 0 && !capabilityInstalled(registered, capability)) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `${capability.label} is not installed in this session, so it cannot be restored. Continue without it.`,
                        },
                    ],
                    details: { activated: false, capability: capability.id, installed: false },
                };
            }

            if (!ctx.hasUI) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `${capability.label} stays withdrawn: restoring it needs an interactive user. Continue without it.`,
                        },
                    ],
                    details: { activated: false, capability: capability.id, headless: true },
                };
            }

            // A standing grant replaces the prompt, not the human: it records a decision this
            // human already made, and only an interactive command can record one.
            const standing = autoAllowed(capability.id);
            const pending = missingTools(active, capability);
            const accepted =
                standing ||
                (await ctx.ui.confirm(
                    `Allow ${capability.label} for this session?`,
                    `The agent asked to ${capability.summary}. Reason given: ${safeMessage(params.reason)}\n\nThis offers ${pending.length} tool${pending.length === 1 ? "" : "s"} for the rest of this session, adds ${capability.schemaCost}, ${capability.activationCost}. Withdraw them again with ${capability.command} off.`,
                ));
            if (!accepted) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `The user declined ${capability.label}. Continue the task without it and do not ask again for this task.`,
                        },
                    ],
                    details: { activated: false, capability: capability.id, declined: true },
                };
            }

            activateCapability(capability.id);
            // A standing grant skips the dialog, so say what happened; a capability must never
            // turn itself on without the human seeing it.
            if (standing) {
                ctx.ui.notify(
                    `${capability.label} offered to this session by a standing grant. Withdraw it with ${capability.command} off, or stop granting it with /capability ask ${capability.id}.`,
                    "info",
                );
            }

            return {
                content: [
                    {
                        type: "text" as const,
                        text: `${capability.label} is available from your next message: ${capability.tools.join(", ")}.`,
                    },
                ],
                details: { activated: true, capability: capability.id, tools: [...capability.tools], standing },
            };
        },
    });

    pi.registerTool({
        name: BACKGROUND_TOOL,
        label: "Background",
        description:
            "Start a shell command that may take more than a minute or two (an eval, build, server, test suite, or waiting on CI or a deploy) without blocking the conversation. It returns at once; the exit code and last lines of output arrive later as a message, so never poll or sleep waiting for it. Use bash only for quick commands. Bash permission rules apply.",
        promptGuidelines: [
            "Use background, not bash, for anything that may take more than a minute or two or that waits on something (CI, deploys, sleep loops); a long bash call stops the user from talking to you until it returns.",
        ],
        parameters: Type.Object(
            {
                command: Type.String({
                    description: "Shell command, run as bash would run it in the session directory",
                }),
                label: Type.Optional(Type.String({ maxLength: 80, description: "Short name shown to the user" })),
            },
            { additionalProperties: false },
        ),
        async execute(_toolCallId, params: any, _signal, _onUpdate, ctx: ExtensionContext) {
            const verdict = backgroundAdmission(ctx, jobs?.running() ?? 0);
            if (!verdict.ok) {
                return {
                    content: [{ type: "text" as const, text: verdict.reason }],
                    isError: true,
                    details: { started: false },
                };
            }

            const command = typeof params.command === "string" ? params.command : "";
            if (command.trim().length === 0) {
                return {
                    content: [{ type: "text" as const, text: "Give the command to run." }],
                    isError: true,
                    details: { started: false },
                };
            }

            jobsContext = ctx;
            jobs ??= createJobManager({ run: runJob, logDir: sessionLogDir(), report: reportJob });
            const job = jobs.start({ command, cwd: ctx.cwd, label: params.label });
            publishJobStatus();

            return {
                content: [{ type: "text" as const, text: startedText(job) }],
                details: { started: true, id: job.id, logPath: job.logPath },
            };
        },
    });

    pi.registerCommand("jobs", {
        description: "List, show or stop this session's background jobs",
        getArgumentCompletions: (prefix: string) =>
            ["list", "output", "stop"]
                .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
                .map((value) => ({ value, label: value })),
        handler: async (args, ctx) => {
            const [actionRaw = "list", target] = args.trim().split(/\s+/u).filter(Boolean);
            const action = actionRaw.toLowerCase();
            const all = jobs?.list() ?? [];
            if (action === "list") {
                ctx.ui.notify(listText(all), "info");

                return;
            }

            if (action === "output") {
                const job = target ? jobs?.get(target) : undefined;
                if (!job) {
                    ctx.ui.notify("Usage: /jobs output <id>. Run /jobs to see the ids.", "error");

                    return;
                }

                ctx.ui.notify(`${tailOf(job.tail) || "(no output yet)"}\n\nFull log: ${job.logPath}`, "info");

                return;
            }

            if (action === "stop") {
                const targets =
                    target === "all" ? all.filter((job) => job.state === "running") : [jobs?.get(target ?? "")];
                const stopped = targets.filter((job) => job && jobs?.stop(job.id, "user")).map((job) => job!.id);
                ctx.ui.notify(
                    stopped.length > 0
                        ? `Stopping background job${stopped.length === 1 ? "" : "s"} ${stopped.join(", ")}.`
                        : "No running job matches. Usage: /jobs stop <id|all>.",
                    stopped.length > 0 ? "info" : "error",
                );

                return;
            }

            ctx.ui.notify("Usage: /jobs [list|output <id>|stop <id|all>]", "error");
        },
    });

    pi.registerCommand("capability", {
        description: "Show withdrawn tool groups, or stop being asked before granting one",
        getArgumentCompletions: (prefix: string) =>
            ["status", ...CAPABILITY_NAMES.flatMap((name) => [`allow ${name}`, `ask ${name}`])]
                .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
                .map((value) => ({ value, label: value })),
        handler: async (args: string, ctx: ExtensionContext) => {
            const [action = "status", name, ...rest] = args.trim().split(/\s+/u).filter(Boolean);
            const verb = action.toLowerCase();
            if (rest.length || (name && verb === "status") || (!name && verb !== "status")) {
                throw new Error(
                    `Usage: /capability [status|allow <name>|ask <name>] (names: ${CAPABILITY_NAMES.join(", ")})`,
                );
            }

            if (verb === "allow" || verb === "ask") {
                const capability = findCapability(name);
                if (!capability) {
                    throw new Error(`Unknown capability. Names: ${CAPABILITY_NAMES.join(", ")}`);
                }

                // Recording a standing grant is the decision itself, so it needs a human at the
                // keyboard exactly as the startup preferences do.
                if (!ctx.hasUI) {
                    throw new Error("Capability policy changes require a human interactive command");
                }

                if (verb === "allow") {
                    allowCapability(capability.id);
                    ctx.ui.notify(
                        `${capability.label} will be offered whenever the agent asks for it, without a prompt. This session is unchanged until it asks. Undo with /capability ask ${capability.id}.`,
                        "info",
                    );

                    return;
                }

                askCapability(capability.id);
                ctx.ui.notify(
                    `${capability.label} will prompt again before it is offered. Tools already offered to this session stay until ${capability.command} off.`,
                    "info",
                );

                return;
            }

            if (verb !== "status") {
                throw new Error(
                    `Usage: /capability [status|allow <name>|ask <name>] (names: ${CAPABILITY_NAMES.join(", ")})`,
                );
            }

            const active = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
            const granted = loadAutoAllowed();
            const lines = CAPABILITY_NAMES.map((id) => {
                const capability = findCapability(id)!;
                const offered = capabilityActive(active, capability) ? "offered" : "withdrawn";

                return `${id}: ${offered}, ${granted.includes(id) ? "granted without asking" : "asks first"}`;
            });
            ctx.ui.notify(`${lines.join(" · ")}. Policy: ${policyPath()}`, "info");
        },
    });
}
