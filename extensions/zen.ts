/**
 * Zen - focused execution mode for Pi.
 *
 * Zen mode is deliberately visible and behavioral:
 * - a persistent specification panel and reduced footer replace normal chrome;
 * - live reasoning and answer streams become stable placeholders until completion;
 * - tool output stays collapsed and routine narration is suppressed;
 * - each model turn receives quiet, evidence-led execution guidance;
 * - disabling the mode restores the normal interface and transcript rendering.
 *
 * Toggle with /zen or Ctrl+Alt+Z.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { describeZenPhase, transformZenMarkdown } from "./zen/core.mjs";

const zenPiAgentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const zenPiStateDir = path.join(zenPiAgentDir, "zenpi");
const zenPiManagedBin = path.join(zenPiStateDir, "bin");

function hasValidatedZenPiTools(): boolean {
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(zenPiStateDir, "manifest.json"), "utf8"));
        const records = manifest.managedOptionalTools || [];
        if (records.length === 0) {
            return false;
        }

        const expectedNames = new Set<string>();
        for (const record of records) {
            if (path.dirname(record.target) !== zenPiManagedBin) {
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

        const actualNames = fs.readdirSync(zenPiManagedBin).filter((name) => !name.startsWith("."));

        return actualNames.length === expectedNames.size && actualNames.every((name) => expectedNames.has(name));
    } catch {
        return false;
    }
}

process.env.PATH = (process.env.PATH || "")
    .split(path.delimiter)
    .filter((entry) => path.resolve(entry || ".").toLowerCase() !== path.resolve(zenPiManagedBin).toLowerCase())
    .join(path.delimiter);
if (hasValidatedZenPiTools()) {
    process.env.PATH = `${zenPiManagedBin}${path.delimiter}${process.env.PATH || ""}`;
}

type ZenPhase = "ready" | "thinking" | "reasoning" | "synthesizing" | `using ${string}` | `${string} failed`;

const ZEN_STATE_ENTRY = "zen-mode";
const ZEN_SYSTEM_GUIDANCE = `

[ZEN MODE — SPEC EXECUTION]
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
    let phase: ZenPhase = "ready";
    let turnCount = 0;
    let toolCount = 0;
    let workflowScope: { active: boolean; pending: number; indeterminate: boolean } = {
        active: false,
        pending: 0,
        indeterminate: false,
    };
    let toolsWereExpanded: boolean | undefined;
    let requestZenRender: (() => void) | undefined;

    const updateActivity = (ctx: ExtensionContext) => {
        if (!enabled) {
            return;
        }

        const theme = ctx.ui.theme;
        const state = describeZenPhase(phase);
        const detail = state.detail ? ` · ${state.detail}` : "";
        ctx.ui.setStatus(
            "zen-mode",
            `${theme.fg("accent", theme.bold("π SPEC"))}${theme.fg("dim", ` · ${state.index} / ${state.label}${detail}`)}`,
        );
        ctx.ui.setWorkingMessage(`${state.index} / ${state.label}${detail}`);
        requestZenRender?.();
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
                        truncateToWidth(theme.fg("dim", "ZENPI · QUIET TECHNICAL EXECUTION"), width, ""),
                        renderEdge("└", "┘", "─ 00 ", width, (text) => theme.fg("borderMuted", text)),
                    ];
                }

                const innerWidth = width - 4;
                const row = (left: string, right: string) =>
                    `${theme.fg("borderMuted", "│")} ${splitLine(left, right, innerWidth)} ${theme.fg("borderMuted", "│")}`;

                return [
                    renderEdge("┌", "┐", "─ π  ZENPI / SPEC EXECUTION ", width, (text) =>
                        theme.fg("borderAccent", text),
                    ),
                    row(theme.fg("text", theme.bold("SYSTEM  ZENPI")), theme.fg("dim", "MODE  FOCUSED")),
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
                    const state = describeZenPhase(phase);
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

        ctx.ui.setWidget("zen-mode", (tui, theme) => {
            const renderNow = () => tui.requestRender();
            requestZenRender = renderNow;

            return {
                dispose() {
                    if (requestZenRender === renderNow) {
                        requestZenRender = undefined;
                    }
                },
                invalidate() {},
                render(width: number): string[] {
                    const state = describeZenPhase(phase);
                    const detail = state.detail ? ` · ${state.detail}` : "";
                    const phaseText = `${state.index} / ${state.label}${detail}`;
                    const run = `${countLabel(turnCount, "T")} · ${countLabel(toolCount, "X")}`;
                    const scope = !workflowScope.active
                        ? "UNSET"
                        : workflowScope.pending > 0 || workflowScope.indeterminate
                          ? "REVIEW"
                          : "CLEAN";

                    if (width < 44) {
                        return [
                            renderEdge("┌", "┐", "─ ACTIVE SPEC ", width, (text) => theme.fg("borderAccent", text)),
                            truncateToWidth(theme.fg("accent", phaseText), width, ""),
                            truncateToWidth(theme.fg("dim", `${run} · SCOPE ${scope} · OUTPUT HELD`), width, ""),
                            renderEdge("└", "┘", "─ /zen exits ", width, (text) => theme.fg("borderMuted", text)),
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
        requestZenRender = undefined;
        ctx.ui.setStatus("zen-mode", undefined);
        ctx.ui.setWidget("zen-mode", undefined);
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
        pi.appendEntry(ZEN_STATE_ENTRY, { enabled, toolsWereExpanded });
    };

    const setMode = (next: boolean, ctx: ExtensionContext, persist = true) => {
        if (enabled === next) {
            ctx.ui.notify(`Zen mode is already ${enabled ? "on" : "off"}.`, "info");

            return;
        }

        enabled = next;
        phase = "ready";
        if (enabled) {
            applyMode(ctx);
            ctx.ui.notify("SPEC MODE / ACTIVE · live response held · tools collapsed", "info");
        } else {
            clearMode(ctx);
            ctx.ui.notify("Zen mode disabled. Previous interface restored.", "info");
        }

        if (persist) {
            persistMode();
        }
    };

    const toggleMode = (ctx: ExtensionContext) => setMode(!enabled, ctx);

    pi.registerMarkdownTransformer((markdown, context) => transformZenMarkdown(markdown, context, enabled));

    pi.on("session_start", async (_event, ctx) => {
        enabled = false;
        phase = "ready";
        turnCount = 0;
        toolCount = 0;
        workflowScope = { active: false, pending: 0, indeterminate: false };
        toolsWereExpanded = undefined;
        requestZenRender = undefined;

        for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type === "custom" && entry.customType === ZEN_STATE_ENTRY) {
                const state = entry.data as { enabled?: boolean; toolsWereExpanded?: boolean } | undefined;
                enabled = Boolean(state?.enabled);
                toolsWereExpanded = state?.toolsWereExpanded;
            }
        }

        if (enabled) {
            applyMode(ctx);
        }
    });

    pi.events.on("zenpi:workflow-status", (state: any) => {
        workflowScope = {
            active: state?.active === true,
            pending: Number.isInteger(state?.pending) ? Math.max(0, state.pending) : 0,
            indeterminate: state?.indeterminate === true,
        };
        requestZenRender?.();
    });

    pi.on("session_shutdown", (_event, ctx) => {
        if (enabled) {
            clearMode(ctx);
        } else {
            requestZenRender = undefined;
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

    pi.on("before_agent_start", async (event) => {
        if (!enabled || event.systemPrompt.includes("[ZEN MODE — SPEC EXECUTION]")) {
            return;
        }

        return { systemPrompt: `${event.systemPrompt}${ZEN_SYSTEM_GUIDANCE}` };
    });

    pi.registerCommand("zen", {
        description: "Toggle immersive spec execution (held live stream, collapsed tools, reduced chrome)",
        getArgumentCompletions: (prefix: string) => {
            const options = ["on", "off", "status"];
            const matches = options.filter((option) => option.startsWith(prefix.trim().toLowerCase()));

            return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
        },
        handler: async (args, ctx) => {
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
                const state = describeZenPhase(phase);
                const detail = state.detail ? ` · ${state.detail}` : "";
                ctx.ui.notify(
                    enabled
                        ? `SPEC MODE / ACTIVE · ${state.index} / ${state.label}${detail} · ${countLabel(turnCount, "T")} · ${countLabel(toolCount, "X")}`
                        : "Zen mode is off.",
                    "info",
                );

                return;
            }

            ctx.ui.notify("Usage: /zen [on|off|status]", "error");
        },
    });

    pi.registerShortcut(Key.ctrlAlt("z"), {
        description: "Toggle Zen focused execution mode",
        handler: async (ctx) => toggleMode(ctx),
    });
}
