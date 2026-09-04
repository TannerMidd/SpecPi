import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import registerWishlist, { improvementCandidatesFromRefresh } from "../../extensions/tool-wishlist/index.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default async function wishlistExtensionHarness() {
    const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR!);
    const tools: any[] = [];
    const commands = new Map<string, any>();
    const renderers = new Map<string, any>();
    const events = new Map<string, any[]>();
    const entries: any[] = [];
    const confirmations: string[] = [];
    const notifications: any[] = [];
    const selections: any[] = [];
    const sentUserMessages: string[] = [];
    const execs: any[] = [];
    let failNextCheck = true;
    let failNextValidator = false;
    const fakePi: any = {
        on(name: string, handler: any) {
            const handlers = events.get(name) ?? [];
            handlers.push(handler);
            events.set(name, handlers);
        },
        registerTool(tool: any) {
            tools.push(tool);
        },
        registerCommand(name: string, command: any) {
            commands.set(name, command);
        },
        registerEntryRenderer(type: string, renderer: any) {
            renderers.set(type, renderer);
        },
        appendEntry(type: string, data: any) {
            entries.push({ type: "custom", customType: type, data });
        },
        sendUserMessage(message: string) {
            sentUserMessages.push(message);
        },
        async exec(command: string, args: string[], options: any) {
            execs.push({ command, args, cwd: options?.cwd });
            if (command === "git") {
                if (args[0] === "status") {
                    // Includes an unstaged entry (" M …") so the porcelain wiring is
                    // proven against the exact format that once corrupted paths.
                    return {
                        code: 0,
                        stdout: " M extensions/tool-wishlist/core.mjs\nM  README.md\n?? tests/new.test.mjs\n",
                        stderr: "",
                        killed: false,
                    };
                }

                if (args[0] === "log") {
                    const adversarialSubject = `def5678 ${"x".repeat(320)} https://private.example/secret`;

                    return {
                        code: 0,
                        stdout: `abc1234 Fixed the thing\n${adversarialSubject}\n`,
                        stderr: "",
                        killed: false,
                    };
                }

                return { code: 128, stdout: "", stderr: "not a git repository", killed: false };
            }

            if (failNextValidator && args[0]?.endsWith("validators.mjs")) {
                failNextValidator = false;

                return { code: 3, stdout: "", stderr: "validator exploded", killed: false };
            }

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
        sessionManager: {
            getSessionId: () => "extension-harness-session",
            getBranch: () => entries,
        },
        ui: {
            async confirm(title: string, message: string) {
                confirmations.push(`${title}\n${message}`);

                return true;
            },
            async select(title: string, options: string[]) {
                selections.push({ title, options });

                return options[0];
            },
            notify(message: string, level: string) {
                notifications.push({ message, level });
            },
            async editor() {},
        },
    };
    fs.mkdirSync(path.join(ctx.cwd, "extensions", "tool-wishlist"), { recursive: true });
    fs.mkdirSync(path.join(ctx.cwd, "extensions", "workflow-controls"), { recursive: true });
    fs.mkdirSync(path.join(ctx.cwd, "scripts"), { recursive: true });
    fs.writeFileSync(
        path.join(ctx.cwd, "package.json"),
        JSON.stringify({ name: "specpi", scripts: { check: "node --test" } }),
    );
    fs.copyFileSync(
        path.join(repoRoot, "extensions", "tool-wishlist", "capabilities.json"),
        path.join(ctx.cwd, "extensions", "tool-wishlist", "capabilities.json"),
    );
    fs.copyFileSync(
        path.join(repoRoot, "extensions", "tool-wishlist", "validators.mjs"),
        path.join(ctx.cwd, "extensions", "tool-wishlist", "validators.mjs"),
    );
    for (const file of ["index.ts", "core.mjs", "registry.mjs", "verification.mjs"]) {
        fs.copyFileSync(
            path.join(repoRoot, "extensions", "tool-wishlist", file),
            path.join(ctx.cwd, "extensions", "tool-wishlist", file),
        );
    }

    for (const file of ["task-contract.mjs", "scope.mjs"]) {
        fs.copyFileSync(
            path.join(repoRoot, "extensions", "workflow-controls", file),
            path.join(ctx.cwd, "extensions", "workflow-controls", file),
        );
    }

    for (const file of [".editorconfig", ".prettierignore", "eslint.config.js", "prettier.config.mjs"]) {
        fs.copyFileSync(path.join(repoRoot, file), path.join(ctx.cwd, file));
    }

    fs.copyFileSync(
        path.join(repoRoot, "scripts", "check-package.mjs"),
        path.join(ctx.cwd, "scripts", "check-package.mjs"),
    );

    const reportTool = tools.find((tool) => tool.name === "report_capability_gap");
    const contractTool = tools.find((tool) => tool.name === "record_harness_contract");
    const finishTool = tools.find((tool) => tool.name === "finish_harness_improvement");
    const wishlist = commands.get("wishlist");
    const harnessImprovement = commands.get("harness-improvement");
    if (!reportTool || !contractTool || !finishTool || !wishlist || !harnessImprovement) {
        throw new Error("Wishlist extension did not register its public surfaces");
    }

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
    for (const handler of events.get("before_agent_start") ?? []) {
        await handler({}, ctx);
    }

    await reportTool.execute("call-2", browserGap, undefined, undefined, ctx);
    const stateDir = path.join(agentDir, "specpi");
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
    const activeSelection = entries.findLast((entry: any) => entry.data?.status === "active")?.data;
    await contractTool.execute(
        "contract-1",
        {
            gapId: completion.gapId,
            selectionId: activeSelection.selectionId,
            sourceRoot: ctx.cwd,
            objective: "Prove local browser improvement",
            hypothesis: "The selected browser capability can be verified by its closed smoke test",
            requirements: [
                {
                    id: "R1",
                    description: "The closed browser validator passes",
                    acceptance: "Validator exits with code zero in temporary state",
                },
            ],
            paths: ["extensions/tool-wishlist/verification.mjs"],
            rollback: "Revert the scoped source changes and rerun the checks",
            nonGoals: ["No remote browser or provider state"],
        },
        undefined,
        undefined,
        ctx,
    );
    let failedGate = "";
    try {
        await finishTool.execute("finish-failed", completion, undefined, undefined, ctx);
    } catch (error) {
        failedGate = error instanceof Error ? error.message : String(error);
    }

    const reportAfterFailedGate = fs.readFileSync(path.join(stateDir, "TOOL_WISHLIST.md"), "utf8");

    let failedValidatorGate = "";
    failNextValidator = true;
    try {
        await finishTool.execute("finish-validator-fail", completion, undefined, undefined, ctx);
    } catch (error) {
        failedValidatorGate = error instanceof Error ? error.message : String(error);
    }

    const reportAfterValidatorFail = fs.readFileSync(path.join(stateDir, "TOOL_WISHLIST.md"), "utf8");
    await finishTool.execute("finish-1", completion, undefined, undefined, ctx);
    const reportStableAfterRetirement = fs.readFileSync(path.join(stateDir, "TOOL_WISHLIST.md"), "utf8");

    // A post-retirement regression reopens the retired item; the improvement
    // prompt must carry the original proof, the changed files, and what changed since.
    for (const handler of events.get("before_agent_start") ?? []) {
        await handler({}, ctx);
    }

    await reportTool.execute("call-3", browserGap, undefined, undefined, ctx);
    await harnessImprovement.handler("", ctx);
    const reopenPrompt = sentUserMessages[1] ?? "";
    await wishlist.handler("history local-browser-automation", ctx);
    await wishlist.handler("status", ctx);

    const reportBeforeReset = fs.readFileSync(path.join(stateDir, "TOOL_WISHLIST.md"), "utf8");
    // Read the durable record before the reset archives the active queue.
    const storedDecisions = fs
        .readFileSync(path.join(stateDir, "tool-wishlist-decisions.jsonl"), "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const journalRecord = storedDecisions.find((decision: any) => decision.action === "retire" && decision.journal);
    const reopens = storedDecisions.filter((decision: any) => decision.action === "reopen");
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
    const historyEntry = entries.find((entry: any) => entry.data?.markdown?.includes("# Improvement journal"));
    const gitContextBlock =
        reopenPrompt
            .split("Changed since the retirement (untrusted, sanitized Git metadata):\n")[1]
            ?.split("\n\n")[0] ?? "";
    const gitContextLines = gitContextBlock.split("\n").filter((line) => line.startsWith("- "));
    const pathRenderer = renderers.get("specpi-wishlist-report");
    const renderedPath = pathRenderer(
        { data: { markdown: "", reportPath: "report\nroot\u2028format\u202e%`file.md", truncated: false } },
        {},
        { bg: (_color: string, text: string) => text, fg: (_color: string, text: string) => text },
    )
        .render(400)
        .join("\n");
    const reportPathRenderingSafe =
        renderedPath.includes("report%0Aroot%E2%80%A8format%E2%80%AE%25%60file.md") &&
        !/[\u2028\u202e`]/u.test(renderedPath);

    process.stdout.write(
        `SPECPI_WISHLIST_HARNESS=${JSON.stringify({
            reportPathRenderingSafe,
            toolNames: tools.map((tool) => tool.name),
            commandNames: [...commands.keys()],
            consent: confirmations[0],
            resetConfirmed: confirmations.some((value) => value.startsWith("Reset active wishlist?")),
            completionToolExposed: tools.some((tool) => tool.name === "finish_harness_improvement"),
            lifecycleBypassBlocked: notifications.some((item) =>
                item.message.includes("verification retires the selected item automatically"),
            ),
            reportStableAfterRetirement:
                reportStableAfterRetirement.includes("# Retired") &&
                !reportStableAfterRetirement.includes("# Needs review"),
            improvementMenu: selections[0],
            reopenMenu: selections[1],
            legacyCandidate,
            unauthorizedCompletion,
            implementationStarted: sentUserMessages[0],
            verificationCommands: execs,
            journalPersisted: Boolean(
                journalRecord?.journal?.evidence?.includes("Browser interaction and visual comparison smoke passed") &&
                journalRecord.journal.gates?.includes("npm run check") &&
                journalRecord.journal.gates?.includes("browser-runtime-smoke") &&
                typeof journalRecord.journal.version === "string",
            ),
            contractRecorded: Boolean(
                entries.find(
                    (entry: any) =>
                        entry.customType === "specpi-task-contract" &&
                        entry.data?.kind === "set" &&
                        entry.data.contract?.gapId === "local-browser-automation" &&
                        entry.data.contract?.selectionId === activeSelection?.selectionId,
                ),
            ),
            receiptPersisted: Boolean(
                journalRecord?.journal?.receipt?.gapId === "local-browser-automation" &&
                journalRecord.journal.receipt?.selectionId === activeSelection?.selectionId &&
                journalRecord.journal.receipt?.runtime?.node === process.version,
            ),
            journalChangedFiles: journalRecord?.journal?.changedFiles,
            failedGate,
            selectedAfterFailedGate:
                reportAfterFailedGate.includes("# Selected") && reportAfterFailedGate.includes("- Status: selected"),
            failedValidatorGate,
            selectedAfterFailedValidator:
                reportAfterValidatorFail.includes("# Selected") &&
                reportAfterValidatorFail.includes("- Status: selected"),
            reopenPrompt,
            gitMetadataSanitizedAndBounded:
                !reopenPrompt.includes("private.example") &&
                gitContextLines.length === 2 &&
                gitContextLines.every((line) => line.length <= 242),
            reopenLinkPersisted:
                reopens.length === 2 && reopens[0].targetKey === "" && reopens[1].targetKey === journalRecord?.id,
            reopenEvidenceIncludesWindow:
                reopens[1]?.evidence?.some(
                    (item: string) => item.startsWith("Signal window: ") && item.includes(" to "),
                ) ?? false,
            historyEntryRendered: Boolean(historyEntry?.data?.markdown?.includes("Linked retirement")),
            evidenceRenderedInHistory: Boolean(
                historyEntry?.data?.markdown?.includes("Browser interaction and visual comparison smoke passed"),
            ),
            statusMetrics: notifications
                .map((item: any) => item.message)
                .find((message: string) => message.includes("retirements")),
            rawSessionIdPersisted: entries.some((entry) => JSON.stringify(entry).includes("extension-harness-session")),
            issueDraftRendered: entries.some((entry) => entry.data?.markdown?.includes("Local draft only")),
            checksumsValid,
            eventsAfterReset,
            collectionMode: config.mode,
            saltPreserved: fs.existsSync(path.join(stateDir, ".tool-wishlist-salt")),
            notifications,
        })}\n`,
    );
}
