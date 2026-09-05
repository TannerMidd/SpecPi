import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const fixture = path.resolve("tests/fixtures/workflow-controls-harness.ts");

function quoteWindows(value) {
    return `"${String(value).replaceAll("%", "%%").replaceAll('"', '""')}"`;
}

test("workflow-controls extension composes scope and completion challenge lifecycle", (context) => {
    const args = ["--offline", "--no-extensions", "--no-skills", "-e", fixture, "--list-models"];
    const result =
        process.platform === "win32"
            ? spawnSync(["pi.cmd", ...args].map(quoteWindows).join(" "), {
                  cwd: process.cwd(),
                  env: { ...process.env, PI_OFFLINE: "1" },
                  encoding: "utf8",
                  timeout: 120000,
                  shell: process.env.ComSpec || "cmd.exe",
              })
            : spawnSync("pi", args, {
                  cwd: process.cwd(),
                  env: { ...process.env, PI_OFFLINE: "1" },
                  encoding: "utf8",
                  timeout: 120000,
              });
    if (result.error?.code === "ENOENT") {
        context.skip("Pi is not available for the extension harness");

        return;
    }

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const match = result.stdout.match(/WORKFLOW_CONTROLS_HARNESS=(.+)/u);
    assert.ok(match, result.stdout);
    const report = JSON.parse(match[1]);
    assert.deepEqual(report.commands, ["challenge", "experiment", "guard", "scope"]);
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
