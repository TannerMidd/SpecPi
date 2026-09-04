import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { runPiFixture } from "../scripts/pi-test-harness.mjs";

const fixture = path.resolve("tests/fixtures/wishlist-verification-harness.ts");
function runScenario(context, scenario) {
    const result = runPiFixture(fixture, {
        env: { SPECPI_VERIFICATION_SCENARIO: scenario },
        timeout: 120_000,
    });
    if (result.unavailable) {
        context.skip(result.error?.message ?? "Pi is not available for the wishlist verification harness");

        return undefined;
    }

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const output = `${result.stdout}\n${result.stderr}`;
    const match = output.match(/SPECPI_WISHLIST_VERIFICATION_HARNESS=(.+)/u);
    assert.ok(match, output);

    return JSON.parse(match[1]);
}

test("wishlist verification preserves task-card authority and deduplicates nested reports", (context) => {
    const report = runScenario(context, "contract");
    if (!report) {
        return;
    }

    assert.equal(report.contractRetryIdempotent, true);
    assert.equal(report.contractReplacementRejected, true);
    assert.equal(report.cardReportDeduped, true);
    assert.equal(report.stableContractId, true);
});

test("wishlist verification freezes scripts, registry, and validator policy while permitting its own new entry", (context) => {
    const report = runScenario(context, "policy");
    if (!report) {
        return;
    }

    assert.equal(report.scriptsRejected, true);
    assert.equal(report.checkPackageRejected, true);
    assert.equal(report.eslintRejected, true);
    assert.equal(report.prettierRejected, true);
    assert.equal(report.prettierIgnoreRejected, true);
    assert.equal(report.registryRejected, true);
    assert.equal(report.validatorRejected, true);
    assert.equal(report.coreRejected, true);
    assert.equal(report.taskContractRejected, true);
    assert.equal(report.scopeRejected, true);
    assert.equal(report.ownRegistryEntryAccepted, true);
});

test("wishlist verification rejects source and active-state races, releases its lock, and preserves cancellation", (context) => {
    const report = runScenario(context, "finish");
    if (!report) {
        return;
    }

    for (const observation of [
        "checkMutationRejected",
        "validatorMutationRejected",
        "sourceStillSelected",
        "concurrentRejected",
        "sessionChangedRejected",
        "sessionStillSelected",
        "cardChangedRejected",
        "cardStillSelected",
        "selectionChangedRejected",
        "cancellationRejected",
        "cancellationPreservedSelection",
        "cancellationReleasedLock",
    ]) {
        assert.equal(report[observation], true, observation);
    }
});

test("wishlist selection follows session trees, invalidates pending tools, and renews exact human reselections", (context) => {
    const report = runScenario(context, "selection");
    if (!report) {
        return;
    }

    for (const observation of [
        "emptyBranchRejected",
        "emptyBranchNoCard",
        "originalBranchRestored",
        "sameSelectionPendingRejected",
        "sameSelectionPendingNoCard",
        "sameAncestorCardPreserved",
        "reselectionFreshNonce",
        "reselectionFreshBaseline",
        "reselectionClearedCard",
        "oldSelectionRejected",
        "newSelectionPendingRejected",
        "newSelectionPendingNoCard",
        "newSelectionContractAccepted",
        "secondReselectionFreshNonce",
        "secondReselectionClearedCard",
        "previousSelectionRejected",
        "secondNewContractAccepted",
        "sameCardTreeFinishRejected",
        "sameCardTreePreservedSelection",
        "sameCardTreePreservedCard",
        "freshPolicyBaselineAccepted",
    ]) {
        assert.equal(report[observation], true, observation);
    }
});

test("wishlist menus reject stale leaf and overlapping choices while accepting current policy at selection", (context) => {
    const report = runScenario(context, "menu");
    if (!report) {
        return;
    }

    for (const observation of [
        "leafAdvanceRejected",
        "leafAdvanceNoEntries",
        "leafAdvanceNoPrompt",
        "leafAdvancePreservedCard",
        "overlappingOlderRejected",
        "overlappingOlderNoEntries",
        "overlappingOlderNoPrompt",
        "staleMenusNoDecisions",
        "newerMenuAccepted",
        "newerMenuClearedCard",
        "newerMenuContractAccepted",
        "menuAcceptedCurrentPolicy",
        "menuCurrentPolicyFinishAccepted",
    ]) {
        assert.equal(report[observation], true, observation);
    }
});
