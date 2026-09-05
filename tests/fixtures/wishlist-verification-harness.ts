import fs from "node:fs";
import path from "node:path";
import registerWishlist from "../../extensions/tool-wishlist/index.ts";
import { createTaskContract, readTaskContract } from "../../extensions/workflow-controls/task-contract.mjs";

type GateKind = "check" | "validator";

const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR!);
const repositoryRoot = path.resolve(process.cwd());
const stateDir = path.join(agentDir, "specpi");
const browserGap = {
    capability: "Local browser automation",
    scenario: "Interact with a locally rendered application",
    limitation: "Browser interaction needed explicit revalidation",
    impact: "degraded",
    workaround: "Manual browser interaction",
    suggestedFix: "tool",
};

function copySourceCheckout(label: string) {
    const root = path.join(agentDir, `verification-${label}`);
    fs.mkdirSync(path.join(root, "extensions", "tool-wishlist"), { recursive: true });
    fs.mkdirSync(path.join(root, "extensions", "workflow-controls"), { recursive: true });
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(root, "tests"), { recursive: true });
    for (const file of [
        "capabilities.json",
        "core.mjs",
        "index.ts",
        "registry.mjs",
        "validators.mjs",
        "verification.mjs",
    ]) {
        fs.copyFileSync(
            path.join(repositoryRoot, "extensions", "tool-wishlist", file),
            path.join(root, "extensions", "tool-wishlist", file),
        );
    }

    for (const file of ["scope.mjs", "task-contract.mjs"]) {
        fs.copyFileSync(
            path.join(repositoryRoot, "extensions", "workflow-controls", file),
            path.join(root, "extensions", "workflow-controls", file),
        );
    }

    fs.copyFileSync(path.join(repositoryRoot, "package.json"), path.join(root, "package.json"));
    fs.copyFileSync(
        path.join(repositoryRoot, "scripts", "check-package.mjs"),
        path.join(root, "scripts", "check-package.mjs"),
    );
    for (const file of [
        ".editorconfig",
        ".gitattributes",
        ".prettierignore",
        "eslint.config.js",
        "prettier.config.mjs",
    ]) {
        fs.copyFileSync(path.join(repositoryRoot, file), path.join(root, file));
    }

    fs.writeFileSync(path.join(root, "tests", "subject.test.mjs"), "export const subject = 1;\n");

    return root;
}

function lineRecords(file: string) {
    if (!fs.existsSync(file)) {
        return [];
    }

    return fs
        .readFileSync(file, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}

function hasSelectedReport() {
    const report = fs.readFileSync(path.join(stateDir, "TOOL_WISHLIST.md"), "utf8");

    return report.includes("# Selected") && report.includes("- Status: selected");
}

function hasRetirement(gapId: string) {
    return lineRecords(path.join(stateDir, "tool-wishlist-decisions.jsonl")).some(
        (decision) => decision.action === "retire" && decision.canonicalKey === gapId,
    );
}

function makeContract(active: any, root: string, paths: string[], objective = "Prove the selected capability") {
    return {
        gapId: active.gapId,
        selectionId: active.selectionId,
        sourceRoot: root,
        objective,
        hypothesis: "The selected capability can be verified by a bounded local gate",
        requirements: [
            {
                id: "R1",
                description: "The selected capability gate passes",
                acceptance: "The gate exits with code zero in isolated temporary state",
            },
        ],
        paths,
        rollback: "Revert the scoped source changes and rerun the gates",
        nonGoals: ["No remote state or provider access"],
    };
}

function createHarness(root: string) {
    const tools: any[] = [];
    const commands = new Map<string, any>();
    const events = new Map<string, any[]>();
    const entries: any[] = [];
    const branch = { entries };
    const notifications: any[] = [];
    const selections: any[] = [];
    const sentUserMessages: string[] = [];
    const execs: any[] = [];
    const session = { value: "verification-session" };
    const leaf = { value: "verification-leaf-0" };
    const controls: any = {
        mutateKind: undefined as GateKind | undefined,
        mutateTarget: undefined as string | undefined,
        mutateContent: "export const subject = 2;\n",
        pause: undefined as any,
        menuPause: undefined as any,
        selectTarget: undefined as string | undefined,
    };

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
        registerEntryRenderer() {},
        appendEntry(type: string, data: any) {
            const entry = { type: "custom", customType: type, data };
            entries.push(entry);
            if (branch.entries !== entries) {
                branch.entries.push(entry);
            }

            leaf.value = `verification-leaf-${entries.length}`;
        },
        sendUserMessage(message: string) {
            sentUserMessages.push(message);
        },
        async exec(command: string, args: string[], options: any = {}) {
            execs.push({ command, args, cwd: options.cwd });
            if (command === "git") {
                if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
                    return { code: 0, stdout: `${root}\n`, stderr: "", killed: false };
                }

                if (args[0] === "rev-parse" && args[1] === "HEAD") {
                    return { code: 0, stdout: "deadbeef\n", stderr: "", killed: false };
                }

                if (args[0] === "status") {
                    return { code: 0, stdout: "", stderr: "", killed: false };
                }

                return { code: 0, stdout: "", stderr: "", killed: false };
            }

            const isCheck = args[0] === "run" && args[1] === "check";
            const isValidator = command === process.execPath && args[0]?.endsWith("validators.mjs");
            const kind: GateKind | undefined = isCheck ? "check" : isValidator ? "validator" : undefined;
            if (kind) {
                if (controls.pause && !controls.pause.used) {
                    const pause = controls.pause;
                    pause.used = true;
                    pause.startedResolve(kind);
                    if (pause.hook) {
                        await pause.hook(kind);
                    }

                    await pause.releasePromise;
                }

                if (controls.mutateKind === kind && controls.mutateTarget) {
                    fs.writeFileSync(controls.mutateTarget, controls.mutateContent);
                    controls.mutateKind = undefined;
                }
            }

            return { code: 0, stdout: "verification passed", stderr: "", killed: false };
        },
    };
    registerWishlist(fakePi);

    const ctx: any = {
        cwd: root,
        hasUI: true,
        mode: "tui",
        isIdle: () => true,
        sessionManager: {
            getSessionId: () => session.value,
            getLeafId: () => leaf.value,
            getBranch: () => branch.entries,
        },
        ui: {
            async confirm() {
                return true;
            },
            async select(title: string, options: string[]) {
                selections.push({ title, options });
                const selected = controls.selectTarget
                    ? options.find((option) => option.includes(controls.selectTarget))
                    : undefined;
                controls.selectTarget = undefined;
                if (controls.menuPause && !controls.menuPause.used) {
                    const pause = controls.menuPause;
                    pause.used = true;
                    pause.startedResolve();
                    await pause.releasePromise;
                }

                return selected ?? options[0];
            },
            notify(message: string, level: string) {
                notifications.push({ message, level });
            },
            async editor() {},
        },
    };

    return {
        tools,
        commands,
        events,
        entries,
        branch,
        notifications,
        selections,
        sentUserMessages,
        execs,
        session,
        leaf,
        controls,
        ctx,
        reportTool: tools.find((tool) => tool.name === "report_capability_gap"),
        contractTool: tools.find((tool) => tool.name === "record_harness_contract"),
        finishTool: tools.find((tool) => tool.name === "finish_harness_improvement"),
        wishlist: commands.get("wishlist"),
        harnessImprovement: commands.get("harness-improvement"),
    };
}

async function selectAndContract(harness: any, root: string, paths: string[], gap = browserGap) {
    await harness.reportTool.execute("report", gap, undefined, undefined, harness.ctx);
    await harness.harnessImprovement.handler("", harness.ctx);
    const activeEntry = harness.entries.findLast(
        (entry: any) => entry.customType === "specpi-harness-improvement" && entry.data?.status === "active",
    );
    if (!activeEntry) {
        const details = harness.notifications.map((item: any) => item.message).join(" | ");
        throw new Error(`selection did not produce active improvement metadata${details ? `: ${details}` : ""}`);
    }

    const active = activeEntry.data;
    const contract = makeContract(active, root, paths);
    const result = await harness.contractTool.execute("contract", contract, undefined, undefined, harness.ctx);
    if (result.details?.idempotent) {
        throw new Error("initial task contract unexpectedly reported idempotent");
    }

    return { active, contract, recordedContract: result.details?.contract };
}

function finishParams(gapId: string) {
    return {
        gapId,
        acceptanceEvidence: ["The isolated verification gate passed"],
        validationNote: "Verification boundaries exercised",
    };
}

function pauseGate(harness: any, hook?: (kind: GateKind) => Promise<void> | void) {
    let startedResolve: (kind: GateKind) => void = () => {};

    let releaseResolve: () => void = () => {};

    const started = new Promise<GateKind>((resolve) => {
        startedResolve = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
        releaseResolve = resolve;
    });
    harness.controls.pause = { startedResolve, releaseResolve, releasePromise, hook, used: false };

    return { started, release: releaseResolve };
}

function pauseMenu(harness: any) {
    let startedResolve: () => void = () => {};

    let releaseResolve: () => void = () => {};

    const started = new Promise<void>((resolve) => {
        startedResolve = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
        releaseResolve = resolve;
    });
    harness.controls.menuPause = { startedResolve, releasePromise, used: false };

    return { started, release: releaseResolve };
}

async function rejected(promise: Promise<unknown>, pattern: RegExp) {
    try {
        await promise;
    } catch (error) {
        return pattern.test(error instanceof Error ? error.message : String(error));
    }

    return false;
}

async function restoreBranch(harness: any, entries: any[]) {
    harness.branch.entries = [...entries];
    for (const handler of harness.events.get("session_tree") ?? []) {
        await handler({ type: "session_tree" }, harness.ctx);
    }
}

function taskCardCount(harness: any) {
    return harness.entries.filter(
        (entry: any) => entry.customType === "specpi-task-contract" && entry.data?.kind === "set",
    ).length;
}

async function pendingContractAcrossTree(harness: any, contract: any, nextBranch: any[]) {
    const lock = path.join(stateDir, ".tool-wishlist.lock");
    fs.mkdirSync(lock);
    const originalMkdir = fs.mkdirSync;
    let attemptedResolve: () => void = () => {};

    const attempted = new Promise<void>((resolve) => {
        attemptedResolve = resolve;
    });
    fs.mkdirSync = ((target: any, options: any) => {
        if (path.resolve(String(target)) === lock) {
            attemptedResolve();
        }

        return originalMkdir(target, options);
    }) as typeof fs.mkdirSync;
    const cardCount = taskCardCount(harness);
    const pending = harness.contractTool.execute("pending-tree-contract", contract, undefined, undefined, harness.ctx);
    const wasRejected = rejected(pending, /selection changed|session branch changed/);
    try {
        await Promise.race([
            attempted,
            pending.then(
                () => {
                    throw new Error("Pending contract completed before reaching the held wishlist lock");
                },
                (error: Error) => {
                    throw new Error(`Pending contract failed before reaching the held wishlist lock: ${error.message}`);
                },
            ),
        ]);
        fs.mkdirSync = originalMkdir;
        await restoreBranch(harness, nextBranch);
    } finally {
        fs.mkdirSync = originalMkdir;
        fs.rmdirSync(lock);
    }

    return { rejected: await wasRejected, noCardAppended: taskCardCount(harness) === cardCount };
}

async function runSelectionScenario() {
    const root = copySourceCheckout("selection");
    const harness = createHarness(root);
    const { active, contract, recordedContract } = await selectAndContract(harness, root, ["tests/subject.test.mjs"]);
    const originalBranch = [...harness.branch.entries];
    await restoreBranch(harness, []);
    const emptyBranchCardCount = taskCardCount(harness);
    const emptyBranchRejected = await rejected(
        harness.contractTool.execute("empty-branch-contract", contract, undefined, undefined, harness.ctx),
        /not authorized|active.*selection/,
    );
    const emptyBranchNoCard = taskCardCount(harness) === emptyBranchCardCount;
    await restoreBranch(harness, originalBranch);
    const restored = await harness.contractTool.execute(
        "restored-contract",
        contract,
        undefined,
        undefined,
        harness.ctx,
    );

    const siblingBranch = [
        ...originalBranch,
        { type: "custom", customType: "verification-branch-marker", data: { leaf: "sibling" } },
    ];
    const sameSelectionPending = await pendingContractAcrossTree(harness, contract, siblingBranch);
    const siblingCard = readTaskContract(harness.branch.entries, root);

    const policyFile = path.join(root, "eslint.config.js");
    fs.appendFileSync(policyFile, "\n// Updated policy explicitly accepted by a fresh human selection\n");
    await harness.harnessImprovement.handler("", harness.ctx);
    const reselected = harness.entries.findLast(
        (entry: any) => entry.customType === "specpi-harness-improvement" && entry.data?.status === "active",
    ).data;
    const reselectedBranch = [...harness.branch.entries];
    const reselectionClearedCard = readTaskContract(reselectedBranch, root) === undefined;
    const oldSelectionRejected = await rejected(
        harness.contractTool.execute("old-selection-contract", contract, undefined, undefined, harness.ctx),
        /selection ID.*active human selection/,
    );

    await restoreBranch(harness, originalBranch);
    const newSelectionPending = await pendingContractAcrossTree(harness, contract, reselectedBranch);
    const newSelectionStillHasNoCard = readTaskContract(harness.branch.entries, root) === undefined;
    const reselectedContract = makeContract(reselected, root, ["tests/subject.test.mjs"]);
    const firstNewCard = await harness.contractTool.execute(
        "new-selection-contract",
        reselectedContract,
        undefined,
        undefined,
        harness.ctx,
    );

    await harness.harnessImprovement.handler("", harness.ctx);
    const twiceSelected = harness.entries.findLast(
        (entry: any) => entry.customType === "specpi-harness-improvement" && entry.data?.status === "active",
    ).data;
    const secondReselectionClearedCard = readTaskContract(harness.branch.entries, root) === undefined;
    const previousSelectionRejected = await rejected(
        harness.contractTool.execute(
            "previous-selection-contract",
            reselectedContract,
            undefined,
            undefined,
            harness.ctx,
        ),
        /selection ID.*active human selection/,
    );
    const secondNewCard = await harness.contractTool.execute(
        "twice-selected-contract",
        makeContract(twiceSelected, root, ["tests/subject.test.mjs"]),
        undefined,
        undefined,
        harness.ctx,
    );

    const sameCardBranch = [...harness.branch.entries];
    const finishPause = pauseGate(harness);
    const pendingFinish = harness.finishTool.execute(
        "same-card-tree-finish",
        finishParams(twiceSelected.gapId),
        undefined,
        undefined,
        harness.ctx,
    );
    const finishRejected = rejected(pendingFinish, /selection changed|session branch changed/);
    await finishPause.started;
    await restoreBranch(harness, [
        ...sameCardBranch,
        { type: "custom", customType: "verification-branch-marker", data: { leaf: "finish-sibling" } },
    ]);
    finishPause.release();
    const sameCardTreeFinishRejected = await finishRejected;
    const sameCardTreePreservedSelection = hasSelectedReport() && !hasRetirement(twiceSelected.gapId);
    const afterTreeCard = readTaskContract(harness.branch.entries, root);
    const freshPolicyFinish = await harness.finishTool.execute(
        "fresh-policy-finish",
        finishParams(twiceSelected.gapId),
        undefined,
        undefined,
        harness.ctx,
    );

    return {
        emptyBranchRejected,
        emptyBranchNoCard,
        originalBranchRestored:
            restored.details?.idempotent === true && restored.details?.contract?.id === recordedContract.id,
        sameSelectionPendingRejected: sameSelectionPending.rejected,
        sameSelectionPendingNoCard: sameSelectionPending.noCardAppended,
        sameAncestorCardPreserved:
            siblingCard?.id === recordedContract.id && siblingCard?.selectionId === active.selectionId,
        reselectionFreshNonce: reselected.selectionId !== active.selectionId,
        reselectionFreshBaseline:
            reselected.moduleDigests["eslint.config.js"] !== active.moduleDigests["eslint.config.js"],
        reselectionClearedCard,
        oldSelectionRejected,
        newSelectionPendingRejected: newSelectionPending.rejected,
        newSelectionPendingNoCard: newSelectionPending.noCardAppended && newSelectionStillHasNoCard,
        newSelectionContractAccepted: firstNewCard.details?.contract?.selectionId === reselected.selectionId,
        secondReselectionFreshNonce: twiceSelected.selectionId !== reselected.selectionId,
        secondReselectionClearedCard,
        previousSelectionRejected,
        secondNewContractAccepted: secondNewCard.details?.contract?.selectionId === twiceSelected.selectionId,
        sameCardTreeFinishRejected,
        sameCardTreePreservedSelection,
        sameCardTreePreservedCard: afterTreeCard?.id === secondNewCard.details?.contract?.id,
        freshPolicyBaselineAccepted: freshPolicyFinish.details?.state === "retired",
    };
}

async function runMenuScenario() {
    const root = copySourceCheckout("menu");
    const harness = createHarness(root);
    const { active, recordedContract } = await selectAndContract(harness, root, ["tests/subject.test.mjs"]);
    const initialEntries = harness.entries.length;
    const initialMessages = harness.sentUserMessages.length;
    const initialDecisions = lineRecords(path.join(stateDir, "tool-wishlist-decisions.jsonl")).length;
    const leafPause = pauseMenu(harness);
    const leafMenu = harness.harnessImprovement.handler("", harness.ctx);
    const leafRejection = rejected(leafMenu, /selection changed|session branch changed/);
    await leafPause.started;
    // Appending ordinary session content advances the leaf without a session_tree event.
    harness.leaf.value = "verification-unrelated-leaf";
    leafPause.release();
    const leafAdvanceRejected = await leafRejection;
    const leafAdvanceNoEntries = harness.entries.length === initialEntries;
    const leafAdvanceNoPrompt = harness.sentUserMessages.length === initialMessages;
    const leafAdvancePreservedCard = readTaskContract(harness.branch.entries, root)?.id === recordedContract.id;

    const olderPause = pauseMenu(harness);
    const olderMenu = harness.harnessImprovement.handler("", harness.ctx);
    const olderRejection = rejected(olderMenu, /selection changed|session branch changed/);
    await olderPause.started;
    const newerPause = pauseMenu(harness);
    const newerMenu = harness.harnessImprovement.handler("", harness.ctx);
    await newerPause.started;
    // Neither pending menu has advanced the leaf; only the newer invocation can invalidate the older one.
    olderPause.release();
    const overlappingOlderRejected = await olderRejection;
    const overlappingOlderNoEntries = harness.entries.length === initialEntries;
    const overlappingOlderNoPrompt = harness.sentUserMessages.length === initialMessages;
    const staleMenusNoDecisions =
        lineRecords(path.join(stateDir, "tool-wishlist-decisions.jsonl")).length === initialDecisions;

    const packageFile = path.join(root, "package.json");
    const packageManifest = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    packageManifest.scripts["test:fresh-menu-policy"] = "node --version";
    fs.writeFileSync(packageFile, `${JSON.stringify(packageManifest)}\n`);
    newerPause.release();
    await newerMenu;
    const newerActive = harness.entries.findLast(
        (entry: any) => entry.customType === "specpi-harness-improvement" && entry.data?.status === "active",
    ).data;
    const newerMenuClearedCard = readTaskContract(harness.branch.entries, root) === undefined;
    const newContract = await harness.contractTool.execute(
        "newer-menu-contract",
        makeContract(newerActive, root, ["tests/subject.test.mjs"]),
        undefined,
        undefined,
        harness.ctx,
    );
    const freshPolicyFinish = await harness.finishTool.execute(
        "fresh-menu-policy-finish",
        finishParams(newerActive.gapId),
        undefined,
        undefined,
        harness.ctx,
    );

    return {
        leafAdvanceRejected,
        leafAdvanceNoEntries,
        leafAdvanceNoPrompt,
        leafAdvancePreservedCard,
        overlappingOlderRejected,
        overlappingOlderNoEntries,
        overlappingOlderNoPrompt,
        staleMenusNoDecisions,
        newerMenuAccepted:
            newerActive.selectionId !== active.selectionId && harness.sentUserMessages.length === initialMessages + 1,
        newerMenuClearedCard,
        newerMenuContractAccepted: newContract.details?.contract?.selectionId === newerActive.selectionId,
        menuAcceptedCurrentPolicy: newerActive.scripts["test:fresh-menu-policy"] === "node --version",
        menuCurrentPolicyFinishAccepted: freshPolicyFinish.details?.state === "retired",
    };
}

async function runContractScenario() {
    const root = copySourceCheckout("contract");
    const harness = createHarness(root);
    const { active, contract, recordedContract } = await selectAndContract(harness, root, ["tests/subject.test.mjs"]);
    const retry = await harness.contractTool.execute("contract-retry", contract, undefined, undefined, harness.ctx);
    const replacementRejected = await rejected(
        harness.contractTool.execute(
            "contract-replacement",
            { ...contract, objective: "Replace the selected task card" },
            undefined,
            undefined,
            harness.ctx,
        ),
        /immutable|different task contract/,
    );

    const firstContractReport = await harness.reportTool.execute(
        "report-card-1",
        browserGap,
        undefined,
        undefined,
        harness.ctx,
    );
    for (const handler of harness.events.get("before_agent_start") ?? []) {
        await handler({}, harness.ctx);
    }

    const nested = path.join(root, "nested");
    fs.mkdirSync(nested);
    harness.ctx.cwd = nested;
    const secondContractReport = await harness.reportTool.execute(
        "report-card-2",
        browserGap,
        undefined,
        undefined,
        harness.ctx,
    );

    return {
        contractRetryIdempotent: retry.details?.idempotent === true,
        contractReplacementRejected: replacementRejected,
        cardReportDeduped:
            firstContractReport.details?.duplicate === false && secondContractReport.details?.duplicate === true,
        stableContractId:
            retry.details?.contract?.id === recordedContract?.id && active.gapId === "local-browser-automation",
    };
}

async function runPolicyScenario() {
    const root = copySourceCheckout("policy");
    const harness = createHarness(root);
    const { active } = await selectAndContract(harness, root, [
        "package.json",
        "scripts/check-package.mjs",
        "eslint.config.js",
        "prettier.config.mjs",
        ".prettierignore",
        "extensions/tool-wishlist/capabilities.json",
        "extensions/tool-wishlist/validators.mjs",
        "extensions/tool-wishlist/core.mjs",
        "extensions/workflow-controls/task-contract.mjs",
        "extensions/workflow-controls/scope.mjs",
    ]);
    const params = finishParams(active.gapId);
    const packageFile = path.join(root, "package.json");
    const checkPackageFile = path.join(root, "scripts", "check-package.mjs");
    const eslintFile = path.join(root, "eslint.config.js");
    const prettierFile = path.join(root, "prettier.config.mjs");
    const prettierIgnoreFile = path.join(root, ".prettierignore");
    const capabilitiesFile = path.join(root, "extensions", "tool-wishlist", "capabilities.json");
    const validatorsFile = path.join(root, "extensions", "tool-wishlist", "validators.mjs");
    const coreFile = path.join(root, "extensions", "tool-wishlist", "core.mjs");
    const taskContractFile = path.join(root, "extensions", "workflow-controls", "task-contract.mjs");
    const scopeFile = path.join(root, "extensions", "workflow-controls", "scope.mjs");
    const originalPackage = fs.readFileSync(packageFile, "utf8");
    const originalCheckPackage = fs.readFileSync(checkPackageFile, "utf8");
    const originalEslint = fs.readFileSync(eslintFile, "utf8");
    const originalPrettier = fs.readFileSync(prettierFile, "utf8");
    const originalPrettierIgnore = fs.readFileSync(prettierIgnoreFile, "utf8");
    const originalCapabilities = fs.readFileSync(capabilitiesFile, "utf8");
    const originalValidators = fs.readFileSync(validatorsFile, "utf8");
    const originalCore = fs.readFileSync(coreFile, "utf8");
    const originalTaskContract = fs.readFileSync(taskContractFile, "utf8");
    const originalScope = fs.readFileSync(scopeFile, "utf8");

    const packageManifest = JSON.parse(originalPackage);
    packageManifest.scripts["unrelated-test-script"] = "echo changed";
    fs.writeFileSync(packageFile, `${JSON.stringify(packageManifest)}\n`);
    const scriptsRejected = await rejected(
        harness.finishTool.execute("scripts", params, undefined, undefined, harness.ctx),
        /npm scripts changed/,
    );
    fs.writeFileSync(packageFile, originalPackage);

    fs.writeFileSync(checkPackageFile, `${originalCheckPackage}\n// weakened package inventory\n`);
    const checkPackageRejected = await rejected(
        harness.finishTool.execute("check-package", params, undefined, undefined, harness.ctx),
        /Protected verification input changed|check-package/,
    );
    fs.writeFileSync(checkPackageFile, originalCheckPackage);

    fs.writeFileSync(eslintFile, `${originalEslint}\n// weakened lint policy\n`);
    const eslintRejected = await rejected(
        harness.finishTool.execute("eslint", params, undefined, undefined, harness.ctx),
        /Protected verification input changed|eslint/,
    );
    fs.writeFileSync(eslintFile, originalEslint);

    fs.writeFileSync(prettierFile, `${originalPrettier}\n// weakened formatting policy\n`);
    const prettierRejected = await rejected(
        harness.finishTool.execute("prettier", params, undefined, undefined, harness.ctx),
        /Protected verification input changed|prettier/,
    );
    fs.writeFileSync(prettierFile, originalPrettier);

    fs.writeFileSync(prettierIgnoreFile, `${originalPrettierIgnore}\n# weakened ignore policy\n`);
    const prettierIgnoreRejected = await rejected(
        harness.finishTool.execute("prettier-ignore", params, undefined, undefined, harness.ctx),
        /Protected verification input changed|prettier/,
    );
    fs.writeFileSync(prettierIgnoreFile, originalPrettierIgnore);

    const registry = JSON.parse(originalCapabilities);
    registry.capabilities[1].title = "Tampered unrelated capability";
    fs.writeFileSync(capabilitiesFile, `${JSON.stringify(registry)}\n`);
    const registryRejected = await rejected(
        harness.finishTool.execute("registry", params, undefined, undefined, harness.ctx),
        /reviewed registry entry .* changed/,
    );
    fs.writeFileSync(capabilitiesFile, originalCapabilities);

    fs.writeFileSync(validatorsFile, `${originalValidators}\n// tampered validator source\n`);
    const validatorRejected = await rejected(
        harness.finishTool.execute("validator", params, undefined, undefined, harness.ctx),
        /Protected verification input changed/,
    );
    fs.writeFileSync(validatorsFile, originalValidators);

    fs.writeFileSync(coreFile, `${originalCore}\n// tampered wishlist state authority\n`);
    const coreRejected = await rejected(
        harness.finishTool.execute("core", params, undefined, undefined, harness.ctx),
        /Protected verification input changed|core/,
    );
    fs.writeFileSync(coreFile, originalCore);

    fs.writeFileSync(taskContractFile, `${originalTaskContract}\n// tampered task contract authority\n`);
    const taskContractRejected = await rejected(
        harness.finishTool.execute("task-contract", params, undefined, undefined, harness.ctx),
        /Protected verification input changed|task contract/,
    );
    fs.writeFileSync(taskContractFile, originalTaskContract);

    fs.writeFileSync(scopeFile, `${originalScope}\n// tampered scope matching authority\n`);
    const scopeRejected = await rejected(
        harness.finishTool.execute("scope", params, undefined, undefined, harness.ctx),
        /Protected verification input changed|scope/,
    );
    fs.writeFileSync(scopeFile, originalScope);

    const customGap = {
        capability: "Custom extension verification",
        scenario: "Verify a newly integrated local extension",
        limitation: "No dedicated extension verification capability was available",
        impact: "blocked",
        workaround: "Manual verification",
        suggestedFix: "tool",
    };
    await harness.reportTool.execute("custom-report", customGap, undefined, undefined, harness.ctx);
    const customGapId = "custom-extension-verification";
    harness.controls.selectTarget = customGapId;
    await harness.harnessImprovement.handler("", harness.ctx);
    const customActiveEntry = harness.entries.findLast(
        (entry: any) => entry.customType === "specpi-harness-improvement" && entry.data?.status === "active",
    );
    const customActive = customActiveEntry.data;
    const customContract = makeContract(customActive, root, ["extensions/tool-wishlist/capabilities.json"]);
    await harness.contractTool.execute("custom-contract", customContract, undefined, undefined, harness.ctx);
    const updatedRegistry = JSON.parse(originalCapabilities);
    updatedRegistry.capabilities.push({
        id: customGapId,
        title: "Custom extension verification",
        aliases: [],
        shippedVersion: "0.10.0",
        shippedAt: "2026-09-04T00:00:00.000Z",
        validations: ["wishlist-state-smoke"],
    });
    fs.writeFileSync(capabilitiesFile, `${JSON.stringify(updatedRegistry)}\n`);
    const customFinish = await harness.finishTool.execute(
        "custom-finish",
        finishParams(customGapId),
        undefined,
        undefined,
        harness.ctx,
    );

    return {
        scriptsRejected,
        checkPackageRejected,
        eslintRejected,
        prettierRejected,
        prettierIgnoreRejected,
        registryRejected,
        validatorRejected,
        coreRejected,
        taskContractRejected,
        scopeRejected,
        ownRegistryEntryAccepted: customFinish.details?.state === "retired" && hasRetirement(customGapId),
    };
}

async function runFinishBoundaryScenario() {
    const sourceRoot = copySourceCheckout("finish-source");
    const sourceHarness = createHarness(sourceRoot);
    const { active: sourceActive } = await selectAndContract(sourceHarness, sourceRoot, ["tests/subject.test.mjs"]);
    const subject = path.join(sourceRoot, "tests", "subject.test.mjs");
    sourceHarness.controls.mutateTarget = subject;
    sourceHarness.controls.mutateKind = "check";
    const checkMutationRejected = await rejected(
        sourceHarness.finishTool.execute(
            "check-mutation",
            finishParams(sourceActive.gapId),
            undefined,
            undefined,
            sourceHarness.ctx,
        ),
        /changed the source checkout|proof is stale/,
    );
    fs.writeFileSync(subject, "export const subject = 1;\n");
    sourceHarness.controls.mutateTarget = subject;
    sourceHarness.controls.mutateKind = "validator";
    const validatorMutationRejected = await rejected(
        sourceHarness.finishTool.execute(
            "validator-mutation",
            finishParams(sourceActive.gapId),
            undefined,
            undefined,
            sourceHarness.ctx,
        ),
        /changed the source checkout|proof is stale/,
    );
    const sourceStillSelected = hasSelectedReport() && !hasRetirement(sourceActive.gapId);

    fs.rmSync(stateDir, { recursive: true, force: true });
    const sessionRoot = copySourceCheckout("finish-session");
    const sessionHarness = createHarness(sessionRoot);
    const { active: sessionActive } = await selectAndContract(sessionHarness, sessionRoot, ["tests/subject.test.mjs"]);
    const sessionPause = pauseGate(sessionHarness);
    const firstFinish = sessionHarness.finishTool.execute(
        "session-finish",
        finishParams(sessionActive.gapId),
        undefined,
        undefined,
        sessionHarness.ctx,
    );
    await sessionPause.started;
    const concurrentRejected = await rejected(
        sessionHarness.finishTool.execute(
            "concurrent-finish",
            finishParams(sessionActive.gapId),
            undefined,
            undefined,
            sessionHarness.ctx,
        ),
        /already running/,
    );
    sessionHarness.session.value = "different-session";
    sessionPause.release();
    const sessionChangedRejected = await rejected(firstFinish, /selection changed/);
    const sessionStillSelected = hasSelectedReport() && !hasRetirement(sessionActive.gapId);

    fs.rmSync(stateDir, { recursive: true, force: true });
    const cardRoot = copySourceCheckout("finish-card");
    const cardHarness = createHarness(cardRoot);
    const { active: cardActive, contract: cardContract } = await selectAndContract(cardHarness, cardRoot, [
        "tests/subject.test.mjs",
    ]);
    const cardPause = pauseGate(cardHarness, async () => {
        const changed = createTaskContract(
            { ...cardContract, objective: "Changed task card during verification" },
            {
                root: cardRoot,
                origin: "improvement",
                gapId: cardActive.gapId,
                selectionId: cardActive.selectionId,
                id: cardContract.id,
            },
        );
        cardHarness.entries.push({
            type: "custom",
            customType: "specpi-task-contract",
            data: { kind: "set", contract: changed },
        });
    });
    const cardFinish = cardHarness.finishTool.execute(
        "card-finish",
        finishParams(cardActive.gapId),
        undefined,
        undefined,
        cardHarness.ctx,
    );
    await cardPause.started;
    cardPause.release();
    const cardChangedRejected = await rejected(cardFinish, /task contract changed/);
    const cardStillSelected = hasSelectedReport() && !hasRetirement(cardActive.gapId);

    fs.rmSync(stateDir, { recursive: true, force: true });
    const selectionRoot = copySourceCheckout("finish-selection");
    const selectionHarness = createHarness(selectionRoot);
    const { active: selectionActive } = await selectAndContract(selectionHarness, selectionRoot, [
        "tests/subject.test.mjs",
    ]);
    const customGap = {
        capability: "Selection replacement verification",
        scenario: "Exercise a second selected improvement while the first is verifying",
        limitation: "Selection state must remain bound to one improvement",
        impact: "blocked",
        workaround: "Manual selection",
        suggestedFix: "tool",
    };
    await selectionHarness.reportTool.execute(
        "selection-report",
        customGap,
        undefined,
        undefined,
        selectionHarness.ctx,
    );
    const customGapId = "selection-replacement-verification";
    const selectionPause = pauseGate(selectionHarness, async () => {
        selectionHarness.controls.selectTarget = customGapId;
        await selectionHarness.harnessImprovement.handler("", selectionHarness.ctx);
    });
    const selectionFinish = selectionHarness.finishTool.execute(
        "selection-finish",
        finishParams(selectionActive.gapId),
        undefined,
        undefined,
        selectionHarness.ctx,
    );
    await selectionPause.started;
    selectionPause.release();
    const selectionChangedRejected = await rejected(selectionFinish, /selection changed/);

    fs.rmSync(stateDir, { recursive: true, force: true });
    const cancelRoot = copySourceCheckout("finish-cancel");
    const cancelHarness = createHarness(cancelRoot);
    const { active: cancelActive } = await selectAndContract(cancelHarness, cancelRoot, ["tests/subject.test.mjs"]);
    const cancelPause = pauseGate(cancelHarness);
    const controller = new AbortController();
    const cancelFinish = cancelHarness.finishTool.execute(
        "cancel-finish",
        finishParams(cancelActive.gapId),
        controller.signal,
        undefined,
        cancelHarness.ctx,
    );
    await cancelPause.started;
    controller.abort(new Error("verification cancelled by test"));
    cancelPause.release();
    const cancellationRejected = await rejected(cancelFinish, /cancelled|cancellation/);
    const cancellationPreservedSelection = hasSelectedReport() && !hasRetirement(cancelActive.gapId);
    const retryAfterCancellation = await cancelHarness.finishTool.execute(
        "cancel-retry",
        finishParams(cancelActive.gapId),
        undefined,
        undefined,
        cancelHarness.ctx,
    );

    return {
        checkMutationRejected,
        validatorMutationRejected,
        sourceStillSelected,
        concurrentRejected,
        sessionChangedRejected,
        sessionStillSelected,
        cardChangedRejected,
        cardStillSelected,
        selectionChangedRejected,
        cancellationRejected,
        cancellationPreservedSelection,
        cancellationReleasedLock: retryAfterCancellation.details?.state === "retired",
    };
}

export default async function wishlistVerificationHarness() {
    const scenario = process.env.SPECPI_VERIFICATION_SCENARIO ?? "all";
    const report =
        scenario === "contract"
            ? await runContractScenario()
            : scenario === "policy"
              ? await runPolicyScenario()
              : scenario === "selection"
                ? await runSelectionScenario()
                : scenario === "menu"
                  ? await runMenuScenario()
                  : await runFinishBoundaryScenario();

    process.stdout.write(`SPECPI_WISHLIST_VERIFICATION_HARNESS=${JSON.stringify(report)}\n`);
}
