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
import {
    TASK_CONTRACT_ENTRY,
    createTaskContract,
    markdownPathLabel,
    readTaskContract,
    renderTaskContract,
    taskContractScopeViolations,
    validateTaskContract,
} from "./task-contract.mjs";

const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
const stateDir = path.join(agentDir, "specpi");
const SCOPE_ENTRY = "specpi-scope-state";
const CHALLENGE_ENTRY = "specpi-completion-challenge";
const TASK_HANDOFF_ENTRY = "specpi-task-handoff";
const SCOPE_STATUS = "specpi-scope";
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
    taskDigest?: string;
}

interface ActiveChallenge {
    generation: string;
    sessionId: string;
    root: string;
    taskContractDigest?: string;
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

interface TaskContractEntryData {
    kind: "set" | "cleared";
    contract?: any;
    createdAt?: string;
    reason?: string;
}

interface TaskHandoffEntryData {
    markdown: string;
    contractId: string;
    contractDigest: string;
    indeterminate: boolean;
    createdAt: string;
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

function taskContractEditorText(contract: any = {}) {
    const requirements = Array.isArray(contract.requirements) ? contract.requirements : [];
    const paths = Array.isArray(contract.paths) ? contract.paths : [];
    const nonGoals = Array.isArray(contract.nonGoals) ? contract.nonGoals : [];
    const requirementLines =
        requirements.length > 0
            ? requirements.flatMap((item: any, index: number) => [
                  `- ${item.id ?? `R${index + 1}`}: ${item.description ?? ""}`,
                  `  Acceptance: ${item.acceptance ?? ""}`,
              ])
            : ["- R1: ", "  Acceptance: "];

    return [
        `Objective: ${contract.objective ?? ""}`,
        `Hypothesis: ${contract.hypothesis ?? ""}`,
        "Requirements:",
        ...requirementLines,
        "Paths:",
        ...(paths.length > 0 ? paths.map((item: string) => `- ${markdownPathLabel(item)}`) : ["- "]),
        `Rollback: ${contract.rollback ?? ""}`,
        "Non-goals:",
        ...(nonGoals.length > 0 ? nonGoals.map((item: string) => `- ${item}`) : ["- "]),
    ].join("\n");
}

function parseTaskContractCard(source: string) {
    const fields: Record<string, string> = {};
    const requirements: any[] = [];
    const paths: string[] = [];
    const nonGoals: string[] = [];
    let section = "";
    let currentRequirement: any;

    for (const rawLine of String(source).split(/\r?\n/u)) {
        const line = rawLine.trimEnd();
        const field = line.match(/^\s*(Objective|Hypothesis|Rollback|Requirements|Paths|Non-goals):\s*(.*)$/iu);
        if (field) {
            const name = field[1].toLowerCase();
            const value = field[2].trim();
            if (["objective", "hypothesis", "rollback"].includes(name)) {
                fields[name] = value;
                section = "";
            } else {
                section = name;
                if (value) {
                    if (name === "paths") {
                        paths.push(decodeDisplayedPath(value.replace(/^[-*]\s*/u, "").trim()));
                    } else if (name === "non-goals") {
                        nonGoals.push(value.replace(/^[-*]\s*/u, "").trim());
                    }
                }
            }

            continue;
        }

        if (!line.trim()) {
            continue;
        }

        if (section === "requirements") {
            const requirement = line.match(/^\s*[-*]\s*(?:\[?([A-Za-z][A-Za-z0-9_-]*)\]?\s*(?::|[-–—])\s*)?(.+?)\s*$/u);
            const acceptance = line.match(/^\s*(?:Acceptance|Accept):\s*(.*)$/iu);
            if (requirement) {
                currentRequirement = {
                    ...(requirement[1] ? { id: requirement[1] } : {}),
                    description: requirement[2].trim(),
                    acceptance: "",
                };
                requirements.push(currentRequirement);
            } else if (acceptance && currentRequirement) {
                currentRequirement.acceptance = acceptance[1].trim();
            }
        } else if (section === "paths") {
            const value = line.replace(/^\s*[-*]\s*/u, "").trim();
            if (value) {
                paths.push(decodeDisplayedPath(value));
            }
        } else if (section === "non-goals") {
            const value = line.replace(/^\s*[-*]\s*/u, "").trim();
            if (value) {
                nonGoals.push(value);
            }
        }
    }

    return {
        objective: fields.objective ?? "",
        hypothesis: fields.hypothesis ?? "",
        requirements,
        paths,
        rollback: fields.rollback ?? "",
        nonGoals,
    };
}

function decodeDisplayedPath(value: string) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function experimentCardEditorText(contract: any, fallbackName: string) {
    if (!contract) {
        return `Name: ${fallbackName}\nHypothesis: \nAcceptance: \nNon-goals:\n- `;
    }

    const acceptance = contract.requirements.map((item: any) => `${item.id}: ${item.acceptance}`).join("; ");
    const nonGoals =
        contract.nonGoals.length > 0 ? contract.nonGoals.map((item: string) => `- ${item}`).join("\n") : "- ";

    return [
        `Name: ${contract.objective}`,
        `Hypothesis: ${contract.hypothesis}`,
        `Acceptance: ${acceptance}`,
        "Non-goals:",
        nonGoals,
    ].join("\n");
}

function safeMessage(error: unknown) {
    return (error instanceof Error ? error.message : String(error))
        .replace(/[\u0000-\u001f\u007f]+/gu, " ")
        .slice(0, 500);
}

export default function workflowControls(pi: ExtensionAPI) {
    let scope = emptyScope(canonicalRoot(process.cwd()));
    let latestTaskContract: any | undefined;
    let activeChallenge: ActiveChallenge | undefined;
    let latestChallenge: ChallengeEntryData | undefined;
    let taskContractError: string | undefined;
    let observedToolFailures = 0;
    let experimentBusy = false;
    let latestSnapshot: any;
    let sessionGeneration = 0;
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

    const emitTaskContractChanged = (contract: any | undefined, previousDigest?: string) => {
        pi.events.emit("specpi:task-contract-changed", {
            active: Boolean(contract),
            previousDigest,
            digest: contract?.digest,
            id: contract?.id,
            objective: contract?.objective,
            requirements: contract?.requirements?.length ?? 0,
        });
    };

    const invalidateChallenge = (ctx: ExtensionContext, reason = "task contract changed") => {
        const hadEvidence = Boolean(activeChallenge || latestChallenge);
        activeChallenge = undefined;
        latestChallenge = undefined;
        if (hadEvidence) {
            pi.appendEntry<ChallengeEntryData>(CHALLENGE_ENTRY, {
                kind: "cleared",
                generation: randomUUID(),
                createdAt: new Date().toISOString(),
                reason,
            });
        }

        return hadEvidence;
    };

    const readCurrentTaskContract = (ctx: ExtensionContext, root: string) => {
        const current = readTaskContract(branchEntries(ctx), root);
        taskContractError = undefined;

        return current;
    };

    const refreshTaskContract = (ctx: ExtensionContext, root: string, { invalidate = true } = {}) => {
        let current;
        try {
            current = readCurrentTaskContract(ctx, root);
        } catch (error) {
            taskContractError = safeMessage(error);
            throw error;
        }

        const previousDigest = latestTaskContract?.digest;
        const changed = previousDigest !== current?.digest;
        latestTaskContract = current;
        if (changed) {
            if (
                invalidate &&
                previousDigest !== current?.digest &&
                (previousDigest !== undefined || activeChallenge || latestChallenge)
            ) {
                invalidateChallenge(ctx);
            }

            emitTaskContractChanged(current, previousDigest);
            emitScopeStatus(ctx);
        }

        return current;
    };

    const persistTaskContract = (contract: any | undefined, ctx: ExtensionContext, reason?: string) => {
        const previousDigest = latestTaskContract?.digest;
        if (contract) {
            const validated = validateTaskContract(contract);
            pi.appendEntry<TaskContractEntryData>(TASK_CONTRACT_ENTRY, {
                kind: "set",
                contract: validated,
                createdAt: new Date().toISOString(),
            });
            latestTaskContract = validated;
        } else {
            pi.appendEntry<TaskContractEntryData>(TASK_CONTRACT_ENTRY, {
                kind: "cleared",
                createdAt: new Date().toISOString(),
                reason,
            });
            latestTaskContract = undefined;
        }

        const changed = previousDigest !== latestTaskContract?.digest;
        if (changed) {
            invalidateChallenge(ctx, reason ?? "task contract changed");
        }

        emitTaskContractChanged(latestTaskContract, previousDigest);
        if (changed || !contract) {
            emitScopeStatus(ctx);
        }
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

    const restoreSession = async (ctx: ExtensionContext) => {
        sessionGeneration += 1;
        const origin = captureSession(ctx);
        // Retire armed prompts synchronously, before root lookup can yield to a tool call or another branch change.
        scope = emptyScope(path.resolve(origin.cwd));
        latestTaskContract = undefined;
        activeChallenge = undefined;
        latestChallenge = undefined;
        taskContractError = undefined;
        observedToolFailures = 0;
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
            } else if (entry.customType === CHALLENGE_ENTRY) {
                const data = entry.data as ChallengeEntryData | undefined;
                if (data?.kind === "result") {
                    latestChallenge = data;
                } else if (data?.kind === "cleared") {
                    latestChallenge = undefined;
                }
            }
        }

        try {
            latestTaskContract = readCurrentTaskContract(ctx, root);
        } catch (error) {
            taskContractError = safeMessage(error);
            ctx.ui.notify(`Task contract unavailable: ${taskContractError}`, "error");
        }

        if (
            latestChallenge &&
            latestChallenge.facts?.taskContractDigest !== latestTaskContract?.digest &&
            (latestTaskContract || latestChallenge.facts?.taskContractDigest !== undefined)
        ) {
            latestChallenge = undefined;
        }

        emitScopeStatus(ctx);
    };

    pi.on("session_start", (_event, ctx) => restoreSession(ctx));
    pi.on("session_tree", (_event, ctx) => restoreSession(ctx));

    pi.on("session_shutdown", (_event, ctx) => {
        sessionGeneration += 1;
        snapshots.clear();
        latestSnapshot = undefined;
        latestTaskContract = undefined;
        activeChallenge = undefined;
        latestChallenge = undefined;
        experimentBusy = false;
        taskContractError = undefined;
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

        if (activeChallenge) {
            activeChallenge.delivered = true;
            guidance.push(activeChallenge.prompt);
        }

        if (guidance.length === 0) {
            return;
        }

        return { systemPrompt: `${event.systemPrompt}\n\n${guidance.join("\n\n")}` };
    });

    const currentSnapshot = async (root: string) => {
        try {
            const status = await pi.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
                cwd: root,
                timeout: 30_000,
            });
            if (status.code !== 0 || typeof status.stdout !== "string") {
                return { root, paths: [], fingerprints: {}, indeterminate: true, reason: "Git status failed" };
            }

            const snapshot = createWorktreeSnapshot(root, status.stdout);
            const fingerprints: Record<string, string> = {};
            for (const relativePath of snapshot.paths) {
                const fingerprint = handoffFingerprint(snapshot.fingerprints[relativePath]);
                const candidate = path.resolve(root, relativePath);
                const candidateRelative = path.relative(root, candidate);
                if (
                    candidateRelative === ".." ||
                    candidateRelative.startsWith(`..${path.sep}`) ||
                    path.isAbsolute(candidateRelative)
                ) {
                    fingerprints[relativePath] = `type:unknown;mode:unknown;${fingerprint}`;

                    continue;
                }

                try {
                    const stat = fs.lstatSync(candidate);
                    const type = stat.isSymbolicLink()
                        ? "symlink"
                        : stat.isFile()
                          ? "file"
                          : stat.isDirectory()
                            ? "directory"
                            : "other";
                    fingerprints[relativePath] = `type:${type};mode:${(stat.mode & 0o7777).toString(8)};${fingerprint}`;
                } catch {
                    fingerprints[relativePath] = `type:missing;mode:unknown;${fingerprint}`;
                }
            }

            return { ...snapshot, fingerprints };
        } catch {
            return { root, paths: [], fingerprints: {}, indeterminate: true, reason: "Git status was unavailable" };
        }
    };

    const handoffFingerprint = (value: unknown) => {
        if (typeof value !== "string") {
            return "unavailable";
        }

        if (/^[a-f0-9]{64}$/u.test(value)) {
            return `sha256:${value}`;
        }

        if (value === "missing") {
            return "missing";
        }

        if (value.startsWith("symlink:")) {
            return "symlink";
        }

        if (/^[0-9]+:[0-9]+:/u.test(value)) {
            return `metadata:${value}`;
        }

        return safeMessage(value);
    };

    const renderTaskHandoff = (contract: any, snapshot: any, root: string) => {
        const indeterminate = Boolean(scope.indeterminate || snapshot?.indeterminate);
        const lines = [
            "## Task Handoff",
            "",
            `Generated for task \`${contract.id}\` at root \`${markdownPathLabel(root)}\`.`,
            "",
            renderTaskContract(contract),
            "",
            "### Current changes",
        ];
        if (indeterminate) {
            lines.push(
                `- Snapshot indeterminate: ${safeMessage(snapshot?.reason ?? "some changes may be unobserved")}.`,
                "- Change paths and fingerprints below are incomplete.",
            );
        } else if (snapshot?.paths.length === 0) {
            lines.push("- No changed paths observed.");
        } else {
            for (const relativePath of snapshot.paths.slice(0, 256)) {
                lines.push(
                    `- \`${markdownPathLabel(relativePath)}\` — ${handoffFingerprint(snapshot.fingerprints[relativePath])}`,
                );
            }
        }

        const violations = indeterminate ? [] : taskContractScopeViolations(contract, snapshot.paths);
        lines.push("", "### Latest review");
        if (!latestChallenge?.result) {
            lines.push("- No completion challenge review is recorded for this task contract.");
        } else {
            lines.push(`- Verdict: **${latestChallenge.result.verdict}**.`);
            for (const item of latestChallenge.result.requirements ?? []) {
                const id = item.id ? `${item.id}: ` : "";
                lines.push(`- ${id}${item.status}: ${safeMessage(item.evidence || "No evidence recorded")}`);
            }

            if (latestChallenge.result.validationGaps?.length) {
                lines.push(`- Validation gaps: ${latestChallenge.result.validationGaps.map(safeMessage).join("; ")}`);
            }
        }

        lines.push("", "### Unresolved facts");
        const unresolved = [];
        if (scope.pending.length > 0) {
            unresolved.push(`Pending scope findings: ${scope.pending.map(markdownPathLabel).join(", ")}`);
        }

        if (violations.length > 0) {
            unresolved.push(`Task paths outside declared paths: ${violations.map(markdownPathLabel).join(", ")}`);
        }

        if (scope.taskDigest !== undefined && scope.taskDigest !== contract.digest) {
            unresolved.push(
                "The imported scope is bound to an older task contract digest; it was not widened automatically.",
            );
        }

        if (indeterminate) {
            unresolved.push("The current worktree snapshot may omit changed paths or fingerprints.");
        }

        if (latestChallenge?.result) {
            for (const item of latestChallenge.result.requirements ?? []) {
                if (item.status !== "proven") {
                    unresolved.push(`${item.id ? `${item.id} ` : ""}requirement remains ${item.status}.`);
                }
            }

            unresolved.push(
                ...(latestChallenge.result.contradictions ?? []).map((item: string) => `Contradiction: ${item}`),
            );
            unresolved.push(
                ...(latestChallenge.result.residualRisks ?? []).map((item: string) => `Residual risk: ${item}`),
            );
        }

        lines.push(
            ...(unresolved.length > 0
                ? unresolved.map((item) => `- ${safeMessage(item)}`)
                : ["- No unresolved facts recorded."]),
        );
        lines.push(
            "",
            "> This handoff is a bounded view of the current conversation state. It does not launch, export, or commit work.",
        );

        return lines.join("\n");
    };

    pi.registerCommand("task", {
        description: "Set, inspect, or hand off the current task contract",
        getArgumentCompletions: (prefix: string) =>
            ["set", "clear", "status", "handoff"]
                .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
                .map((value) => ({ value, label: value })),
        handler: async (args, ctx) => {
            const origin = captureSession(ctx);
            const action = args.trim().toLowerCase() || "status";
            try {
                const root = await resolveRoot(origin.cwd);
                if (!sessionIsCurrent(origin, ctx)) {
                    return;
                }

                const current = refreshTaskContract(ctx, root);
                if (action === "status") {
                    if (!current) {
                        ctx.ui.notify("No task contract is active for this project.", "info");

                        return;
                    }

                    ctx.ui.notify(
                        `Task ${current.id.slice(0, 8)}: ${current.objective}; ${current.requirements.length} fixed requirement(s); digest ${current.digest.slice(0, 12)}.`,
                        "info",
                    );

                    return;
                }

                if (action === "clear") {
                    persistTaskContract(undefined, ctx, "task contract cleared by human");
                    ctx.ui.notify(
                        "Task contract cleared. Existing scope remains unchanged and is reported as stale if it was task-bound.",
                        "warning",
                    );

                    return;
                }

                if (action === "set") {
                    if (!ctx.hasUI || typeof ctx.ui.editor !== "function") {
                        ctx.ui.notify("/task set requires interactive editor support.", "error");

                        return;
                    }

                    const edited = await ctx.ui.editor("Task contract", taskContractEditorText(current));
                    if (!sessionIsCurrent(origin, ctx) || edited === undefined) {
                        return;
                    }

                    const card = parseTaskContractCard(edited);
                    const contractOrigin = current?.origin === "improvement" ? "improvement" : "human";
                    const contract = createTaskContract(card, {
                        root,
                        origin: contractOrigin,
                        ...(contractOrigin === "improvement"
                            ? { gapId: current.gapId, selectionId: current.selectionId, id: current.id }
                            : current
                              ? { id: current.id }
                              : {}),
                    });
                    persistTaskContract(contract, ctx, "task contract revised by human");
                    ctx.ui.notify(
                        `Task contract set: ${contract.objective} (${contract.requirements.length} requirement(s)).`,
                        "info",
                    );

                    return;
                }

                if (action === "handoff") {
                    if (!current) {
                        ctx.ui.notify("No task contract is active for this project.", "error");

                        return;
                    }

                    const snapshot = await currentSnapshot(root);
                    if (!sessionIsCurrent(origin, ctx)) {
                        return;
                    }

                    const markdown = renderTaskHandoff(current, snapshot, root);
                    const data: TaskHandoffEntryData = {
                        markdown,
                        contractId: current.id,
                        contractDigest: current.digest,
                        indeterminate: Boolean(scope.indeterminate || snapshot.indeterminate),
                        createdAt: new Date().toISOString(),
                    };
                    pi.appendEntry(TASK_HANDOFF_ENTRY, data);
                    if (!supportsEntryRenderer && typeof ctx.ui.editor === "function") {
                        await ctx.ui.editor("Task handoff (view only)", markdown);
                    }

                    ctx.ui.notify("Task handoff rendered in the current conversation.", "info");

                    return;
                }

                ctx.ui.notify("Usage: /task [set|clear|status|handoff]", "error");
            } catch (error) {
                if (!sessionIsCurrent(origin, ctx)) {
                    return;
                }

                taskContractError = safeMessage(error);
                ctx.ui.notify(taskContractError, "error");
            }
        },
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

                    const currentTask = refreshTaskContract(ctx, repository.repoRoot);
                    const template = experimentCardEditorText(currentTask, query);
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
                        // still there, so it can only be released, never activated, and SpecPi never deletes it.
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
                        id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
                        requirement: Type.Optional(Type.String({ minLength: 1, maxLength: 360 })),
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
            taskContractDigest: Type.Optional(Type.String({ minLength: 64, maxLength: 64 })),
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

            let currentTask;
            try {
                currentTask = readCurrentTaskContract(ctx, activeChallenge.root);
            } catch {
                invalidateChallenge(ctx, "task contract could not be revalidated");

                throw new Error("Task contract could not be revalidated for this challenge");
            }

            if (currentTask?.digest !== activeChallenge.taskContractDigest) {
                invalidateChallenge(ctx, "task contract changed during challenge");

                throw new Error("No matching completion challenge is active for the current task contract");
            }

            const result = validateChallengeSubmission(params, {
                ...activeChallenge.facts,
                challengeGeneration: activeChallenge.generation,
                taskContractDigest: activeChallenge.taskContractDigest,
            });
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
            emitScopeStatus(ctx, { taskReviewChanged: true });

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
            const origin = captureSession(ctx);
            const action = args.trim().toLowerCase();
            if (action === "status") {
                try {
                    const root = await resolveRoot(origin.cwd);
                    if (!sessionIsCurrent(origin, ctx)) {
                        return;
                    }

                    refreshTaskContract(ctx, root);
                } catch (error) {
                    if (!sessionIsCurrent(origin, ctx)) {
                        return;
                    }

                    ctx.ui.notify(`Task contract unavailable: ${safeMessage(error)}`, "error");

                    return;
                }

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
            let challengeRoot: string | undefined;
            let challengeTask;
            let challengeTaskScopeStale = scope.taskDigest !== undefined;
            try {
                const root = await resolveRoot(origin.cwd);
                if (!sessionIsCurrent(origin, ctx)) {
                    return;
                }

                challengeRoot = root;
                challengeTask = refreshTaskContract(ctx, root);
                challengeTaskScopeStale = scope.taskDigest !== undefined && challengeTask?.digest !== scope.taskDigest;
            } catch (error) {
                if (!sessionIsCurrent(origin, ctx)) {
                    return;
                }

                ctx.ui.notify(`Task contract unavailable: ${safeMessage(error)}. Challenge was not started.`, "error");

                return;
            }

            try {
                const status = await pi.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
                    cwd: challengeRoot,
                    timeout: 30_000,
                });
                if (!sessionIsCurrent(origin, ctx)) {
                    return;
                }

                snapshot = status.code === 0 ? createWorktreeSnapshot(challengeRoot, status.stdout) : undefined;
            } catch {
                snapshot = undefined;
            }

            if (!sessionIsCurrent(origin, ctx)) {
                return;
            }

            let experiment;
            try {
                experiment = findExperiment(stateDir, "", origin.cwd);
            } catch {
                experiment = undefined;
            }

            const facts = boundedChallengeFacts({
                changedPaths: snapshot?.paths ?? [],
                scopeEntries: scope.active
                    ? scope.entries.map((item) => `${item.path}${item.directory ? "/" : ""}`)
                    : [],
                pendingScope: scope.active ? scope.pending : [],
                experiment,
                observedToolFailures,
                snapshotIndeterminate: scope.indeterminate || !snapshot || snapshot.indeterminate,
                taskContract: challengeTask,
                taskContractDigest: challengeTask?.digest,
                scopeTaskStale: challengeTaskScopeStale,
            });
            const generation = randomUUID();
            const prompt = challengePrompt(generation, facts);
            activeChallenge = {
                generation,
                sessionId: origin.sessionId,
                root: challengeRoot ?? scope.root,
                taskContractDigest: facts.taskContractDigest,
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
        pi.registerEntryRenderer<TaskContractEntryData>(TASK_CONTRACT_ENTRY, (entry, _options, theme) => {
            const data = entry.data;
            const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
            if (data?.kind === "set" && data.contract) {
                try {
                    box.addChild(new Markdown(renderTaskContract(data.contract), 0, 0, getMarkdownTheme()));
                } catch (error) {
                    box.addChild(
                        new Text(theme.fg("warning", `Task contract unavailable: ${safeMessage(error)}`), 0, 0),
                    );
                }
            } else {
                box.addChild(new Text(theme.fg("dim", "Task contract cleared"), 0, 0));
            }

            return box;
        });

        pi.registerEntryRenderer<TaskHandoffEntryData>(TASK_HANDOFF_ENTRY, (entry, _options, theme) => {
            const data = entry.data;
            const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
            box.addChild(new Markdown(data?.markdown ?? "Task handoff unavailable.", 0, 0, getMarkdownTheme()));

            return box;
        });

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
