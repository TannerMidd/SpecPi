import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

test("Desktop RPC starts with Guard off and changes mode without duplicate prompts", () => {
    const fixture = path.resolve("tests/fixtures/command-guard-desktop-harness.ts");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", fixture], {
        encoding: "utf8",
        env: { ...process.env },
    });
    assert.equal(result.status, 0, result.stderr);
    const line = result.stdout.split("\n").find((entry) => entry.startsWith("COMMAND_GUARD_DESKTOP="));
    assert.ok(line, result.stdout);
    const value = JSON.parse(line.slice("COMMAND_GUARD_DESKTOP=".length));
    assert.equal(value.selects, 0);
    assert.equal(value.notifications, 0);
    assert.equal(value.confirms, 0);
    assert.equal(value.genericRpcSelects, 0);
    assert.equal(value.genericRpcStatus, "🛡 Guard");
    assert.equal(value.startupStatus, "Guard Off");
    assert.equal(value.strictStatus, "🛡 Strict");
    assert.equal(value.finalStatus, "Guard Off");
    assert.equal(value.safeAllowed, true);
});

test("extension blocks before executor and latches critical lock", () => {
    const fixture = path.resolve("tests/fixtures/command-guard-harness.ts");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", fixture], {
        encoding: "utf8",
        env: { ...process.env },
    });
    assert.equal(result.status, 0, result.stderr);
    const line = result.stdout.split("\n").find((entry) => entry.startsWith("COMMAND_GUARD_HARNESS="));
    assert.ok(line, result.stdout);
    const value = JSON.parse(line.slice("COMMAND_GUARD_HARNESS=".length));
    assert.equal(value.dangerousBlocked, true);
    assert.equal(value.mutatedApprovalBlocked, true);
    assert.equal(value.lockedApprovalBlocked, true);
    assert.equal(value.safeBlockedAfterLock, true);
    assert.equal(value.nonLatchingCleanupBlocked, true);
    assert.equal(value.nonLatchingCleanupDidNotLock, true);
    assert.equal(value.commandRegistered, true);
    assert.equal(value.statusInspectable, true);
    assert.equal(value.guardUnknownAllowed, true);
    assert.equal(value.unknownTerminalBlocked, true);
    assert.equal(value.promptTimeoutBlocked, true);
    assert.equal(value.promptFailureBlocked, true);
    assert.equal(value.promptHasContext, true);
    assert.equal(value.unlockRestoredStrict, true);
    assert.equal(value.sessionResetGuard, true);
    assert.equal(value.confirmedOffAllows, true);
    assert.equal(value.startOnlyReset, true);
});

test("approval prompts wait on the person while startup falls back on its own bound", () => {
    const fixture = path.resolve("tests/fixtures/command-guard-timeout-harness.ts");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", fixture], {
        encoding: "utf8",
        env: { ...process.env },
    });
    assert.equal(result.status, 0, result.stderr);
    const line = result.stdout.split("\n").find((entry) => entry.startsWith("COMMAND_GUARD_TIMEOUT="));
    assert.ok(line, result.stdout);
    const value = JSON.parse(line.slice("COMMAND_GUARD_TIMEOUT=".length));
    assert.equal(value.slowApprovalAllowed, true, "an approval slower than the startup bound must not be auto-denied");
    assert.equal(value.shortApprovalBlocked, true, "an approval past its own bound must still fail closed");
    assert.equal(value.legacyAliasBlocked, true, "promptTimeoutMs must keep bounding both prompt kinds");
});

test("exact-call approvals last for the session and never override catastrophe", () => {
    const fixture = path.resolve("tests/fixtures/command-guard-session-approval-harness.ts");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", fixture], {
        encoding: "utf8",
        env: { ...process.env },
    });
    assert.equal(result.status, 0, result.stderr);
    const line = result.stdout.split("\n").find((entry) => entry.startsWith("COMMAND_GUARD_SESSION_APPROVAL="));
    assert.ok(line, result.stdout);
    const value = JSON.parse(line.slice("COMMAND_GUARD_SESSION_APPROVAL=".length));
    assert.equal(value.firstAllowed, true);
    assert.equal(value.repeatAllowed, true);
    assert.equal(value.repeatSkippedPrompt, true);
    assert.equal(value.changedCwdBlocked, true);
    assert.equal(value.changedBlocked, true);
    assert.equal(value.statusCountedApproval, true);
    assert.equal(value.afterClearBlocked, true);
    assert.equal(value.writeFirstAllowed, true);
    assert.equal(value.writeRepeatAllowed, true);
    assert.equal(value.writeChangedBlocked, true);
    assert.equal(value.modeChangeCleared, true);
    assert.equal(value.largeWriteApprovable, true);
    assert.equal(value.criticalBlocked, true);
    assert.equal(value.criticalWasNotPrompted, true);
});

test("approval scope clears across lifecycle boundaries and concurrent calls stay isolated", () => {
    const fixture = path.resolve("tests/fixtures/command-guard-approval-lifecycle-harness.ts");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", fixture], {
        encoding: "utf8",
        env: { ...process.env },
    });
    assert.equal(result.status, 0, result.stderr);
    const line = result.stdout.split("\n").find((entry) => entry.startsWith("COMMAND_GUARD_APPROVAL_LIFECYCLE="));
    assert.ok(line, result.stdout);
    const value = JSON.parse(line.slice("COMMAND_GUARD_APPROVAL_LIFECYCLE=".length));
    assert.equal(value.allowOnceDoesNotRepeat, true);
    assert.equal(value.restartClears, true);
    assert.equal(value.offClears, true);
    assert.equal(value.lockAndUnlockClear, true);
    assert.equal(value.concurrentIsolated, true);
});

test("session approvals are bounded with deterministic oldest-entry eviction", () => {
    const fixture = path.resolve("tests/fixtures/command-guard-approval-bound-harness.ts");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", fixture], {
        encoding: "utf8",
        env: { ...process.env },
    });
    assert.equal(result.status, 0, result.stderr);
    const line = result.stdout.split("\n").find((entry) => entry.startsWith("COMMAND_GUARD_APPROVAL_BOUND="));
    assert.ok(line, result.stdout);
    const value = JSON.parse(line.slice("COMMAND_GUARD_APPROVAL_BOUND=".length));
    assert.equal(value.bounded, true);
    assert.equal(value.oldestEvicted, true);
    assert.equal(value.promptedAgain, true);
});

test("a refused read does not strand the session, a refused mutation still locks it", () => {
    const fixture = path.resolve("tests/fixtures/command-guard-lock-harness.ts");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", fixture], {
        encoding: "utf8",
        env: { ...process.env },
    });
    assert.equal(result.status, 0, result.stderr);
    const line = result.stdout.split("\n").find((entry) => entry.startsWith("COMMAND_GUARD_LOCK="));
    assert.ok(line, result.stdout);
    const value = JSON.parse(line.slice("COMMAND_GUARD_LOCK=".length));
    assert.equal(value.readDenied, true, "a protected read must still be refused");
    assert.equal(value.readDidNotLock, true, "refusing a read must not lock every later call");
    assert.equal(value.writeDenied, true, "a protected mutation must be refused");
    assert.equal(value.writeLatchedLock, true, "a critical mutation attempt must still latch the lock");
});
