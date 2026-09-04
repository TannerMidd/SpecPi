import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { runPiFixture } from "../scripts/pi-test-harness.mjs";

const fixture = path.resolve("tests/fixtures/workflow-controls-harness.ts");

test("workflow-controls extension composes scope and completion challenge lifecycle", (context) => {
    const result = runPiFixture(fixture);
    if (result.unavailable) {
        context.skip(result.error?.message ?? "Pi is not available for the extension harness");

        return;
    }

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const output = `${result.stdout}\n${result.stderr}`;
    const match = output.match(/WORKFLOW_CONTROLS_HARNESS=(.+)/u);
    assert.ok(match, output);
    const report = JSON.parse(match[1]);
    assert.deepEqual(report.commands, ["challenge", "experiment", "guard", "scope", "task"]);
    assert.equal(report.toolRegistered, true);
    assert.equal(report.nestedCwdOutOfScopeDenied, true);
    assert.equal(report.nestedCwdInScopeAllowed, true);
    assert.equal(report.denied, true);
    assert.equal(report.allowed, true);
    assert.equal(report.pendingRecorded, true);
    assert.equal(report.headlessAllowed, true);
    assert.equal(report.headlessPending, true);
    assert.equal(report.challengeTriggered, true);
    assert.equal(report.challengeTerminated, true);
    assert.equal(report.challengeVerdict, "incomplete");
    assert.equal(report.staleChallengeRejected, true);
    for (const observation of [
        "genericChallengeTriggered",
        "legacyReviewInvalidated",
        "genericActiveReviewInvalidated",
        "taskImportPreservedPending",
        "taskImportBoundDigest",
        "taskChallengeExactIds",
        "handoffRendered",
        "handoffDidNotTriggerTurn",
        "taskRevisionKeepsId",
        "taskRevisionChangedDigest",
        "taskRevisionInvalidatedReview",
        "taskScopeReportedStale",
        "taskReimportUpdatedDigest",
        "taskRevisionEmittedStaleImmediately",
        "taskClearEmittedStaleImmediately",
        "malformedTaskChallengeBlocked",
        "malformedTaskRendererSafe",
        "stickyChallengeIndeterminate",
        "stickyReadyRejected",
        "scopeRecheckClearedUncertainty",
        "handoffStickyUncertainty",
        "treeClearedChallengeBeforeRoot",
        "treeOldStateCleared",
        "treeOlderRestoreIgnored",
        "treeArmedGenericChallengeCleared",
        "treeDelayedChallengeRootIgnored",
        "treeDelayedChallengeSnapshotIgnored",
        "treeDelayedTaskEditorIgnored",
        "treeDelayedHandoffIgnored",
        "treeDelayedRecheckIgnored",
        "shutdownDelayedChallengeIgnored",
    ]) {
        assert.equal(report[observation], true, observation);
    }

    assert.equal(report.acceptClearedPending, true);
    assert.equal(report.acceptKeptScope, true);
    assert.equal(report.addWidenedScope, true);
    assert.equal(report.percentPathStayedCanonical, true);
    assert.equal(report.readSkippedSnapshots, true);
    assert.equal(report.abandonedChallengeExpired, true);
    assert.equal(report.resumedActive, true);
    assert.equal(report.resumedChallengeArmed, false);
    assert.equal(report.completedResultSurvivedRestart, true);
    assert.equal(report.restoredRecordUnchanged, true);
    assert.equal(report.addAfterResumeWidened, true);
    assert.equal(report.guardStillUsable, true);
    assert.equal(report.emittedScopeStatus, true);
});
