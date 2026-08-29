/**
 * ZenPi capability-gap collector and explicit improvement lifecycle.
 *
 * Observations are privacy-minimized and task-deduplicated. Selection,
 * retirement, reopening, and curation happen only through explicit commands.
 */

import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	appendWishlistDecision,
	archiveWishlist,
	createIssueDraft,
	readCollectionMode,
	recordCapabilityGap,
	refreshWishlist,
	setCollectionMode,
} from "./core.mjs";

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

function cleanDisplayPath(value: string) {
	return value.replace(/[\u0000-\u001f\u007f]/g, "?");
}

export default function toolWishlist(pi: ExtensionAPI) {
	let activeRunId = randomUUID();
	const supportsReportEntries = typeof pi.registerEntryRenderer === "function";

	pi.on("before_agent_start", async () => {
		activeRunId = randomUUID();
	});

	const displayMarkdown = async (markdown: string, reportPath: string, ctx: any) => {
		const display = truncateReportDisplay(markdown);
		const displayPath = cleanDisplayPath(reportPath);
		const content = display.truncated
			? `${display.content}\n\n> Display truncated. Open the report path below to view the complete file.`
			: display.content;
		if (supportsReportEntries) {
			pi.appendEntry<WishlistReportEntry>(WISHLIST_REPORT_ENTRY, {
				markdown: content,
				reportPath: displayPath,
				truncated: display.truncated,
			});
		} else if ((ctx.mode === "tui" || ctx.mode === undefined) && typeof ctx.ui.editor === "function") {
			await ctx.ui.editor("ZenPi Wishlist (view only; changes are ignored)", `${content}\n\n---\nReport: ${displayPath}`);
		}
	};

	pi.registerTool({
		name: "report_capability_gap",
		label: "Report Capability Gap",
		description:
			"Privately record a material, reusable capability gap in ZenPi's local wishlist. Report only after reasonable existing tools or workarounds proved insufficient. Do not use for transient failures, command mistakes, credentials or permissions the user must supply, ordinary project-specific work, or speculative nice-to-haves. Never include secrets, source code, full commands, file paths, URLs with private data, or user prompt text. Report a gap at most once per user task. Collection requires an explicit local on/off decision and never uploads data.",
		promptSnippet: "Record recurring, generalizable capability friction without interrupting the user task",
		promptGuidelines: [
			"Use report_capability_gap only for a material and generalizable missing capability after reasonable existing tools or workarounds have proved insufficient.",
			"Do not use report_capability_gap for transient errors, model mistakes, missing credentials or permissions, ordinary project-specific work, or speculative nice-to-haves.",
			"Call report_capability_gap at most once per distinct gap per user task; use a short durable capability phrase without project names, and never include secrets, source code, full commands, private paths, or user prompt text.",
			"After report_capability_gap, continue the requested task; never treat a report as permission to modify ZenPi or external state.",
		],
		parameters: Type.Object(
			{
				capability: Type.String({ minLength: 3, maxLength: 120, description: "Short, reusable noun phrase for the missing capability; omit project-specific names" }),
				scenario: Type.String({ minLength: 5, maxLength: 300, description: "Sanitized description of the general task that needed the capability" }),
				limitation: Type.String({ minLength: 5, maxLength: 300, description: "Why currently available capabilities were materially insufficient" }),
				impact: StringEnum(["minor", "degraded", "blocked"] as const, { description: "minor=extra friction, degraded=costly workaround, blocked=no reasonable completion path" }),
				workaround: Type.Optional(Type.String({ maxLength: 240, description: "Sanitized workaround used, if any; never include commands, paths, source, or secrets" })),
				suggestedFix: StringEnum(["tool", "skill", "prompt", "config", "bug", "unknown"] as const, { description: "Smallest likely intervention; not every gap needs a new tool" }),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			let mode = readCollectionMode(stateDir);
			if (mode === "undecided") {
				if (!ctx.hasUI) {
					return {
						content: [{ type: "text", text: "Not recorded: local wishlist collection is undecided. The user can run /wishlist on or /wishlist off in an interactive session." }],
						details: { recorded: false, mode },
					};
				}
				const enabled = await ctx.ui.confirm(
					"Enable local capability-gap collection?",
					"ZenPi stores sanitized summaries and salted task, session, and project hashes locally. It never uploads them. You can change this later with /wishlist on or /wishlist off.",
				);
				mode = enabled ? "on" : "off";
				await setCollectionMode({ stateDir, mode, signal });
			}
			if (mode === "off") {
				return {
					content: [{ type: "text", text: "Not recorded: local wishlist collection is off. Continue the user task." }],
					details: { recorded: false, mode },
				};
			}
			const result = await recordCapabilityGap({
				stateDir,
				sessionId: ctx.sessionManager.getSessionId(),
				runId: activeRunId,
				cwd: ctx.cwd,
				gap: params,
				signal,
			});
			const disposition = result.duplicate
				? "Already recorded for this task"
				: result.regression
					? "Recorded post-retirement signal for explicit review"
					: "Recorded";
			return {
				content: [{
					type: "text",
					text: `${disposition}: ${result.canonicalKey} (${result.occurrences} occurrence${result.occurrences === 1 ? "" : "s"} across ${result.sessions} session${result.sessions === 1 ? "" : "s"}). Continue the user task; lifecycle changes require an explicit /wishlist command.`,
				}],
				details: { ...result, recorded: !result.duplicate, mode },
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

	const usage = "Usage: /wishlist [next|status|on|off|select <id>|decline <id>|retire <id> <validation note>|reopen <id>|merge <from> <to>|unmerge <merge-decision-id>|draft <id>|archive|reset]";
	pi.registerCommand("wishlist", {
		description: "View and explicitly curate ZenPi's local capability wishlist",
		getArgumentCompletions: (prefix: string) => {
			const options = ["next", "status", "on", "off", "select", "decline", "retire", "reopen", "merge", "unmerge", "draft", "archive", "reset"];
			const first = prefix.trim().split(/\s+/, 1)[0] ?? "";
			const matches = options.filter((option) => option.startsWith(first));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const action = parts.shift()?.toLowerCase() ?? "list";
			if (action === "status") {
				const mode = readCollectionMode(stateDir);
				const result = await refreshWishlist({ stateDir });
				ctx.ui.notify(`Wishlist collection: ${mode}; ${result.uniqueGaps} queued gap${result.uniqueGaps === 1 ? "" : "s"}. ${cleanDisplayPath(result.reportPath)}`, "info");
				return;
			}
			if (action === "on" || action === "off") {
				await setCollectionMode({ stateDir, mode: action });
				ctx.ui.notify(`Local wishlist collection is ${action}. No data is uploaded.`, "info");
				return;
			}
			if (action === "archive" || action === "reset") {
				if (!ctx.hasUI) {
					ctx.ui.notify(`${action} requires interactive confirmation.`, "error");
					return;
				}
				const confirmed = await ctx.ui.confirm(
					`${action === "archive" ? "Archive" : "Reset"} active wishlist?`,
					"Observations, decisions, and the report will move to a private timestamped archive. Collection mode and the private salt are preserved.",
				);
				if (!confirmed) return;
				const result = await archiveWishlist({ stateDir, reason: action });
				ctx.ui.notify(`Wishlist ${action} complete. Archive: ${cleanDisplayPath(result.archiveDir)}`, "info");
				return;
			}
			if (action === "next") {
				const result = await refreshWishlist({ stateDir });
				await displayMarkdown(result.next, result.reportPath, ctx);
				return;
			}
			if (action === "draft") {
				if (parts.length !== 1) {
					ctx.ui.notify(usage, "error");
					return;
				}
				const result = await createIssueDraft({ stateDir, canonicalKey: parts[0] });
				const report = await refreshWishlist({ stateDir });
				await displayMarkdown(result.markdown, report.reportPath, ctx);
				return;
			}
			if (["select", "decline", "retire", "reopen"].includes(action)) {
				if (parts.length < 1) {
					ctx.ui.notify(usage, "error");
					return;
				}
				const [canonicalKey, ...note] = parts;
				const result = await appendWishlistDecision({ stateDir, action, canonicalKey, note: note.join(" ") });
				ctx.ui.notify(`Wishlist ${action}: ${result.canonicalKey}`, "info");
				return;
			}
			if (action === "merge") {
				if (parts.length !== 2) {
					ctx.ui.notify(usage, "error");
					return;
				}
				const result = await appendWishlistDecision({ stateDir, action, canonicalKey: parts[0], targetKey: parts[1] });
				ctx.ui.notify(`Wishlist merged: ${result.canonicalKey} → ${result.targetKey} (decision ${result.decisionId})`, "info");
				return;
			}
			if (action === "unmerge") {
				if (parts.length !== 1) {
					ctx.ui.notify(usage, "error");
					return;
				}
				const result = await appendWishlistDecision({ stateDir, action, canonicalKey: parts[0] });
				ctx.ui.notify(`Wishlist merge removed: ${result.canonicalKey}`, "info");
				return;
			}
			if (action !== "list") {
				ctx.ui.notify(usage, "error");
				return;
			}
			const result = await refreshWishlist({ stateDir });
			await displayMarkdown(result.report, result.reportPath, ctx);
			const warning = result.invalidLines > 0 ? `; ${result.invalidLines} malformed state line(s) ignored` : "";
			ctx.ui.notify(`Tool wishlist refreshed: ${result.uniqueGaps} queued gap${result.uniqueGaps === 1 ? "" : "s"}, ${result.occurrences} occurrence${result.occurrences === 1 ? "" : "s"}${warning}. ${cleanDisplayPath(result.reportPath)}`, result.invalidLines > 0 ? "warning" : "info");
		},
	});
}
