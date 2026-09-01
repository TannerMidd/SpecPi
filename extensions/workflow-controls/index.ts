import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Box, Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
    canonicalRoot,
    compareWorktreeSnapshots,
    createWorktreeSnapshot,
    normalizeScopeEntries,
    relativeMutationPath,
    sanitizePathLabel,
    scopeMatches,
} from "./scope.mjs";
import {
    createExperiment,
    defaultPatchPath,
    discardExperiment,
    experimentStatus,
    exportExperimentPatch,
    findExperiment,
    inspectRepository,
    readExperimentRegistry,
    recoverExperiments,
    repairExperimentRecord,
} from "./experiments.mjs";
import {
    boundedChallengeFacts,
    challengePrompt,
    renderChallengeMarkdown,
    validateChallengeSubmission,
} from "./challenge.mjs";

const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
const stateDir = path.join(agentDir, "zenpi");
const SCOPE_ENTRY = "zenpi-scope-state";
const CHALLENGE_ENTRY = "zenpi-completion-challenge";
const SCOPE_STATUS = "zenpi-scope";
const MAX_PENDING_SCOPE = 40;
// `read` is the one documented Pi seam that cannot mutate the worktree. Every other tool, including extension-provided
// ones, still gets snapshotted because an unrecognised tool is exactly the case post-hoc detection exists for.
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
}

interface ActiveChallenge {
    generation: string;
    sessionId: string;
    facts: any;
    prompt: string;
    delivered: boolean;
}

interface ChallengeEntryData {
    kind: "active" | "result" | "display" | "expired" | "cleared";
    generation: string;
    facts?: any;
    result?: any;
    markdown?: string;
    createdAt?: string;
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
    };
}

function parseExperimentCard(source: string, fallbackName: string) {
    const field = (name: string) => source.match(new RegExp(`^${name}:\\s*(.+)$`, "imu"))?.[1]?.trim() ?? "";
    const nonGoalsBlock = source.match(/^Non-goals:\s*\n([\s\S]*)$/imu)?.[1] ?? "";

    return {
        name: field("Name") || fallbackName,
        hypothesis: field("Hypothesis"),
        acceptance: field("Acceptance"),
        nonGoals: nonGoalsBlock
            .split("\n")
            .map((line) => line.replace(/^\s*-\s*/u, "").trim())
            .filter(Boolean),
    };
}

function safeMessage(error: unknown) {
    return (error instanceof Error ? error.message : String(error))
        .replace(/[\u0000-\u001f\u007f]+/gu, " ")
        .slice(0, 500);
}

export default function workflowControls(pi: ExtensionAPI) {
    let scope = emptyScope(canonicalRoot(process.cwd()));
    let activeChallenge: ActiveChallenge | undefined;
    let latestChallenge: ChallengeEntryData | undefined;
    let observedToolFailures = 0;
    let experimentBusy = false;
    let latestSnapshot: any;
    const snapshots = new Map<string, any>();
    const supportsEntryRenderer = typeof pi.registerEntryRenderer === "function";

    const exec = (command: string, args: string[], options: any = {}) => pi.exec(command, args, options);

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

    const emitScopeStatus = (ctx: ExtensionContext) => {
        const summary = scope.active
            ? {
                  active: true,
                  pending: scope.pending.length,
                  entries: scope.entries.length,
                  indeterminate: scope.indeterminate,
              }
            : { active: false, pending: 0, entries: 0, indeterminate: false };
        pi.events.emit("zenpi:workflow-status", summary);
        if (!scope.active) {
            ctx.ui.setStatus(SCOPE_STATUS, undefined);
            ctx.ui.setWidget(SCOPE_STATUS, undefined);

            return;
        }

        const label = scope.pending.length > 0 || scope.indeterminate ? "scope: review" : "scope: clean";
        ctx.ui.setStatus(SCOPE_STATUS, label);
        ctx.ui.setWidget(SCOPE_STATUS, (_tui, theme) => ({
            invalidate() {},
            render(width: number): string[] {
                const pending = scope.pending.length > 0 ? ` · ${scope.pending.length} pending` : "";
                const uncertain = scope.indeterminate ? " · snapshot uncertain" : "";

                return [
                    truncateToWidth(
                        theme.fg(
                            scope.pending.length > 0 || scope.indeterminate ? "warning" : "dim",
                            `scope · ${scope.entries.length} paths · ${scope.observed.length} changed${pending}${uncertain}`,
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

        try {
            const result = await pi.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
                cwd: scope.root,
                timeout: 30_000,
            });
            if (result.code !== 0 || typeof result.stdout !== "string") {
                // A failed status leaves no trustworthy baseline, so the next tool must observe the worktree afresh
                // rather than diffing against a snapshot taken before the gap.
                latestSnapshot = undefined;

                return { root: scope.root, paths: [], fingerprints: {}, indeterminate: true };
            }

            const snapshot = createWorktreeSnapshot(scope.root, result.stdout);
            latestSnapshot = snapshot;

            return snapshot;
        } catch {
            latestSnapshot = undefined;

            return { root: scope.root, paths: [], fingerprints: {}, indeterminate: true };
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

    const setScopeEntries = (entries: ScopeItem[], ctx: ExtensionContext) => {
        if (entries.length === 0 || entries.length > 40) {
            throw new Error("Scope must contain between 1 and 40 paths");
        }

        scope.active = true;
        scope.entries = entries;
        scope.pending = scope.pending.filter((item) => !scopeMatches(entries, item));
        scope.generation += 1;
        latestSnapshot = undefined;
        persistScope(ctx);
    };

    pi.on("session_start", async (_event, ctx) => {
        const root = await resolveRoot(ctx.cwd);
        scope = emptyScope(root);
        activeChallenge = undefined;
        latestChallenge = undefined;
        observedToolFailures = 0;
        latestSnapshot = undefined;
        snapshots.clear();

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
                    };
                } else if (data?.active === false) {
                    scope = emptyScope(root);
                }
            } else if (entry.customType === CHALLENGE_ENTRY) {
                const data = entry.data as ChallengeEntryData | undefined;
                if (data?.kind === "result") {
                    latestChallenge = data;
                } else if (data?.kind === "cleared") {
                    latestChallenge = undefined;
                }
            }
        }

        emitScopeStatus(ctx);
    });

    pi.on("session_shutdown", (_event, ctx) => {
        snapshots.clear();
        latestSnapshot = undefined;
        activeChallenge = undefined;
        experimentBusy = false;
        ctx.ui.setStatus(SCOPE_STATUS, undefined);
        ctx.ui.setWidget(SCOPE_STATUS, undefined);
    });

    pi.on("input", () => {
        observedToolFailures = 0;
    });

    // The challenge prompt tells the model not to implement anything this turn. If the turn ends without the tool call
    // that retires it, leaving it armed would silently apply that instruction to every later turn, so it expires here.
    pi.on("agent_settled", (_event, ctx) => {
        if (!activeChallenge?.delivered) {
            return;
        }

        const abandoned = activeChallenge;
        activeChallenge = undefined;
        pi.appendEntry<ChallengeEntryData>(CHALLENGE_ENTRY, {
            kind: "expired",
            generation: abandoned.generation,
            createdAt: new Date().toISOString(),
        });
        ctx.ui.notify(
            `Completion challenge ${abandoned.generation.slice(0, 8)} ended without a structured result. Run /challenge again if you still want one.`,
            "warning",
        );
    });

    pi.on("tool_execution_start", async (event: any) => {
        if (!scope.active || READ_ONLY_TOOLS.has(event.toolName)) {
            return;
        }

        snapshots.set(event.toolCallId, await baselineSnapshot());
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
        if (!ctx.hasUI) {
            addPending([relativePath], ctx);

            return;
        }

        const answer = await ctx.ui.select(`Outside declared scope: ${relativePath}`, [
            "Deny this call (Recommended)",
            "Allow once without expanding scope",
            "Add this path to scope and allow",
        ]);
        if (generation !== scope.generation || event.input.path !== originalPath) {
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
        if (event.isError) {
            observedToolFailures = Math.min(99, observedToolFailures + 1);
        }

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

        const after = await takeSnapshot();
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
        const warning = `ZenPi scope warning: mutation outside declared scope is pending acknowledgement: ${comparison.outside.slice(0, 8).map(sanitizePathLabel).join(", ")}. The human can run /scope accept <path> to acknowledge it without widening scope, /scope add <path> to widen scope, or /scope clear.`;

        return { content: [...event.content, { type: "text", text: warning }] };
    });

    pi.on("before_agent_start", async (event) => {
        const guidance = [];
        if (scope.active) {
            guidance.push(
                `[ZENPI SCOPE]\nDeclared paths: ${scope.entries.map((item) => `${sanitizePathLabel(item.path)}${item.directory ? "/" : ""}`).join(", ")}\nPending outside-scope paths: ${scope.pending.map(sanitizePathLabel).join(", ") || "none"}. Do not describe pending paths as accepted scope.`,
            );
        }

        if (activeChallenge) {
            activeChallenge.delivered = true;
            guidance.push(activeChallenge.prompt);
        }

        if (guidance.length === 0) {
            return;
        }

        return { systemPrompt: `${event.systemPrompt}\n\n${guidance.join("\n\n")}` };
    });

    pi.registerCommand("scope", {
        description: "Declare expected project paths and review scope drift",
        getArgumentCompletions: (prefix: string) =>
            ["set", "add", "remove", "accept", "recheck", "status", "clear"]
                .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
                .map((value) => ({ value, label: value })),
        handler: async (args, ctx) => {
            const [actionRaw, ...rest] = args.trim().split(/\s+/u).filter(Boolean);
            const action = actionRaw?.toLowerCase() || (scope.active ? "status" : "set");
            const requestedPath = rest.join(" ");
            try {
                if (action === "status") {
                    ctx.ui.notify(
                        scope.active
                            ? `Scope: ${scope.entries.map((item) => `${sanitizePathLabel(item.path)}${item.directory ? "/" : ""}`).join(", ")}; pending: ${scope.pending.map(sanitizePathLabel).join(", ") || "none"}; snapshot: ${scope.indeterminate ? "indeterminate" : "observed"}.`
                            : "Scope monitoring is inactive.",
                        scope.pending.length > 0 || scope.indeterminate ? "warning" : "info",
                    );

                    return;
                }

                if (action === "clear") {
                    scope = emptyScope(await resolveRoot(ctx.cwd));
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
                    if (edited === undefined) {
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
                scope.pending = scope.pending.filter((item) => !scopeMatches([normalized], item));
                scope.generation += 1;
                persistScope(ctx);
                ctx.ui.notify(`${sanitizePathLabel(normalized.path)} added to declared scope.`, "info");
            } catch (error) {
                ctx.ui.notify(safeMessage(error), "error");
            }
        },
    });

    const withExperimentOperation = async (ctx: ExtensionContext, operation: () => Promise<void>) => {
        if (experimentBusy) {
            ctx.ui.notify("Another experiment operation is already active.", "warning");

            return;
        }

        experimentBusy = true;
        try {
            await operation();
        } catch (error) {
            ctx.ui.notify(safeMessage(error), "error");
        } finally {
            experimentBusy = false;
        }
    };

    pi.registerCommand("experiment", {
        description: "Create and close bounded detached Git worktree experiments",
        getArgumentCompletions: (prefix: string) =>
            ["start", "status", "close", "recover"]
                .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
                .map((value) => ({ value, label: value })),
        handler: async (args, ctx) => {
            const [actionRaw, ...rest] = args.trim().split(/\s+/u).filter(Boolean);
            const action = actionRaw?.toLowerCase() || "status";
            const query = rest.join(" ");
            await withExperimentOperation(ctx, async () => {
                if (action === "start") {
                    if (!ctx.hasUI || typeof ctx.ui.editor !== "function") {
                        throw new Error("Starting an experiment requires interactive editor support");
                    }

                    const repository = await inspectRepository(exec, ctx.cwd);
                    if (repository.changedPaths.length > 0) {
                        const proceed = await ctx.ui.confirm(
                            "Start from HEAD without current uncommitted changes?",
                            `${repository.changedPaths.length} dirty path(s) remain untouched in the base worktree and will not be copied.`,
                        );
                        if (!proceed) {
                            return;
                        }
                    }

                    const template = `Name: ${query}\nHypothesis: \nAcceptance: \nNon-goals:\n- `;
                    const edited = await ctx.ui.editor("Experiment card", template);
                    if (edited === undefined) {
                        return;
                    }

                    const card = parseExperimentCard(edited, query);
                    const preview = `Base: ${repository.baseCommit}\nRepository: ${repository.repoRoot}\nHypothesis: ${card.hypothesis}\nAcceptance: ${card.acceptance}`;
                    if (!(await ctx.ui.confirm("Create detached experiment worktree?", preview))) {
                        return;
                    }

                    const record = await createExperiment({ exec, stateDir, repository, card });
                    ctx.ui.notify(
                        `Experiment ${record.id.slice(0, 8)} created at ${record.worktreePath}. Open a separate human-controlled Pi session in that directory.`,
                        "info",
                    );

                    return;
                }

                if (action === "status") {
                    if (!query) {
                        try {
                            const current = findExperiment(stateDir, "", ctx.cwd);
                            const status = await experimentStatus(exec, current);
                            ctx.ui.notify(
                                `${current.name} (${current.id.slice(0, 8)}): ${current.status}; ${status.changedPaths.length} changed, ${status.committed} committed, ${status.untracked} untracked, ${status.ignored} ignored path(s) (not exportable); acceptance: ${current.acceptance}`,
                                "info",
                            );
                        } catch {
                            const records = readExperimentRegistry(stateDir).experiments;
                            ctx.ui.notify(
                                records.length > 0
                                    ? records
                                          .map(
                                              (item) =>
                                                  `${item.id.slice(0, 8)} ${item.name} [${item.status}] ${item.worktreePath}`,
                                          )
                                          .join("\n")
                                    : "No retained experiments.",
                                "info",
                            );
                        }

                        return;
                    }

                    const record = findExperiment(stateDir, query, ctx.cwd);
                    const status = await experimentStatus(exec, record);
                    ctx.ui.notify(
                        `${record.name} (${record.id.slice(0, 8)}): ${record.status}; ${status.changedPaths.length} changed, ${status.committed} committed, ${status.untracked} untracked, ${status.ignored} ignored path(s) (not exportable); acceptance: ${record.acceptance}`,
                        "info",
                    );

                    return;
                }

                if (action === "close") {
                    const record = findExperiment(stateDir, query, ctx.cwd);
                    const status = await experimentStatus(exec, record);
                    if (!ctx.hasUI) {
                        throw new Error("Closing an experiment requires interactive confirmation");
                    }

                    const extraNote = [
                        status.committed > 0 ? `${status.committed} committed path(s)` : "",
                        status.ignored > 0 ? `${status.ignored} ignored path(s) a patch cannot carry` : "",
                        status.committedUnknown ? "commit history could not be read" : "",
                    ]
                        .filter(Boolean)
                        .join(", ");
                    const ignoredNote = extraNote ? `; ${extraNote}` : "";
                    const choice = await ctx.ui.select(
                        `${record.name}: ${status.changedPaths.length} changed path(s)${ignoredNote}; acceptance: ${record.acceptance}`,
                        ["Keep worktree", "Export patch", "Discard worktree"],
                    );
                    if (choice === "Keep worktree" || !choice) {
                        ctx.ui.notify("Experiment kept; no files changed.", "info");

                        return;
                    }

                    if (choice === "Export patch") {
                        const suggested = defaultPatchPath(stateDir, record);
                        const edited =
                            typeof ctx.ui.editor === "function"
                                ? await ctx.ui.editor("Patch output path", suggested)
                                : suggested;
                        if (edited === undefined || !edited.trim()) {
                            return;
                        }

                        const destination = path.resolve(edited.trim());
                        const overwrite = fs.existsSync(destination)
                            ? await ctx.ui.confirm("Overwrite existing patch?", destination)
                            : false;
                        if (fs.existsSync(destination) && !overwrite) {
                            return;
                        }

                        const exported = await exportExperimentPatch({
                            exec,
                            stateDir,
                            record,
                            outputPath: destination,
                            overwrite,
                        });
                        ctx.ui.notify(
                            status.ignored > 0
                                ? `Patch exported to ${exported.outputPath}; worktree kept. ${status.ignored} ignored path(s) are NOT in the patch: ${status.ignoredPaths.slice(0, 5).map(sanitizePathLabel).join(", ")}`
                                : `Patch exported to ${exported.outputPath}; worktree kept.`,
                            status.ignored > 0 ? "warning" : "info",
                        );

                        return;
                    }

                    if (
                        !(await ctx.ui.confirm(
                            "Discard this registered experiment worktree?",
                            `${record.worktreePath}\nThis does not alter the base worktree.`,
                        ))
                    ) {
                        return;
                    }

                    // Ignored files never appear in `status --untracked-files=all` and never reach a patch, so without
                    // counting them here a worktree holding only ignored work would be deleted as if it were empty.
                    if (
                        status.hasWork &&
                        !(await ctx.ui.confirm(
                            "Discard dirty experiment permanently?",
                            status.ignored > 0
                                ? `${status.changedPaths.length} changed and ${status.committed} committed path(s) will be removed, plus ${status.ignored} ignored path(s) a patch cannot carry: ${status.ignoredPaths.slice(0, 5).map(sanitizePathLabel).join(", ")}`
                                : `${status.changedPaths.length} changed and ${status.committed} committed path(s) will be removed. Export a patch first if needed.`,
                        ))
                    ) {
                        return;
                    }

                    await discardExperiment({ exec, stateDir, record });
                    ctx.ui.notify(`Experiment ${record.id.slice(0, 8)} discarded.`, "warning");

                    return;
                }

                if (action === "recover") {
                    const repository = await inspectRepository(exec, ctx.cwd);
                    const findings = await recoverExperiments({ exec, stateDir, repoRoot: repository.repoRoot });
                    const pending = findings.filter((item) => item.needsRecovery);
                    if (pending.length === 0) {
                        ctx.ui.notify("No experiment recovery is needed for this repository.", "info");

                        return;
                    }

                    if (!ctx.hasUI) {
                        throw new Error(`${pending.length} experiment record(s) need interactive recovery`);
                    }

                    for (const finding of pending) {
                        // An orphan directory is neither present nor missing: Git has forgotten it but the files are
                        // still there, so it can only be released, never activated, and ZenPi never deletes it.
                        const state = finding.present
                            ? "worktree present"
                            : finding.orphanDirectory
                              ? "directory left behind by an interrupted creation"
                              : "worktree missing";
                        const options = finding.present
                            ? ["Leave unchanged", "Activate registry record"]
                            : finding.orphanDirectory
                              ? ["Leave unchanged", "Release record and keep the directory"]
                              : ["Leave unchanged", "Forget missing record"];
                        const choice = await ctx.ui.select(
                            `${finding.record.id.slice(0, 8)} ${finding.record.name}: ${state}`,
                            options,
                        );
                        const access = { exec, repoRoot: repository.repoRoot };
                        if (choice === "Activate registry record") {
                            await repairExperimentRecord(stateDir, finding.record.id, "activate", access);
                        } else if (choice === "Forget missing record") {
                            await repairExperimentRecord(stateDir, finding.record.id, "forget", access);
                        } else if (choice === "Release record and keep the directory") {
                            const released = await repairExperimentRecord(
                                stateDir,
                                finding.record.id,
                                "release",
                                access,
                            );
                            ctx.ui.notify(
                                `Record released. ${released?.released ?? finding.record.worktreePath} was left in place for you to inspect or delete.`,
                                "warning",
                            );
                        }
                    }

                    return;
                }

                throw new Error("Usage: /experiment [start [name]|status [id]|close [id]|recover]");
            });
        },
    });

    const challengeSchema = Type.Object(
        {
            generation: Type.String({ minLength: 36, maxLength: 36 }),
            verdict: StringEnum(["ready-for-human-review", "incomplete", "blocked"] as const),
            requirements: Type.Array(
                Type.Object(
                    {
                        requirement: Type.String({ minLength: 1, maxLength: 360 }),
                        status: StringEnum(["proven", "partial", "unproven"] as const),
                        evidence: Type.String({ maxLength: 600 }),
                    },
                    { additionalProperties: false },
                ),
                { minItems: 1, maxItems: 16 },
            ),
            contradictions: Type.Array(Type.String({ minLength: 1, maxLength: 360 }), { maxItems: 12 }),
            falsePositiveChecks: Type.Array(Type.String({ minLength: 1, maxLength: 360 }), { maxItems: 12 }),
            scopeFindings: Type.Array(Type.String({ minLength: 1, maxLength: 360 }), { maxItems: 12 }),
            validationGaps: Type.Array(Type.String({ minLength: 1, maxLength: 360 }), { maxItems: 12 }),
            residualRisks: Type.Array(Type.String({ minLength: 1, maxLength: 360 }), { maxItems: 12 }),
            nextAction: Type.String({ maxLength: 500 }),
        },
        { additionalProperties: false },
    );

    pi.registerTool({
        name: "submit_completion_challenge",
        label: "Submit Completion Challenge",
        description:
            "Submit the structured result for an active user-requested /challenge. Use only while the matching challenge generation is active, cite available evidence without inventing proof, and make this the final tool call of that turn.",
        promptSnippet: "Finish an active completion challenge with a bounded structured readiness review",
        parameters: challengeSchema,
        async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
            const sessionId = ctx.sessionManager.getSessionId();
            if (
                !activeChallenge ||
                activeChallenge.generation !== params.generation ||
                activeChallenge.sessionId !== sessionId
            ) {
                throw new Error("No matching completion challenge is active in this session");
            }

            const result = validateChallengeSubmission(params, activeChallenge.facts);
            const data: ChallengeEntryData = {
                kind: "result",
                generation: activeChallenge.generation,
                facts: boundedChallengeFacts(activeChallenge.facts),
                result,
                markdown: renderChallengeMarkdown(result, { generation: activeChallenge.generation }),
                createdAt: new Date().toISOString(),
            };
            pi.appendEntry(CHALLENGE_ENTRY, data);
            latestChallenge = data;
            activeChallenge = undefined;

            return {
                content: [{ type: "text", text: data.markdown }],
                details: { generation: data.generation, verdict: result.verdict },
                terminate: true,
            };
        },
    });

    pi.registerCommand("challenge", {
        description: "Run or inspect an adversarial completion-readiness challenge",
        getArgumentCompletions: (prefix: string) =>
            ["status", "clear"]
                .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
                .map((value) => ({ value, label: value })),
        handler: async (args, ctx) => {
            const action = args.trim().toLowerCase();
            if (action === "status") {
                if (!latestChallenge) {
                    ctx.ui.notify("No completed challenge exists on this session branch.", "info");
                } else if (supportsEntryRenderer) {
                    pi.appendEntry(CHALLENGE_ENTRY, { ...latestChallenge, kind: "display" });
                } else if (typeof ctx.ui.editor === "function") {
                    await ctx.ui.editor("Completion challenge (view only)", latestChallenge.markdown ?? "Unavailable");
                } else {
                    ctx.ui.notify(`${latestChallenge.result?.verdict ?? "unknown"}`, "info");
                }

                return;
            }

            if (action === "clear") {
                activeChallenge = undefined;
                latestChallenge = undefined;
                pi.appendEntry(CHALLENGE_ENTRY, {
                    kind: "cleared",
                    generation: randomUUID(),
                    createdAt: new Date().toISOString(),
                });
                ctx.ui.notify("Completion challenge state cleared for this branch.", "info");

                return;
            }

            if (action) {
                ctx.ui.notify("Usage: /challenge [status|clear]", "error");

                return;
            }

            if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
                ctx.ui.notify("Wait for the active agent run to settle before starting a challenge.", "warning");

                return;
            }

            if (activeChallenge) {
                ctx.ui.notify("A completion challenge is already active.", "warning");

                return;
            }

            let snapshot;
            try {
                const root = await resolveRoot(ctx.cwd);
                const status = await pi.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
                    cwd: root,
                    timeout: 30_000,
                });
                snapshot = status.code === 0 ? createWorktreeSnapshot(root, status.stdout) : undefined;
            } catch {
                snapshot = undefined;
            }

            let experiment;
            try {
                experiment = findExperiment(stateDir, "", ctx.cwd);
            } catch {
                experiment = undefined;
            }

            const facts = boundedChallengeFacts({
                changedPaths: snapshot?.paths ?? [],
                scopeEntries: scope.active
                    ? scope.entries.map((item) => `${sanitizePathLabel(item.path)}${item.directory ? "/" : ""}`)
                    : [],
                pendingScope: scope.active ? scope.pending.map(sanitizePathLabel) : [],
                experiment,
                observedToolFailures,
                snapshotIndeterminate: !snapshot || snapshot.indeterminate,
            });
            const generation = randomUUID();
            const prompt = challengePrompt(generation, facts);
            activeChallenge = {
                generation,
                sessionId: ctx.sessionManager.getSessionId(),
                facts,
                prompt,
                delivered: false,
            };
            pi.appendEntry<ChallengeEntryData>(CHALLENGE_ENTRY, {
                kind: "active",
                generation,
                facts: boundedChallengeFacts(facts),
                createdAt: new Date().toISOString(),
            });
            pi.sendMessage(
                {
                    customType: CHALLENGE_ENTRY,
                    content: prompt,
                    display: true,
                    details: { generation },
                },
                { deliverAs: "followUp", triggerTurn: true },
            );
        },
    });

    if (supportsEntryRenderer) {
        pi.registerEntryRenderer<ChallengeEntryData>(CHALLENGE_ENTRY, (entry, _options, theme) => {
            const data = entry.data;
            const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
            if ((data?.kind === "result" || data?.kind === "display") && data.markdown) {
                box.addChild(new Markdown(data.markdown, 0, 0, getMarkdownTheme()));
            } else if (data?.kind === "active") {
                box.addChild(
                    new Text(theme.fg("accent", `Completion challenge started · ${data.generation.slice(0, 8)}`), 0, 0),
                );
            } else if (data?.kind === "expired") {
                box.addChild(
                    new Text(
                        theme.fg("dim", `Completion challenge expired unanswered · ${data.generation.slice(0, 8)}`),
                        0,
                        0,
                    ),
                );
            } else {
                box.addChild(new Text(theme.fg("dim", "Completion challenge state cleared"), 0, 0));
            }

            return box;
        });
    }
}
