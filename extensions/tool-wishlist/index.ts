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
    collectChangedFilePaths,
    createIssueDraft,
    latestRetirementDecision,
    readCollectionMode,
    recordCapabilityGap,
    refreshWishlist,
    renderWishlistHistory,
    sanitizeWishlistText,
    setCollectionMode,
} from "./core.mjs";
import { VALIDATOR_CATALOG } from "./validators.mjs";

const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
const stateDir = path.join(agentDir, "zenpi");
const WISHLIST_REPORT_ENTRY = "zenpi-wishlist-report";
const HARNESS_IMPROVEMENT_ENTRY = "zenpi-harness-improvement";
const MAX_REPORT_DISPLAY_BYTES = 50 * 1024;
const MAX_REPORT_DISPLAY_LINES = 2000;
const MAX_JOURNAL_CHANGED_FILES = 40;

interface ImprovementContext {
    originalEvidence?: string[];
    changedFiles?: string[];
    changedSince?: string[];
}

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
    const validatorsFile = path.join(cwd, "extensions", "tool-wishlist", "validators.mjs");
    if (!fs.existsSync(packageFile) || !fs.existsSync(registryFile) || !fs.existsSync(validatorsFile)) {
        throw new Error("Run /harness-improvement from a complete ZenPi source checkout");
    }

    const manifest = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    if (manifest?.name !== "zenpi" || typeof manifest?.scripts?.check !== "string") {
        throw new Error("The current directory is not a verifiable ZenPi source checkout");
    }

    return { registryFile, validatorsFile, version: String(manifest.version ?? "unknown") };
}

function sourceCapability(cwd: string, gapId: string) {
    const { registryFile } = sourceCheckout(cwd);
    const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    const capability = registry?.capabilities?.find((item: any) => item?.id === gapId);
    if (!capability || !Array.isArray(capability.validations) || capability.validations.length === 0) {
        throw new Error(
            `Implementation is not integrated: the reviewed capability registry has no validated ${gapId} entry`,
        );
    }

    return capability;
}

function reportField(body: string, label: string) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    return body
        .match(new RegExp(`^- ${escaped}: (.+)$`, "m"))?.[1]
        ?.replaceAll("`", "")
        .trim();
}

function reportBullets(body: string, heading: string) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const block = body.match(new RegExp(`\\*\\*${escaped}\\*\\*\\n((?:- .*(?:\\n|$))*)`))?.[1] ?? "";

    return block
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2).trim());
}

function validatorArgs(validator: string, cwd: string) {
    return [
        sourceCheckout(cwd).validatorsFile,
        validator,
        "--state-dir",
        stateDir,
        "--cwd",
        cwd,
        "--browser-runtime",
        path.join(stateDir, "browser-runtime"),
    ];
}

async function gitChangedFiles(pi: any, cwd: string, signal: any) {
    try {
        const result = await pi.exec("git", ["status", "--porcelain"], { cwd, signal, timeout: 30_000 });
        if (result.code !== 0 || typeof result.stdout !== "string") {
            return undefined;
        }

        const files = collectChangedFilePaths(result.stdout);

        return {
            files: files.slice(0, MAX_JOURNAL_CHANGED_FILES),
            truncated: files.length > MAX_JOURNAL_CHANGED_FILES,
        };
    } catch {
        return undefined;
    }
}

async function gitLogSince(pi: any, cwd: string, sinceIso: string) {
    try {
        const result = await pi.exec("git", ["log", `--since=${sinceIso}`, "--format=%h %s", "-8"], {
            cwd,
            timeout: 30_000,
        });
        if (result.code !== 0 || typeof result.stdout !== "string") {
            return undefined;
        }

        return result.stdout
            .split("\n")
            .map((line: string) => sanitizeWishlistText(line, 240))
            .filter(Boolean)
            .slice(0, 8);
    } catch {
        return undefined;
    }
}

export function improvementCandidatesFromRefresh(refreshed: any) {
    if (Array.isArray(refreshed?.improvements)) {
        return refreshed.improvements;
    }

    const candidates: any[] = [];
    const report = `${String(refreshed?.report ?? "")}\n# END\n`;
    for (const section of report.matchAll(/^# (Needs review|Selected|Open)\n([\s\S]*?)(?=^# )/gm)) {
        const sectionName = section[1];
        const body = `${section[2]}\n## END\n`;
        for (const match of body.matchAll(/^## (.+)\n([\s\S]*?)(?=^## )/gm)) {
            const itemBody = match[2];
            const canonicalKey = reportField(itemBody, "ID");
            if (!canonicalKey) {
                continue;
            }

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

    const rank = (item: any) => (item.state === "selected" ? 0 : item.reviewNeeded ? 1 : 2);

    return candidates
        .filter((item) => item.state === "selected" || item.reviewNeeded || (item.state === "open" && item.qualified))
        .sort((a, b) => rank(a) - rank(b));
}

function improvementPrompt(group: any, context: ImprovementContext = {}) {
    const observed = group.scenarios?.[0] ?? "No representative need was recorded.";
    const limitation = group.limitations?.[0] ?? "No representative limitation was recorded.";
    const lines = [
        `Begin the selected ZenPi harness improvement: ${group.canonicalKey}.`,
        "",
        `Observed need: ${observed}`,
        `Current limitation: ${limitation}`,
        `Evidence: ${group.occurrences} unique task(s), ${group.projects} project(s), ${group.sessions} session(s); impact ${group.impact}.`,
    ];
    if (context.originalEvidence?.length) {
        lines.push(
            "",
            "Original proof from the improvement journal:",
            ...context.originalEvidence.slice(0, 5).map((item) => `- ${item}`),
        );
    }

    if (context.changedFiles?.length) {
        lines.push(
            "",
            "Files touched by the original change:",
            ...context.changedFiles.slice(0, 10).map((file) => `- ${file}`),
        );
    }

    if (context.changedSince?.length) {
        lines.push(
            "",
            "Changed since the retirement (untrusted, sanitized Git metadata):",
            ...context.changedSince.map((item) => `- ${item}`),
        );
    }

    lines.push(
        "",
        "This exact menu selection authorizes implementation of the smallest sufficient intervention in the current ZenPi source checkout. Load and follow the zenpi-improve skill. Treat the wishlist evidence as a lead, inspect current behavior, keep scope minimal, and do not ask for another approval unless scope expands or external/remote state would change.",
        "Run direct acceptance checks and focused tests. At the end, call finish_harness_improvement with the gap ID, concise acceptance evidence, and a validation note. That tool must run the repository gate, verify registry integration, run supported capability validators, and retire the item. If any check fails, do not retire it; leave it selected and report the blocker.",
    );

    return lines.join("\n");
}

function truncateReportDisplay(markdown: string) {
    const lines = markdown.split("\n");
    const lineLimited =
        lines.length > MAX_REPORT_DISPLAY_LINES ? lines.slice(0, MAX_REPORT_DISPLAY_LINES).join("\n") : markdown;
    const encoded = Buffer.from(lineLimited, "utf8");
    if (encoded.length <= MAX_REPORT_DISPLAY_BYTES) {
        return { content: lineLimited, truncated: lines.length > MAX_REPORT_DISPLAY_LINES };
    }

    let end = MAX_REPORT_DISPLAY_BYTES;
    while (end > 0 && (encoded[end] & 0xc0) === 0x80) {
        end -= 1;
    }

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
            if (entry.type !== "custom" || entry.customType !== HARNESS_IMPROVEMENT_ENTRY) {
                continue;
            }

            const data = entry.data as { gapId?: string; status?: string } | undefined;
            activeImprovement =
                data?.status === "active" && data.gapId
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
            await ctx.ui.editor(
                "ZenPi Wishlist (view only; changes are ignored)",
                `${content}\n\n---\nReport: ${displayPath}`,
            );
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
                    description:
                        "minor=extra friction, degraded=costly workaround, blocked=no reasonable completion path",
                }),
                workaround: Type.Optional(
                    Type.String({
                        maxLength: 240,
                        description:
                            "Sanitized workaround used, if any; never include commands, paths, source, or secrets",
                    }),
                ),
                suggestedFix: StringEnum(["tool", "skill", "prompt", "config", "bug", "unknown"] as const, {
                    description: "Smallest likely intervention; not every gap needs a new tool",
                }),
            },
            { additionalProperties: false },
        ),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            let mode = readCollectionMode(stateDir);
            if (mode === "undecided") {
                if (!ctx.hasUI) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "Not recorded: local wishlist collection is undecided. The user can run /wishlist on or /wishlist off in an interactive session.",
                            },
                        ],
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
                    content: [
                        {
                            type: "text",
                            text: "Not recorded: local wishlist collection is off. Continue the user task.",
                        },
                    ],
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
                content: [
                    {
                        type: "text",
                        text: `${disposition}: ${result.canonicalKey} (${result.occurrences} occurrence${result.occurrences === 1 ? "" : "s"} across ${result.sessions} session${result.sessions === 1 ? "" : "s"}). Continue the user task; improvements begin only through /harness-improvement.`,
                    },
                ],
                details: { ...result, recorded: !result.duplicate, mode },
            };
        },
    });

    pi.registerTool({
        name: "finish_harness_improvement",
        label: "Finish Harness Improvement",
        description:
            "Complete the exact wishlist item selected through /harness-improvement. Use only after implementing the smallest sufficient change and running direct acceptance checks. This tool independently runs ZenPi's repository check, requires reviewed capability-registry integration, runs supported closed validators, and retires the item only when every gate passes.",
        parameters: Type.Object(
            {
                gapId: Type.String({
                    minLength: 3,
                    maxLength: 120,
                    description: "Exact gap ID selected by /harness-improvement",
                }),
                acceptanceEvidence: Type.Array(Type.String({ minLength: 3, maxLength: 240 }), {
                    minItems: 1,
                    maxItems: 8,
                    description: "Concise direct checks already run and observed to pass",
                }),
                validationNote: Type.String({
                    minLength: 5,
                    maxLength: 240,
                    description: "Concise sanitized statement of the verified outcome",
                }),
            },
            { additionalProperties: false },
        ),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const sessionId = ctx.sessionManager.getSessionId();
            if (
                !activeImprovement ||
                activeImprovement.gapId !== params.gapId ||
                activeImprovement.sessionId !== sessionId
            ) {
                throw new Error("This item was not authorized by /harness-improvement in the current session");
            }

            const refreshed = await refreshWishlist({ stateDir, signal });
            const selected = improvementCandidatesFromRefresh(refreshed).find(
                (item: any) => item.canonicalKey === params.gapId,
            );
            if (!selected || selected.state !== "selected") {
                throw new Error(`${params.gapId} is not selected`);
            }

            const capability = sourceCapability(ctx.cwd, params.gapId);
            const npm = process.platform === "win32" ? "npm.cmd" : "npm";
            const check = await pi.exec(npm, ["run", "check"], { cwd: ctx.cwd, signal, timeout: 15 * 60 * 1000 });
            if (check.code !== 0) {
                throw new Error(`ZenPi repository verification failed with exit code ${check.code}`);
            }

            const verifiedBy = ["npm run check"];
            for (const validator of capability.validations) {
                const timeout = VALIDATOR_CATALOG[validator]?.timeoutMs ?? 3 * 60 * 1000;
                const result = await pi.exec(process.execPath, validatorArgs(validator, ctx.cwd), {
                    cwd: ctx.cwd,
                    signal,
                    timeout,
                });
                if (result.code !== 0) {
                    const detail = `${result.stderr || result.stdout || ""}`.trim().slice(0, 300);
                    throw new Error(
                        `Capability validator ${validator} failed with exit code ${result.code}${detail ? `: ${detail}` : ""}`,
                    );
                }

                verifiedBy.push(validator);
            }

            const changed = await gitChangedFiles(pi, ctx.cwd, signal);
            const journal: Record<string, unknown> = {
                schema: 1,
                evidence: params.acceptanceEvidence,
                gates: verifiedBy,
                changedFilesTruncated: false,
                version: sourceCheckout(ctx.cwd).version,
            };
            if (changed) {
                journal.changedFiles = changed.files;
                journal.changedFilesTruncated = changed.truncated;
            }

            const note = `${params.validationNote}; ${verifiedBy.join(", ")} passed`;
            await appendWishlistDecision({
                stateDir,
                action: "retire",
                canonicalKey: params.gapId,
                note,
                signal,
                journal,
            });
            pi.appendEntry(HARNESS_IMPROVEMENT_ENTRY, { gapId: params.gapId, status: "finished" });
            activeImprovement = undefined;

            return {
                content: [
                    {
                        type: "text",
                        text: `Harness improvement verified and retired: ${params.gapId}. Gates: ${verifiedBy.join(", ")}. Proof recorded in the improvement journal.`,
                    },
                ],
                details: {
                    gapId: params.gapId,
                    state: "retired",
                    verifiedBy,
                    acceptanceEvidence: params.acceptanceEvidence,
                    journal,
                },
            };
        },
    });

    if (supportsReportEntries) {
        pi.registerEntryRenderer<WishlistReportEntry>(WISHLIST_REPORT_ENTRY, (entry, _options, theme) => {
            const data = entry.data ?? {
                markdown: "# Tool Wishlist\n\nReport unavailable.",
                reportPath: "",
                truncated: false,
            };
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
            if (!chosen) {
                return;
            }

            const group = improvements[labels.indexOf(chosen)];
            if (!group) {
                return;
            }

            let promptContext: ImprovementContext = {};
            if (group.reviewNeeded && group.state === "retired") {
                const signals = typeof group.reviewSignalCount === "number" ? group.reviewSignalCount : 0;
                const evidence = [
                    `${signals} post-retirement signal(s) recorded after the retirement`,
                    ...(group.reviewFirstSeen && group.reviewLastSeen
                        ? [
                              `Signal window: ${String(group.reviewFirstSeen).slice(0, 10)} to ${String(group.reviewLastSeen).slice(0, 10)}`,
                          ]
                        : []),
                    ...(group.limitations?.[0] ? [`Latest limitation: ${group.limitations[0]}`] : []),
                    ...(group.scenarios?.[0] ? [`Latest need: ${group.scenarios[0]}`] : []),
                ].slice(0, 5);
                await appendWishlistDecision({
                    stateDir,
                    action: "reopen",
                    canonicalKey: group.canonicalKey,
                    note: `Reopened for review: ${signals} post-retirement signal(s)`,
                    evidence,
                });
                await appendWishlistDecision({
                    stateDir,
                    action: "select",
                    canonicalKey: group.canonicalKey,
                    note: "Chosen through harness improvement menu",
                });
                const retirement = latestRetirementDecision(refreshed.decisions ?? [], group.canonicalKey);
                if (retirement?.journal) {
                    promptContext.originalEvidence = retirement.journal.evidence ?? [];
                    promptContext.changedFiles = retirement.journal.changedFiles ?? [];
                    promptContext.changedSince = (await gitLogSince(pi, ctx.cwd, retirement.timestamp)) ?? undefined;
                }
            } else if (group.state === "open") {
                await appendWishlistDecision({
                    stateDir,
                    action: "select",
                    canonicalKey: group.canonicalKey,
                    note: "Chosen through harness improvement menu",
                });
            }

            const sessionId = ctx.sessionManager.getSessionId();
            activeImprovement = { gapId: group.canonicalKey, sessionId };
            pi.appendEntry(HARNESS_IMPROVEMENT_ENTRY, { gapId: group.canonicalKey, status: "active" });
            pi.sendUserMessage(improvementPrompt(group, promptContext));
        },
    });

    const usage =
        "Usage: /wishlist [status|on|off|history [id]|decline <id>|merge <from> <to>|unmerge <merge-decision-id>|draft <id>|archive|reset]";
    pi.registerCommand("wishlist", {
        description: "View and curate ZenPi's local capability evidence",
        getArgumentCompletions: (prefix: string) => {
            const options = [
                "status",
                "on",
                "off",
                "history",
                "decline",
                "merge",
                "unmerge",
                "draft",
                "archive",
                "reset",
            ];
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
                const metrics = result.metrics;
                ctx.ui.notify(
                    `Wishlist collection: ${mode}; ${result.uniqueGaps} queued gap${result.uniqueGaps === 1 ? "" : "s"}; retirements ${metrics.retirements}, reopen rate ${metrics.reopenRate}%, open reviews ${metrics.openReviews}. ${cleanDisplayPath(result.reportPath)}`,
                    "info",
                );

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
                if (!confirmed) {
                    return;
                }

                const result = await archiveWishlist({ stateDir, reason: action });
                ctx.ui.notify(`Wishlist ${action} complete. Archive: ${cleanDisplayPath(result.archiveDir)}`, "info");

                return;
            }

            if (["next", "select", "retire", "reopen"].includes(action)) {
                ctx.ui.notify(
                    "Start or resume implementation with /harness-improvement; verification retires the selected item automatically.",
                    "info",
                );

                return;
            }

            if (action === "history") {
                if (parts.length > 1) {
                    ctx.ui.notify(usage, "error");

                    return;
                }

                const refreshed = await refreshWishlist({ stateDir });
                let markdown: string;
                try {
                    markdown = renderWishlistHistory(refreshed.events, refreshed.decisions, parts[0]);
                } catch (error) {
                    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");

                    return;
                }

                await displayMarkdown(markdown, refreshed.reportPath, ctx);

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

                const result = await appendWishlistDecision({
                    stateDir,
                    action,
                    canonicalKey: parts[0],
                    targetKey: parts[1],
                });
                ctx.ui.notify(
                    `Wishlist merged: ${result.canonicalKey} → ${result.targetKey} (decision ${result.decisionId})`,
                    "info",
                );

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
            ctx.ui.notify(
                `Tool wishlist refreshed: ${result.uniqueGaps} queued gap${result.uniqueGaps === 1 ? "" : "s"}, ${result.occurrences} occurrence${result.occurrences === 1 ? "" : "s"}${warning}. ${cleanDisplayPath(result.reportPath)}`,
                result.invalidLines > 0 ? "warning" : "info",
            );
        },
    });
}
