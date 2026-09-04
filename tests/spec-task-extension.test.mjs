import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { runPiFixture } from "../scripts/pi-test-harness.mjs";

const fixture = path.resolve("tests/fixtures/spec-task-harness.ts");

function readHarnessReport(stdout) {
    const line = stdout.split(/\r?\n/u).find((entry) => entry.startsWith("SPEC_TASK_HARNESS="));
    assert.ok(line, stdout);

    return JSON.parse(line.slice("SPEC_TASK_HARNESS=".length));
}

test("spec visibly tracks the current branch task and ignores stale review roots", (context) => {
    const result = runPiFixture(fixture);
    if (result.unavailable) {
        context.skip(result.error?.message ?? "Pi is not available for the task display fixture");

        return;
    }

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.error, null);
    const report = readHarnessReport(`${result.stdout}\n${result.stderr}`);

    assert.match(report.noCardDisplay, /TASK\s+UNSET/u);
    assert.match(report.noCardDisplay, /REQ\s+UNSET/u);
    assert.doesNotMatch(report.noCardDisplay, /INVALID/u);
    assert.match(report.noCardStatus, /task:\s*unset/u);
    assert.match(report.noCardStatus, /requirements:\s*unset/iu);

    assert.match(report.setDisplay, /TASK\s+Prove the first task contract/u);
    assert.match(report.setDisplay, /REQ\s+0\/2/u);
    assert.match(report.matchingReviewDisplay, /TASK\s+Prove the first task contract/u);
    assert.match(report.matchingReviewDisplay, /REQ\s+1\/2/u);

    assert.match(report.staleReviewDisplay, /TASK\s+Prove the first task contract/u);
    assert.match(report.staleReviewDisplay, /REQ\s+0\/2/u);

    assert.match(report.revisedDisplay, /TASK\s+Revise the first task card/u);
    assert.match(report.revisedDisplay, /REQ\s+0\/3/u);
    assert.match(report.revisedReviewDisplay, /TASK\s+Revise the first task card/u);
    assert.match(report.revisedReviewDisplay, /REQ\s+1\/3/u);

    assert.match(report.clearedDisplay, /TASK\s+UNSET/u);
    assert.match(report.clearedDisplay, /REQ\s+UNSET/u);

    assert.match(report.sessionSwitchDisplay, /TASK\s+Session B objective/u);
    assert.match(report.sessionSwitchDisplay, /REQ\s+0\/1/u);
    assert.doesNotMatch(report.sessionSwitchDisplay, /Old session objective/u);

    assert.match(report.treeSourceDisplay, /TASK\s+Tree source objective/u);
    assert.match(report.treeSourceDisplay, /REQ\s+2\/2/u);
    assert.match(report.treeSourceDisplay, /SCOPE\s+REVIEW/u);
    assert.doesNotMatch(report.treeImmediateDisplay, /Tree source objective|REQ\s+2\/2|SCOPE\s+REVIEW/u);
    assert.match(report.treeDestinationDisplay, /TASK\s+Tree destination objective/u);
    assert.match(report.treeDestinationDisplay, /REQ\s+1\/3/u);
    assert.match(report.treeDestinationDisplay, /SCOPE\s+UNSET/u);
    assert.match(report.treeDestinationMode, /response held until complete/u);
    assert.match(report.treeScopeDisplay, /SCOPE\s+CLEAN/u);
    assert.equal(report.treeAfterOldRefreshDisplay, report.treeScopeDisplay);
    assert.equal(report.treeOldRefreshIgnored, true);

    assert.equal(report.treeDisabledImmediateDisplay, "");
    assert.equal(report.treeDisabledDisplay, "");
    assert.equal(report.treeDisabledMode, "tree response");
    assert.equal(report.treeDisabledStatusCleared, true);
    assert.match(report.treeReenabledDisplay, /TASK\s+Tree destination objective/u);
    assert.match(report.treeReenabledDisplay, /REQ\s+1\/3/u);
    assert.match(report.treeReenabledDisplay, /SCOPE\s+UNSET/u);
    assert.equal(report.treeRestoreDidNotPersist, true);
    assert.equal(report.shutdownRefreshIgnored, true);
    assert.equal(report.shutdownUiStayedClear, true);
    assert.ok(report.renderRequests >= 5, JSON.stringify(report));
});
