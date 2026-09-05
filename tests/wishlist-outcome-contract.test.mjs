import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    appendWishlistDecision,
    readDecisionsFile,
    recordCapabilityGap,
    refreshWishlist,
    setCollectionMode,
} from "../extensions/tool-wishlist/core.mjs";
import { captureSourceSnapshot, createVerificationReceipt } from "../extensions/tool-wishlist/verification.mjs";

function createSourceRoot(label) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `specpi-outcome-source-${label}-`));
    fs.mkdirSync(path.join(root, "extensions"));
    fs.writeFileSync(path.join(root, "extensions", "fixture.mjs"), "export default 1;\n");

    return root;
}

function createReceipt(sourceRoot, gapId, selectionId) {
    const before = captureSourceSnapshot(sourceRoot, { head: "main" });
    const after = captureSourceSnapshot(sourceRoot, { head: "main" });

    return createVerificationReceipt({
        before,
        after,
        registryDigest: "a".repeat(64),
        validatorDigest: "b".repeat(64),
        gates: [{ id: "outcome-contract-test", exitCode: 0 }],
        contractDigest: "c".repeat(64),
        gapId,
        selectionId,
        sourceRootSalt: "outcome-contract-test-salt",
        runtimeAt: "2026-09-04T00:00:00.000Z",
    });
}

function gapFor(gapId) {
    const title = gapId.replace(/-/g, " ");

    return {
        capability: title,
        scenario: `Exercise ${title}`,
        limitation: `The ${title} capability was unavailable`,
        impact: "blocked",
        workaround: "Manual fallback",
        suggestedFix: "tool",
    };
}

function retirementJournal(receipt) {
    return {
        schema: 1,
        evidence: ["The temporary outcome contract check passed"],
        gates: ["outcome-contract-test"],
        version: "0.10.0",
        ...(receipt === undefined ? {} : { receipt }),
    };
}

async function seedRetirement(
    stateDir,
    sourceRoot,
    {
        gapId = "outcome-contract-gap",
        selectionId = "selection-1",
        eventAt = "2026-09-01T00:00:00.000Z",
        retirementAt = "2026-09-02T00:00:00.000Z",
        receipt = true,
        journal = true,
    } = {},
) {
    await setCollectionMode({ stateDir, mode: "on" });
    await recordCapabilityGap({
        stateDir,
        sessionId: `session-${gapId}-${selectionId}`,
        runId: `run-${gapId}-${selectionId}`,
        cwd: stateDir,
        gap: gapFor(gapId),
        now: eventAt,
    });
    await appendWishlistDecision({
        stateDir,
        action: "select",
        canonicalKey: gapId,
        now: new Date(Date.parse(eventAt) + 60 * 60 * 1000).toISOString(),
    });

    return appendWishlistDecision({
        stateDir,
        action: "retire",
        canonicalKey: gapId,
        note: "Receipt-backed outcome contract proof",
        now: retirementAt,
        ...(journal
            ? {
                  journal: retirementJournal(
                      receipt === true ? createReceipt(sourceRoot, gapId, selectionId) : undefined,
                  ),
              }
            : {}),
    });
}

async function appendOutcome(stateDir, options) {
    return appendWishlistDecision({
        stateDir,
        action: "outcome",
        note: "Outcome recorded by the local contract test",
        ...options,
    });
}

test("outcomes require collection on and the exact latest local receipt retirement", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-outcome-gates-"));
    const sourceRoot = createSourceRoot("gates");
    try {
        const first = await seedRetirement(root, sourceRoot, {
            gapId: "outcome-latest-gap",
            selectionId: "selection-1",
        });

        await appendWishlistDecision({
            stateDir: root,
            action: "reopen",
            canonicalKey: "outcome-latest-gap",
            note: "Review the first retirement",
            now: "2026-09-03T00:00:00.000Z",
        });
        await appendWishlistDecision({
            stateDir: root,
            action: "select",
            canonicalKey: "outcome-latest-gap",
            now: "2026-09-03T01:00:00.000Z",
        });
        const second = await appendWishlistDecision({
            stateDir: root,
            action: "retire",
            canonicalKey: "outcome-latest-gap",
            note: "Receipt-backed second proof",
            now: "2026-09-04T00:00:00.000Z",
            journal: retirementJournal(createReceipt(sourceRoot, "outcome-latest-gap", "selection-2")),
        });

        await assert.rejects(
            () =>
                appendOutcome(root, {
                    canonicalKey: "outcome-latest-gap",
                    targetKey: first.decisionId,
                    outcome: "helped",
                    requestId: "old-retirement-response",
                    previousOutcomeId: "",
                }),
            /exact latest local retirement receipt|latest local retirement/i,
        );

        const accepted = await appendOutcome(root, {
            canonicalKey: "outcome-latest-gap",
            targetKey: second.decisionId,
            outcome: "helped",
            requestId: "latest-retirement-response",
            previousOutcomeId: "",
        });
        assert.equal(accepted.targetKey, second.decisionId);
        assert.equal(
            readDecisionsFile(path.join(root, "tool-wishlist-decisions.jsonl")).decisions.filter(
                (decision) => decision.action === "outcome",
            ).length,
            1,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
});

test("baseline and legacy no-receipt retirements, plus collection off, cannot receive outcomes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-outcome-eligibility-"));
    const sourceRoot = createSourceRoot("eligibility");
    try {
        await setCollectionMode({ stateDir: root, mode: "on" });

        await assert.rejects(
            () =>
                appendOutcome(root, {
                    canonicalKey: "local-browser-automation",
                    targetKey: "11111111-1111-4111-8111-111111111111",
                    outcome: "helped",
                    requestId: "shipped-baseline-outcome",
                    previousOutcomeId: "",
                }),
            /exact latest local retirement receipt|latest local retirement/i,
        );

        const legacyJournal = await seedRetirement(root, sourceRoot, {
            gapId: "legacy-journal-gap",
            selectionId: "legacy-journal-selection",
            receipt: false,
        });
        await assert.rejects(
            () =>
                appendOutcome(root, {
                    canonicalKey: "legacy-journal-gap",
                    targetKey: legacyJournal.decisionId,
                    outcome: "helped",
                    requestId: "legacy-journal-outcome",
                    previousOutcomeId: "",
                }),
            /exact latest local retirement receipt|latest local retirement/i,
        );

        const legacyNoJournal = await seedRetirement(root, sourceRoot, {
            gapId: "legacy-no-journal-gap",
            selectionId: "legacy-no-journal-selection",
            journal: false,
            retirementAt: "2026-09-05T00:00:00.000Z",
        });
        await assert.rejects(
            () =>
                appendOutcome(root, {
                    canonicalKey: "legacy-no-journal-gap",
                    targetKey: legacyNoJournal.decisionId,
                    outcome: "helped",
                    requestId: "legacy-no-journal-outcome",
                    previousOutcomeId: "",
                }),
            /exact latest local retirement receipt|latest local retirement/i,
        );

        const receiptRetirement = await seedRetirement(root, sourceRoot, {
            gapId: "outcome-off-gap",
            selectionId: "off-selection",
            retirementAt: "2026-09-06T00:00:00.000Z",
        });
        await setCollectionMode({ stateDir: root, mode: "off" });
        await assert.rejects(
            () =>
                appendOutcome(root, {
                    canonicalKey: "outcome-off-gap",
                    targetKey: receiptRetirement.decisionId,
                    outcome: "helped",
                    requestId: "off-mode-outcome",
                    previousOutcomeId: "",
                }),
            /collection|explicitly on|off/i,
        );

        const decisions = readDecisionsFile(path.join(root, "tool-wishlist-decisions.jsonl")).decisions;
        assert.equal(
            decisions.some((decision) => decision.action === "outcome"),
            false,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
});

test("all outcome values append as non-lifecycle corrections and preserve independent signals", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-outcome-values-"));
    const sourceRoot = createSourceRoot("values");
    try {
        const gapId = "outcome-value-gap";
        const retirement = await seedRetirement(root, sourceRoot, { gapId });
        const values = ["helped", "failed", "not-exercised", "reverted"];
        const outcomes = [];
        let previousOutcomeId = "";

        for (const [index, value] of values.entries()) {
            const decision = await appendOutcome(root, {
                canonicalKey: gapId,
                targetKey: retirement.decisionId,
                outcome: value,
                requestId: `outcome-value-${index + 1}`,
                previousOutcomeId,
                now: `2026-09-0${3 + index}T00:00:00.000Z`,
            });
            outcomes.push(decision);
            previousOutcomeId = decision.decisionId;

            const stored = readDecisionsFile(path.join(root, "tool-wishlist-decisions.jsonl")).decisions;
            assert.equal(stored.filter((decisionEntry) => decisionEntry.action === "outcome").length, index + 1);
        }

        const negative = await refreshWishlist({ stateDir: root, now: "2026-09-07T00:00:00.000Z" });
        assert.equal(negative.metrics.openReviews, 1);
        assert.match(negative.report, /Review needed: yes/);
        assert.deepEqual(
            negative.decisions
                .filter((decision) => ["select", "decline", "retire", "reopen"].includes(decision.action))
                .map((decision) => decision.action),
            ["select", "retire"],
        );

        await recordCapabilityGap({
            stateDir: root,
            sessionId: "post-retirement-signal-session",
            runId: "post-retirement-signal-run",
            cwd: root,
            gap: gapFor(gapId),
            now: "2026-09-08T00:00:00.000Z",
        });

        const helpedCorrection = await appendOutcome(root, {
            canonicalKey: gapId,
            targetKey: retirement.decisionId,
            outcome: "helped",
            requestId: "outcome-helped-correction",
            previousOutcomeId: outcomes.at(-1).decisionId,
            note: "Correction after the independent post-retirement signal",
            now: "2026-09-09T00:00:00.000Z",
        });
        assert.notEqual(helpedCorrection.decisionId, outcomes.at(-1).decisionId);

        const refreshed = await refreshWishlist({ stateDir: root, now: "2026-09-10T00:00:00.000Z" });
        assert.deepEqual(refreshed.metrics.outcomes, {
            helped: 1,
            failed: 0,
            "not-exercised": 0,
            reverted: 0,
            unassessed: 0,
        });
        assert.equal(refreshed.metrics.openReviews, 1);
        assert.match(refreshed.report, /Review needed: yes/);
        assert.match(refreshed.report, /Unresolved post-retirement signals: 1/);
        assert.deepEqual(
            refreshed.decisions.filter((decision) => decision.action === "outcome").map((decision) => decision.outcome),
            [...values, "helped"],
        );
        assert.deepEqual(
            refreshed.decisions
                .filter((decision) => ["select", "decline", "retire", "reopen"].includes(decision.action))
                .map((decision) => decision.action),
            ["select", "retire"],
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
});

test("outcome request retries are idempotent while conflicts, stale corrections, and newer retirements fail", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-outcome-retries-"));
    const sourceRoot = createSourceRoot("retries");
    try {
        const gapId = "outcome-retry-gap";
        const firstRetirement = await seedRetirement(root, sourceRoot, { gapId });
        const first = await appendOutcome(root, {
            canonicalKey: gapId,
            targetKey: firstRetirement.decisionId,
            outcome: "helped",
            requestId: "outcome-retry-request",
            previousOutcomeId: "",
            now: "2026-09-03T00:00:00.000Z",
        });
        const retry = await appendOutcome(root, {
            canonicalKey: gapId,
            targetKey: firstRetirement.decisionId,
            outcome: "helped",
            requestId: "outcome-retry-request",
            previousOutcomeId: "",
            now: "2026-09-03T00:00:01.000Z",
        });
        assert.equal(retry.decisionId, first.decisionId);
        assert.equal(retry.idempotent, true);

        await assert.rejects(
            () =>
                appendOutcome(root, {
                    canonicalKey: gapId,
                    targetKey: firstRetirement.decisionId,
                    outcome: "failed",
                    requestId: "outcome-retry-request",
                    previousOutcomeId: "",
                }),
            /already used|different decision/i,
        );

        const correction = await appendOutcome(root, {
            canonicalKey: gapId,
            targetKey: firstRetirement.decisionId,
            outcome: "failed",
            requestId: "outcome-retry-correction",
            previousOutcomeId: first.decisionId,
            now: "2026-09-04T00:00:00.000Z",
        });
        await assert.rejects(
            () =>
                appendOutcome(root, {
                    canonicalKey: gapId,
                    targetKey: firstRetirement.decisionId,
                    outcome: "helped",
                    requestId: "outcome-stale-correction",
                    previousOutcomeId: first.decisionId,
                }),
            /stale|latest.*outcome/i,
        );

        await appendWishlistDecision({
            stateDir: root,
            action: "reopen",
            canonicalKey: gapId,
            note: "Review the failed outcome",
            now: "2026-09-05T00:00:00.000Z",
        });
        await appendWishlistDecision({
            stateDir: root,
            action: "select",
            canonicalKey: gapId,
            now: "2026-09-05T01:00:00.000Z",
        });
        const secondRetirement = await appendWishlistDecision({
            stateDir: root,
            action: "retire",
            canonicalKey: gapId,
            note: "Receipt-backed second outcome proof",
            now: "2026-09-06T00:00:00.000Z",
            journal: retirementJournal(createReceipt(sourceRoot, gapId, "selection-2")),
        });

        await assert.rejects(
            () =>
                appendOutcome(root, {
                    canonicalKey: gapId,
                    targetKey: firstRetirement.decisionId,
                    outcome: "helped",
                    requestId: "outcome-old-retirement-response",
                    previousOutcomeId: correction.decisionId,
                }),
            /exact latest local retirement receipt|latest local retirement/i,
        );
        await assert.rejects(
            () =>
                appendOutcome(root, {
                    canonicalKey: gapId,
                    targetKey: secondRetirement.decisionId,
                    outcome: "helped",
                    requestId: "outcome-new-retirement-stale",
                    previousOutcomeId: correction.decisionId,
                }),
            /stale|latest.*outcome/i,
        );

        const decisions = readDecisionsFile(path.join(root, "tool-wishlist-decisions.jsonl")).decisions;
        assert.deepEqual(
            decisions.filter((decision) => decision.action === "outcome").map((decision) => decision.requestId),
            ["outcome-retry-request", "outcome-retry-correction"],
        );
        assert.deepEqual(
            decisions
                .filter((decision) => ["select", "decline", "retire", "reopen"].includes(decision.action))
                .map((decision) => decision.action),
            ["select", "retire", "reopen", "select", "retire"],
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
});
