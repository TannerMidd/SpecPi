import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("extension blocks before executor and latches critical lock", () => {
  const fixture = path.resolve("tests/fixtures/command-guard-harness.ts");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", fixture], { encoding: "utf8", env: { ...process.env, PI_SUBAGENT_CHILD: "" } });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("COMMAND_GUARD_HARNESS="));
  assert.ok(line, result.stdout);
  const value = JSON.parse(line.slice("COMMAND_GUARD_HARNESS=".length));
  assert.equal(value.dangerousBlocked, true);
  assert.equal(value.mutatedApprovalBlocked, true);
  assert.equal(value.lockedApprovalBlocked, true);
  assert.equal(value.racedPreflightBlocked, true);
  assert.equal(value.lockedLaunchBlocked, true);
  assert.equal(value.safeBlockedAfterLock, true);
  assert.equal(value.executorCalls, 0);
  assert.equal(value.commandRegistered, true);
  assert.equal(value.statusInspectable, true);
  assert.equal(value.directLaunchAllowed, true);
  assert.equal(value.workflowBlocked, true);
  assert.equal(value.bindingInjected, true);
  assert.equal(value.bindingMode, "guard");
  assert.equal(value.unrelatedBindingKept, true);
  assert.equal(value.spoofedLaunchBlocked, true);
  assert.equal(value.mutatedPreflightBlocked, true);
  assert.equal(value.unprotectedLaunchBlocked, true);
  assert.equal(value.guardUnknownAllowed, true);
  assert.equal(value.unknownTerminalBlocked, true);
  assert.equal(value.promptTimeoutBlocked, true);
  assert.equal(value.promptFailureBlocked, true);
  assert.equal(value.promptHasContext, true);
  assert.equal(value.unlockRestoredStrict, true);
  assert.equal(value.sessionResetGuard, true);
  assert.equal(value.nonceReset, true);
  assert.equal(value.confirmedOffAllows, true);
  assert.equal(value.offChildGuarded, true);
  assert.equal(value.startOnlyReset, true);
});

test("approval prompts wait on the person while startup falls back on its own bound", () => {
  const fixture = path.resolve("tests/fixtures/command-guard-timeout-harness.ts");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", fixture], { encoding: "utf8", env: { ...process.env, PI_SUBAGENT_CHILD: "" } });
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
  const result = spawnSync(process.execPath, ["--experimental-strip-types", fixture], { encoding: "utf8", env: { ...process.env, PI_SUBAGENT_CHILD: "" } });
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

test("approval scope clears across lifecycle boundaries and stays isolated", () => {
  const fixture = path.resolve("tests/fixtures/command-guard-approval-lifecycle-harness.ts");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", fixture], { encoding: "utf8", env: { ...process.env, PI_SUBAGENT_CHILD: "" } });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("COMMAND_GUARD_APPROVAL_LIFECYCLE="));
  assert.ok(line, result.stdout);
  const value = JSON.parse(line.slice("COMMAND_GUARD_APPROVAL_LIFECYCLE=".length));
  assert.equal(value.allowOnceDoesNotRepeat, true);
  assert.equal(value.restartClears, true);
  assert.equal(value.offClears, true);
  assert.equal(value.lockAndUnlockClear, true);
  assert.equal(value.childIsolated, true);
  assert.equal(value.concurrentIsolated, true);
});

test("session approvals are bounded with deterministic oldest-entry eviction", () => {
  const fixture = path.resolve("tests/fixtures/command-guard-approval-bound-harness.ts");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", fixture], { encoding: "utf8", env: { ...process.env, PI_SUBAGENT_CHILD: "" } });
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
  const result = spawnSync(process.execPath, ["--experimental-strip-types", fixture], { encoding: "utf8", env: { ...process.env, PI_SUBAGENT_CHILD: "" } });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("COMMAND_GUARD_LOCK="));
  assert.ok(line, result.stdout);
  const value = JSON.parse(line.slice("COMMAND_GUARD_LOCK=".length));
  assert.equal(value.readDenied, true, "a protected read must still be refused");
  assert.equal(value.readDidNotLock, true, "refusing a read must not lock every later call");
  assert.equal(value.writeDenied, true, "a protected mutation must be refused");
  assert.equal(value.writeLatchedLock, true, "a critical mutation attempt must still latch the lock");
});

function findPiExecutable() {
  if (process.env.ZENPI_PI_BIN && fs.existsSync(process.env.ZENPI_PI_BIN)) return process.env.ZENPI_PI_BIN;
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["pi"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : undefined;
}
function findPackageRoot(start, expected) {
  let current = fs.realpathSync(start);
  if (!fs.statSync(current).isDirectory()) current = path.dirname(current);
  while (true) {
    try { if (JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8")).name === expected) return current; } catch {}
    const parent = path.dirname(current); if (parent === current) return undefined; current = parent;
  }
}

test("child requires a supervisor binding and blocks dangerous calls", () => {
  const fixture = path.resolve("tests/fixtures/command-guard-child-harness.ts");
  const env = { ...process.env, PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_EXTENSION_BINDINGS: JSON.stringify({ "zenpi.command-guard/1": { mode: "strict", policyVersion: 1, parentLocked: false, nonce: "abcdef12" } }) };
  const result = spawnSync(process.execPath, ["--experimental-strip-types", fixture], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("COMMAND_GUARD_CHILD="));
  assert.ok(line, result.stdout);
  const value = JSON.parse(line.slice("COMMAND_GUARD_CHILD=".length));
  assert.equal(value.blocked, true);
  assert.equal(value.childOffRejected, true);
  assert.equal(value.strictWriteBlocked, true);
  assert.equal(value.strictUnknownBlocked, true);
  for (const bindings of [undefined, { "zenpi.command-guard/1": { mode: "off", policyVersion: 1, parentLocked: false, nonce: "abcdef12" } }]) {
    const invalidEnv = { ...process.env, PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_EXTENSION_BINDINGS: bindings ? JSON.stringify(bindings) : "" };
    const invalid = spawnSync(process.execPath, ["--experimental-strip-types", fixture], { encoding: "utf8", env: invalidEnv });
    assert.equal(invalid.status, 0, invalid.stderr);
    const invalidLine = invalid.stdout.split("\n").find((entry) => entry.startsWith("COMMAND_GUARD_CHILD="));
    assert.ok(invalidLine, invalid.stdout);
    assert.equal(JSON.parse(invalidLine.slice("COMMAND_GUARD_CHILD=".length)).blocked, true);
  }
});

test("real pi-subagents child receives the guard and blocks before execution", { timeout: 90000 }, (t) => {
  const piCli = process.env.ZENPI_PI_CLI;
  const piBin = piCli || findPiExecutable();
  const npmRoot = process.env.ZENPI_SUBAGENTS_NPM_ROOT || path.join(os.homedir(), ".pi", "agent", "npm");
  const subagents = path.join(npmRoot, "node_modules", "pi-subagents", "index.ts");
  if (!piBin || !fs.existsSync(subagents) || !fs.existsSync(path.join(npmRoot, "node_modules", "jiti"))) {
    if (process.env.ZENPI_REQUIRE_NATIVE_CHILD_TEST === "1") assert.fail("Pinned Pi/pi-subagents runtime is required by this validation job.");
    return t.skip("Pinned Pi/pi-subagents runtime is unavailable.");
  }
  const piRoot = process.env.ZENPI_PI_PACKAGE_ROOT || findPackageRoot(piBin, "@earendil-works/pi-coding-agent");
  if (!piRoot) {
    if (process.env.ZENPI_REQUIRE_NATIVE_CHILD_TEST === "1") assert.fail("Pi package root is required by this validation job.");
    return t.skip("Pi package root is unavailable.");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-command-guard-child-"));
  try {
    const agentDir = path.join(root, "agent");
    const guardDir = path.join(agentDir, "extensions", "command-guard");
    fs.mkdirSync(path.dirname(guardDir), { recursive: true });
    fs.cpSync(path.resolve("extensions/command-guard"), guardDir, { recursive: true });
    const provider = path.join(agentDir, "extensions", "command-guard-faux-provider.ts");
    fs.copyFileSync(path.resolve("tests/fixtures/command-guard-faux-provider.ts"), provider);
    const unrelated = path.join(agentDir, "extensions", "unrelated-child-extension.ts");
    fs.writeFileSync(unrelated, 'import fs from "node:fs"; export default function () { if (process.env.PI_SUBAGENT_CHILD === "1") fs.writeFileSync(process.env.ZENPI_COMMAND_GUARD_UNRELATED_LOADED, "loaded"); }\n');
    fs.symlinkSync(npmRoot, path.join(agentDir, "npm"), process.platform === "win32" ? "junction" : "dir");
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: { defaultExtensions: [path.join(guardDir, "index.ts"), provider], modelScope: { enforce: false }, agentOverrides: { researcher: { model: "zenpi-guard-faux/guard-test", thinking: false, extensions: [unrelated, provider, path.join(guardDir, "index.ts")] } } } }));
    const canary = path.join(agentDir, "zenpi-command-guard-canary");
    const childStarted = path.join(root, "child-started.json");
    const unrelatedLoaded = path.join(root, "unrelated-loaded.txt");
    const piArgs = ["--mode", "json", "--no-session", "--offline", "--no-extensions", "--no-skills", "--no-themes", "--no-context-files", "--extension", path.join(guardDir, "index.ts"), "--extension", provider, "--extension", subagents, "--model", "zenpi-guard-faux/guard-test", "--print", "Launch the worker now."];
    const result = spawnSync(piCli ? process.execPath : piBin, piCli ? [piCli, ...piArgs] : piArgs, {
      cwd: root, encoding: "utf8", timeout: 80000,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ZENPI_PI_PACKAGE_ROOT: piRoot, ZENPI_COMMAND_GUARD_CANARY: canary, ZENPI_COMMAND_GUARD_CHILD_STARTED: childStarted, ZENPI_COMMAND_GUARD_UNRELATED_LOADED: unrelatedLoaded, PI_OFFLINE: "1" },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /PARENT_GUARD_COMPLETED/);
    assert.equal(fs.existsSync(childStarted), true, `native child did not start: ${result.stdout}\n${result.stderr}`);
    const childProof = JSON.parse(fs.readFileSync(childStarted, "utf8"));
    assert.equal(childProof.child, true);
    assert.equal(childProof.binding?.mode, "guard");
    assert.equal(childProof.binding?.policyVersion, 1);
    assert.equal(fs.readFileSync(unrelatedLoaded, "utf8"), "loaded");
    assert.equal(fs.existsSync(canary), false, `guarded child executed the canary command: ${canary}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
