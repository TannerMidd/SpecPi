import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  aggregateEvents,
  appendWishlistDecision,
  collectChangedFilePaths,
  isValidChangedFilePath,
  linkReopenToRetirement,
  loopMetrics,
  readDecisionsFile,
  recordCapabilityGap,
  refreshWishlist,
  renderWishlist,
  renderWishlistHistory,
  setCollectionMode,
} from "../extensions/tool-wishlist/core.mjs";
import { isValidValidatorName, validateCapabilityRegistry } from "../extensions/tool-wishlist/registry.mjs";
import { runValidator } from "../extensions/tool-wishlist/validators.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validatorsCli = path.join(repoRoot, "extensions", "tool-wishlist", "validators.mjs");
const capabilitiesPath = path.join(repoRoot, "extensions", "tool-wishlist", "capabilities.json");
const fakeBrowserNpm = path.join(repoRoot, "tests", "fixtures", "fake-browser-npm.mjs");
const cli = path.join(repoRoot, "scripts", "zenpi.mjs");

async function seedLifecycle(stateDir, { withJournal = true } = {}) {
  await setCollectionMode({ stateDir, mode: "on" });
  const gap = {
    capability: "Local audio transcription",
    scenario: "Transcribe a local recording",
    limitation: "No local transcription capability was available",
    impact: "blocked",
    workaround: "Manual transcription",
    suggestedFix: "tool",
  };
  await recordCapabilityGap({ stateDir, sessionId: "s1", runId: "r1", cwd: "/proj/a", gap, now: "2026-01-01T00:00:00.000Z" });
  await recordCapabilityGap({ stateDir, sessionId: "s2", runId: "r2", cwd: "/proj/b", gap, now: "2026-01-02T00:00:00.000Z" });
  await appendWishlistDecision({ stateDir, action: "select", canonicalKey: "local-audio-transcription", now: "2026-01-02T06:00:00.000Z" });
  const retire = await appendWishlistDecision({
    stateDir,
    action: "retire",
    canonicalKey: "local-audio-transcription",
    note: "Transcription smoke passed",
    now: "2026-01-03T00:00:00.000Z",
    ...(withJournal ? {
      journal: {
        schema: 1,
        evidence: ["Transcription smoke completed at 2026-01-03"],
        gates: ["npm run check", "wishlist-state-smoke"],
        changedFiles: ["extensions/tool-wishlist/core.mjs", "tests/wishlist-improvement-loop.test.mjs"],
        changedFilesTruncated: false,
        version: "0.7.0",
      },
    } : {}),
  });
  return { gap, retire };
}

test("retirement journal persists sanitized bounded proof next to the decision", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-journal-"));
  try {
    const { retire } = await seedLifecycle(root, { withJournal: true });
    const decisions = readDecisionsFile(path.join(root, "tool-wishlist-decisions.jsonl")).decisions;
    const stored = decisions.find((decision) => decision.id === retire.decisionId);
    assert.equal(stored.action, "retire");
    assert.deepEqual(stored.journal.gates, ["npm run check", "wishlist-state-smoke"]);
    assert.deepEqual(stored.journal.changedFiles, ["extensions/tool-wishlist/core.mjs", "tests/wishlist-improvement-loop.test.mjs"]);
    assert.equal(stored.journal.changedFilesTruncated, false);
    assert.equal(stored.journal.version, "0.7.0");
    assert.equal(stored.journal.evidence.length, 1);
    assert.doesNotMatch(JSON.stringify(stored.journal), /\/proj\/|C:\\/);

    const refreshed = await refreshWishlist({ stateDir: root });
    assert.match(refreshed.report, /# Retired/);
    assert.match(refreshed.report, /verified 2026-01-03 via npm run check, wishlist-state-smoke/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retirement journals tolerate absent git context by omitting changed files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-journal-nogit-"));
  try {
    const gap = {
      capability: "Audio transcript generation",
      scenario: "Generate a transcript from a recording",
      limitation: "No transcript generation capability was available",
      impact: "degraded",
      workaround: "Manual transcription",
      suggestedFix: "skill",
    };
    await setCollectionMode({ stateDir: root, mode: "on" });
    await recordCapabilityGap({ stateDir: root, sessionId: "s1", runId: "r1", cwd: "/proj/a", gap, now: "2026-01-01T00:00:00.000Z" });
    await appendWishlistDecision({ stateDir: root, action: "select", canonicalKey: "audio-transcript-generation", now: "2026-01-02T00:00:00.000Z" });
    const retire = await appendWishlistDecision({
      stateDir: root,
      action: "retire",
      canonicalKey: "audio-transcript-generation",
      note: "Journal without git context",
      journal: {
        schema: 1,
        evidence: ["Acceptance check passed without repository access"],
        gates: ["npm run check"],
        changedFilesTruncated: false,
        version: "0.7.0",
      },
    });
    const decisions = readDecisionsFile(path.join(root, "tool-wishlist-decisions.jsonl")).decisions;
    const stored = decisions.find((decision) => decision.id === retire.decisionId);
    assert.equal(stored.journal.changedFiles, undefined);
    assert.equal(stored.journal.changedFilesTruncated, false);
    const detail = renderWishlistHistory([], decisions, "audio-transcript-generation");
    assert.match(detail, /- Changed files: not recorded/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("journal bounds and placement fail closed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-journal-bounds-"));
  try {
    const { retire } = await seedLifecycle(root);
    const base = {
      stateDir: root,
      canonicalKey: "local-audio-transcription",
      note: "Retire attempt",
    };
    await assert.rejects(
      () => appendWishlistDecision({ ...base, action: "retire", journal: { schema: 1, evidence: Array.from({ length: 9 }, (_, index) => `evidence ${index}`), gates: ["npm run check"], version: "0.7.0" } }),
      /Retirement journal is invalid/,
    );
    await assert.rejects(
      () => appendWishlistDecision({ ...base, action: "retire", journal: { schema: 1, evidence: ["ok"], gates: ["bad gate!"], version: "0.7.0" } }),
      /Retirement journal is invalid/,
    );
    await assert.rejects(
      () => appendWishlistDecision({ ...base, action: "retire", journal: { schema: 1, evidence: ["ok"], gates: ["   "], version: "0.7.0" } }),
      /Retirement journal is invalid/,
    );
    await assert.rejects(
      () => appendWishlistDecision({ ...base, action: "retire", journal: { schema: 1, evidence: ["ok"], gates: ["npm run check"], version: "https://private.example/token" } }),
      /Retirement journal is invalid/,
    );
    await assert.rejects(
      () => appendWishlistDecision({ ...base, action: "retire", journal: { schema: 1, evidence: ["ok"], gates: ["npm run check"], changedFiles: ["C:\\abs\\path.ts"], version: "0.7.0" } }),
      /Retirement journal is invalid/,
    );
    await assert.rejects(
      () => appendWishlistDecision({ ...base, action: "retire", journal: { schema: 1, evidence: ["ok"], gates: ["npm run check"], changedFiles: ["a/../../etc"], version: "0.7.0" } }),
      /Retirement journal is invalid/,
    );
    await assert.rejects(
      () => appendWishlistDecision({ ...base, action: "retire", journal: { schema: 1, evidence: ["ok"], gates: ["npm run check"], changedFiles: ["has space.ts"], version: "0.7.0" } }),
      /Retirement journal is invalid/,
    );
    await assert.rejects(
      () => appendWishlistDecision({ ...base, action: "retire", journal: { schema: 1, evidence: ["   "], gates: ["npm run check"], version: "0.7.0" } }),
      /invalid after sanitization/,
    );
    await assert.rejects(
      () => appendWishlistDecision({ ...base, action: "retire", journal: { schema: 1, evidence: ["ok"], gates: ["npm run check"], version: "\u0000\u0000" } }),
      /Retirement journal is invalid/,
    );
    await assert.rejects(
      () => appendWishlistDecision({ ...base, action: "reopen", canonicalKey: "local-audio-transcription", note: "Reopened with blank evidence", evidence: [" "] }),
      /invalid after sanitization/,
    );
    await assert.rejects(
      () => appendWishlistDecision({ ...base, action: "select", journal: { schema: 1, evidence: ["ok"], gates: ["npm run check"], version: "0.7.0" } }),
      /only valid on retire decisions/,
    );
    await assert.rejects(
      () => appendWishlistDecision({ ...base, action: "retire", evidence: ["top-level evidence"] }),
      /evidence belongs in the journal/,
    );
    await assert.rejects(
      () => appendWishlistDecision({ ...base, action: "merge", canonicalKey: "alpha", targetKey: "beta", evidence: ["nope"] }),
      /only valid on reopen decisions/,
    );

    // The seeded retirement survived every failed attempt untouched.
    const decisions = readDecisionsFile(path.join(root, "tool-wishlist-decisions.jsonl")).decisions;
    assert.equal(decisions.filter((decision) => decision.action === "retire").length, 1);
    assert.equal(decisions.find((decision) => decision.id === retire.decisionId).journal.evidence.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reopen evidence is bounded, sanitized, and rejected elsewhere", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-reopen-evidence-"));
  try {
    const { gap } = await seedLifecycle(root);
    await recordCapabilityGap({ stateDir: root, sessionId: "s3", runId: "r3", cwd: "/proj/a", gap, now: "2026-01-04T00:00:00.000Z" });
    const review = await refreshWishlist({ stateDir: root });
    assert.equal(review.improvements[0].reviewFirstSeen, "2026-01-04T00:00:00.000Z");
    assert.equal(review.improvements[0].reviewLastSeen, "2026-01-04T00:00:00.000Z");
    await assert.rejects(
      () => appendWishlistDecision({
        stateDir: root,
        action: "reopen",
        canonicalKey: "local-audio-transcription",
        note: "Reopened for review: 1 post-retirement signal(s)",
        evidence: Array.from({ length: 6 }, (_, index) => `signal ${index}`),
      }),
      /must contain 1 to 5/,
    );
    const reopen = await appendWishlistDecision({
      stateDir: root,
      action: "reopen",
      canonicalKey: "local-audio-transcription",
      note: "Reopened for review: 1 post-retirement signal(s)",
      evidence: ["1 post-retirement signal(s) recorded after the retirement", "Latest limitation: No local transcription capability was available"],
    });
    const stored = readDecisionsFile(path.join(root, "tool-wishlist-decisions.jsonl")).decisions;
    const storedReopen = stored.find((decision) => decision.id === reopen.decisionId);
    assert.equal(storedReopen.evidence.length, 2);
    assert.equal(storedReopen.targetKey.length, 36);
    assert.equal(storedReopen.journal, undefined);
    assert.equal(linkReopenToRetirement(stored, storedReopen).action, "retire");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy decision records without journal or evidence still parse", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-journal-legacy-"));
  try {
    const legacy = {
      schema: 1,
      id: "0d3f4a5e-6b7c-4d8e-9f0a-1b2c3d4e5f60",
      timestamp: "2026-01-01T00:00:00.000Z",
      action: "retire",
      canonicalKey: "legacy-gap",
      targetKey: "",
      reverses: "",
      note: "Legacy retirement note",
    };
    fs.writeFileSync(path.join(root, "tool-wishlist-decisions.jsonl"), `${JSON.stringify(legacy)}\n`);
    const parsed = readDecisionsFile(path.join(root, "tool-wishlist-decisions.jsonl"));
    assert.equal(parsed.decisions.length, 1);
    assert.equal(parsed.invalidLines, 0);
    assert.equal(parsed.decisions[0].journal, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reopen decisions reject malformed journal placement at the reader boundary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-journal-reader-"));
  try {
    const invalid = {
      schema: 1,
      id: "1d3f4a5e-6b7c-4d8e-9f0a-1b2c3d4e5f60",
      timestamp: "2026-01-01T00:00:00.000Z",
      action: "reopen",
      canonicalKey: "some-gap",
      targetKey: "",
      reverses: "",
      note: "Reopen with a misplaced journal",
      journal: { schema: 1, evidence: ["ok"], gates: ["npm run check"], version: "0.7.0" },
    };
    fs.writeFileSync(path.join(root, "tool-wishlist-decisions.jsonl"), `${JSON.stringify(invalid)}\n`);
    const parsed = readDecisionsFile(path.join(root, "tool-wishlist-decisions.jsonl"));
    assert.equal(parsed.decisions.length, 0);
    assert.equal(parsed.invalidLines, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reopen lineage links to the latest retirement and rejects broken explicit links", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-lineage-"));
  try {
    const { retire, gap } = await seedLifecycle(root);
    await recordCapabilityGap({ stateDir: root, sessionId: "s3", runId: "r3", cwd: "/proj/a", gap, now: "2026-01-04T00:00:00.000Z" });
    // The gap is retired here, so a broken explicit link is what fails first.
    await assert.rejects(
      () => appendWishlistDecision({
        stateDir: root,
        action: "reopen",
        canonicalKey: "local-audio-transcription",
        note: "Reopened with a broken link",
        linkedRetirementId: "not-a-real-decision-id",
      }),
      /is not a retire decision/,
    );
    await appendWishlistDecision({ stateDir: root, action: "reopen", canonicalKey: "local-audio-transcription", note: "Reopened for review: 1 post-retirement signal(s)", now: "2026-01-05T00:00:00.000Z" });
    await appendWishlistDecision({ stateDir: root, action: "select", canonicalKey: "local-audio-transcription", note: "Chosen through harness improvement menu", now: "2026-01-05T01:00:00.000Z" });
    await appendWishlistDecision({ stateDir: root, action: "retire", canonicalKey: "local-audio-transcription", note: "Revalidated transcription smoke passed", now: "2026-01-06T00:00:00.000Z" });
    await recordCapabilityGap({ stateDir: root, sessionId: "s4", runId: "r4", cwd: "/proj/a", gap, now: "2026-01-07T00:00:00.000Z" });
    await appendWishlistDecision({ stateDir: root, action: "reopen", canonicalKey: "local-audio-transcription", note: "Reopened for review: 1 post-retirement signal(s)", now: "2026-01-08T00:00:00.000Z" });

    const decisions = readDecisionsFile(path.join(root, "tool-wishlist-decisions.jsonl")).decisions;
    const reopens = decisions.filter((decision) => decision.action === "reopen");
    const retires = decisions.filter((decision) => decision.action === "retire");
    assert.deepEqual(reopens.map((decision) => decision.targetKey), [retire.decisionId, retires[1].id]);
    assert.equal(linkReopenToRetirement(decisions, reopens[1]).id, retires[1].id);
    assert.equal(linkReopenToRetirement(decisions, retires[0]), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loop health metrics are deterministic and rendered only with observations", async () => {
  const base = {
    schema: 1,
    sessionHash: "session",
    projectHash: "project",
    capability: "Gap",
    scenario: "Reusable need",
    limitation: "Current capability falls short",
    workaround: "Manual fallback",
    suggestedFix: "tool",
    impact: "degraded",
  };
  const events = [
    { ...base, canonicalKey: "alpha", runHash: "a1", timestamp: "2026-01-01T00:00:00.000Z" },
    { ...base, canonicalKey: "alpha", runHash: "a2", timestamp: "2026-01-05T00:00:00.000Z" },
    { ...base, canonicalKey: "beta", runHash: "b1", timestamp: "2026-01-02T00:00:00.000Z" },
    { ...base, canonicalKey: "alpha", runHash: "a3", timestamp: "2026-01-08T00:00:00.000Z" },
  ];
  const decisions = [
    { schema: 1, id: "select-1", timestamp: "2026-01-03T00:00:00.000Z", action: "select", canonicalKey: "alpha", targetKey: "", reverses: "", note: "" },
    { schema: 1, id: "retire-1", timestamp: "2026-01-07T00:00:00.000Z", action: "retire", canonicalKey: "alpha", targetKey: "", reverses: "", note: "done" },
    { schema: 1, id: "reopen-1", timestamp: "2026-01-09T00:00:00.000Z", action: "reopen", canonicalKey: "alpha", targetKey: "retire-1", reverses: "", note: "regression" },
  ];
  const retiredWithSignal = loopMetrics(events, decisions.slice(0, 2));
  assert.equal(retiredWithSignal.retirements, 1);
  assert.equal(retiredWithSignal.reopenRate, 0);
  assert.equal(retiredWithSignal.openReviews, 1);
  assert.equal(retiredWithSignal.medianDaysToRetire, 6);
  const metrics = loopMetrics(events, decisions);
  assert.equal(metrics.retirements, 1);
  assert.equal(metrics.reopens, 1);
  assert.equal(metrics.reopenRate, 100);
  assert.equal(metrics.openReviews, 0);
  assert.equal(metrics.medianDaysToRetire, 6);
  assert.equal(metrics.qualificationRate, 50);
  assert.equal(metrics.observedGroups, 2);

  // A reopen from declined is not a retirement regression and must not count.
  const declinedCycle = loopMetrics(
    [{ ...base, canonicalKey: "gamma", runHash: "g1", timestamp: "2026-01-01T00:00:00.000Z" }],
    [
      { schema: 1, id: "select-g", timestamp: "2026-01-02T00:00:00.000Z", action: "select", canonicalKey: "gamma", targetKey: "", reverses: "", note: "" },
      { schema: 1, id: "decline-g", timestamp: "2026-01-03T00:00:00.000Z", action: "decline", canonicalKey: "gamma", targetKey: "", reverses: "", note: "" },
      { schema: 1, id: "reopen-g", timestamp: "2026-01-04T00:00:00.000Z", action: "reopen", canonicalKey: "gamma", targetKey: "", reverses: "", note: "" },
    ],
  );
  assert.equal(declinedCycle.reopens, 0);
  assert.equal(declinedCycle.reopenRate, 0);

  // Even counts average the two middle durations.
  const twoRetirements = loopMetrics(
    [
      { ...base, canonicalKey: "alpha", runHash: "a1", timestamp: "2026-01-01T00:00:00.000Z" },
      { ...base, canonicalKey: "beta", runHash: "b1", timestamp: "2026-01-04T00:00:00.000Z" },
    ],
    [
      { schema: 1, id: "retire-a", timestamp: "2026-01-07T00:00:00.000Z", action: "retire", canonicalKey: "alpha", targetKey: "", reverses: "", note: "done" },
      { schema: 1, id: "retire-b", timestamp: "2026-01-06T00:00:00.000Z", action: "retire", canonicalKey: "beta", targetKey: "", reverses: "", note: "done" },
    ],
  );
  assert.equal(twoRetirements.retirements, 2);
  assert.equal(twoRetirements.medianDaysToRetire, 4);

  assert.equal(loopMetrics([], []).retirements, 0);
  assert.equal(loopMetrics([], []).reopenRate, 0);
  assert.equal(loopMetrics([], []).qualificationRate, 0);
  assert.equal(loopMetrics([], []).medianDaysToRetire, undefined);
  assert.equal(loopMetrics([events[0]]).qualificationRate, 0);

  const report = renderWishlist(events, { decisions });
  assert.match(report, /# Loop health/);
  assert.match(report, /- Retirements: 1 \| Reopen rate: 100% \| Open reviews: 0/);
  assert.match(report, /- Median time to retire: 6 day\(s\) \| Qualification rate: 50% of 2 observed gap\(s\)/);
  assert.doesNotMatch(renderWishlist([]), /# Loop health/);
  assert.match(renderWishlist([{ ...base, canonicalKey: "solo", runHash: "s1", timestamp: "2026-01-01T00:00:00.000Z" }]), /Qualification rate: 0% of 1 observed gap\(s\)/);
});

test("improvement journal renders summaries, detail, and rejects unknown gaps", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-history-"));
  try {
    const { gap } = await seedLifecycle(root);
    await recordCapabilityGap({ stateDir: root, sessionId: "s3", runId: "r3", cwd: "/proj/a", gap, now: "2026-01-04T00:00:00.000Z" });
    await appendWishlistDecision({
      stateDir: root,
      action: "reopen",
      canonicalKey: "local-audio-transcription",
      note: "Reopened for review: 1 post-retirement signal(s)",
      evidence: ["1 post-retirement signal(s) recorded after the retirement"],
      now: "2026-01-05T00:00:00.000Z",
    });

    const refreshed = await refreshWishlist({ stateDir: root });
    const summary = renderWishlistHistory(refreshed.events, refreshed.decisions);
    assert.match(summary, /# Improvement journal/);
    assert.match(summary, /retire `local-audio-transcription`/);
    assert.match(summary, /gates: npm run check, wishlist-state-smoke · v0\.7\.0/);
    assert.match(summary, /reopen `local-audio-transcription`/);

    const detail = renderWishlistHistory(refreshed.events, refreshed.decisions, "local-audio-transcription");
    assert.match(detail, /## Local audio transcription/);
    assert.match(detail, /### Retired 2026-01-03/);
    assert.match(detail, /- Gates: npm run check, wishlist-state-smoke/);
    assert.match(detail, /- ZenPi version: 0\.7\.0/);
    assert.match(detail, /- Changed files: `extensions\/tool-wishlist\/core.mjs`, `tests\/wishlist-improvement-loop.test.mjs`/);
    assert.match(detail, /- Rollback: revert the changed files above/);
    assert.match(detail, /### Reopened 2026-01-05/);
    assert.match(detail, /- Linked retirement: `/);
    assert.match(detail, /- Post-retirement signals:/);

    assert.throws(() => renderWishlistHistory(refreshed.events, refreshed.decisions, "never-recorded-gap"), /No retirement history/);
    assert.match(renderWishlistHistory([], []), /No retirements or reopens recorded yet/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("changed-file path validation is exact", () => {
  assert.equal(isValidChangedFilePath("extensions/tool-wishlist/core.mjs"), true);
  assert.equal(isValidChangedFilePath("README.md"), true);
  assert.equal(isValidChangedFilePath(""), false);
  assert.equal(isValidChangedFilePath("/absolute/path.mjs"), false);
  assert.equal(isValidChangedFilePath("C:\\Windows\\path.mjs"), false);
  assert.equal(isValidChangedFilePath("a/../b.mjs"), false);
  assert.equal(isValidChangedFilePath("has space.mjs"), false);
  assert.equal(isValidChangedFilePath(`${"a".repeat(201)}.mjs`), false);
});

test("porcelain parsing keeps full paths for unstaged, staged, untracked, and renamed entries", () => {
  assert.deepEqual(collectChangedFilePaths(" M src/unstaged.ts\nM  src/staged.ts\n?? src/new.ts\nAM src/added.ts\n"), [
    "src/added.ts",
    "src/new.ts",
    "src/staged.ts",
    "src/unstaged.ts",
  ]);
  assert.deepEqual(collectChangedFilePaths("R  old/name.ts -> new/name.ts\n"), ["new/name.ts"]);
  assert.deepEqual(collectChangedFilePaths(" M crlf.ts\r\n"), ["crlf.ts"]);
  assert.deepEqual(collectChangedFilePaths("not porcelain\n\n"), []);
  assert.deepEqual(collectChangedFilePaths(""), []);
  assert.deepEqual(collectChangedFilePaths(undefined), []);
});

test("validator catalog, registry, and capability links stay in sync", () => {
  const registry = validateCapabilityRegistry(JSON.parse(fs.readFileSync(capabilitiesPath, "utf8")));
  assert.ok(registry.capabilities.length >= 5);
  for (const capability of registry.capabilities) {
    assert.ok(capability.validations.length >= 1);
    for (const validator of capability.validations) {
      assert.equal(isValidValidatorName(validator), true, `capability ${capability.id} links unregistered validator ${validator}`);
    }
  }
  for (const id of ["durable-retirement-proof", "improvement-journal", "loop-health-metric", "context-rich-reopen"]) {
    const entry = registry.capabilities.find((capability) => capability.id === id);
    assert.ok(entry, `missing registry entry for ${id}`);
    assert.deepEqual(entry.validations, ["wishlist-state-smoke"]);
  }
  const commandGuard = registry.capabilities.find((capability) => capability.id === "command-guard");
  assert.ok(commandGuard, "missing registry entry for command-guard");
  assert.deepEqual(commandGuard.validations, ["command-guard-smoke"]);
});

test("every registry-linked validator executes through the shared CLI with isolated prerequisites", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-registry-validators-"));
  try {
    const runtime = path.join(root, "browser-runtime");
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, "package.json"), "{}\n");
    const prepared = spawnSync(process.execPath, [fakeBrowserNpm, "ci"], { cwd: runtime, encoding: "utf8", timeout: 30000 });
    assert.equal(prepared.status, 0, `${prepared.stderr}\n${prepared.stdout}`);

    const registry = validateCapabilityRegistry(JSON.parse(fs.readFileSync(capabilitiesPath, "utf8")));
    const validators = [...new Set(registry.capabilities.flatMap((capability) => capability.validations))].sort();
    for (const validator of validators) {
      const result = spawnSync(process.execPath, [
        validatorsCli,
        validator,
        "--state-dir", path.join(root, "state"),
        "--cwd", repoRoot,
        "--browser-runtime", runtime,
      ], { encoding: "utf8", timeout: 120000 });
      assert.equal(result.status, 0, `${validator} failed\n${result.stderr}\n${result.stdout}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wishlist-state-smoke proves the full lifecycle in temporary state", () => {
  const result = spawnSync(process.execPath, [validatorsCli, "wishlist-state-smoke"], { encoding: "utf8", timeout: 120000 });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /wishlist-state-smoke passed: record, select, retire with journal, reopen with linkage, metrics, and history verified/);
});

test("wishlist-state-smoke fails when its expectations cannot hold", () => {
  const result = spawnSync(process.execPath, [validatorsCli, "wishlist-state-smoke"], {
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, ZENPI_WISHLIST_SMOKE_FAULT: "expectation" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Injected expectation fault/);
});

test("unknown validators fail closed with the registered set", () => {
  const result = spawnSync(process.execPath, [validatorsCli, "made-up-validator"], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown validator: made-up-validator/);
  assert.match(result.stderr, /browser-runtime-smoke, wishlist-state-smoke, command-guard-smoke/);
});

test("validator runs are killed at their timeout and reported as failures", () => {
  const result = runValidator("wishlist-state-smoke", {}, { timeoutMs: 1 });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /timed out after 1ms/);
});

test("doctor fails when a linked capability validator fails", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-doctor-validator-fail-"));
  const agentDir = path.join(root, "agent");
  try {
    const install = spawnSync(process.execPath, [cli, "install", "--yes", "--skip-package-install", "--skip-tool-install", "--skip-shell"], {
      cwd: repoRoot,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      encoding: "utf8",
    });
    assert.equal(install.status, 0, install.stderr);
    const doctor = spawnSync(process.execPath, [cli, "doctor"], {
      cwd: repoRoot,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ZENPI_WISHLIST_SMOKE_FAULT: "expectation" },
      encoding: "utf8",
    });
    assert.notEqual(doctor.status, 0);
    assert.match(doctor.stderr, /validator wishlist-state-smoke failed/);
    assert.match(doctor.stderr, /Injected expectation fault/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("aggregate events tolerate journal-carrying decisions in merges", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-journal-merge-"));
  try {
    await seedLifecycle(root, { withJournal: false });
    await recordCapabilityGap({
      stateDir: root,
      sessionId: "s9",
      runId: "r9",
      cwd: "/proj/c",
      gap: {
        capability: "Audio transcript generation",
        scenario: "Generate a transcript from a recording",
        limitation: "No transcript generation capability was available",
        impact: "degraded",
        workaround: "Manual transcription",
        suggestedFix: "skill",
      },
      now: "2026-01-06T00:00:00.000Z",
    });
    const merge = await appendWishlistDecision({
      stateDir: root,
      action: "merge",
      canonicalKey: "audio-transcript-generation",
      targetKey: "local-audio-transcription",
    });
    const refreshed = await refreshWishlist({ stateDir: root });
    assert.equal(refreshed.uniqueGaps, 0);
    assert.ok(refreshed.report.includes(`merge decision \`${merge.decisionId}\``));
    assert.equal(refreshed.metrics.observedGroups, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
