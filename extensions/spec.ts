/**
 * Spec - focused execution mode for Pi.
 *
 * Spec mode is deliberately visible and behavioral:
 * - a persistent specification panel and reduced footer replace normal chrome;
 * - live reasoning and answer streams become stable placeholders until completion;
 * - tool output stays collapsed and routine narration is suppressed;
 * - each model turn receives quiet, evidence-led execution guidance;
 * - disabling the mode restores the normal interface and transcript rendering.
 *
 * Toggle with /spec or Ctrl+Alt+Z.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { describeSpecPhase, transformSpecMarkdown } from "./spec/core.mjs";
import { canonicalRoot } from "./workflow-controls/scope.mjs";
import { readTaskContract } from "./workflow-controls/task-contract.mjs";

const specPiAgentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const specPiStateDir = path.join(specPiAgentDir, "specpi");
const specPiManagedBin = path.join(specPiStateDir, "bin");

function hasValidatedSpecPiTools(): boolean {
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(specPiStateDir, "manifest.json"), "utf8"));
        const records = manifest.managedOptionalTools || [];
        if (records.length === 0) {
            return false;
        }

        const expectedNames = new Set<string>();
        for (const record of records) {
            if (path.dirname(record.target) !== specPiManagedBin) {
                return false;
            }

            const stat = fs.lstatSync(record.target);
            if (!stat.isFile() || stat.isSymbolicLink()) {
                return false;
            }

            const hash = createHash("sha256").update(fs.readFileSync(record.target)).digest("hex");
            if (hash !== record.installedHash) {
                return false;
            }

            expectedNames.add(path.basename(record.target));
        }

        const actualNames = fs.readdirSync(specPiManagedBin).filter((name) => !name.startsWith("."));

        return actualNames.length === expectedNames.size && actualNames.every((name) => expectedNames.has(name));
    } catch {
        return false;
    }
}

process.env.PATH = (process.env.PATH || "")
    .split(path.delimiter)
    .filter((entry) => path.resolve(entry || ".").toLowerCase() !== path.resolve(specPiManagedBin).toLowerCase())
    .join(path.delimiter);
if (hasValidatedSpecPiTools()) {
    process.env.PATH = `${specPiManagedBin}${path.delimiter}${process.env.PATH || ""}`;
}

type SpecPhase = "ready" | "thinking" | "reasoning" | "synthesizing" | `using ${string}` | `${string} failed`;

interface SpecTaskState {
    active: boolean;
    objective: string;
    proven: number;
    total: number;
    digest?: string;
    error?: string;
}

const SPEC_STATE_ENTRY = "spec-mode";
const CHALLENGE_ENTRY = "specpi-completion-challenge";
const SPEC_SYSTEM_GUIDANCE = `

[SPEC MODE — SPEC EXECUTION]
Operate as a quiet technical instrument on one objective.
- Inspect relevant state before changing it.
- Prefer the smallest coherent change; avoid unrelated additions and cleanup.
- Use tools without narrating routine progress. Speak mid-task only for a material decision, blocker, or safety boundary.
- Do not repeat tool output. Convert evidence into conclusions.
- Ask when ambiguity would materially change the result.
- Validate with direct evidence before declaring completion.
- Keep the final response specification-minimal: outcome, evidence, and residual risk only when useful.`;

function renderEdge(
    left: string,
    right: string,
    label: string,
    width: number,
    color: (text: string) => string,
): string {
    if (width <= 0) {
        return "";
    }

    if (width === 1) {
        return color("─");
    }

    const innerWidth = width - visibleWidth(left) - visibleWidth(right);
    const fittedLabel = truncateToWidth(label, Math.max(0, innerWidth), "");
    const fill = "─".repeat(Math.max(0, innerWidth - visibleWidth(fittedLabel)));

    return truncateToWidth(color(`${left}${fittedLabel}${fill}${right}`), width, "");
}

function splitLine(left: string, right: string, width: number): string {
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));

    return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width, "");
}

function countLabel(value: number, unit: string): string {
    return `${unit}${String(value).padStart(2, "0")}`;
}

export default function (pi: ExtensionAPI) {
    let enabled = false;
    let phase: SpecPhase = "ready";
    let turnCount = 0;
    let toolCount = 0;
    let workflowScope: {
        active: boolean;
        pending: number;
        indeterminate: boolean;
        taskBound: boolean;
        taskStale: boolean;
    } = {
        active: false,
        pending: 0,
        indeterminate: false,
        taskBound: false,
        taskStale: false,
    };
    let workflowTask: SpecTaskState = {
        active: false,
        objective: "",
        proven: 0,
        total: 0,
    };
    let taskRefreshPending = true;
    let taskRefreshGeneration = 0;
    let toolsWereExpanded: boolean | undefined;
    let requestSpecRender: (() => void) | undefined;
    let lastContext: ExtensionContext | undefined;

    const resolveRoot = async (cwd: string) => {
        try {
            const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 15_000 });
            if (result.code === 0 && typeof result.stdout === "string" && result.stdout.trim()) {
                return canonicalRoot(path.resolve(cwd, result.stdout.trim()));
            }
        } catch {
            /* A non-Git session can still display a task contract rooted at its current directory. */
        }

        return canonicalRoot(cwd);
    };

    const refreshTask = async (ctx: ExtensionContext, expectedGeneration = taskRefreshGeneration) => {
        const cwd = ctx.cwd;
        const sessionId = ctx.sessionManager.getSessionId();
        const isCurrent = () =>
            expectedGeneration === taskRefreshGeneration &&
            cwd === ctx.cwd &&
            sessionId === ctx.sessionManager.getSessionId();
        const root = await resolveRoot(cwd);
        if (!isCurrent()) {
            return false;
        }

        let contract;
        try {
            contract = readTaskContract(ctx.sessionManager.getBranch?.() ?? [], root);
        } catch (error) {
            if (!isCurrent()) {
                return false;
            }

            workflowTask = {
                active: false,
                objective: "",
                proven: 0,
                total: 0,
                error:
                    error instanceof Error
                        ? error.message.replace(/[\u0000-\u001f\u007f]+/gu, " ").slice(0, 160)
                        : "unavailable",
            };
            taskRefreshPending = false;

            return true;
        }

        if (!isCurrent()) {
            return false;
        }

        if (!contract) {
            workflowTask = { active: false, objective: "", proven: 0, total: 0 };
            taskRefreshPending = false;

            return true;
        }

        let latestReview;
        for (const entry of ctx.sessionManager.getBranch?.() ?? []) {
            if (entry.type !== "custom" || entry.customType !== CHALLENGE_ENTRY) {
                continue;
            }

            if (entry.data?.kind === "result") {
                latestReview = entry.data;
            } else if (entry.data?.kind === "cleared") {
                latestReview = undefined;
            }
        }

        if (latestReview?.facts?.taskContractDigest !== contract.digest) {
            latestReview = undefined;
        }

        const provenIds = new Set(
            latestReview?.result?.requirements
                ?.filter((item: any) => item?.status === "proven" && typeof item.id === "string")
                .map((item: any) => item.id) ?? [],
        );
        workflowTask = {
            active: true,
            objective: contract.objective,
            proven: contract.requirements.filter((item: any) => provenIds.has(item.id)).length,
            total: contract.requirements.length,
            digest: contract.digest,
        };
        taskRefreshPending = false;

        return true;
    };

    const queueTaskRefresh = (ctx = lastContext) => {
        taskRefreshPending = true;
        const generation = ++taskRefreshGeneration;
        if (!ctx) {
            requestSpecRender?.();

            return;
        }

        void refreshTask(ctx, generation)
            .then((applied) => {
                if (applied) {
                    requestSpecRender?.();
                }
            })
            .catch(() => {
                if (generation === taskRefreshGeneration) {
                    requestSpecRender?.();
                }
            });
        requestSpecRender?.();
    };

    const taskStatusLabel = () => {
        if (workflowTask.error) {
            return "INVALID";
        }

        if (!workflowTask.active) {
            return "UNSET";
        }

        return `${workflowTask.proven}/${workflowTask.total}`;
    };

    const taskObjectiveLabel = () => {
        const objective = workflowTask.objective.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();

        return objective.length > 42 ? `${objective.slice(0, 39)}...` : objective;
    };

    const updateActivity = (ctx: ExtensionContext) => {
        if (!enabled) {
            return;
        }

        const theme = ctx.ui.theme;
        const state = describeSpecPhase(phase);
        const detail = state.detail ? ` · ${state.detail}` : "";
        ctx.ui.setStatus(
            "spec-mode",
            `${theme.fg("accent", theme.bold("π SPEC"))}${theme.fg("dim", ` · ${state.index} / ${state.label}${detail}`)}`,
        );
        ctx.ui.setWorkingMessage(`${state.index} / ${state.label}${detail}`);
        requestSpecRender?.();
    };

    const applyMode = (ctx: ExtensionContext) => {
        if (!enabled) {
            return;
        }

        if (toolsWereExpanded === undefined) {
            toolsWereExpanded = ctx.ui.getToolsExpanded();
        }

        ctx.ui.setToolsExpanded(false);
        ctx.ui.setWorkingVisible(false);
        ctx.ui.setWorkingIndicator({ frames: [] });
        ctx.ui.setHiddenThinkingLabel("01 / REASONING · SEALED");

        ctx.ui.setHeader((_tui, theme) => ({
            invalidate() {},
            render(width: number): string[] {
                if (width < 44) {
                    return [
                        renderEdge("┌", "┐", "─ π / SPEC ", width, (text) => theme.fg("borderAccent", text)),
                        truncateToWidth(theme.fg("dim", "SPECPI · QUIET TECHNICAL EXECUTION"), width, ""),
                        renderEdge("└", "┘", "─ 00 ", width, (text) => theme.fg("borderMuted", text)),
                    ];
                }

                const innerWidth = width - 4;
                const row = (left: string, right: string) =>
                    `${theme.fg("borderMuted", "│")} ${splitLine(left, right, innerWidth)} ${theme.fg("borderMuted", "│")}`;

                return [
                    renderEdge("┌", "┐", "─ π  SPECPI / SPEC EXECUTION ", width, (text) =>
                        theme.fg("borderAccent", text),
                    ),
                    row(theme.fg("text", theme.bold("SYSTEM  SPECPI")), theme.fg("dim", "MODE  FOCUSED")),
                    row(theme.fg("muted", "STREAM  HELD UNTIL COMPLETE"), theme.fg("dim", "TOOLS  COLLAPSED")),
                    renderEdge("└", "┘", "─ HUMAN-DIRECTED · EVIDENCE-LED ", width, (text) =>
                        theme.fg("borderMuted", text),
                    ),
                ];
            },
        }));

        ctx.ui.setFooter((tui, theme, footerData) => {
            const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

            return {
                dispose: unsubscribe,
                invalidate() {},
                render(width: number): string[] {
                    const state = describeSpecPhase(phase);
                    const detail = state.detail ? ` · ${state.detail}` : "";
                    const usage = ctx.getContextUsage();
                    const context =
                        usage?.percent === null || usage?.percent === undefined
                            ? "CTX --"
                            : `CTX ${usage.percent.toFixed(0)}%`;
                    const branch = footerData.getGitBranch();
                    const model = ctx.model?.id || "NO MODEL";
                    const left = theme.fg("accent", `${state.index} / ${state.label}${detail}`);
                    const right = theme.fg("dim", `${context} · ${model}${branch ? ` · ${branch}` : ""}`);

                    return [splitLine(left, right, width)];
                },
            };
        });

        ctx.ui.setWidget("spec-mode", (tui, theme) => {
            const renderNow = () => tui.requestRender();
            requestSpecRender = renderNow;

            return {
                dispose() {
                    if (requestSpecRender === renderNow) {
                        requestSpecRender = undefined;
                    }
                },
                invalidate() {},
                render(width: number): string[] {
                    const state = describeSpecPhase(phase);
                    const detail = state.detail ? ` · ${state.detail}` : "";
                    const phaseText = `${state.index} / ${state.label}${detail}`;
                    const run = `${countLabel(turnCount, "T")} · ${countLabel(toolCount, "X")}`;
                    const scope = !workflowScope.active
                        ? "UNSET"
                        : workflowScope.pending > 0 || workflowScope.indeterminate || workflowScope.taskStale
                          ? "REVIEW"
                          : "CLEAN";
                    const taskStatus = taskStatusLabel();
                    const taskObjective = taskObjectiveLabel() || "UNSET";

                    if (width < 44) {
                        return [
                            renderEdge("┌", "┐", "─ ACTIVE SPEC ", width, (text) => theme.fg("borderAccent", text)),
                            truncateToWidth(theme.fg("accent", phaseText), width, ""),
                            truncateToWidth(theme.fg("dim", `${run} · TASK ${taskStatus} · SCOPE ${scope}`), width, ""),
                            truncateToWidth(theme.fg("muted", taskObjective), width, ""),
                            renderEdge("└", "┘", "─ /spec exits ", width, (text) => theme.fg("borderMuted", text)),
                        ];
                    }

                    const innerWidth = width - 4;
                    const row = (left: string, right: string) =>
                        `${theme.fg("borderMuted", "│")} ${splitLine(left, right, innerWidth)} ${theme.fg("borderMuted", "│")}`;

                    return [
                        renderEdge("┌", "┐", "─ ACTIVE SPECIFICATION ", width, (text) =>
                            theme.fg("borderAccent", text),
                        ),
                        row(theme.fg("accent", theme.bold(phaseText)), theme.fg("dim", `RUN  ${run}`)),
                        row(
                            theme.fg("muted", "OUTPUT  RESPONSE HELD · TOOLS COLLAPSED"),
                            theme.fg("dim", `SCOPE  ${scope}`),
                        ),
                        row(theme.fg("muted", `TASK  ${taskObjective}`), theme.fg("dim", `REQ  ${taskStatus}`)),
                        renderEdge("└", "┘", "─ CTRL+ALT+Z / EXIT SPEC MODE ", width, (text) =>
                            theme.fg("borderMuted", text),
                        ),
                    ];
                },
            };
        });

        updateActivity(ctx);
    };

    const clearMode = (ctx: ExtensionContext) => {
        requestSpecRender = undefined;
        ctx.ui.setStatus("spec-mode", undefined);
        ctx.ui.setWidget("spec-mode", undefined);
        ctx.ui.setFooter(undefined);
        ctx.ui.setWorkingIndicator();
        ctx.ui.setWorkingMessage();
        ctx.ui.setWorkingVisible(true);
        ctx.ui.setHiddenThinkingLabel();
        ctx.ui.setHeader(undefined);
        if (toolsWereExpanded !== undefined) {
            ctx.ui.setToolsExpanded(toolsWereExpanded);
        }

        toolsWereExpanded = undefined;
    };

    const persistMode = () => {
        pi.appendEntry(SPEC_STATE_ENTRY, { enabled, toolsWereExpanded });
    };

    const setMode = (next: boolean, ctx: ExtensionContext, persist = true) => {
        if (enabled === next) {
            ctx.ui.notify(`Spec mode is already ${enabled ? "on" : "off"}.`, "info");

            return;
        }

        enabled = next;
        phase = "ready";
        if (enabled) {
            applyMode(ctx);
            ctx.ui.notify("SPEC MODE / ACTIVE · live response held · tools collapsed", "info");
        } else {
            clearMode(ctx);
            ctx.ui.notify("Spec mode disabled. Previous interface restored.", "info");
        }

        if (persist) {
            persistMode();
        }
    };

    const toggleMode = (ctx: ExtensionContext) => setMode(!enabled, ctx);

    pi.registerMarkdownTransformer((markdown, context) => transformSpecMarkdown(markdown, context, enabled));

    const restoreSession = async (ctx: ExtensionContext) => {
        lastContext = ctx;
        const generation = ++taskRefreshGeneration;
        if (enabled) {
            clearMode(ctx);
        }

        enabled = false;
        phase = "ready";
        turnCount = 0;
        toolCount = 0;
        workflowScope = {
            active: false,
            pending: 0,
            indeterminate: false,
            taskBound: false,
            taskStale: false,
        };
        workflowTask = { active: false, objective: "", proven: 0, total: 0 };
        taskRefreshPending = true;
        toolsWereExpanded = undefined;
        requestSpecRender = undefined;

        for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type === "custom" && entry.customType === SPEC_STATE_ENTRY) {
                const state = entry.data as { enabled?: boolean; toolsWereExpanded?: boolean } | undefined;
                enabled = Boolean(state?.enabled);
                toolsWereExpanded = state?.toolsWereExpanded;
            }
        }

        if (enabled) {
            applyMode(ctx);
        }

        if (await refreshTask(ctx, generation)) {
            requestSpecRender?.();
        }
    };

    pi.on("session_start", (_event, ctx) => restoreSession(ctx));
    pi.on("session_tree", (_event, ctx) => restoreSession(ctx));

    pi.events.on("specpi:workflow-status", (state: any) => {
        workflowScope = {
            active: state?.active === true,
            pending: Number.isInteger(state?.pending) ? Math.max(0, state.pending) : 0,
            indeterminate: state?.indeterminate === true,
            taskBound: state?.taskBound === true,
            taskStale: state?.taskStale === true,
        };
        if (state?.taskBound === true || state?.taskReviewChanged === true) {
            // Scope status is also the notification used when a challenge result changes the proven requirement
            // count. Refresh from the branch so the panel follows that result immediately while generation checks
            // prevent a delayed root lookup from overwriting a newer session.
            queueTaskRefresh();
        } else {
            taskRefreshPending = true;
            requestSpecRender?.();
        }
    });

    pi.events.on("specpi:task-contract-changed", () => {
        queueTaskRefresh();
    });

    pi.on("session_shutdown", (_event, ctx) => {
        taskRefreshGeneration += 1;
        lastContext = undefined;
        if (enabled) {
            clearMode(ctx);
        } else {
            requestSpecRender = undefined;
        }
    });

    pi.on("agent_start", async (_event, ctx) => {
        if (!enabled) {
            return;
        }

        phase = "thinking";
        updateActivity(ctx);
    });

    pi.on("turn_start", async (_event, ctx) => {
        if (!enabled) {
            return;
        }

        turnCount += 1;
        phase = "reasoning";
        updateActivity(ctx);
    });

    pi.on("tool_execution_start", async (event, ctx) => {
        if (!enabled) {
            return;
        }

        toolCount += 1;
        ctx.ui.setToolsExpanded(false);
        phase = `using ${event.toolName}`;
        updateActivity(ctx);
    });

    pi.on("tool_execution_end", async (event, ctx) => {
        if (!enabled) {
            return;
        }

        phase = event.isError ? `${event.toolName} failed` : "synthesizing";
        updateActivity(ctx);
    });

    pi.on("agent_settled", async (_event, ctx) => {
        if (!enabled) {
            return;
        }

        phase = "ready";
        updateActivity(ctx);
    });

    pi.on("before_agent_start", async (event, ctx) => {
        lastContext = ctx;
        if (taskRefreshPending || enabled) {
            const generation = ++taskRefreshGeneration;
            if (!(await refreshTask(ctx, generation))) {
                return;
            }

            requestSpecRender?.();
        }

        if (!enabled || event.systemPrompt.includes("[SPEC MODE — SPEC EXECUTION]")) {
            return;
        }

        const taskGuidance = workflowTask.active
            ? `\n\n[SPEC TASK]\nObjective: ${taskObjectiveLabel()}\nFixed requirements proven: ${workflowTask.proven}/${workflowTask.total}. Assess the original requirement set by its stable IDs.`
            : workflowTask.error
              ? `\n\n[SPEC TASK]\nTask contract unavailable: ${workflowTask.error}`
              : "";

        return { systemPrompt: `${event.systemPrompt}${SPEC_SYSTEM_GUIDANCE}${taskGuidance}` };
    });

    pi.registerCommand("spec", {
        description: "Toggle immersive spec execution (held live stream, collapsed tools, reduced chrome)",
        getArgumentCompletions: (prefix: string) => {
            const options = ["on", "off", "status"];
            const matches = options.filter((option) => option.startsWith(prefix.trim().toLowerCase()));

            return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
        },
        handler: async (args, ctx) => {
            lastContext = ctx;
            const action = args.trim().toLowerCase();
            if (!action) {
                toggleMode(ctx);

                return;
            }

            if (action === "on") {
                setMode(true, ctx);

                return;
            }

            if (action === "off") {
                setMode(false, ctx);

                return;
            }

            if (action === "status") {
                const generation = ++taskRefreshGeneration;
                if (!(await refreshTask(ctx, generation))) {
                    return;
                }

                const state = describeSpecPhase(phase);
                const detail = state.detail ? ` · ${state.detail}` : "";
                ctx.ui.notify(
                    enabled
                        ? `SPEC MODE / ACTIVE · ${state.index} / ${state.label}${detail} · ${countLabel(turnCount, "T")} · ${countLabel(toolCount, "X")} · task: ${taskObjectiveLabel() || "unset"} · requirements: ${taskStatusLabel()}`
                        : "Spec mode is off.",
                    "info",
                );

                return;
            }

            ctx.ui.notify("Usage: /spec [on|off|status]", "error");
        },
    });

    pi.registerShortcut(Key.ctrlAlt("z"), {
        description: "Toggle Spec focused execution mode",
        handler: async (ctx) => toggleMode(ctx),
    });
}
