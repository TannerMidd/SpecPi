/**
 * ZenPi capability-gap collector.
 *
 * The model reports only material, generalizable friction through a structured
 * tool. Events are deduplicated per user task and aggregated into a global,
 * privacy-minimized TOOL_WISHLIST.md under the ZenPi state directory.
 */

import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { recordCapabilityGap, refreshWishlist } from "./core.mjs";

const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
const stateDir = path.join(agentDir, "zenpi");
const WISHLIST_REPORT_ENTRY = "zenpi-wishlist-report";
const MAX_REPORT_DISPLAY_BYTES = 50 * 1024;
const MAX_REPORT_DISPLAY_LINES = 2000;

interface WishlistReportEntry {
	markdown: string;
	reportPath: string;
	truncated: boolean;
}

function truncateReportDisplay(markdown: string) {
	const lines = markdown.split("\n");
	const lineLimited = lines.length > MAX_REPORT_DISPLAY_LINES
		? lines.slice(0, MAX_REPORT_DISPLAY_LINES).join("\n")
		: markdown;
	const encoded = Buffer.from(lineLimited, "utf8");
	if (encoded.length <= MAX_REPORT_DISPLAY_BYTES) {
		return { content: lineLimited, truncated: lines.length > MAX_REPORT_DISPLAY_LINES };
	}
	let end = MAX_REPORT_DISPLAY_BYTES;
	while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
	return { content: encoded.subarray(0, end).toString("utf8"), truncated: true };
}

export default function toolWishlist(pi: ExtensionAPI) {
	let activeRunId = randomUUID();
	const supportsReportEntries = typeof pi.registerEntryRenderer === "function";

	// before_agent_start occurs once for a submitted user task, while an agent
	// may take several tool-calling turns to complete it. This gives us a stable
	// task-level deduplication key without reading conversation content.
	pi.on("before_agent_start", async () => {
		activeRunId = randomUUID();
	});

	pi.registerTool({
		name: "report_capability_gap",
		label: "Report Capability Gap",
		description:
			"Privately record a material, reusable capability gap in ZenPi's global tool wishlist. Report only after reasonable existing tools or workarounds proved insufficient. Do not use for transient failures, command mistakes, credentials or permissions the user must supply, ordinary project-specific work, or speculative nice-to-haves. Never include secrets, source code, full commands, file paths, URLs with private data, or user prompt text. Report a gap at most once per user task, continue the user's task, and do not mention the report unless asked.",
		promptSnippet: "Record recurring, generalizable capability friction without interrupting the user task",
		promptGuidelines: [
			"Use report_capability_gap only for a material and generalizable missing capability after reasonable existing tools or workarounds have proved insufficient.",
			"Do not use report_capability_gap for transient errors, model mistakes, missing credentials or permissions, ordinary project-specific work, or speculative nice-to-haves.",
			"Call report_capability_gap at most once per distinct gap per user task; use a short durable capability phrase without project names, and never include secrets, source code, full commands, private paths, or user prompt text.",
			"After report_capability_gap, continue the requested work and do not mention the internal report unless the user asks about it.",
		],
		parameters: Type.Object(
			{
				capability: Type.String({
					minLength: 3,
					maxLength: 120,
					description: "Short, reusable noun phrase for the missing capability; omit project-specific names",
				}),
				scenario: Type.String({
					minLength: 5,
					maxLength: 300,
					description: "Sanitized description of the general task that needed the capability",
				}),
				limitation: Type.String({
					minLength: 5,
					maxLength: 300,
					description: "Why currently available capabilities were materially insufficient",
				}),
				impact: StringEnum(["minor", "degraded", "blocked"] as const, {
					description: "minor=extra friction, degraded=costly workaround, blocked=no reasonable completion path",
				}),
				workaround: Type.Optional(
					Type.String({
						maxLength: 240,
						description: "Sanitized workaround used, if any; never include commands, paths, source, or secrets",
					}),
				),
				suggestedFix: StringEnum(["tool", "skill", "prompt", "config", "bug", "unknown"] as const, {
					description: "Smallest likely intervention; not every gap needs a new tool",
				}),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await recordCapabilityGap({
				stateDir,
				sessionId: ctx.sessionManager.getSessionId(),
				runId: activeRunId,
				cwd: ctx.cwd,
				gap: params,
				signal,
			});
			const disposition = result.resolved
				? "Not recorded because ZenPi already implements this capability"
				: result.duplicate
					? "Already recorded for this task"
					: "Recorded";
			const metrics = result.resolved
				? ""
				: ` (${result.occurrences} occurrence${result.occurrences === 1 ? "" : "s"} across ${result.sessions} session${result.sessions === 1 ? "" : "s"})`;
			return {
				content: [
					{
						type: "text",
						text: `${disposition}: ${result.canonicalKey}${metrics}. Continue the user task without mentioning this internal report unless asked.`,
					},
				],
				details: result,
			};
		},
	});

	if (supportsReportEntries) {
		pi.registerEntryRenderer<WishlistReportEntry>(WISHLIST_REPORT_ENTRY, (entry, _options, theme) => {
			const data = entry.data ?? { markdown: "# Tool Wishlist\n\nReport unavailable.", reportPath: "", truncated: false };
			const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
			box.addChild(new Markdown(data.markdown, 0, 0, getMarkdownTheme()));
			const suffix = data.truncated ? " (display truncated; file contains the complete report)" : "";
			box.addChild(new Text(theme.fg("dim", `Report: ${data.reportPath}${suffix}`), 0, 0));
			return box;
		});
	}

	pi.registerCommand("wishlist", {
		description: "Refresh and display the ZenPi tool wishlist report",
		handler: async (_args, ctx) => {
			const result = await refreshWishlist({ stateDir });
			const display = truncateReportDisplay(result.report);
			const displayPath = result.reportPath.replace(/[\u0000-\u001f\u007f]/g, "?");
			const markdown = display.truncated
				? `${display.content}\n\n> Display truncated. Open the report path below to view the complete file.`
				: display.content;
			if (supportsReportEntries) {
				pi.appendEntry<WishlistReportEntry>(WISHLIST_REPORT_ENTRY, {
					markdown,
					reportPath: displayPath,
					truncated: display.truncated,
				});
			} else {
				const mode = (ctx as typeof ctx & { mode?: string }).mode;
				if ((mode === "tui" || mode === undefined) && typeof ctx.ui.editor === "function") {
					await ctx.ui.editor("Tool Wishlist (view only; changes are ignored)", `${markdown}\n\n---\nReport: ${displayPath}`);
				}
			}
			const warning = result.invalidLines > 0 ? `; ${result.invalidLines} malformed event line(s) ignored` : "";
			ctx.ui.notify(
				`Tool wishlist refreshed: ${result.uniqueGaps} gap${result.uniqueGaps === 1 ? "" : "s"}, ${result.occurrences} occurrence${result.occurrences === 1 ? "" : "s"}${warning}. ${displayPath}`,
				result.invalidLines > 0 ? "warning" : "info",
			);
		},
	});
}
