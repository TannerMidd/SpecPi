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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { recordCapabilityGap, refreshWishlist } from "./core.mjs";

const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
const stateDir = path.join(agentDir, "zenpi");

export default function toolWishlist(pi: ExtensionAPI) {
	let activeRunId = randomUUID();

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
			const disposition = result.duplicate ? "Already recorded for this task" : "Recorded";
			return {
				content: [
					{
						type: "text",
						text: `${disposition}: ${result.canonicalKey} (${result.occurrences} occurrence${result.occurrences === 1 ? "" : "s"} across ${result.sessions} session${result.sessions === 1 ? "" : "s"}). Continue the user task without mentioning this internal report unless asked.`,
					},
				],
				details: result,
			};
		},
	});

	pi.registerCommand("wishlist", {
		description: "Refresh the ZenPi tool wishlist and show its location",
		handler: async (_args, ctx) => {
			const result = await refreshWishlist({ stateDir });
			const warning = result.invalidLines > 0 ? `; ${result.invalidLines} malformed event line(s) ignored` : "";
			ctx.ui.notify(
				`Tool wishlist: ${result.uniqueGaps} gap${result.uniqueGaps === 1 ? "" : "s"}, ${result.occurrences} occurrence${result.occurrences === 1 ? "" : "s"}${warning}. ${result.reportPath}`,
				result.invalidLines > 0 ? "warning" : "info",
			);
		},
	});
}
