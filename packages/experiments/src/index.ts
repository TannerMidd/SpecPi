import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    createExperiment,
    defaultPatchPath,
    discardExperiment,
    experimentStatus,
    exportExperimentPatch,
    findExperiment,
    inspectRepository,
    readExperimentRegistry,
    recoverExperiments,
    repairExperimentRecord,
} from "./experiments.mjs";
import { experimentCardEditorText, parseExperimentCard } from "./card.mjs";
import { sanitizePathLabel } from "./git-status.mjs";

const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
const stateDir = path.join(agentDir, "specpi");
const TASK_CONTRACT_ENTRY = "specpi-task-contract";

// A task contract is optional context, not a dependency. Another package may publish a
// `specpi-task-contract` branch entry to prefill the card; without one the card starts blank.
function readTaskContract(ctx: ExtensionContext): any | undefined {
    let latest: any;
    try {
        for (const entry of ctx.sessionManager.getBranch?.() ?? []) {
            if ((entry as any)?.type === "custom" && (entry as any).customType === TASK_CONTRACT_ENTRY) {
                latest = (entry as any).data;
            }
        }
    } catch {
        return undefined;
    }

    const contract = latest?.kind === "set" ? latest.contract : undefined;

    return contract && Array.isArray(contract.requirements) && Array.isArray(contract.nonGoals) ? contract : undefined;
}

function safeMessage(error: unknown) {
    return (error instanceof Error ? error.message : String(error))
        .replace(/[\u0000-\u001f\u007f]+/gu, " ")
        .slice(0, 500);
}

export default function experiments(pi: ExtensionAPI) {
    let experimentBusy = false;
    const exec = (command: string, args: string[], options: any = {}) => pi.exec(command, args, options);

    // One experiment operation at a time: these drive `git worktree`, which is not safe to
    // run concurrently against the same repository.
    const withExperimentOperation = async (ctx: ExtensionContext, operation: () => Promise<void>) => {
        if (experimentBusy) {
            ctx.ui.notify("Another experiment operation is already active.", "warning");

            return;
        }

        experimentBusy = true;
        try {
            await operation();
        } catch (error) {
            ctx.ui.notify(safeMessage(error), "error");
        } finally {
            experimentBusy = false;
        }
    };

    pi.registerCommand("experiment", {
        description: "Create and close bounded detached Git worktree experiments",
        getArgumentCompletions: (prefix: string) =>
            ["start", "status", "close", "recover"]
                .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
                .map((value) => ({ value, label: value })),
        handler: async (args, ctx) => {
            const [actionRaw, ...rest] = args.trim().split(/\s+/u).filter(Boolean);
            const action = actionRaw?.toLowerCase() || "status";
            const query = rest.join(" ");
            await withExperimentOperation(ctx, async () => {
                if (action === "start") {
                    if (!ctx.hasUI || typeof ctx.ui.editor !== "function") {
                        throw new Error("Starting an experiment requires interactive editor support");
                    }

                    const repository = await inspectRepository(exec, ctx.cwd);
                    if (repository.changedPaths.length > 0) {
                        const proceed = await ctx.ui.confirm(
                            "Start from HEAD without current uncommitted changes?",
                            `${repository.changedPaths.length} dirty path(s) remain untouched in the base worktree and will not be copied.`,
                        );
                        if (!proceed) {
                            return;
                        }
                    }

                    const currentTask = readTaskContract(ctx);
                    const template = experimentCardEditorText(currentTask, query);
                    const edited = await ctx.ui.editor("Experiment card", template);
                    if (edited === undefined) {
                        return;
                    }

                    const card = parseExperimentCard(edited, query);
                    const preview = `Base: ${repository.baseCommit}\nRepository: ${repository.repoRoot}\nHypothesis: ${card.hypothesis}\nAcceptance: ${card.acceptance}`;
                    if (!(await ctx.ui.confirm("Create detached experiment worktree?", preview))) {
                        return;
                    }

                    const record = await createExperiment({ exec, stateDir, repository, card });
                    ctx.ui.notify(
                        `Experiment ${record.id.slice(0, 8)} created at ${record.worktreePath}. Open a separate human-controlled Pi session in that directory.`,
                        "info",
                    );

                    return;
                }

                if (action === "status") {
                    if (!query) {
                        try {
                            const current = findExperiment(stateDir, "", ctx.cwd);
                            const status = await experimentStatus(exec, current);
                            ctx.ui.notify(
                                `${current.name} (${current.id.slice(0, 8)}): ${current.status}; ${status.changedPaths.length} changed, ${status.committed} committed, ${status.untracked} untracked, ${status.ignored} ignored path(s) (not exportable); acceptance: ${current.acceptance}`,
                                "info",
                            );
                        } catch {
                            const records = readExperimentRegistry(stateDir).experiments;
                            ctx.ui.notify(
                                records.length > 0
                                    ? records
                                          .map(
                                              (item) =>
                                                  `${item.id.slice(0, 8)} ${item.name} [${item.status}] ${item.worktreePath}`,
                                          )
                                          .join("\n")
                                    : "No retained experiments.",
                                "info",
                            );
                        }

                        return;
                    }

                    const record = findExperiment(stateDir, query, ctx.cwd);
                    const status = await experimentStatus(exec, record);
                    ctx.ui.notify(
                        `${record.name} (${record.id.slice(0, 8)}): ${record.status}; ${status.changedPaths.length} changed, ${status.committed} committed, ${status.untracked} untracked, ${status.ignored} ignored path(s) (not exportable); acceptance: ${record.acceptance}`,
                        "info",
                    );

                    return;
                }

                if (action === "close") {
                    const record = findExperiment(stateDir, query, ctx.cwd);
                    const status = await experimentStatus(exec, record);
                    if (!ctx.hasUI) {
                        throw new Error("Closing an experiment requires interactive confirmation");
                    }

                    const extraNote = [
                        status.committed > 0 ? `${status.committed} committed path(s)` : "",
                        status.ignored > 0 ? `${status.ignored} ignored path(s) a patch cannot carry` : "",
                        status.committedUnknown ? "commit history could not be read" : "",
                    ]
                        .filter(Boolean)
                        .join(", ");
                    const ignoredNote = extraNote ? `; ${extraNote}` : "";
                    const choice = await ctx.ui.select(
                        `${record.name}: ${status.changedPaths.length} changed path(s)${ignoredNote}; acceptance: ${record.acceptance}`,
                        ["Keep worktree", "Export patch", "Discard worktree"],
                    );
                    if (choice === "Keep worktree" || !choice) {
                        ctx.ui.notify("Experiment kept; no files changed.", "info");

                        return;
                    }

                    if (choice === "Export patch") {
                        const suggested = defaultPatchPath(stateDir, record);
                        const edited =
                            typeof ctx.ui.editor === "function"
                                ? await ctx.ui.editor("Patch output path", suggested)
                                : suggested;
                        if (edited === undefined || !edited.trim()) {
                            return;
                        }

                        const destination = path.resolve(edited.trim());
                        const overwrite = fs.existsSync(destination)
                            ? await ctx.ui.confirm("Overwrite existing patch?", destination)
                            : false;
                        if (fs.existsSync(destination) && !overwrite) {
                            return;
                        }

                        const exported = await exportExperimentPatch({
                            exec,
                            stateDir,
                            record,
                            outputPath: destination,
                            overwrite,
                        });
                        ctx.ui.notify(
                            status.ignored > 0
                                ? `Patch exported to ${exported.outputPath}; worktree kept. ${status.ignored} ignored path(s) are NOT in the patch: ${status.ignoredPaths.slice(0, 5).map(sanitizePathLabel).join(", ")}`
                                : `Patch exported to ${exported.outputPath}; worktree kept.`,
                            status.ignored > 0 ? "warning" : "info",
                        );

                        return;
                    }

                    if (
                        !(await ctx.ui.confirm(
                            "Discard this registered experiment worktree?",
                            `${record.worktreePath}\nThis does not alter the base worktree.`,
                        ))
                    ) {
                        return;
                    }

                    // Ignored files never appear in `status --untracked-files=all` and never reach a patch, so without
                    // counting them here a worktree holding only ignored work would be deleted as if it were empty.
                    if (
                        status.hasWork &&
                        !(await ctx.ui.confirm(
                            "Discard dirty experiment permanently?",
                            status.ignored > 0
                                ? `${status.changedPaths.length} changed and ${status.committed} committed path(s) will be removed, plus ${status.ignored} ignored path(s) a patch cannot carry: ${status.ignoredPaths.slice(0, 5).map(sanitizePathLabel).join(", ")}`
                                : `${status.changedPaths.length} changed and ${status.committed} committed path(s) will be removed. Export a patch first if needed.`,
                        ))
                    ) {
                        return;
                    }

                    await discardExperiment({ exec, stateDir, record });
                    ctx.ui.notify(`Experiment ${record.id.slice(0, 8)} discarded.`, "warning");

                    return;
                }

                if (action === "recover") {
                    const repository = await inspectRepository(exec, ctx.cwd);
                    const findings = await recoverExperiments({ exec, stateDir, repoRoot: repository.repoRoot });
                    const pending = findings.filter((item) => item.needsRecovery);
                    if (pending.length === 0) {
                        ctx.ui.notify("No experiment recovery is needed for this repository.", "info");

                        return;
                    }

                    if (!ctx.hasUI) {
                        throw new Error(`${pending.length} experiment record(s) need interactive recovery`);
                    }

                    for (const finding of pending) {
                        // An orphan directory is neither present nor missing: Git has forgotten it but the files are
                        // still there, so it can only be released, never activated, and SpecPi never deletes it.
                        const state = finding.present
                            ? "worktree present"
                            : finding.orphanDirectory
                              ? "directory left behind by an interrupted creation"
                              : "worktree missing";
                        const options = finding.present
                            ? ["Leave unchanged", "Activate registry record"]
                            : finding.orphanDirectory
                              ? ["Leave unchanged", "Release record and keep the directory"]
                              : ["Leave unchanged", "Forget missing record"];
                        const choice = await ctx.ui.select(
                            `${finding.record.id.slice(0, 8)} ${finding.record.name}: ${state}`,
                            options,
                        );
                        const access = { exec, repoRoot: repository.repoRoot };
                        if (choice === "Activate registry record") {
                            await repairExperimentRecord(stateDir, finding.record.id, "activate", access);
                        } else if (choice === "Forget missing record") {
                            await repairExperimentRecord(stateDir, finding.record.id, "forget", access);
                        } else if (choice === "Release record and keep the directory") {
                            const released = await repairExperimentRecord(
                                stateDir,
                                finding.record.id,
                                "release",
                                access,
                            );
                            ctx.ui.notify(
                                `Record released. ${released?.released ?? finding.record.worktreePath} was left in place for you to inspect or delete.`,
                                "warning",
                            );
                        }
                    }

                    return;
                }

                throw new Error("Usage: /experiment [start [name]|status [id]|close [id]|recover]");
            });
        },
    });
}
