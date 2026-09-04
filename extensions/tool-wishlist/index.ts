/**
 * SpecPi capability-gap collector and explicit improvement lifecycle.
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
    latestLocalRetirementDecision,
    latestOutcomeDecision,
    latestRetirementDecision,
    normalizeCapability,
    readCollectionMode,
    recordCapabilityGap,
    refreshWishlist,
    renderWishlistHistory,
    sanitizeWishlistText,
    setCollectionMode,
    wishlistSourceRootIdentity,
    wishlistSourceRootSalt,
} from "./core.mjs";
import { VALIDATOR_CATALOG } from "./validators.mjs";
import { isValidValidatorName, validateCapabilityRegistry } from "./registry.mjs";
import {
    TASK_CONTRACT_ENTRY,
    createTaskContract,
    markdownPathLabel,
    readTaskContract,
    taskContractScopeViolations,
} from "../workflow-controls/task-contract.mjs";
import {
    captureSourceSnapshot,
    assertNoRootNpmrc,
    assertSafeSourceInput,
    canonicalSourceRoot,
    compareSourceSnapshots,
    createVerificationReceipt,
    readSafeSourceText,
    validateSourceSnapshot,
    validateVerificationReceipt,
} from "./verification.mjs";

const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
const stateDir = path.join(agentDir, "specpi");
const WISHLIST_REPORT_ENTRY = "specpi-wishlist-report";
const HARNESS_IMPROVEMENT_ENTRY = "specpi-harness-improvement";
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
    root: string;
    selectionId: string;
    baseline: any;
    checkScript: string;
    scripts: Record<string, string>;
    validatorNames: string[];
    validatorIds: string[];
    registryDefinitions: any[];
    registryHadGap: boolean;
    moduleDigests: Record<string, string>;
}

function sourceCheckout(cwd: string) {
    const packageFile = path.join(cwd, "package.json");
    const registryFile = path.join(cwd, "extensions", "tool-wishlist", "capabilities.json");
    const validatorsFile = path.join(cwd, "extensions", "tool-wishlist", "validators.mjs");
    if (!fs.existsSync(packageFile) || !fs.existsSync(registryFile) || !fs.existsSync(validatorsFile)) {
        throw new Error("Run /harness-improvement from a complete SpecPi source checkout");
    }

    assertNoRootNpmrc(cwd);
    assertSafeSourceInput(cwd, "package.json");
    assertSafeSourceInput(cwd, "extensions/tool-wishlist/capabilities.json");
    assertSafeSourceInput(cwd, "extensions/tool-wishlist/validators.mjs");

    const manifest = JSON.parse(readSafeSourceText(cwd, "package.json"));
    if (manifest?.name !== "specpi" || typeof manifest?.scripts?.check !== "string") {
        throw new Error("The current directory is not a verifiable SpecPi source checkout");
    }

    const registry = validateCapabilityRegistry(
        JSON.parse(readSafeSourceText(cwd, "extensions/tool-wishlist/capabilities.json")),
    );

    return {
        registryFile,
        validatorsFile,
        version: String(manifest.version ?? "unknown"),
        checkScript: manifest.scripts.check,
        scripts: cloneJson(manifest.scripts),
        registry,
        validatorNames: Object.keys(VALIDATOR_CATALOG).sort(),
    };
}

function sourceCapability(cwd: string, gapId: string) {
    const { registry } = sourceCheckout(cwd);
    const capability = registry?.capabilities?.find((item: any) => item?.id === gapId);
    if (!capability || !Array.isArray(capability.validations) || capability.validations.length === 0) {
        throw new Error(
            `Implementation is not integrated: the reviewed capability registry has no validated ${gapId} entry`,
        );
    }

    return capability;
}

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function sourceModulePaths() {
    return {
        editorConfig: ".editorconfig",
        prettierIgnore: ".prettierignore",
        eslintConfig: "eslint.config.js",
        prettierConfig: "prettier.config.mjs",
        packageCheck: "scripts/check-package.mjs",
        core: "extensions/tool-wishlist/core.mjs",
        dispatcher: "extensions/tool-wishlist/index.ts",
        registry: "extensions/tool-wishlist/registry.mjs",
        validators: "extensions/tool-wishlist/validators.mjs",
        verification: "extensions/tool-wishlist/verification.mjs",
        taskContract: "extensions/workflow-controls/task-contract.mjs",
        scope: "extensions/workflow-controls/scope.mjs",
    };
}

function sourceModuleDigests(snapshot: any) {
    const digests: Record<string, string> = {};
    for (const relativePath of Object.values(sourceModulePaths())) {
        const digest = snapshot.files?.[relativePath]?.sha256;
        if (typeof digest !== "string") {
            throw new Error(`Verification baseline is missing ${markdownPathLabel(relativePath)}`);
        }

        digests[relativePath] = digest;
    }

    return digests;
}

function branchEntries(ctx: any) {
    return (ctx.sessionManager.getBranch?.() ?? []).filter((entry: any) => entry?.type === "custom");
}

function branchTaskContract(ctx: any, root: string, { tolerateMalformed = false } = {}) {
    try {
        return readTaskContract(branchEntries(ctx), root);
    } catch (error) {
        if (tolerateMalformed) {
            return undefined;
        }

        throw error;
    }
}

function parseGitInventory(stdout: string) {
    const ignored = new Set<string>();
    const fields = stdout.includes("\0") ? stdout.split("\0") : stdout.split("\n");
    for (const field of fields) {
        if (!field.startsWith("!! ")) {
            continue;
        }

        const value = field.slice(3).replace(/[\\/]+$/u, "");
        if (value) {
            ignored.add(value);
        }
    }

    return [...ignored];
}

async function gitIgnoredPaths(pi: any, cwd: string, signal: any) {
    try {
        const result = await pi.exec(
            "git",
            ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"],
            { cwd, signal, timeout: 30_000 },
        );
        if (result.code !== 0 || typeof result.stdout !== "string") {
            if (fs.existsSync(path.join(cwd, ".git")) || fs.existsSync(path.join(cwd, ".gitignore"))) {
                throw new Error("Could not enumerate Git ignored inputs for the SpecPi checkout");
            }

            return [];
        }

        return parseGitInventory(result.stdout);
    } catch (error) {
        if (signal?.aborted) {
            throw signal.reason ?? error;
        }

        throw error;
    }
}

async function gitHead(pi: any, cwd: string, signal: any) {
    try {
        const result = await pi.exec("git", ["rev-parse", "HEAD"], { cwd, signal, timeout: 30_000 });
        const value = typeof result.stdout === "string" ? result.stdout.trim() : "";
        if (result.code !== 0 || !/^[a-f0-9]{7,64}$/iu.test(value)) {
            return undefined;
        }

        return value;
    } catch (error) {
        if (signal?.aborted) {
            throw signal.reason ?? error;
        }

        return undefined;
    }
}

async function resolveTaskContractRoot(pi: any, cwd: string, signal: any) {
    let result;
    try {
        result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, signal, timeout: 15_000 });
    } catch (error) {
        if (signal?.aborted) {
            throw signal.reason ?? error;
        }

        return canonicalSourceRoot(cwd);
    }

    if (signal?.aborted) {
        throw signal.reason ?? new Error("Wishlist report cancelled");
    }

    if (result?.code === 0 && typeof result.stdout === "string" && result.stdout.trim()) {
        const candidate = path.resolve(cwd, result.stdout.trim());
        const relative = path.relative(candidate, cwd);
        if (relative !== "" && relative.startsWith("..")) {
            throw new Error("Git reported a task contract root outside the current project");
        }

        return canonicalSourceRoot(candidate);
    }

    return canonicalSourceRoot(cwd);
}

async function captureCheckoutSnapshot(pi: any, cwd: string, signal: any) {
    const ignoredPaths = await gitIgnoredPaths(pi, cwd, signal);
    const headResult = await gitHead(pi, cwd, signal);

    return captureSourceSnapshot(cwd, {
        ...(ignoredPaths === undefined ? {} : { ignoredPaths }),
        ...(headResult === undefined ? {} : { head: headResult }),
    });
}

function policyFromCheckout(checkout: ReturnType<typeof sourceCheckout>, baseline: any, gapId: string) {
    const currentEntry = checkout.registry.capabilities.find((item: any) => item.id === gapId);

    return {
        checkScript: checkout.checkScript,
        scripts: cloneJson(checkout.scripts),
        validatorNames: [...checkout.validatorNames],
        registryDefinitions: cloneJson(checkout.registry.capabilities),
        registryHadGap: Boolean(currentEntry),
        validatorIds: currentEntry ? [...currentEntry.validations] : [],
        moduleDigests: sourceModuleDigests(baseline),
    };
}

function sameJson(left: unknown, right: unknown) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function assertFrozenSourcePolicy(cwd: string, gapId: string, active: ActiveImprovement) {
    const checkout = sourceCheckout(cwd);
    if (checkout.checkScript !== active.checkScript) {
        throw new Error("The SpecPi check script changed after this improvement was selected; reselect the gap");
    }

    if (!sameJson(checkout.scripts, active.scripts)) {
        throw new Error("The SpecPi npm scripts changed after this improvement was selected; reselect the gap");
    }

    if (!sameJson(checkout.validatorNames, active.validatorNames)) {
        throw new Error("The closed validator catalog changed after this improvement was selected; reselect the gap");
    }

    const frozenById = new Map(active.registryDefinitions.map((item: any) => [item.id, item]));
    const currentById = new Map(checkout.registry.capabilities.map((item: any) => [item.id, item]));
    for (const [id, frozen] of frozenById) {
        if (!sameJson(currentById.get(id), frozen)) {
            throw new Error(
                `The reviewed registry entry ${id} changed after this improvement was selected; reselect the gap`,
            );
        }
    }

    const extra = checkout.registry.capabilities.filter((item: any) => !frozenById.has(item.id));
    if (active.registryHadGap) {
        if (extra.length > 0) {
            throw new Error("The capability registry gained entries after selection; reselect the gap");
        }
    } else if (extra.length !== 1 || extra[0]?.id !== gapId) {
        throw new Error("A new improvement may add only its own capability registry entry");
    } else if (
        !Array.isArray(extra[0].validations) ||
        extra[0].validations.length === 0 ||
        extra[0].validations.some((validator: string) => !active.validatorNames.includes(validator))
    ) {
        throw new Error("A new capability registry entry must use only the frozen validator catalog");
    }

    if (active.registryHadGap && !sameJson(currentById.get(gapId)?.validations, active.validatorIds)) {
        throw new Error("The selected capability validator list changed after selection; reselect the gap");
    }

    return { checkout, capability: currentById.get(gapId) };
}

function assertFrozenModuleDigests(snapshot: any, active: ActiveImprovement) {
    for (const [relativePath, expected] of Object.entries(active.moduleDigests)) {
        if (snapshot.files?.[relativePath]?.sha256 !== expected) {
            throw new Error(`Protected verification input changed after selection: ${markdownPathLabel(relativePath)}`);
        }
    }
}

function assertFinishSelectionStillActive(
    current: ActiveImprovement | undefined,
    expected: ActiveImprovement,
    ctx: any,
    signal?: any,
) {
    if (signal?.aborted) {
        throw signal.reason ?? new Error("Verification cancelled");
    }

    if (
        !current ||
        current.gapId !== expected.gapId ||
        current.sessionId !== expected.sessionId ||
        current.root !== expected.root ||
        current.selectionId !== expected.selectionId ||
        current.baseline?.digest !== expected.baseline?.digest ||
        current.checkScript !== expected.checkScript ||
        !sameJson(current.scripts, expected.scripts) ||
        !sameJson(current.validatorNames, expected.validatorNames) ||
        !sameJson(current.validatorIds, expected.validatorIds) ||
        !sameJson(current.registryDefinitions, expected.registryDefinitions) ||
        current.registryHadGap !== expected.registryHadGap ||
        !sameJson(current.moduleDigests, expected.moduleDigests) ||
        ctx.sessionManager.getSessionId() !== expected.sessionId
    ) {
        throw new Error("The active improvement selection changed while verification was running");
    }

    if (canonicalSourceRoot(ctx.cwd) !== expected.root) {
        throw new Error("The SpecPi source root changed while verification was running");
    }
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
        `Begin the selected SpecPi harness improvement: ${group.canonicalKey}.`,
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
        "This exact menu selection authorizes implementation of the smallest sufficient intervention in the current SpecPi source checkout. Load and follow the specpi-improve skill. Treat the wishlist evidence as a lead, inspect current behavior, keep scope minimal, and do not ask for another approval unless scope expands or external/remote state would change.",
        "First call record_harness_contract with the exact gap, selection ID, source root, proposed requirements, acceptance checks, paths, rollback, and non-goals. Run direct acceptance checks and focused tests. At the end, call finish_harness_improvement with the gap ID, concise acceptance evidence, and a validation note. That tool independently runs the repository gate, verifies registry integration and frozen policy inputs, runs supported capability validators, records a bounded local receipt, and retires the item. If any check fails, do not retire it; leave it selected and report the blocker.",
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
    return markdownPathLabel(value);
}

export default function toolWishlist(pi: ExtensionAPI) {
    let activeRunId = randomUUID();
    let activeImprovement: ActiveImprovement | undefined;
    let improvementLifecycleGeneration = 0;
    let improvementMenuGeneration = 0;
    let finishBusy = false;
    let contractBusy = false;
    const supportsReportEntries = typeof pi.registerEntryRenderer === "function";

    const restoreActiveImprovement = (ctx: any) => {
        improvementLifecycleGeneration += 1;
        activeImprovement = undefined;
        for (const entry of ctx.sessionManager.getBranch?.() ?? []) {
            if (entry.type !== "custom" || entry.customType !== HARNESS_IMPROVEMENT_ENTRY) {
                continue;
            }

            const data = entry.data as
                | {
                      gapId?: string;
                      status?: string;
                      root?: string;
                      selectionId?: string;
                      baseline?: any;
                      checkScript?: string;
                      scripts?: Record<string, string>;
                      validatorNames?: string[];
                      validatorIds?: string[];
                      registryDefinitions?: any[];
                      registryHadGap?: boolean;
                      moduleDigests?: Record<string, string>;
                  }
                | undefined;
            if (data?.status !== "active") {
                activeImprovement = undefined;
                continue;
            }

            try {
                if (
                    !data.gapId ||
                    !data.root ||
                    !data.selectionId ||
                    !data.baseline ||
                    typeof data.checkScript !== "string" ||
                    !data.scripts ||
                    typeof data.scripts !== "object" ||
                    !Array.isArray(data.validatorNames) ||
                    !data.validatorNames.every(isValidValidatorName) ||
                    !Array.isArray(data.validatorIds) ||
                    !data.validatorIds.every(isValidValidatorName) ||
                    !Array.isArray(data.registryDefinitions) ||
                    typeof data.registryHadGap !== "boolean" ||
                    !data.moduleDigests ||
                    typeof data.moduleDigests !== "object"
                ) {
                    throw new Error("legacy improvement selection metadata");
                }

                const baseline = validateSourceSnapshot(data.baseline, data.root);
                const expectedModuleDigests = sourceModuleDigests(baseline);
                if (!sameJson(data.moduleDigests, expectedModuleDigests)) {
                    throw new Error("improvement module baseline mismatch");
                }

                validateCapabilityRegistry({ schema: 1, capabilities: data.registryDefinitions });
                activeImprovement = {
                    gapId: data.gapId,
                    sessionId: ctx.sessionManager.getSessionId(),
                    root: baseline.root,
                    selectionId: data.selectionId,
                    baseline,
                    checkScript: data.checkScript,
                    scripts: cloneJson(data.scripts),
                    validatorNames: [...data.validatorNames],
                    validatorIds: [...data.validatorIds],
                    registryDefinitions: cloneJson(data.registryDefinitions),
                    registryHadGap: data.registryHadGap,
                    moduleDigests: { ...data.moduleDigests },
                };
            } catch {
                // Older active entries intentionally require a fresh human selection.
                activeImprovement = undefined;
            }
        }
    };

    pi.on("session_start", (_event, ctx) => {
        restoreActiveImprovement(ctx);
    });

    pi.on("session_tree", (_event, ctx) => {
        restoreActiveImprovement(ctx);
    });

    pi.on("session_shutdown", () => {
        improvementLifecycleGeneration += 1;
        activeImprovement = undefined;
    });

    const assertImprovementStillCurrent = (expected: ActiveImprovement, generation: number, ctx: any, signal?: any) => {
        assertFinishSelectionStillActive(activeImprovement, expected, ctx, signal);
        if (improvementLifecycleGeneration !== generation) {
            throw new Error("The active improvement selection changed with the session branch");
        }
    };

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
                reportPath,
                truncated: display.truncated,
            });
        } else if ((ctx.mode === "tui" || ctx.mode === undefined) && typeof ctx.ui.editor === "function") {
            await ctx.ui.editor(
                "SpecPi Wishlist (view only; changes are ignored)",
                `${content}\n\n---\nReport: ${displayPath}`,
            );
        }
    };

    pi.registerTool({
        name: "report_capability_gap",
        label: "Report Capability Gap",
        description:
            "Privately record a material, reusable capability gap in SpecPi's local wishlist. Report only after reasonable existing tools or workarounds proved insufficient. Do not use for transient failures, command mistakes, credentials or permissions the user must supply, ordinary project-specific work, or speculative nice-to-haves. Never include secrets, source code, full commands, file paths, URLs with private data, or user prompt text. Report a gap at most once per user task. Collection requires an explicit local on/off decision and never uploads data.",
        promptSnippet: "Record recurring, generalizable capability friction without interrupting the user task",
        promptGuidelines: [
            "Use report_capability_gap only for a material and generalizable missing capability after reasonable existing tools or workarounds have proved insufficient.",
            "Do not use report_capability_gap for transient errors, model mistakes, missing credentials or permissions, ordinary project-specific work, or speculative nice-to-haves.",
            "Call report_capability_gap at most once per distinct gap per user task; use a short durable capability phrase without project names, and never include secrets, source code, full commands, private paths, or user prompt text.",
            "After report_capability_gap, continue the requested task; never treat a report as permission to modify SpecPi or external state.",
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
                    "SpecPi stores sanitized summaries and salted task, session, and project hashes locally. It never uploads them. You can change this later with /wishlist on or /wishlist off.",
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

            const contractRoot = await resolveTaskContractRoot(pi, ctx.cwd, signal);
            const contract = branchTaskContract(ctx, contractRoot, { tolerateMalformed: true });
            const result = await recordCapabilityGap({
                stateDir,
                sessionId: ctx.sessionManager.getSessionId(),
                runId: contract?.id ?? activeRunId,
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
        name: "record_harness_contract",
        label: "Record Harness Improvement Contract",
        description:
            "Record one bounded task contract for the exact human-selected wishlist improvement. The model may propose objective, hypothesis, requirements, acceptance checks, paths, rollback, and non-goals; this tool never creates human approval or broadens the selected gap.",
        parameters: Type.Object(
            {
                gapId: Type.String({ minLength: 3, maxLength: 120 }),
                selectionId: Type.String({ minLength: 1, maxLength: 120 }),
                sourceRoot: Type.String({ minLength: 1, maxLength: 500 }),
                objective: Type.String({ minLength: 3, maxLength: 600 }),
                hypothesis: Type.String({ minLength: 3, maxLength: 600 }),
                requirements: Type.Array(
                    Type.Object(
                        {
                            id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
                            description: Type.String({ minLength: 3, maxLength: 360 }),
                            acceptance: Type.String({ minLength: 3, maxLength: 600 }),
                        },
                        { additionalProperties: false },
                    ),
                    { minItems: 1, maxItems: 16 },
                ),
                paths: Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { minItems: 1, maxItems: 40 }),
                rollback: Type.String({ minLength: 3, maxLength: 600 }),
                nonGoals: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 360 }), { maxItems: 16 })),
            },
            { additionalProperties: false },
        ),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            if (contractBusy) {
                throw new Error("A task contract is already being recorded for this improvement");
            }

            contractBusy = true;
            try {
                const generation = improvementLifecycleGeneration;
                const sessionId = ctx.sessionManager.getSessionId();
                if (
                    !activeImprovement ||
                    activeImprovement.gapId !== params.gapId ||
                    activeImprovement.sessionId !== sessionId
                ) {
                    throw new Error("This item was not authorized by /harness-improvement in the current session");
                }

                const expectedSelection = structuredClone(activeImprovement);
                const sourceRoot = canonicalSourceRoot(params.sourceRoot);
                if (sourceRoot !== expectedSelection.root || sourceRoot !== canonicalSourceRoot(ctx.cwd)) {
                    throw new Error("The task contract source root must exactly match the selected SpecPi checkout");
                }

                if (params.selectionId !== expectedSelection.selectionId) {
                    throw new Error("The task contract selection ID does not match the active human selection");
                }

                assertImprovementStillCurrent(expectedSelection, generation, ctx, signal);
                const refreshed = await refreshWishlist({ stateDir, signal });
                assertImprovementStillCurrent(expectedSelection, generation, ctx, signal);
                const selected = improvementCandidatesFromRefresh(refreshed).find(
                    (item: any) => item.canonicalKey === expectedSelection.gapId && item.state === "selected",
                );
                if (!selected) {
                    throw new Error(
                        "The selected wishlist gap is no longer selected; reselect it before recording a contract",
                    );
                }

                const input = {
                    objective: params.objective,
                    hypothesis: params.hypothesis,
                    requirements: params.requirements,
                    paths: params.paths,
                    rollback: params.rollback,
                    nonGoals: params.nonGoals,
                };
                const existing = branchTaskContract(ctx, expectedSelection.root);
                if (
                    existing &&
                    (existing.origin !== "improvement" ||
                        existing.gapId !== expectedSelection.gapId ||
                        existing.selectionId !== expectedSelection.selectionId)
                ) {
                    throw new Error("A different task contract is active; revise it through /task or reselect the gap");
                }

                const contract = createTaskContract(
                    {
                        ...input,
                    },
                    {
                        root: expectedSelection.root,
                        origin: "improvement",
                        gapId: expectedSelection.gapId,
                        selectionId: expectedSelection.selectionId,
                        ...(existing ? { id: existing.id } : {}),
                    },
                );
                if (existing) {
                    if (existing.digest !== contract.digest) {
                        throw new Error("The improvement task contract is immutable; revise it through /task");
                    }

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Harness improvement contract already recorded (${existing.id}); digest ${existing.digest}.`,
                            },
                        ],
                        details: { contract: existing, idempotent: true },
                    };
                }

                assertImprovementStillCurrent(expectedSelection, generation, ctx, signal);
                pi.appendEntry(TASK_CONTRACT_ENTRY, { kind: "set", contract });

                return {
                    content: [
                        {
                            type: "text",
                            text: `Harness improvement contract recorded (${contract.id}); digest ${contract.digest}.`,
                        },
                    ],
                    details: { contract, idempotent: false },
                };
            } finally {
                contractBusy = false;
            }
        },
    });

    pi.registerTool({
        name: "finish_harness_improvement",
        label: "Finish Harness Improvement",
        description:
            "Complete the exact wishlist item selected through /harness-improvement. Use only after implementing the smallest sufficient change and running direct acceptance checks. This tool independently runs SpecPi's repository check, requires reviewed capability-registry integration, runs supported closed validators, and retires the item only when every gate passes.",
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
            if (finishBusy) {
                throw new Error("A finish verification is already running for this improvement");
            }

            finishBusy = true;
            try {
                const generation = improvementLifecycleGeneration;
                const sessionId = ctx.sessionManager.getSessionId();
                const selectedImprovement = activeImprovement;
                if (
                    !selectedImprovement ||
                    selectedImprovement.gapId !== params.gapId ||
                    selectedImprovement.sessionId !== sessionId
                ) {
                    throw new Error("This item was not authorized by /harness-improvement in the current session");
                }

                const expectedSelection = structuredClone(selectedImprovement);
                assertImprovementStillCurrent(expectedSelection, generation, ctx, signal);

                const root = canonicalSourceRoot(ctx.cwd);
                if (root !== selectedImprovement.root) {
                    throw new Error("The SpecPi source root changed after this improvement was selected");
                }

                const contract = branchTaskContract(ctx, root);
                if (
                    !contract ||
                    contract.origin !== "improvement" ||
                    contract.gapId !== params.gapId ||
                    contract.selectionId !== selectedImprovement.selectionId ||
                    contract.root !== root
                ) {
                    throw new Error("Record a task contract for this exact improvement selection before finishing");
                }

                const assertFinishStillCurrent = () => {
                    assertImprovementStillCurrent(expectedSelection, generation, ctx, signal);
                    const currentContract = branchTaskContract(ctx, root);
                    if (!currentContract || currentContract.digest !== contract.digest) {
                        throw new Error("The improvement task contract changed while verification was running");
                    }
                };

                const refreshed = await refreshWishlist({ stateDir, signal });
                assertFinishStillCurrent();
                const selected = improvementCandidatesFromRefresh(refreshed).find(
                    (item: any) => item.canonicalKey === params.gapId,
                );
                if (!selected || selected.state !== "selected") {
                    throw new Error(`${params.gapId} is not selected`);
                }

                const baseline = validateSourceSnapshot(selectedImprovement.baseline, root);
                const before = await captureCheckoutSnapshot(pi, root, signal);
                assertFinishStillCurrent();
                const baselineComparison = compareSourceSnapshots(baseline, before);
                if (baselineComparison.headChanged) {
                    throw new Error("The source checkout HEAD changed after selection; reselect the gap");
                }

                const baselineViolations = taskContractScopeViolations(contract, baselineComparison.changed);
                if (baselineViolations.length > 0) {
                    throw new Error(
                        `Changes outside the task contract: ${baselineViolations.map(markdownPathLabel).join(", ")}`,
                    );
                }

                assertFrozenModuleDigests(before, selectedImprovement);
                const policy = assertFrozenSourcePolicy(root, params.gapId, selectedImprovement);
                const capability = policy.capability;
                if (!capability || !Array.isArray(capability.validations) || capability.validations.length === 0) {
                    throw new Error(
                        `Implementation is not integrated: the reviewed capability registry has no validated ${params.gapId} entry`,
                    );
                }

                const validators = selectedImprovement.registryHadGap
                    ? selectedImprovement.validatorIds
                    : [...capability.validations];
                if (
                    validators.length === 0 ||
                    validators.some(
                        (validator: string) =>
                            !isValidValidatorName(validator) || !selectedImprovement.validatorNames.includes(validator),
                    )
                ) {
                    throw new Error("The selected capability references a validator outside the frozen closed catalog");
                }

                const npm = process.platform === "win32" ? "npm.cmd" : "npm";
                const check = await pi.exec(npm, ["run", "check"], {
                    cwd: root,
                    signal,
                    timeout: 15 * 60 * 1000,
                });
                assertFinishStillCurrent();
                if (check.code !== 0) {
                    throw new Error(`SpecPi repository verification failed with exit code ${check.code}`);
                }

                const gates = [{ id: "npm run check", exitCode: 0 }];
                let after = await captureCheckoutSnapshot(pi, root, signal);
                assertFinishStillCurrent();
                assertFrozenModuleDigests(after, selectedImprovement);
                const afterCheck = compareSourceSnapshots(before, after);
                if (afterCheck.changed.length > 0 || afterCheck.headChanged) {
                    throw new Error("SpecPi check changed the source checkout; verification proof is stale");
                }

                for (const validator of validators) {
                    const validatorBefore = after;
                    const timeout = VALIDATOR_CATALOG[validator]?.timeoutMs ?? 3 * 60 * 1000;
                    const result = await pi.exec(process.execPath, validatorArgs(validator, root), {
                        cwd: root,
                        signal,
                        timeout,
                    });
                    assertFinishStillCurrent();
                    if (result.code !== 0) {
                        const detail = sanitizeWishlistText(`${result.stderr || result.stdout || ""}`, 300);
                        throw new Error(
                            `Capability validator ${validator} failed with exit code ${result.code}${detail ? `: ${detail}` : ""}`,
                        );
                    }

                    gates.push({ id: validator, exitCode: result.code });
                    after = await captureCheckoutSnapshot(pi, root, signal);
                    assertFinishStillCurrent();
                    assertFrozenModuleDigests(after, selectedImprovement);
                    const validatorComparison = compareSourceSnapshots(validatorBefore, after);
                    if (validatorComparison.changed.length > 0 || validatorComparison.headChanged) {
                        throw new Error(
                            `Validator ${validator} changed the source checkout; verification proof is stale`,
                        );
                    }
                }

                const finalComparison = compareSourceSnapshots(baseline, after);
                if (finalComparison.headChanged) {
                    throw new Error("The source checkout HEAD changed during verification; proof is stale");
                }

                const finalViolations = taskContractScopeViolations(contract, finalComparison.changed);
                if (finalViolations.length > 0) {
                    throw new Error(
                        `Changes outside the task contract: ${finalViolations.map(markdownPathLabel).join(", ")}`,
                    );
                }

                assertFrozenModuleDigests(after, selectedImprovement);
                const receipt = createVerificationReceipt({
                    before,
                    after,
                    registryDigest: after.files["extensions/tool-wishlist/capabilities.json"]?.sha256,
                    validatorDigest: selectedImprovement.moduleDigests["extensions/tool-wishlist/validators.mjs"],
                    gates,
                    contractDigest: contract.digest,
                    gapId: params.gapId,
                    selectionId: selectedImprovement.selectionId,
                    sourceRootSalt: wishlistSourceRootSalt(stateDir),
                });

                const changed = await gitChangedFiles(pi, root, signal);
                assertFinishStillCurrent();
                const journal: Record<string, unknown> = {
                    schema: 1,
                    evidence: params.acceptanceEvidence,
                    gates: gates.map((gate) => gate.id),
                    changedFilesTruncated: false,
                    version: policy.checkout.version,
                    receipt,
                };
                if (changed) {
                    journal.changedFiles = changed.files;
                    journal.changedFilesTruncated = changed.truncated;
                }

                const note = `${params.validationNote}; ${gates.map((gate) => gate.id).join(", ")} passed`;
                await appendWishlistDecision({
                    stateDir,
                    action: "retire",
                    canonicalKey: params.gapId,
                    note,
                    signal,
                    journal,
                    precondition: async () => {
                        assertFinishStillCurrent();
                        const currentContract = branchTaskContract(ctx, root);

                        const currentRoot = canonicalSourceRoot(ctx.cwd);
                        if (currentRoot !== root) {
                            throw new Error("The SpecPi source root changed while verification was running");
                        }

                        const currentSnapshot = await captureCheckoutSnapshot(pi, root, signal);
                        assertFrozenModuleDigests(currentSnapshot, selectedImprovement);
                        const currentComparison = compareSourceSnapshots(after, currentSnapshot);
                        if (currentComparison.changed.length > 0 || currentComparison.headChanged) {
                            throw new Error("Source changed after verification; proof was not appended");
                        }

                        assertFinishStillCurrent();
                        const currentPolicy = assertFrozenSourcePolicy(root, params.gapId, selectedImprovement);
                        if (!currentPolicy.capability) {
                            throw new Error("The reviewed capability registry entry disappeared before retirement");
                        }

                        const validatedReceipt = validateVerificationReceipt(receipt);
                        if (
                            validatedReceipt.sourceDigest !== currentSnapshot.digest ||
                            validatedReceipt.registryDigest !==
                                currentSnapshot.files["extensions/tool-wishlist/capabilities.json"]?.sha256 ||
                            validatedReceipt.contractDigest !== currentContract.digest ||
                            validatedReceipt.gapId !== params.gapId ||
                            validatedReceipt.selectionId !== selectedImprovement.selectionId ||
                            validatedReceipt.sourceRootIdentity !== wishlistSourceRootIdentity(stateDir, root)
                        ) {
                            throw new Error(
                                "Verification receipt no longer matches the active source, card, or selection",
                            );
                        }
                    },
                });
                assertFinishStillCurrent();
                pi.appendEntry(HARNESS_IMPROVEMENT_ENTRY, {
                    gapId: params.gapId,
                    status: "finished",
                    root,
                    selectionId: selectedImprovement.selectionId,
                    contractDigest: contract.digest,
                    receiptDigest: receipt.sourceDigest,
                });
                if (activeImprovement?.selectionId === selectedImprovement.selectionId) {
                    activeImprovement = undefined;
                }

                return {
                    content: [
                        {
                            type: "text",
                            text: `Harness improvement verified and retired: ${params.gapId}. Gates: ${gates.map((gate) => gate.id).join(", ")}. Proof recorded in the improvement journal.`,
                        },
                    ],
                    details: {
                        gapId: params.gapId,
                        state: "retired",
                        verifiedBy: gates.map((gate) => gate.id),
                        acceptanceEvidence: params.acceptanceEvidence,
                        journal,
                    },
                };
            } finally {
                finishBusy = false;
            }
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
            box.addChild(new Text(theme.fg("dim", `Report: ${cleanDisplayPath(data.reportPath)}${suffix}`), 0, 0));

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

            const generation = improvementLifecycleGeneration;
            const menuGeneration = ++improvementMenuGeneration;
            const sessionId = ctx.sessionManager.getSessionId();
            let leafId = ctx.sessionManager.getLeafId?.();
            let root: string;
            let checkout: ReturnType<typeof sourceCheckout>;
            try {
                root = canonicalSourceRoot(ctx.cwd);
                checkout = sourceCheckout(root);
            } catch (error) {
                ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");

                return;
            }

            const assertSelectionContextCurrent = () => {
                if (
                    improvementLifecycleGeneration !== generation ||
                    improvementMenuGeneration !== menuGeneration ||
                    ctx.sessionManager.getSessionId() !== sessionId ||
                    ctx.sessionManager.getLeafId?.() !== leafId
                ) {
                    throw new Error("The improvement selection changed with the session branch; choose it again");
                }

                if (canonicalSourceRoot(ctx.cwd) !== root) {
                    throw new Error("The SpecPi source root changed while choosing the improvement; choose it again");
                }
            };

            const refreshed = await refreshWishlist({ stateDir });
            assertSelectionContextCurrent();
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
            assertSelectionContextCurrent();
            if (!chosen) {
                return;
            }

            const group = improvements[labels.indexOf(chosen)];
            if (!group) {
                return;
            }

            let baseline: any;
            let policy: ReturnType<typeof policyFromCheckout>;
            try {
                baseline = await captureCheckoutSnapshot(pi, root, undefined);
                assertSelectionContextCurrent();
                checkout = sourceCheckout(root);
                policy = policyFromCheckout(checkout, baseline, group.canonicalKey);
            } catch (error) {
                ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");

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
                    precondition: assertSelectionContextCurrent,
                });
                assertSelectionContextCurrent();
                await appendWishlistDecision({
                    stateDir,
                    action: "select",
                    canonicalKey: group.canonicalKey,
                    note: "Chosen through harness improvement menu",
                    precondition: assertSelectionContextCurrent,
                });
                assertSelectionContextCurrent();
                const retirement = latestRetirementDecision(refreshed.decisions ?? [], group.canonicalKey);
                if (retirement?.journal) {
                    promptContext.originalEvidence = retirement.journal.evidence ?? [];
                    promptContext.changedFiles = retirement.journal.changedFiles ?? [];
                    promptContext.changedSince = (await gitLogSince(pi, root, retirement.timestamp)) ?? undefined;
                    assertSelectionContextCurrent();
                }
            } else if (group.state === "open") {
                await appendWishlistDecision({
                    stateDir,
                    action: "select",
                    canonicalKey: group.canonicalKey,
                    note: "Chosen through harness improvement menu",
                    precondition: assertSelectionContextCurrent,
                });
                assertSelectionContextCurrent();
            }

            assertSelectionContextCurrent();
            const selectionId = randomUUID();
            activeImprovement = {
                gapId: group.canonicalKey,
                sessionId,
                root,
                selectionId,
                baseline,
                ...policy,
            };
            assertSelectionContextCurrent();
            pi.appendEntry(TASK_CONTRACT_ENTRY, { kind: "cleared" });
            leafId = ctx.sessionManager.getLeafId?.();
            assertSelectionContextCurrent();
            pi.appendEntry(HARNESS_IMPROVEMENT_ENTRY, {
                gapId: group.canonicalKey,
                status: "active",
                root,
                selectionId,
                baseline,
                ...policy,
            });
            leafId = ctx.sessionManager.getLeafId?.();
            assertSelectionContextCurrent();
            pi.sendUserMessage(improvementPrompt(group, promptContext));
        },
    });

    const usage =
        "Usage: /wishlist [status|on|off|history [id]|outcome <id>|decline <id>|merge <from> <to>|unmerge <merge-decision-id>|draft <id>|archive|reset]";
    pi.registerCommand("wishlist", {
        description: "View and curate SpecPi's local capability evidence",
        getArgumentCompletions: (prefix: string) => {
            const options = [
                "status",
                "on",
                "off",
                "history",
                "outcome",
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
                    `Wishlist collection: ${mode}; ${result.uniqueGaps} queued gap${result.uniqueGaps === 1 ? "" : "s"}; retirements ${metrics.retirements}, reopen rate ${metrics.reopenRateKnown ? `${metrics.reopenRate}%` : "unknown"}, open reviews ${metrics.openReviews}; local cohort rate ${metrics.reopenRateKnown ? `${metrics.reopenRate}%` : "unknown"}, baseline reviews ${metrics.baselineReviews}. ${cleanDisplayPath(result.reportPath)}`,
                    "info",
                );

                return;
            }

            if (action === "on" || action === "off") {
                await setCollectionMode({ stateDir, mode: action });
                ctx.ui.notify(`Local wishlist collection is ${action}. No data is uploaded.`, "info");

                return;
            }

            if (action === "outcome") {
                if (parts.length !== 1) {
                    ctx.ui.notify(usage, "error");

                    return;
                }

                if (readCollectionMode(stateDir) !== "on") {
                    ctx.ui.notify("Record an outcome only while local wishlist collection is on.", "error");

                    return;
                }

                if (!ctx.hasUI || typeof ctx.ui.select !== "function") {
                    ctx.ui.notify("/wishlist outcome requires an interactive menu.", "error");

                    return;
                }

                const gapId = normalizeCapability(parts[0]);
                const refreshed = await refreshWishlist({ stateDir });
                const retirement = latestLocalRetirementDecision(refreshed.decisions, gapId);
                if (!retirement?.journal?.receipt) {
                    ctx.ui.notify("This gap has no locally recorded retirement receipt to assess.", "error");

                    return;
                }

                const latestOutcome = latestOutcomeDecision(refreshed.decisions, gapId, retirement.id);
                const choices = ["helped", "failed", "not-exercised", "reverted"];
                const chosenOutcome = await ctx.ui.select(
                    `How did the retired improvement work for ${gapId}?`,
                    choices,
                );
                if (!chosenOutcome || !choices.includes(chosenOutcome)) {
                    return;
                }

                const requestId = randomUUID();
                const retirementId = retirement.id;
                const retirementReceipt = cloneJson(retirement.journal.receipt);
                const previousOutcomeId = latestOutcome?.id ?? "";
                const result = await appendWishlistDecision({
                    stateDir,
                    action: "outcome",
                    canonicalKey: gapId,
                    targetKey: retirementId,
                    outcome: chosenOutcome,
                    requestId,
                    previousOutcomeId,
                    note: "",
                    precondition: async ({ decisions }: any) => {
                        if (readCollectionMode(stateDir) !== "on") {
                            throw new Error("Local wishlist collection was turned off before the outcome was recorded");
                        }

                        const currentRetirement = latestLocalRetirementDecision(decisions, gapId);
                        if (
                            !currentRetirement ||
                            currentRetirement.id !== retirementId ||
                            !sameJson(currentRetirement.journal?.receipt, retirementReceipt)
                        ) {
                            throw new Error("The retirement changed while the outcome menu was open; choose again");
                        }

                        const currentOutcome = latestOutcomeDecision(decisions, gapId, retirementId);
                        if ((currentOutcome?.id ?? "") !== previousOutcomeId) {
                            throw new Error(
                                "The retirement outcome changed while the outcome menu was open; choose again",
                            );
                        }

                        validateVerificationReceipt(retirementReceipt);
                        if (retirementReceipt.gapId !== gapId) {
                            throw new Error("The retirement receipt is bound to a different wishlist gap");
                        }
                    },
                });
                ctx.ui.notify(`Wishlist outcome recorded: ${gapId} → ${chosenOutcome}.`, "info");

                return result;
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
