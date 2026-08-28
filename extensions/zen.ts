/**
 * Zen - focused execution mode for Pi.
 *
 * Zen mode is deliberately visible and behavioral:
 * - a persistent activity panel and footer status show that the mode is active;
 * - tool output starts collapsed to reduce transcript noise;
 * - the working indicator reports the current phase;
 * - each model turn receives focused-execution guidance;
 * - disabling the mode restores the user's prior UI state.
 *
 * Toggle with /zen or Ctrl+Alt+Z.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type ZenPhase = "ready" | "thinking" | "reasoning" | "synthesizing" | `using ${string}` | `${string} failed`;

const ZEN_STATE_ENTRY = "zen-mode";
const ZEN_SYSTEM_GUIDANCE = `

[ZEN MODE — FOCUSED EXECUTION]
Work on one clear objective at a time.
- Inspect relevant state before changing it.
- Prefer the smallest coherent change; avoid unrelated additions and cleanup.
- Ask when ambiguity would materially change the result.
- Validate with direct evidence before declaring completion.
- Keep narration concise and emphasize decisions, evidence, and results.`;

function renderEdge(
	left: string,
	right: string,
	label: string,
	width: number,
	color: (text: string) => string,
): string {
	if (width <= 0) return "";
	if (width === 1) return color("─");

	const innerWidth = width - visibleWidth(left) - visibleWidth(right);
	const fittedLabel = truncateToWidth(label, Math.max(0, innerWidth), "");
	const fill = "─".repeat(Math.max(0, innerWidth - visibleWidth(fittedLabel)));
	return truncateToWidth(color(`${left}${fittedLabel}${fill}${right}`), width, "");
}

function formatPhase(phase: ZenPhase): string {
	return phase.replace(/^using /, "using ");
}

export default function (pi: ExtensionAPI) {
	let enabled = false;
	let phase: ZenPhase = "ready";
	let turnCount = 0;
	let toolCount = 0;
	let toolsWereExpanded: boolean | undefined;
	let widgetTimer: ReturnType<typeof setInterval> | undefined;

	const stopWidgetTimer = () => {
		if (widgetTimer) {
			clearInterval(widgetTimer);
			widgetTimer = undefined;
		}
	};

	const updateActivity = (ctx: ExtensionContext) => {
		if (!enabled) return;
		const theme = ctx.ui.theme;
		const state = formatPhase(phase);
		ctx.ui.setStatus(
			"zen-mode",
			`${theme.fg("accent", theme.bold("◆ ZEN"))}${theme.fg("dim", ` · ${state}`)}`,
		);
		ctx.ui.setWorkingMessage(`ZEN · ${state}`);
	};

	const applyMode = (ctx: ExtensionContext) => {
		if (!enabled) return;

		if (toolsWereExpanded === undefined) toolsWereExpanded = ctx.ui.getToolsExpanded();
		ctx.ui.setToolsExpanded(false);
		ctx.ui.setWorkingIndicator({
			frames: [
				ctx.ui.theme.fg("dim", "◇"),
				ctx.ui.theme.fg("muted", "◈"),
				ctx.ui.theme.fg("accent", "◆"),
				ctx.ui.theme.fg("muted", "◈"),
			],
			intervalMs: 420,
		});
		updateActivity(ctx);

		ctx.ui.setHeader((_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				if (width < 36) {
					return [truncateToWidth(theme.fg("accent", theme.bold("◆ ZEN MODE")), width, "")];
				}
				const title = theme.fg("accent", theme.bold("Z E N   ◆"));
				const subtitle = theme.fg("dim", "focus · evidence · finish");
				const center = (line: string) => {
					const padding = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
					return truncateToWidth(`${" ".repeat(padding)}${line}`, width, "");
				};
				return ["", center(title), center(subtitle), ""];
			},
		}));

		ctx.ui.setWidget("zen-mode", (tui, theme) => {
			stopWidgetTimer();
			widgetTimer = setInterval(() => tui.requestRender(), 30_000);

			return {
				dispose: stopWidgetTimer,
				invalidate() {},
				render(width: number): string[] {
					const state = formatPhase(phase);
					if (width < 32) {
						return [
							truncateToWidth(theme.fg("accent", `◆ ZEN · ${state}`), width, ""),
							truncateToWidth(theme.fg("dim", `${turnCount} turns · ${toolCount} tools · /zen exits`), width, ""),
						];
					}

					const detail = `◆ ${state} · ${turnCount} turn${turnCount === 1 ? "" : "s"} · ${toolCount} tool${toolCount === 1 ? "" : "s"} · output collapsed`;
					const innerWidth = width - 4;
					const fitted = truncateToWidth(detail, innerWidth, "");
					const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(fitted)));

					return [
						renderEdge("╭", "╮", "─ ZEN MODE ", width, (text) => theme.fg("borderAccent", text)),
						truncateToWidth(
							`${theme.fg("borderAccent", "│")} ${theme.fg("muted", fitted)}${padding} ${theme.fg("borderAccent", "│")}`,
							width,
							"",
						),
						renderEdge(
							"╰",
							"╯",
							"─ focused execution · /zen exits ",
							width,
							(text) => theme.fg("borderMuted", text),
						),
					];
				},
			};
		});
	};

	const clearMode = (ctx: ExtensionContext) => {
		stopWidgetTimer();
		ctx.ui.setStatus("zen-mode", undefined);
		ctx.ui.setWidget("zen-mode", undefined);
		ctx.ui.setWorkingIndicator();
		ctx.ui.setWorkingMessage();
		ctx.ui.setHeader(undefined);
		if (toolsWereExpanded !== undefined) ctx.ui.setToolsExpanded(toolsWereExpanded);
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
			ctx.ui.notify("Zen mode enabled: focused guidance, live activity, collapsed tool output.", "info");
		} else {
			clearMode(ctx);
			ctx.ui.notify("Zen mode disabled. Previous interface restored.", "info");
		}
		if (persist) persistMode();
	};

	const toggleMode = (ctx: ExtensionContext) => setMode(!enabled, ctx);

	pi.on("session_start", async (_event, ctx) => {
		enabled = false;
		phase = "ready";
		turnCount = 0;
		toolCount = 0;
		toolsWereExpanded = undefined;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ZEN_STATE_ENTRY) {
				const state = entry.data as { enabled?: boolean; toolsWereExpanded?: boolean } | undefined;
				enabled = Boolean(state?.enabled);
				toolsWereExpanded = state?.toolsWereExpanded;
			}
		}

		if (enabled) applyMode(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (enabled) clearMode(ctx);
		else stopWidgetTimer();
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (!enabled) return;
		phase = "thinking";
		updateActivity(ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!enabled) return;
		turnCount += 1;
		phase = "reasoning";
		updateActivity(ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (!enabled) return;
		toolCount += 1;
		phase = `using ${event.toolName}`;
		updateActivity(ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!enabled) return;
		phase = event.isError ? `${event.toolName} failed` : "synthesizing";
		updateActivity(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!enabled) return;
		phase = "ready";
		updateActivity(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (!enabled || event.systemPrompt.includes("[ZEN MODE — FOCUSED EXECUTION]")) return;
		return { systemPrompt: `${event.systemPrompt}${ZEN_SYSTEM_GUIDANCE}` };
	});

	pi.registerCommand("zen", {
		description: "Toggle focused execution mode (visible state, collapsed output, focused guidance)",
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
				ctx.ui.notify(
					enabled
						? `Zen mode is on · ${formatPhase(phase)} · ${turnCount} turns · ${toolCount} tools.`
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
