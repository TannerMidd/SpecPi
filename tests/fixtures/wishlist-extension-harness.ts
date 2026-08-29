import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import registerWishlist, { improvementCandidatesFromRefresh } from "../../extensions/tool-wishlist/index.ts";

export default async function wishlistExtensionHarness() {
	const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR!);
	const tools: any[] = [];
	const commands = new Map<string, any>();
	const events = new Map<string, any[]>();
	const entries: any[] = [];
	const confirmations: string[] = [];
	const notifications: any[] = [];
	const selections: any[] = [];
	const sentUserMessages: string[] = [];
	const execs: any[] = [];
	let failNextCheck = true;
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
		sendUserMessage(message: string) { sentUserMessages.push(message); },
		async exec(command: string, args: string[], options: any) {
			execs.push({ command, args, cwd: options?.cwd });
			if (failNextCheck && args[0] === "run" && args[1] === "check") {
				failNextCheck = false;
				return { code: 1, stdout: "", stderr: "verification failed", killed: false };
			}
			return { code: 0, stdout: "verification passed", stderr: "", killed: false };
		},
	};
	registerWishlist(fakePi);

	const ctx: any = {
		cwd: path.join(agentDir, "project"),
		hasUI: true,
		mode: "tui",
		isIdle: () => true,
		sessionManager: { getSessionId: () => "extension-harness-session", getBranch: () => [] },
		ui: {
			async confirm(title: string, message: string) {
				confirmations.push(`${title}\n${message}`);
				return true;
			},
			async select(title: string, options: string[]) {
				selections.push({ title, options });
				return options[0];
			},
			notify(message: string, level: string) { notifications.push({ message, level }); },
			async editor() {},
		},
	};
	fs.mkdirSync(path.join(ctx.cwd, "extensions", "tool-wishlist"), { recursive: true });
	fs.writeFileSync(path.join(ctx.cwd, "package.json"), JSON.stringify({ name: "zenpi", scripts: { check: "node --test" } }));
	fs.copyFileSync(path.resolve("extensions", "tool-wishlist", "capabilities.json"), path.join(ctx.cwd, "extensions", "tool-wishlist", "capabilities.json"));

	const reportTool = tools.find((tool) => tool.name === "report_capability_gap");
	const finishTool = tools.find((tool) => tool.name === "finish_harness_improvement");
	const wishlist = commands.get("wishlist");
	const harnessImprovement = commands.get("harness-improvement");
	if (!reportTool || !finishTool || !wishlist || !harnessImprovement) throw new Error("Wishlist extension did not register its public surfaces");
	const gap = {
		capability: "Local audio transcription",
		scenario: "Transcribe a local recording",
		limitation: "No local transcription capability was available",
		impact: "blocked",
		workaround: "Manual transcription",
		suggestedFix: "skill",
	};
	await reportTool.execute("call-1", gap, undefined, undefined, ctx);
	await wishlist.handler("retire local-audio-transcription unverified bypass", ctx);
	await wishlist.handler("draft local-audio-transcription", ctx);

	const browserGap = {
		capability: "Local browser automation",
		scenario: "Interact with a locally rendered application",
		limitation: "Browser interaction needed explicit revalidation",
		impact: "degraded",
		workaround: "Manual browser interaction",
		suggestedFix: "tool",
	};
	for (const handler of events.get("before_agent_start") ?? []) await handler({}, ctx);
	await reportTool.execute("call-2", browserGap, undefined, undefined, ctx);
	const stateDir = path.join(agentDir, "zenpi");
	const legacyCandidate = improvementCandidatesFromRefresh({
		report: fs.readFileSync(path.join(stateDir, "TOOL_WISHLIST.md"), "utf8"),
	})[0];
	const completion = {
		gapId: "local-browser-automation",
		acceptanceEvidence: ["Browser interaction and visual comparison smoke passed"],
		validationNote: "Browser workflow revalidated",
	};
	let unauthorizedCompletion = "";
	try {
		await finishTool.execute("finish-unauthorized", completion, undefined, undefined, ctx);
	} catch (error) {
		unauthorizedCompletion = error instanceof Error ? error.message : String(error);
	}
	await harnessImprovement.handler("", ctx);
	let failedGate = "";
	try {
		await finishTool.execute("finish-failed", completion, undefined, undefined, ctx);
	} catch (error) {
		failedGate = error instanceof Error ? error.message : String(error);
	}
	const reportAfterFailedGate = fs.readFileSync(path.join(stateDir, "TOOL_WISHLIST.md"), "utf8");
	await finishTool.execute("finish-1", completion, undefined, undefined, ctx);

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
		completionToolExposed: tools.some((tool) => tool.name === "finish_harness_improvement"),
		lifecycleBypassBlocked: notifications.some((item) => item.message.includes("verification retires the selected item automatically")),
		reportStableAfterRevalidation: reportBeforeReset.includes("# Retired") && !reportBeforeReset.includes("# Needs review"),
		improvementMenu: selections[0],
		legacyCandidate,
		unauthorizedCompletion,
		implementationStarted: sentUserMessages[0],
		verificationCommands: execs,
		rawSessionIdPersisted: entries.some((entry) => JSON.stringify(entry).includes("extension-harness-session")),
		acceptanceEvidencePersisted: entries.some((entry) => JSON.stringify(entry).includes("Browser interaction and visual comparison smoke passed")),
		failedGate,
		selectedAfterFailedGate: reportAfterFailedGate.includes("# Selected") && reportAfterFailedGate.includes("- Status: selected"),
		issueDraftRendered: entries.some((entry) => entry.data?.markdown?.includes("Local draft only")),
		checksumsValid,
		eventsAfterReset,
		collectionMode: config.mode,
		saltPreserved: fs.existsSync(path.join(stateDir, ".tool-wishlist-salt")),
		notifications,
	})}\n`);
}
