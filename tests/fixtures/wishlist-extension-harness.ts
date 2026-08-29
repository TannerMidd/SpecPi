import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import registerWishlist from "../../extensions/tool-wishlist/index.ts";

export default async function wishlistExtensionHarness() {
	const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR!);
	const tools: any[] = [];
	const commands = new Map<string, any>();
	const events = new Map<string, any[]>();
	const entries: any[] = [];
	const confirmations: string[] = [];
	const notifications: any[] = [];
	const fakePi: any = {
		on(name: string, handler: any) {
			const handlers = events.get(name) ?? [];
			handlers.push(handler);
			events.set(name, handlers);
		},
		registerTool(tool: any) { tools.push(tool); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerEntryRenderer() {},
		appendEntry(type: string, data: any) { entries.push({ type, data }); },
	};
	registerWishlist(fakePi);

	const ctx: any = {
		cwd: path.join(agentDir, "project"),
		hasUI: true,
		mode: "tui",
		sessionManager: { getSessionId: () => "extension-harness-session" },
		ui: {
			async confirm(title: string, message: string) {
				confirmations.push(`${title}\n${message}`);
				return true;
			},
			notify(message: string, level: string) { notifications.push({ message, level }); },
			async editor() {},
		},
	};
	fs.mkdirSync(ctx.cwd, { recursive: true });

	const reportTool = tools.find((tool) => tool.name === "report_capability_gap");
	const wishlist = commands.get("wishlist");
	if (!reportTool || !wishlist) throw new Error("Wishlist extension did not register its public surfaces");
	const gap = {
		capability: "Local audio transcription",
		scenario: "Transcribe a local recording",
		limitation: "No local transcription capability was available",
		impact: "blocked",
		workaround: "Manual transcription",
		suggestedFix: "skill",
	};
	await reportTool.execute("call-1", gap, undefined, undefined, ctx);
	await wishlist.handler("select local-audio-transcription", ctx);
	await wishlist.handler("decline local-audio-transcription not the smallest change", ctx);
	await wishlist.handler("reopen local-audio-transcription", ctx);
	await wishlist.handler("select local-audio-transcription", ctx);
	await wishlist.handler("retire local-audio-transcription focused validation passed", ctx);
	for (const handler of events.get("before_agent_start") ?? []) await handler({}, ctx);
	await reportTool.execute("call-2", gap, undefined, undefined, ctx);
	await wishlist.handler("reopen local-audio-transcription", ctx);
	await wishlist.handler("select local-audio-transcription", ctx);
	await wishlist.handler("retire local-audio-transcription revalidation passed", ctx);
	await wishlist.handler("draft local-audio-transcription", ctx);

	const stateDir = path.join(agentDir, "zenpi");
	const reportBeforeReset = fs.readFileSync(path.join(stateDir, "TOOL_WISHLIST.md"), "utf8");
	await wishlist.handler("reset", ctx);
	const archiveRoot = path.join(stateDir, "tool-wishlist-archives");
	const archiveName = fs.readdirSync(archiveRoot)[0];
	const archiveDir = path.join(archiveRoot, archiveName);
	const archive = JSON.parse(fs.readFileSync(path.join(archiveDir, "archive.json"), "utf8"));
	const checksumsValid = archive.files.every((item: any) => {
		const content = fs.readFileSync(path.join(archiveDir, item.name));
		return createHash("sha256").update(content).digest("hex") === item.sha256;
	});
	const eventsAfterReset = fs.readFileSync(path.join(stateDir, "tool-wishlist-events.jsonl"), "utf8");
	const config = JSON.parse(fs.readFileSync(path.join(stateDir, "tool-wishlist-config.json"), "utf8"));

	process.stdout.write(`ZENPI_WISHLIST_HARNESS=${JSON.stringify({
		toolNames: tools.map((tool) => tool.name),
		commandNames: [...commands.keys()],
		consent: confirmations[0],
		resetConfirmed: confirmations.some((value) => value.startsWith("Reset active wishlist?")),
		lifecycleToolExposed: tools.some((tool) => /wishlist|lifecycle|retire|reopen/.test(tool.name) && tool.name !== "report_capability_gap"),
		reportStableAfterRevalidation: reportBeforeReset.includes("# Retired") && !reportBeforeReset.includes("# Needs review"),
		issueDraftRendered: entries.some((entry) => entry.data?.markdown?.includes("Local draft only")),
		checksumsValid,
		eventsAfterReset,
		collectionMode: config.mode,
		saltPreserved: fs.existsSync(path.join(stateDir, ".tool-wishlist-salt")),
		notifications,
	})}\n`);
}
