import path from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
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
    syncActiveTools as syncWebAccessTools,
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
        ctx.ui.notify(`DIAG set root=${scope.root} count=${entries.length}`, "info");
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

    // TEMP-DIAG-CI-HANG: narrows the Windows-only scope wipe. Revert after reading.
    const restoreSession = async (ctx: ExtensionContext, trigger = "unknown") => {
        sessionGeneration += 1;
        const origin = captureSession(ctx);
        // Retire armed prompts synchronously, before root lookup can yield to a tool call or another branch change.
        scope = emptyScope(path.resolve(origin.cwd));
        ctx.ui.notify(`DIAG restore start ${trigger} gen=${origin.generation} root=${scope.root}`, "info");
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
        ctx.ui.notify(
            `DIAG restore read ${trigger} root=${root} entries=${(ctx.sessionManager.getBranch?.() ?? []).length}`,
            "info",
        );

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

    // Web access ships hidden. A missing or unreadable preference means off, and the
    // gate only ever touches its own four tool names.
    let webAccessEnabled = loadStartupActivation();
    const applyWebAccess = () => syncWebAccessTools(pi, WEB_TOOL_NAMES, webAccessEnabled);

    pi.on("session_start", (_event, ctx) => {
        webAccessEnabled = loadStartupActivation();
        applyWebAccess();
        restoreSession(ctx, `start:${(_event as any)?.reason ?? "?"}`);
    });

    pi.on("session_tree", (_event, ctx) => restoreSession(ctx, "tree"));

    pi.on("session_shutdown", (_event, ctx) => {
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
                `[SPECPI SCOPE]\nDeclared paths: ${scope.entries.map((item) => `${sanitizePathLabel(item.path)}${item.directory ? "/" : ""}`).join(", ")}\nPending outside-scope paths: ${scope.pending.map(sanitizePathLabel).join(", ") || "none"}. Do not describe pending paths as accepted scope.${taskStale ? "\nTask-bound scope is stale; do not widen it automatically." : ""}`,
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
}
