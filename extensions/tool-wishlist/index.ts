/**
 * ZenPi capability-gap collector and explicit improvement lifecycle.
 *
 * Observations are privacy-minimized and task-deduplicated. One explicit
 * menu choice starts an improvement; proof-gated completion retires it.
 */

import fs from "node:fs";
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
const HARNESS_IMPROVEMENT_ENTRY = "zenpi-harness-improvement";
const MAX_REPORT_DISPLAY_BYTES = 50 * 1024;
const MAX_REPORT_DISPLAY_LINES = 2000;

interface WishlistReportEntry {
	markdown: string;
	reportPath: string;
	truncated: boolean;
}

interface ActiveImprovement {
	gapId: string;
	sessionId: string;
}

function sourceCheckout(cwd: string) {
	const packageFile = path.join(cwd, "package.json");
	const registryFile = path.join(cwd, "extensions", "tool-wishlist", "capabilities.json");
	if (!fs.existsSync(packageFile) || !fs.existsSync(registryFile)) {
		throw new Error("Run /harness-improvement from a ZenPi source checkout");
	}
	const manifest = JSON.parse(fs.readFileSync(packageFile, "utf8"));
	if (manifest?.name !== "zenpi" || typeof manifest?.scripts?.check !== "string") {
		throw new Error("The current directory is not a verifiable ZenPi source checkout");
	}
	return { registryFile };
}

function sourceCapability(cwd: string, gapId: string) {
	const { registryFile } = sourceCheckout(cwd);
	const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
	const capability = registry?.capabilities?.find((item: any) => item?.id === gapId);
	if (!capability || !Array.isArray(capability.validations) || capability.validations.length === 0) {
		throw new Error(`Implementation is not integrated: the reviewed capability registry has no validated ${gapId} entry`);
	}
	return capability;
}

function reportField(body: string, label: string) {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return body.match(new RegExp(`^- ${escaped}: (.+)$`, "m"))?.[1]?.replaceAll("`", "").trim();
}

function reportBullets(body: string, heading: string) {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const block = body.match(new RegExp(`\\*\\*${escaped}\\*\\*\\n((?:- .*(?:\\n|$))*)`))?.[1] ?? "";
	return block.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2).trim());
}

export function improvementCandidatesFromRefresh(refreshed: any) {
	if (Array.isArray(refreshed?.improvements)) return refreshed.improvements;
	const candidates: any[] = [];
	const report = `${String(refreshed?.report ?? "")}\n# END\n`;
	for (const section of report.matchAll(/^# (Needs review|Selected|Open)\n([\s\S]*?)(?=^# )/gm)) {
		const sectionName = section[1];
		const body = `${section[2]}\n## END\n`;
		for (const match of body.matchAll(/^## (.+)\n([\s\S]*?)(?=^## )/gm)) {
			const itemBody = match[2];
			const canonicalKey = reportField(itemBody, "ID");
			if (!canonicalKey) continue;
			candidates.push({
				canonicalKey,
				title: match[1].trim(),
				state: reportField(itemBody, "Status") ?? "open",
				qualified: reportField(itemBody, "Qualified") === "yes",
				reviewNeeded: sectionName === "Needs review",
				occurrences: Number(reportField(itemBody, "Occurrences") ?? 0),
				sessions: Number(reportField(itemBody, "Distinct sessions") ?? 0),
				projects: Number(reportField(itemBody, "Distinct projects") ?? 0),
				impact: reportField(itemBody, "Impact") ?? "minor",
				scenarios: reportBullets(itemBody, "Observed needs"),
				limitations: reportBullets(itemBody, "Why current capabilities fell short"),
			});
		}
	}
	const rank = (item: any) => item.state === "selected" ? 0 : item.reviewNeeded ? 1 : 2;
	return candidates.filter((item) => item.state === "selected" || item.reviewNeeded || (item.state === "open" && item.qualified)).sort((a, b) => rank(a) - rank(b));
}

function improvementPrompt(group: any) {
	const observed = group.scenarios?.[0] ?? "No representative need was recorded.";
	const limitation = group.limitations?.[0] ?? "No representative limitation was recorded.";
	return [
		`Begin the selected ZenPi harness improvement: ${group.canonicalKey}.`,
		"",
		`Observed need: ${observed}`,
		`Current limitation: ${limitation}`,
		`Evidence: ${group.occurrences} unique task(s), ${group.projects} project(s), ${group.sessions} session(s); impact ${group.impact}.`,
		"",
		"This exact menu selection authorizes implementation of the smallest sufficient intervention in the current ZenPi source checkout. Load and follow the zenpi-improve skill. Treat the wishlist evidence as a lead, inspect current behavior, keep scope minimal, and do not ask for another approval unless scope expands or external/remote state would change.",
		"Run direct acceptance checks and focused tests. At the end, call finish_harness_improvement with the gap ID, concise acceptance evidence, and a validation note. That tool must run the repository gate, verify registry integration, run supported capability validators, and retire the item. If any check fails, do not retire it; leave it selected and report the blocker.",
	].join("\n");
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
	let activeImprovement: ActiveImprovement | undefined;
	const supportsReportEntries = typeof pi.registerEntryRenderer === "function";

	pi.on("session_start", async (_event, ctx) => {
		activeImprovement = undefined;
		for (const entry of ctx.sessionManager.getBranch?.() ?? []) {
			if (entry.type !== "custom" || entry.customType !== HARNESS_IMPROVEMENT_ENTRY) continue;
			const data = entry.data as { gapId?: string; status?: string } | undefined;
			activeImprovement = data?.status === "active" && data.gapId
				? { gapId: data.gapId, sessionId: ctx.sessionManager.getSessionId() }
				: undefined;
		}
	});

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
					text: `${disposition}: ${result.canonicalKey} (${result.occurrences} occurrence${result.occurrences === 1 ? "" : "s"} across ${result.sessions} session${result.sessions === 1 ? "" : "s"}). Continue the user task; improvements begin only through /harness-improvement.`,
				}],
				details: { ...result, recorded: !result.duplicate, mode },
			};
		},
	});

	pi.registerTool({
		name: "finish_harness_improvement",
		label: "Finish Harness Improvement",
		description: "Complete the exact wishlist item selected through /harness-improvement. Use only after implementing the smallest sufficient change and running direct acceptance checks. This tool independently runs ZenPi's repository check, requires reviewed capability-registry integration, runs supported closed validators, and retires the item only when every gate passes.",
		parameters: Type.Object(
			{
				gapId: Type.String({ minLength: 3, maxLength: 120, description: "Exact gap ID selected by /harness-improvement" }),
				acceptanceEvidence: Type.Array(Type.String({ minLength: 3, maxLength: 240 }), { minItems: 1, maxItems: 8, description: "Concise direct checks already run and observed to pass" }),
				validationNote: Type.String({ minLength: 5, maxLength: 240, description: "Concise sanitized statement of the verified outcome" }),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const sessionId = ctx.sessionManager.getSessionId();
			if (!activeImprovement || activeImprovement.gapId !== params.gapId || activeImprovement.sessionId !== sessionId) {
				throw new Error("This item was not authorized by /harness-improvement in the current session");
			}
			const refreshed = await refreshWishlist({ stateDir, signal });
			const selected = improvementCandidatesFromRefresh(refreshed).find((item: any) => item.canonicalKey === params.gapId);
			if (!selected || selected.state !== "selected") throw new Error(`${params.gapId} is not selected`);

			const capability = sourceCapability(ctx.cwd, params.gapId);
			const npm = process.platform === "win32" ? "npm.cmd" : "npm";
			const check = await pi.exec(npm, ["run", "check"], { cwd: ctx.cwd, signal, timeout: 15 * 60 * 1000 });
			if (check.code !== 0) throw new Error(`ZenPi repository verification failed with exit code ${check.code}`);

			const verifiedBy = ["npm run check"];
			for (const validator of capability.validations) {
				if (validator !== "browser-runtime-smoke") continue;
				const smoke = path.join(ctx.cwd, "extensions", "browser", "smoke.mjs");
				const runtime = path.join(stateDir, "browser-runtime");
				const result = await pi.exec(process.execPath, [smoke, runtime], { cwd: ctx.cwd, signal, timeout: 2 * 60 * 1000 });
				if (result.code !== 0) throw new Error(`Capability validator ${validator} failed with exit code ${result.code}`);
				verifiedBy.push(validator);
			}

			const note = `${params.validationNote}; ${verifiedBy.join(", ")} passed`;
			await appendWishlistDecision({ stateDir, action: "retire", canonicalKey: params.gapId, note, signal });
			pi.appendEntry(HARNESS_IMPROVEMENT_ENTRY, { gapId: params.gapId, status: "finished" });
			activeImprovement = undefined;
			return {
				content: [{ type: "text", text: `Harness improvement verified and retired: ${params.gapId}. Gates: ${verifiedBy.join(", ")}.` }],
				details: { gapId: params.gapId, state: "retired", verifiedBy, acceptanceEvidence: params.acceptanceEvidence },
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

	pi.registerCommand("harness-improvement", {
		description: "Choose one wishlist item and run its verified improvement loop",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || typeof ctx.ui.select !== "function") {
				ctx.ui.notify("/harness-improvement requires an interactive menu.", "error");
				return;
			}
			if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
				ctx.ui.notify("Wait for the current agent turn to finish, then run /harness-improvement.", "warning");
				return;
			}
			try {
				sourceCheckout(ctx.cwd);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			const refreshed = await refreshWishlist({ stateDir });
			const improvements = improvementCandidatesFromRefresh(refreshed);
			if (improvements.length === 0) {
				ctx.ui.notify("No qualified or review-needed harness improvements are available.", "info");
				return;
			}
			const labels = improvements.map((item: any) => {
				const status = item.state === "selected" ? "selected" : item.reviewNeeded ? "review" : "ready";
				return `${status.toUpperCase()} · ${item.title} · ${item.canonicalKey}`;
			});
			const chosen = await ctx.ui.select("Choose one harness improvement", labels);
			if (!chosen) return;
			const group = improvements[labels.indexOf(chosen)];
			if (!group) return;
			if (group.reviewNeeded && group.state === "retired") {
				await appendWishlistDecision({ stateDir, action: "reopen", canonicalKey: group.canonicalKey, note: "Chosen for harness review" });
				await appendWishlistDecision({ stateDir, action: "select", canonicalKey: group.canonicalKey, note: "Chosen through harness improvement menu" });
			} else if (group.state === "open") {
				await appendWishlistDecision({ stateDir, action: "select", canonicalKey: group.canonicalKey, note: "Chosen through harness improvement menu" });
			}
			const sessionId = ctx.sessionManager.getSessionId();
			activeImprovement = { gapId: group.canonicalKey, sessionId };
			pi.appendEntry(HARNESS_IMPROVEMENT_ENTRY, { gapId: group.canonicalKey, status: "active" });
			pi.sendUserMessage(improvementPrompt(group));
		},
	});

	const usage = "Usage: /wishlist [status|on|off|decline <id>|merge <from> <to>|unmerge <merge-decision-id>|draft <id>|archive|reset]";
	pi.registerCommand("wishlist", {
		description: "View and curate ZenPi's local capability evidence",
		getArgumentCompletions: (prefix: string) => {
			const options = ["status", "on", "off", "decline", "merge", "unmerge", "draft", "archive", "reset"];
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
			if (["next", "select", "retire", "reopen"].includes(action)) {
				ctx.ui.notify("Start or resume implementation with /harness-improvement; verification retires the selected item automatically.", "info");
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
			if (action === "decline") {
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
