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
  archiveWishlist,
  createIssueDraft,
  isImplementedCapability,
  normalizeCapability,
  readCollectionMode,
  recordCapabilityGap,
  refreshWishlist,
  setCollectionMode,
} from "../extensions/tool-wishlist/core.mjs";
import { validateCapabilityRegistry } from "../extensions/tool-wishlist/registry.mjs";
import { CYCLE_STAGES, nextCycleStep, previousCycleStep } from "../site/cycle.js";
import {
  assertDistinctPaths,
  comparePngBuffers,
  normalizeBrowserUrl,
  publishBuffer,
  resolveUserPath,
  resolveViewport,
} from "../extensions/browser/core.mjs";
import {
  AGENTS_END,
  AGENTS_START,
  deletePath,
  mergePackages,
  packageIdentity,
  readPath,
  removeManagedBlock,
  setPath,
  sha256,
  upsertManagedBlock,
} from "../scripts/lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "scripts", "zenpi.mjs");

function invokeCli(agentDir, args, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv, PI_CODING_AGENT_DIR: agentDir },
    encoding: "utf8",
  });
}

function runCli(agentDir, ...args) {
  const result = invokeCli(agentDir, args);
  if (result.status !== 0) {
    throw new Error(`zenpi ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

async function recordTestGap(options) {
  if (readCollectionMode(options.stateDir) !== "on") {
    await setCollectionMode({ stateDir: options.stateDir, mode: "on" });
  }
  return recordCapabilityGap(options);
}

function writeExecutable(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
}

function runWishlistExtensionHarness(agentDir) {
  const harness = path.join(repoRoot, "tests", "fixtures", "wishlist-extension-harness.ts");
  const result = spawnSync("pi", ["--offline", "--no-extensions", "--no-skills", "-e", harness, "--list-models"], {
    cwd: repoRoot,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
    encoding: "utf8",
  });
  if (result.error?.code === "ENOENT") return undefined;
  if (result.status !== 0) {
    throw new Error(`wishlist extension harness failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  const marker = result.stdout.split("\n").find((line) => line.startsWith("ZENPI_WISHLIST_HARNESS="));
  if (!marker) throw new Error(`wishlist extension harness result missing\n${result.stdout}`);
  return JSON.parse(marker.slice("ZENPI_WISHLIST_HARNESS=".length));
}

function installFakeBrowserNpm(fakeBin) {
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "tests", "fixtures", "fake-browser-npm.mjs"), path.join(fakeBin, "npm"));
  fs.chmodSync(path.join(fakeBin, "npm"), 0o755);
}

test("npm package identities ignore pinned versions", () => {
  assert.equal(packageIdentity("npm:pi-subagents@0.58.0"), "npm:pi-subagents");
  assert.equal(
    packageIdentity("npm:@scope/example@1.2.3"),
    "npm:@scope/example",
  );
  assert.equal(packageIdentity({ source: "npm:@scope/example" }), "npm:@scope/example");
});

test("package merge replaces matching identities and preserves unrelated entries", () => {
  const existing = [
    "npm:other@1.0.0",
    { source: "npm:pi-subagents@0.1.0", skills: [] },
  ];
  assert.deepEqual(mergePackages(existing, ["npm:pi-subagents@0.58.0"]), [
    "npm:other@1.0.0",
    "npm:pi-subagents@0.58.0",
  ]);
});

test("managed blocks preserve surrounding user content", () => {
  const installed = upsertManagedBlock("before\nafter\n", AGENTS_START, AGENTS_END, "managed v1");
  assert.match(installed, /before\nafter/);
  assert.match(installed, /managed v1/);

  const updated = upsertManagedBlock(installed, AGENTS_START, AGENTS_END, "managed v2");
  assert.doesNotMatch(updated, /managed v1/);
  assert.match(updated, /managed v2/);
  assert.equal(removeManagedBlock(updated, AGENTS_START, AGENTS_END), "before\nafter\n");
});

test("path operations create, read, and prune empty parents", () => {
  const value = {};
  setPath(value, ["one", "two", "three"], 3);
  assert.deepEqual(readPath(value, ["one", "two", "three"]), { exists: true, value: 3 });
  deletePath(value, ["one", "two", "three"]);
  assert.deepEqual(value, {});
});

test("platform launchers invoke Node directly", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const windowsLauncher = fs.readFileSync(path.join(repoRoot, "zenpi.cmd"), "utf8");
  assert.equal(manifest.bin.zenpi, "./scripts/zenpi.mjs");
  assert.match(windowsLauncher, /node "%~dp0scripts\\zenpi\.mjs" %\*/i);
  assert.ok(fs.readFileSync(path.join(repoRoot, "zenpi"), "utf8").startsWith("#!/usr/bin/env sh\n"));
});

test("showcase site is self-contained and Pages-ready", () => {
  const siteDir = path.join(repoRoot, "site");
  const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf8");
  const css = fs.readFileSync(path.join(siteDir, "styles.css"), "utf8");
  const cycle = fs.readFileSync(path.join(siteDir, "cycle.js"), "utf8");
  const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "pages.yml"), "utf8");

  assert.match(html, /<html lang="en">/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /href="styles\.css"/);
  assert.match(html, /href="logo\.svg"/);
  assert.match(html, /id="principles"/);
  assert.match(html, /id="features"/);
  assert.match(html, /id="wishlist"/);
  assert.match(html, /id="workings"/);
  assert.match(html, /id="goal"/);
  assert.match(html, /A control loop,<br>not an autopilot\./);
  assert.match(html, /<code>\/harness-improvement<\/code> opens one clean menu/);
  assert.match(html, /type="module" src="cycle\.js"/);
  assert.match(html, /data-cycle-story/);
  assert.match(html, /role="tablist" aria-label="Improvement stages"/);
  assert.equal(html.match(/data-cycle-step=/g)?.length, 7);
  assert.match(html, /class="story-fallback"/);
  assert.match(html, /surface later evidence for human review/);
  assert.match(html, /aria-live="polite" data-story-announcement/);
  assert.match(html, /Walk one gap from friction to proof\./);
  assert.doesNotMatch(html, /cycle-charts|cycle-orbit|gate-outcomes/);
  assert.doesNotMatch(html, /<strong>high<\/strong><span>impact/);
  assert.match(html, /id="install"/);
  assert.match(html, /Stable <code>v0\.3\.0<\/code> includes the one-command improvement loop/);
  assert.match(html, /\\zenpi\.cmd install/);
  assert.match(html, /\.\/zenpi install/);
  assert.ok(fs.existsSync(path.join(siteDir, "logo.svg")));
  assert.match(css, /\.cycle-story/);
  assert.match(css, /\.story-tabs button\[aria-selected="true"\]/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.equal(cycle.match(/stage: "/g)?.length, 7);
  assert.match(cycle, /scrollIntoView/);
  assert.match(cycle, /ArrowRight|ArrowDown/);
  assert.equal(CYCLE_STAGES.length, 7);
  assert.deepEqual(CYCLE_STAGES.map((stage) => stage.status), ["open", "qualified", "selected", "selected", "verifying", "retired", "review-needed"]);
  assert.equal(nextCycleStep(0), 1);
  assert.equal(nextCycleStep(6), 2);
  assert.equal(previousCycleStep(3), 2);
  assert.equal(previousCycleStep(0), 0);
  assert.match(workflow, /actions\/configure-pages@v5/);
  assert.match(workflow, /actions\/upload-pages-artifact@v4/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
  assert.match(workflow, /permissions:\n\s+contents: read\n\s+pages: write\n\s+id-token: write/);
  assert.match(workflow, /path: site/);
});

test("capability keys and registry validation are exact", () => {
  assert.equal(normalizeCapability("Missing Browser Automation Tools"), "browser-automation");
  assert.equal(normalizeCapability("browser automations"), "browser-automation");
  assert.equal(isImplementedCapability("Local browser visual regression testing"), true);
  assert.equal(isImplementedCapability("Local browser automation"), true);
  assert.equal(isImplementedCapability("Browser automation with persisted authentication"), false);
  assert.throws(
    () => validateCapabilityRegistry({
      schema: 1,
      capabilities: [
        { id: "browser-automation", title: "Browser automation", aliases: ["shared-alias"], shippedVersion: "1.0.0", shippedAt: "2026-01-01T00:00:00.000Z", validations: ["browser-runtime-smoke"] },
        { id: "visual-regression", title: "Visual regression", aliases: ["shared-alias"], shippedVersion: "1.0.0", shippedAt: "2026-01-01T00:00:00.000Z", validations: ["browser-runtime-smoke"] },
      ],
    }),
    /duplicate or invalid capability alias/,
  );
  assert.throws(
    () => validateCapabilityRegistry({
      schema: 1,
      capabilities: [{ id: "browser-automation", title: "Browser automation", aliases: [], shippedVersion: "1.0.0", shippedAt: "2026-01-01T00:00:00.000Z", validations: ["shell-command"] }],
    }),
    /invalid capability entry/,
  );
});

test("browser inputs normalize local URLs, viewports, and project paths", () => {
  assert.equal(normalizeBrowserUrl("localhost:4173/demo"), "http://localhost:4173/demo");
  assert.equal(normalizeBrowserUrl("https://example.com/path"), "https://example.com/path");
  assert.throws(() => normalizeBrowserUrl("file:///tmp/private.html"), /http: or https:/);
  assert.deepEqual(resolveViewport({ preset: "mobile" }), { width: 390, height: 844 });
  assert.deepEqual(resolveViewport({ width: 1024, height: 768 }), { width: 1024, height: 768 });
  assert.throws(() => resolveViewport({ width: 100, height: 768 }), /200 to 4096/);
  assert.throws(() => resolveViewport({ width: 4096, height: 4096 }), /pixel limit/);
  assert.equal(resolveUserPath("/tmp/project", "@screenshots/base.png"), "/tmp/project/screenshots/base.png");
});

test("browser PNG comparison reports exact pass and dimension mismatch", () => {
  function fakePng(width, height, value = 0) {
    const buffer = Buffer.alloc(25);
    Buffer.from("89504e470d0a1a0a", "hex").copy(buffer);
    buffer.write("IHDR", 12, "ascii");
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    buffer[24] = value;
    return buffer;
  }
  class FakePng {
    constructor({ width, height }) {
      this.width = width;
      this.height = height;
      this.data = Buffer.alloc(width * height * 4);
    }
  }
  FakePng.sync = {
    read(buffer) {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { width, height, data: Buffer.alloc(width * height * 4, buffer[24]) };
    },
    write(image) {
      return fakePng(image.width, image.height);
    },
  };
  const runtime = {
    PNG: FakePng,
    pixelmatch(left, right) {
      return left.equals(right) ? 0 : left.length / 4;
    },
  };
  const same = comparePngBuffers(fakePng(2, 2, 1), fakePng(2, 2, 1), runtime);
  assert.equal(same.pass, true);
  assert.equal(same.diffPixels, 0);
  const changed = comparePngBuffers(fakePng(2, 2, 1), fakePng(2, 2, 2), runtime);
  assert.equal(changed.pass, false);
  assert.equal(changed.diffPixelRatio, 1);
  const resized = comparePngBuffers(fakePng(2, 2, 1), fakePng(3, 2, 1), runtime);
  assert.equal(resized.pass, false);
  assert.equal(resized.dimensionsMatch, false);
});

test("browser output helpers reject aliases and preserve existing files by default", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-browser-output-"));
  const output = path.join(root, "capture.png");
  try {
    assert.throws(
      () => assertDistinctPaths([["baselinePath", output], ["currentPath", path.join(root, ".", "capture.png")]]),
      /must not alias/,
    );
    await publishBuffer(output, Buffer.from("first"));
    const hardlink = path.join(root, "hardlink.png");
    fs.linkSync(output, hardlink);
    assert.throws(() => assertDistinctPaths([["baselinePath", output], ["diffPath", hardlink]]), /must not alias/);
    await assert.rejects(() => publishBuffer(output, Buffer.from("second")), /Output already exists/);
    assert.equal(fs.readFileSync(output, "utf8"), "first");
    await publishBuffer(output, Buffer.from("second"), { overwrite: true });
    assert.equal(fs.readFileSync(output, "utf8"), "second");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tool wishlist deduplicates a gap per task and stores privacy-minimized metrics", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-wishlist-test-"));
  const stateDir = path.join(root, "zenpi");
  const gap = {
    capability: "Local audio transcription",
    scenario: "Interact with src/private/customer.ts in a dynamic web application\nwithout a browser interface",
    limitation: "Static fetching at https://private.example/token with Authorization: Bearer eyJheader123.eyJpayload123.signature could not complete the interactive flow",
    impact: "degraded",
    workaround: "Used (/private/fallback) with api_key=sk-secretvalue123",
    suggestedFix: "tool",
  };

  try {
    const first = await recordTestGap({
      stateDir,
      sessionId: "private-session-id",
      runId: "task-one",
      cwd: "/private/project/path",
      gap,
      now: "2026-01-01T00:00:00.000Z",
    });
    const duplicate = await recordTestGap({
      stateDir,
      sessionId: "private-session-id",
      runId: "task-one",
      cwd: "/private/project/path",
      gap,
      now: "2026-01-01T00:01:00.000Z",
    });
    const secondTask = await recordTestGap({
      stateDir,
      sessionId: "private-session-id",
      runId: "task-two",
      cwd: "/private/project/path",
      gap: { ...gap, impact: "blocked" },
      now: "2026-01-02T00:00:00.000Z",
    });

    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(secondTask.duplicate, false);
    assert.equal(secondTask.occurrences, 2);
    assert.equal(secondTask.sessions, 1);
    assert.equal(secondTask.priority, 6);

    const eventText = fs.readFileSync(path.join(stateDir, "tool-wishlist-events.jsonl"), "utf8");
    assert.equal(eventText.trim().split("\n").length, 2);
    assert.doesNotMatch(eventText, /private-session-id|private\/project\/path/);
    assert.doesNotMatch(eventText, /private\.example|private\/fallback|private\/customer|sk-secretvalue123|eyJheader123/);
    assert.match(eventText, /\[url omitted\]/);
    assert.match(eventText, /\[credential omitted\]/);
    assert.match(eventText, /\[path omitted\]/);
    assert.doesNotMatch(eventText, /\nwithout a browser interface/);

    const report = fs.readFileSync(path.join(stateDir, "TOOL_WISHLIST.md"), "utf8");
    assert.match(report, /Occurrences: 2/);
    assert.match(report, /Distinct sessions: 1/);
    assert.match(report, /Priority: \*\*6\*\*/);
    assert.doesNotMatch(report, /private-session-id|private\/project\/path/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wishlist aggregation ignores duplicate run records and malformed lines", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-wishlist-refresh-test-"));
  const stateDir = path.join(root, "zenpi");
  fs.mkdirSync(stateDir, { recursive: true });
  const event = {
    schema: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    canonicalKey: "audio-transcription",
    sessionHash: "session-hash",
    runHash: "run-hash",
    projectHash: "project-hash",
    capability: "Local audio transcription",
    scenario: "Exercise an interactive site",
    limitation: "No interactive browser was available",
    impact: "minor",
    workaround: "Manual fallback",
    suggestedFix: "tool",
  };
  const implementedEvent = {
    ...event,
    canonicalKey: "local-browser-visual-regression-testing",
    runHash: "implemented-run-hash",
    capability: "Local browser visual regression testing",
  };
  const localAutomationEvent = {
    ...implementedEvent,
    canonicalKey: "local-browser-automation",
    runHash: "local-automation-run-hash",
    capability: "Local browser automation",
  };
  const eventsPath = path.join(stateDir, "tool-wishlist-events.jsonl");
  fs.writeFileSync(
    eventsPath,
    `${JSON.stringify(event)}\n${JSON.stringify(event)}\n${JSON.stringify(implementedEvent)}\n${JSON.stringify(localAutomationEvent)}\nnot-json\n`,
  );

  try {
    assert.equal(aggregateEvents([event, event])[0].occurrences, 1);
    const refreshed = await refreshWishlist({
      stateDir,
      now: "2026-01-03T00:00:00.000Z",
    });
    assert.equal(refreshed.occurrences, 1);
    assert.equal(refreshed.uniqueGaps, 1);
    assert.equal(refreshed.invalidLines, 1);
    assert.match(refreshed.report, /1 malformed observation line\(s\) were ignored/);
    assert.doesNotMatch(refreshed.report, /## Local browser visual regression testing/);
    assert.doesNotMatch(refreshed.report, /## Local browser automation/);
    assert.match(refreshed.report, /# Retired/);
    assert.equal(
      refreshed.report,
      fs.readFileSync(path.join(stateDir, "TOOL_WISHLIST.md"), "utf8"),
    );

    const eventHistory = fs.readFileSync(eventsPath, "utf8");
    const resolved = await recordTestGap({
      stateDir,
      sessionId: "session-two",
      runId: "run-two",
      cwd: root,
      gap: {
        capability: "Local browser visual regression testing",
        scenario: "Compare a local rendered page against an explicit baseline",
        limitation: "No browser-backed pixel comparison was available",
        impact: "degraded",
        workaround: "Manual screenshot review",
        suggestedFix: "tool",
      },
    });
    assert.equal(resolved.resolved, true);
    assert.equal(resolved.regression, true);
    assert.equal(resolved.uniqueGaps, 1);
    assert.equal(resolved.reviewNeeded, true);
    assert.notEqual(fs.readFileSync(eventsPath, "utf8"), eventHistory);
    assert.match(fs.readFileSync(path.join(stateDir, "TOOL_WISHLIST.md"), "utf8"), /# Needs review/);

    const localAutomation = await recordTestGap({
      stateDir,
      sessionId: "session-three",
      runId: "run-three",
      cwd: root,
      gap: {
        capability: "Local browser automation",
        scenario: "Interact with a locally rendered application",
        limitation: "No browser interaction capability was available",
        impact: "degraded",
        workaround: "Manual browser interaction",
        suggestedFix: "tool",
      },
    });
    assert.equal(localAutomation.resolved, true);
    assert.equal(localAutomation.regression, true);
    assert.equal(fs.readFileSync(eventsPath, "utf8").trim().split("\n").length, 7);

    const adjacentGap = await recordTestGap({
      stateDir,
      sessionId: "session-four",
      runId: "run-four",
      cwd: root,
      gap: {
        capability: "Browser automation visual regression authentication",
        scenario: "Compare authenticated application states",
        limitation: "Fresh isolated contexts do not retain an authenticated session",
        impact: "degraded",
        workaround: "Manual authenticated comparison",
        suggestedFix: "tool",
      },
    });
    assert.equal(adjacentGap.resolved, false);
    assert.equal(adjacentGap.canonicalKey, "browser-automation-visual-regression-authentication");
    assert.equal(adjacentGap.uniqueGaps, 2);
    assert.notEqual(fs.readFileSync(eventsPath, "utf8"), eventHistory);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wishlist ranking uses reach and recency after impact-weighted task evidence", () => {
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
    { ...base, canonicalKey: "beta", runHash: "b1", timestamp: "2026-01-01T00:00:00.000Z" },
    { ...base, canonicalKey: "beta", runHash: "b2", projectHash: "project-2", timestamp: "2026-01-01T00:00:00.000Z", impact: "minor" },
    { ...base, canonicalKey: "alpha", runHash: "a2", timestamp: "2026-02-01T00:00:00.000Z", impact: "minor" },
  ];
  const ranked = aggregateEvents(events);
  assert.equal(ranked[0].canonicalKey, "beta");
  assert.equal(ranked[0].projects, 2);

  const sameTaskAfterMerge = aggregateEvents([
    { ...base, observedKey: "left-gap", canonicalKey: "left-gap", runHash: "same", timestamp: "2026-03-01T00:00:00.000Z", impact: "minor" },
    { ...base, observedKey: "right-gap", canonicalKey: "right-gap", runHash: "same", timestamp: "2026-03-02T00:00:00.000Z", impact: "blocked" },
  ], {
    decisions: [{ schema: 1, id: "merge-1", timestamp: "2026-03-03T00:00:00.000Z", action: "merge", canonicalKey: "left-gap", targetKey: "right-gap", reverses: "", note: "" }],
  });
  assert.equal(sameTaskAfterMerge.length, 1);
  assert.equal(sameTaskAfterMerge[0].occurrences, 1);
  assert.equal(sameTaskAfterMerge[0].priority, 4);

  const offsetOrder = aggregateEvents([
    { ...base, canonicalKey: "earlier-offset", runHash: "o1", timestamp: "2026-01-01T00:30:00+02:00" },
    { ...base, canonicalKey: "later-zulu", runHash: "o2", timestamp: "2025-12-31T23:00:00Z" },
  ]);
  assert.equal(offsetOrder[0].canonicalKey, "later-zulu");
});

test("wishlist next requires qualified evidence and gives selected-state guidance", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-wishlist-next-"));
  const gap = {
    capability: "Local audio transcription",
    scenario: "Transcribe a local recording",
    limitation: "No local transcription capability was available",
    impact: "minor",
    workaround: "Manual transcription",
    suggestedFix: "skill",
  };
  try {
    await recordTestGap({ stateDir: root, sessionId: "s1", runId: "r1", cwd: root, gap });
    let refreshed = await refreshWishlist({ stateDir: root });
    assert.match(refreshed.next, /No candidate is available/);
    assert.doesNotMatch(refreshed.next, /wishlist select/);

    await recordTestGap({ stateDir: root, sessionId: "s2", runId: "r2", cwd: root, gap });
    refreshed = await refreshWishlist({ stateDir: root });
    assert.match(refreshed.next, /Run `\/harness-improvement` to choose an item/);

    await appendWishlistDecision({ stateDir: root, action: "select", canonicalKey: "local-audio-transcription" });
    refreshed = await refreshWishlist({ stateDir: root });
    assert.match(refreshed.next, /This gap is selected/);
    assert.match(refreshed.next, /Run `\/harness-improvement` to resume/);
    assert.doesNotMatch(refreshed.next, /wishlist select local-audio-transcription/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wishlist collection is fail-closed and explicit at the mutation boundary", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-wishlist-consent-"));
  const gap = {
    capability: "Local audio transcription",
    scenario: "Transcribe a local recording",
    limitation: "No local transcription capability was available",
    impact: "minor",
    workaround: "Manual transcription",
    suggestedFix: "tool",
  };
  try {
    assert.equal(readCollectionMode(root), "undecided");
    await assert.rejects(
      () => recordCapabilityGap({ stateDir: root, sessionId: "s", runId: "r1", cwd: root, gap }),
      /must be explicitly on/,
    );
    assert.equal(fs.existsSync(path.join(root, ".tool-wishlist-salt")), false);
    assert.equal(fs.existsSync(path.join(root, "tool-wishlist-events.jsonl")), false);

    await setCollectionMode({ stateDir: root, mode: "on" });
    await recordCapabilityGap({ stateDir: root, sessionId: "s", runId: "r1", cwd: root, gap });
    const eventsPath = path.join(root, "tool-wishlist-events.jsonl");
    const recorded = fs.readFileSync(eventsPath, "utf8");
    assert.equal(readCollectionMode(root), "on");

    await setCollectionMode({ stateDir: root, mode: "off" });
    await assert.rejects(
      () => recordCapabilityGap({ stateDir: root, sessionId: "s", runId: "r2", cwd: root, gap }),
      /must be explicitly on/,
    );
    assert.equal(fs.readFileSync(eventsPath, "utf8"), recorded);
    assert.equal(readCollectionMode(root), "off");
    await assert.rejects(() => setCollectionMode({ stateDir: root, mode: "ask" }), /on or off/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wishlist lifecycle requires evidence, captures regressions, and reopens explicitly", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-wishlist-lifecycle-"));
  const gap = {
    capability: "Local audio transcription",
    scenario: "Transcribe a local recording",
    limitation: "No local transcription capability was available",
    impact: "blocked",
    workaround: "Manual transcription",
    suggestedFix: "tool",
  };
  try {
    await recordTestGap({ stateDir: root, sessionId: "s1", runId: "r1", cwd: root, gap, now: "2026-01-01T00:00:00.000Z" });
    await appendWishlistDecision({ stateDir: root, action: "select", canonicalKey: "local-audio-transcription", now: "2026-01-02T00:00:00.000Z" });
    await assert.rejects(
      () => appendWishlistDecision({ stateDir: root, action: "retire", canonicalKey: "local-audio-transcription" }),
      /validation note/,
    );
    await appendWishlistDecision({
      stateDir: root,
      action: "retire",
      canonicalKey: "local-audio-transcription",
      note: "Focused transcription smoke passed",
      now: "2026-01-03T00:00:00.000Z",
    });
    let report = await refreshWishlist({ stateDir: root });
    assert.match(report.report, /# Retired/);

    const regression = await recordTestGap({ stateDir: root, sessionId: "s2", runId: "r2", cwd: root, gap, now: "2026-01-04T00:00:00.000Z" });
    assert.equal(regression.regression, true);
    report = await refreshWishlist({ stateDir: root });
    assert.equal(regression.uniqueGaps, 0);
    assert.equal(regression.reviewNeeded, true);
    assert.match(report.report, /# Needs review/);
    assert.match(report.report, /Unresolved post-retirement signals: 1/);
    assert.match(report.report, /- Status: retired/);

    await appendWishlistDecision({ stateDir: root, action: "reopen", canonicalKey: "local-audio-transcription", now: "2026-01-05T00:00:00.000Z" });
    report = await refreshWishlist({ stateDir: root });
    assert.match(report.report, /- Status: open/);
    assert.doesNotMatch(report.report, /# Needs review/);

    await appendWishlistDecision({ stateDir: root, action: "select", canonicalKey: "local-audio-transcription", now: "2026-01-06T00:00:00.000Z" });
    await appendWishlistDecision({
      stateDir: root,
      action: "retire",
      canonicalKey: "local-audio-transcription",
      note: "Revalidated transcription smoke passed",
      now: "2026-01-07T00:00:00.000Z",
    });
    report = await refreshWishlist({ stateDir: root });
    assert.doesNotMatch(report.report, /# Needs review/);
    assert.match(report.report, /# Retired/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wishlist aliases are exact and reversibly reference merge decisions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-wishlist-alias-"));
  const gap = (capability) => ({
    capability,
    scenario: "Exercise a reusable workflow",
    limitation: "No matching capability was available",
    impact: "degraded",
    workaround: "Manual fallback",
    suggestedFix: "skill",
  });
  try {
    await recordTestGap({ stateDir: root, sessionId: "s", runId: "left", cwd: root, gap: gap("Audio transcript generation") });
    await recordTestGap({ stateDir: root, sessionId: "s", runId: "right", cwd: root, gap: gap("Audio transcription") });
    let report = await refreshWishlist({ stateDir: root });
    assert.equal(report.uniqueGaps, 2);

    const merge = await appendWishlistDecision({
      stateDir: root,
      action: "merge",
      canonicalKey: "audio-transcript-generation",
      targetKey: "audio-transcription",
    });
    report = await refreshWishlist({ stateDir: root });
    assert.equal(report.uniqueGaps, 1);
    assert.ok(report.report.includes(`merge decision \`${merge.decisionId}\``));

    await appendWishlistDecision({ stateDir: root, action: "unmerge", canonicalKey: merge.decisionId });
    report = await refreshWishlist({ stateDir: root });
    assert.equal(report.uniqueGaps, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("merging an observed gap into a retired registry capability surfaces review without reopening", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-wishlist-registry-merge-"));
  const gap = {
    capability: "Rendered page interaction",
    scenario: "Interact with a locally rendered page",
    limitation: "No matching browser interaction capability was available",
    impact: "degraded",
    workaround: "Manual browser interaction",
    suggestedFix: "tool",
  };
  try {
    await recordTestGap({ stateDir: root, sessionId: "s", runId: "r", cwd: root, gap });
    await appendWishlistDecision({
      stateDir: root,
      action: "merge",
      canonicalKey: "rendered-page-interaction",
      targetKey: "local-browser-automation",
    });
    const refreshed = await refreshWishlist({ stateDir: root });
    assert.equal(refreshed.uniqueGaps, 0);
    assert.match(refreshed.report, /# Needs review/);
    assert.match(refreshed.report, /- Status: retired/);
    assert.match(refreshed.report, /Unresolved post-retirement signals: 1/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wishlist issue drafts stay local and archives recover after a prepared operation failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-wishlist-archive-"));
  const gap = {
    capability: "Local audio transcription",
    scenario: "Transcribe a local recording at /private/customer.wav",
    limitation: "No capability at https://private.example was available",
    impact: "degraded",
    workaround: "Manual fallback",
    suggestedFix: "tool",
  };
  try {
    await setCollectionMode({ stateDir: root, mode: "on" });
    await recordTestGap({ stateDir: root, sessionId: "s", runId: "r", cwd: root, gap });
    const draft = await createIssueDraft({ stateDir: root, canonicalKey: "local-audio-transcription" });
    assert.match(draft.markdown, /Local draft only/);
    assert.doesNotMatch(draft.markdown, /private\.example|private\/customer/);

    await assert.rejects(
      () => archiveWishlist({ stateDir: root, now: "2026-04-01T00:00:00.000Z", failAfterPrepared: true }),
      /Injected failure/,
    );
    assert.ok(fs.existsSync(path.join(root, ".tool-wishlist-archive-transaction.json")));
    const refreshed = await refreshWishlist({ stateDir: root, now: "2026-04-01T00:01:00.000Z" });
    assert.equal(refreshed.uniqueGaps, 0);
    assert.equal(readCollectionMode(root), "on");
    assert.equal(fs.existsSync(path.join(root, ".tool-wishlist-salt")), true);
    assert.equal(fs.existsSync(path.join(root, ".tool-wishlist-archive-transaction.json")), false);
    const archives = fs.readdirSync(path.join(root, "tool-wishlist-archives"));
    assert.equal(archives.length, 1);
    assert.ok(fs.existsSync(path.join(root, "tool-wishlist-archives", archives[0], "archive.json")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wishlist extension runs the one-command improvement loop and preserves consent, drafts, reset, and checksums", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-wishlist-extension-"));
  try {
    const result = runWishlistExtensionHarness(path.join(root, "agent"));
    if (!result) {
      const source = fs.readFileSync(path.join(repoRoot, "extensions", "tool-wishlist", "index.ts"), "utf8");
      assert.equal(source.match(/pi\.registerTool\(/g)?.length, 2);
      assert.match(source, /name: "report_capability_gap"/);
      assert.match(source, /name: "finish_harness_improvement"/);
      assert.equal(source.match(/pi\.registerCommand\(/g)?.length, 2);
      assert.match(source, /pi\.registerCommand\("harness-improvement"/);
      assert.match(source, /pi\.registerCommand\("wishlist"/);
      assert.match(source, /salted task, session, and project hashes locally/);
      assert.match(source, /archiveWishlist\(\{ stateDir, reason: action \}\)/);
      return;
    }
    assert.deepEqual(result.toolNames, ["report_capability_gap", "finish_harness_improvement"]);
    assert.deepEqual(result.commandNames, ["harness-improvement", "wishlist"]);
    assert.equal(result.completionToolExposed, true);
    assert.equal(result.lifecycleBypassBlocked, true);
    assert.match(result.consent, /salted task, session, and project hashes locally/);
    assert.equal(result.resetConfirmed, true);
    assert.equal(result.reportStableAfterRevalidation, true);
    assert.match(result.improvementMenu.title, /Choose one harness improvement/);
    assert.match(result.improvementMenu.options[0], /REVIEW · Local browser automation · local-browser-automation/);
    assert.equal(result.legacyCandidate.canonicalKey, "local-browser-automation");
    assert.equal(result.legacyCandidate.reviewNeeded, true);
    assert.match(result.unauthorizedCompletion, /not authorized by \/harness-improvement in the current session/);
    assert.match(result.implementationStarted, /Begin the selected ZenPi harness improvement: local-browser-automation/);
    assert.deepEqual(result.verificationCommands.map((item) => item.args), [
      ["run", "check"],
      ["run", "check"],
      [path.join(root, "agent", "project", "extensions", "browser", "smoke.mjs"), path.join(root, "agent", "zenpi", "browser-runtime")],
    ]);
    assert.equal(result.rawSessionIdPersisted, false);
    assert.equal(result.acceptanceEvidencePersisted, false);
    assert.match(result.failedGate, /repository verification failed/);
    assert.equal(result.selectedAfterFailedGate, true);
    assert.equal(result.issueDraftRendered, true);
    assert.equal(result.checksumsValid, true);
    assert.equal(result.eventsAfterReset, "");
    assert.equal(result.collectionMode, "on");
    assert.equal(result.saltPreserved, true);
    assert.ok(result.notifications.some((item) => item.message.startsWith("Wishlist reset complete.")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wishlist capacity refusal leaves existing data refreshable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-wishlist-capacity-test-"));
  const stateDir = path.join(root, "zenpi");
  const gap = {
    capability: "Local audio transcription",
    scenario: "Exercise an interactive site",
    limitation: "No interactive browser was available",
    impact: "minor",
    workaround: "Manual fallback",
    suggestedFix: "tool",
  };

  try {
    await recordTestGap({
      stateDir,
      sessionId: "session-one",
      runId: "run-one",
      cwd: root,
      gap,
    });
    const eventsPath = path.join(stateDir, "tool-wishlist-events.jsonl");
    const currentBytes = fs.statSync(eventsPath).size;
    await assert.rejects(
      recordTestGap({
        stateDir,
        sessionId: "session-two",
        runId: "run-two",
        cwd: root,
        gap,
        maxEventFileBytes: currentBytes,
      }),
      /reached its .*byte limit/,
    );
    assert.equal(fs.readFileSync(eventsPath, "utf8").trim().split("\n").length, 1);
    assert.equal((await refreshWishlist({ stateDir })).occurrences, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wishlist never reclaims an unverified lock", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-wishlist-lock-test-"));
  const stateDir = path.join(root, "zenpi");
  const lockDir = path.join(stateDir, ".tool-wishlist.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "owner"), "another-process:token\n");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("test cancellation")), 30);

  try {
    await assert.rejects(refreshWishlist({ stateDir, signal: controller.signal }), /test cancellation/);
    assert.equal(fs.readFileSync(path.join(lockDir, "owner"), "utf8"), "another-process:token\n");
  } finally {
    clearTimeout(timer);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wishlist release never removes a substituted lock", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-wishlist-lock-replacement-test-"));
  const stateDir = path.join(root, "zenpi");
  const lockDir = path.join(stateDir, ".tool-wishlist.lock");
  const replacementMarker = path.join(lockDir, "replacement-owner");
  const gap = {
    get capability() {
      fs.rmSync(lockDir, { recursive: true, force: true });
      fs.mkdirSync(lockDir);
      fs.writeFileSync(replacementMarker, "owned\n");
      return "Local audio transcription";
    },
    scenario: "Exercise an interactive site",
    limitation: "No interactive browser was available",
    impact: "minor",
    workaround: "Manual fallback",
    suggestedFix: "tool",
  };

  try {
    await recordTestGap({
      stateDir,
      sessionId: "session-one",
      runId: "run-one",
      cwd: root,
      gap,
    });
    assert.equal(fs.readFileSync(replacementMarker, "utf8"), "owned\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installer plan is non-mutating even when browser installation is planned", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-plan-test-"));
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), '{"kept":true}\n');
  const before = fs.readFileSync(path.join(agentDir, "settings.json"), "utf8");
  try {
    const result = invokeCli(agentDir, ["plan", "--skip-shell"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Playwright 1\.62\.1 \+ matching managed Chromium/);
    assert.match(result.stdout, /salted task\/session\/project hashes/);
    assert.equal(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"), before);
    assert.equal(fs.existsSync(path.join(agentDir, "zenpi")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("plan shows pinned managed optional-tool assets", () => {
  if (process.platform !== "linux" || process.arch !== "x64") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-optional-plan-test-"));
  const agentDir = path.join(root, "agent");
  const fakeBin = path.join(root, "bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  writeExecutable(path.join(fakeBin, "tar"), "#!/bin/sh\nexit 0\n");

  try {
    const result = invokeCli(agentDir, ["plan", "--skip-package-install", "--skip-shell"], { PATH: fakeBin });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /bat-v0\.26\.1-x86_64-unknown-linux-gnu\.tar\.gz/);
    assert.match(result.stdout, /sha256:726f04c8f576a7fd18b7634f1bbf2f915c43494c1c0f013baa3287edb0d5a2a3/);
    assert.match(result.stdout, /delta-0\.19\.2-x86_64-unknown-linux-gnu\.tar\.gz/);
    assert.match(result.stdout, /glow_3\.0\.0_Linux_x86_64\.tar\.gz/);
    assert.equal(fs.existsSync(path.join(agentDir, "zenpi")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("--yes installs each missing optional external tool", () => {
  if (process.platform === "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-optional-tools-test-"));
  const agentDir = path.join(root, "agent");
  const fakeBin = path.join(root, "bin");
  const log = path.join(root, "tools.log");
  fs.mkdirSync(fakeBin, { recursive: true });
  for (const command of ["bat", "delta", "glow"]) {
    writeExecutable(path.join(fakeBin, command), "#!/bin/sh\nexit 0\n");
  }
  writeExecutable(
    path.join(fakeBin, "npm"),
    "#!/bin/sh\nprintf 'npm %s\\n' \"$*\" >> \"$ZENPI_FAKE_LOG\"\nprintf '#!/bin/sh\\nexit 0\\n' > \"$ZENPI_FAKE_BIN/donsetch\"\n/bin/chmod 755 \"$ZENPI_FAKE_BIN/donsetch\"\n",
  );
  const env = {
    PATH: fakeBin,
    ZENPI_FAKE_BIN: fakeBin,
    ZENPI_FAKE_LOG: log,
  };

  try {
    const result = invokeCli(
      agentDir,
      ["install", "--yes", "--skip-package-install", "--skip-shell"],
      env,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.readFileSync(log, "utf8").trim(),
      "npm install --global donsetch@3.4.0 --no-audit --no-fund",
    );
    runCli(agentDir, "uninstall", "--yes");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("optional tool failures warn without blocking the core install", () => {
  if (process.platform === "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-optional-failure-test-"));
  const agentDir = path.join(root, "agent");
  const fakeBin = path.join(root, "bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  writeExecutable(path.join(fakeBin, "npm"), "#!/bin/sh\nexit 8\n");

  try {
    const result = invokeCli(
      agentDir,
      ["install", "--yes", "--skip-package-install", "--skip-shell"],
      { PATH: fakeBin },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Could not install optional tool bat: tar is required/);
    assert.match(result.stderr, /Optional tool DonSeTch failed to install/);
    assert.ok(fs.existsSync(path.join(agentDir, "zenpi", "manifest.json")));
    runCli(agentDir, "uninstall", "--yes");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed optional tool targets reject symlinks before download", () => {
  if (process.platform !== "linux" || process.arch !== "x64") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-optional-symlink-test-"));
  const agentDir = path.join(root, "agent");
  const fakeBin = path.join(root, "bin");
  const outside = path.join(root, "outside");
  const target = path.join(agentDir, "zenpi", "bin", "bat");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(outside, "kept\n");
  fs.symlinkSync(outside, target);
  for (const command of ["delta", "glow", "donsetch", "tar"]) {
    writeExecutable(path.join(fakeBin, command), "#!/bin/sh\nexit 0\n");
  }

  try {
    const result = invokeCli(
      agentDir,
      ["install", "--yes", "--skip-package-install", "--skip-shell"],
      { PATH: fakeBin },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Managed optional tool path must not be a symlink/);
    assert.equal(fs.readFileSync(outside, "utf8"), "kept\n");
    assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
    fs.rmSync(target);
    runCli(agentDir, "uninstall", "--yes");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("later core failure reports external optional tools that remain installed", () => {
  if (process.platform === "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-optional-core-failure-test-"));
  const agentDir = path.join(root, "agent");
  const fakeBin = path.join(root, "bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  for (const command of ["bat", "delta", "glow"]) {
    writeExecutable(path.join(fakeBin, command), "#!/bin/sh\nexit 0\n");
  }
  writeExecutable(
    path.join(fakeBin, "npm"),
    "#!/bin/sh\nprintf '#!/bin/sh\\nexit 0\\n' > \"$ZENPI_FAKE_BIN/donsetch\"\n/bin/chmod 755 \"$ZENPI_FAKE_BIN/donsetch\"\n",
  );
  writeExecutable(
    path.join(fakeBin, "pi"),
    "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 0.84.3; exit 0; fi\nexit 9\n",
  );

  try {
    const result = invokeCli(
      agentDir,
      ["install", "--yes", "--skip-browser-install", "--skip-shell"],
      { PATH: fakeBin, ZENPI_FAKE_BIN: fakeBin },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /External optional tool changes were not rolled back: DonSeTch/);
    assert.equal(fs.existsSync(path.join(agentDir, "zenpi", "manifest.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("uninstall moves modified managed tools outside the trusted bin", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-modified-tool-test-"));
  const agentDir = path.join(root, "agent");
  try {
    runCli(agentDir, "install", "--yes", "--skip-package-install", "--skip-tool-install", "--skip-shell");
    const target = path.join(agentDir, "zenpi", "bin", "bat");
    const marker = path.join(agentDir, "zenpi", "optional-tools", "bat.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(target, "modified\n", { mode: 0o755 });
    fs.writeFileSync(marker, '{}\n');
    const manifestPath = path.join(agentDir, "zenpi", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.managedOptionalTools = [{
      schema: 1,
      tool: "bat",
      version: "0.26.1",
      installedHash: sha256(Buffer.from("original\n")),
      target,
      marker,
    }];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = runCli(agentDir, "uninstall", "--yes");
    assert.match(result.stderr, /Moved modified managed optional tool outside trusted PATH/);
    assert.equal(fs.existsSync(target), false);
    const preservedDir = path.join(agentDir, "zenpi", "preserved-modified-tools");
    const preserved = fs.readdirSync(preservedDir);
    assert.equal(preserved.length, 1);
    assert.equal(fs.readFileSync(path.join(preservedDir, preserved[0]), "utf8"), "modified\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installer rejects an incompatible Pi before mutating configuration", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-pi-version-test-"));
  const agentDir = path.join(root, "agent");
  const fakeBin = path.join(root, "bin");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), '{"kept":true}\n');
  writeExecutable(path.join(fakeBin, "pi"), "#!/bin/sh\necho 0.79.9\n");

  try {
    const result = invokeCli(
      agentDir,
      ["install", "--yes", "--skip-browser-install", "--skip-tool-install", "--skip-shell"],
      { PATH: `${fakeBin}:${process.env.PATH}` },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Pi 0\.80\.0 or newer is required; found 0\.79\.9/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")), { kept: true });
    assert.equal(fs.existsSync(path.join(agentDir, "zenpi")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("install, update, doctor, and uninstall round trip in an isolated agent dir", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-test-"));
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });

  const originalSettings = {
    defaultProvider: "openrouter",
    defaultModel: "example/model",
    packages: ["npm:other@1.0.0", "npm:pi-web-access@0.1.0"],
    subagents: {
      defaultModel: "legacy/provider-model",
      customSetting: true,
    },
  };
  fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify(originalSettings, null, 2)}\n`);
  fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "# Personal instructions\n");
  fs.writeFileSync(path.join(agentDir, "extensions", "zen.ts"), "// personal prior zen\n");

  try {
    runCli(agentDir, "install", "--yes", "--skip-package-install", "--skip-tool-install", "--skip-shell");
    const installed = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(installed.defaultProvider, "openrouter");
    assert.equal(installed.defaultModel, "example/model");
    assert.equal(installed.subagents.defaultModel, undefined);
    assert.deepEqual(installed.subagents.modelScope, {
      enforce: true,
      strict: true,
      allow: ["inherit"],
    });
    assert.equal(installed.subagents.agentOverrides.worker.model, "inherit");
    assert.equal(installed.subagents.agentOverrides["codex-exec"].disabled, true);
    assert.ok(fs.existsSync(path.join(agentDir, "zenpi", "manifest.json")));
    assert.ok(fs.existsSync(path.join(agentDir, "extensions", "tool-wishlist", "index.ts")));
    assert.ok(fs.existsSync(path.join(agentDir, "extensions", "tool-wishlist", "core.mjs")));
    assert.ok(fs.existsSync(path.join(agentDir, "extensions", "tool-wishlist", "registry.mjs")));
    assert.ok(fs.existsSync(path.join(agentDir, "extensions", "tool-wishlist", "capabilities.json")));
    assert.ok(fs.existsSync(path.join(agentDir, "skills", "zenpi-improve", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(agentDir, "extensions", "browser", "index.ts")));
    assert.ok(fs.existsSync(path.join(agentDir, "extensions", "browser", "core.mjs")));
    assert.ok(fs.existsSync(path.join(agentDir, "extensions", "browser", "smoke.mjs")));
    assert.match(fs.readFileSync(path.join(agentDir, "AGENTS.md"), "utf8"), /# Personal instructions/);

    const fakeBin = path.join(root, "bin");
    writeExecutable(path.join(fakeBin, "pi"), "#!/bin/sh\necho 0.84.3\nexit 0\n");
    const doctor = invokeCli(agentDir, ["doctor"], {
      PATH: `${fakeBin}:${process.env.PATH}`,
    });
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.match(doctor.stderr, /Managed browser runtime unavailable: .*installation was skipped/);

    const installedRegistryPath = path.join(agentDir, "extensions", "tool-wishlist", "capabilities.json");
    const installedRegistry = fs.readFileSync(installedRegistryPath);
    fs.writeFileSync(installedRegistryPath, '{"schema":1,"capabilities":[{"id":"Invalid ID","title":"Broken","aliases":[],"shippedVersion":"1","validations":["browser-runtime-smoke"]}]}\n');
    const invalidRegistryDoctor = invokeCli(agentDir, ["doctor"], { PATH: `${fakeBin}:${process.env.PATH}` });
    assert.notEqual(invalidRegistryDoctor.status, 0);
    assert.match(invalidRegistryDoctor.stderr, /Capability registry invalid/);
    fs.writeFileSync(installedRegistryPath, installedRegistry);

    // Simulate ownership retired by a future ZenPi version.
    const retiredFile = path.join(agentDir, "extensions", "retired.ts");
    fs.writeFileSync(retiredFile, "// retired\n");
    const beforeUpdateSettings = JSON.parse(
      fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"),
    );
    beforeUpdateSettings.subagents.retiredFlag = true;
    beforeUpdateSettings.packages.push("npm:retired-zenpi-package@1.0.0");
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify(beforeUpdateSettings, null, 2)}\n`,
    );
    const manifestPath = path.join(agentDir, "zenpi", "manifest.json");
    const beforeUpdateManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    beforeUpdateManifest.settingsChanges.push({
      path: ["subagents", "retiredFlag"],
      beforeExists: false,
      installedExists: true,
      installed: true,
    });
    beforeUpdateManifest.packageChanges.push({
      identity: "npm:retired-zenpi-package",
      beforeExists: false,
      installed: "npm:retired-zenpi-package@1.0.0",
    });
    beforeUpdateManifest.files[retiredFile] = {
      existed: false,
      installedHash: sha256(fs.readFileSync(retiredFile)),
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(beforeUpdateManifest, null, 2)}\n`);

    const update = invokeCli(agentDir, ["update", "--yes", "--skip-package-install", "--skip-tool-install", "--skip-shell"]);
    assert.equal(update.status, 0, update.stderr);
    assert.match(update.stdout, /restart active Pi sessions/);
    const afterUpdate = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(afterUpdate.subagents.retiredFlag, undefined);
    assert.equal(
      afterUpdate.packages.some((entry) => String(entry).includes("retired-zenpi-package")),
      false,
    );
    assert.equal(fs.existsSync(retiredFile), false);

    const retainedWishlist = path.join(agentDir, "zenpi", "tool-wishlist-events.jsonl");
    fs.writeFileSync(retainedWishlist, '{"local":"evidence"}\n', { mode: 0o600 });
    const uninstall = runCli(agentDir, "uninstall", "--yes");
    assert.match(uninstall.stdout, /local wishlist state\/archives were preserved/);
    assert.equal(fs.readFileSync(retainedWishlist, "utf8"), '{"local":"evidence"}\n');

    const restored = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.deepEqual(restored, originalSettings);
    assert.equal(fs.readFileSync(path.join(agentDir, "AGENTS.md"), "utf8"), "# Personal instructions\n");
    assert.equal(
      fs.readFileSync(path.join(agentDir, "extensions", "zen.ts"), "utf8"),
      "// personal prior zen\n",
    );
    assert.equal(fs.existsSync(path.join(agentDir, "extensions", "tool-wishlist", "index.ts")), false);
    assert.equal(fs.existsSync(path.join(agentDir, "extensions", "tool-wishlist", "core.mjs")), false);
    assert.equal(fs.existsSync(path.join(agentDir, "extensions", "tool-wishlist", "registry.mjs")), false);
    assert.equal(fs.existsSync(path.join(agentDir, "extensions", "tool-wishlist", "capabilities.json")), false);
    assert.equal(fs.existsSync(path.join(agentDir, "skills", "zenpi-improve", "SKILL.md")), false);
    assert.equal(fs.existsSync(path.join(agentDir, "extensions", "browser", "index.ts")), false);
    assert.equal(fs.existsSync(path.join(agentDir, "extensions", "browser", "core.mjs")), false);
    assert.equal(fs.existsSync(path.join(agentDir, "zenpi", "manifest.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed browser runtime completes install, reuse update, doctor, and uninstall with fake browser", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-browser-lifecycle-"));
  const agentDir = path.join(root, "agent");
  const fakeBin = path.join(root, "bin");
  writeExecutable(path.join(fakeBin, "pi"), "#!/bin/sh\necho 0.84.3\nexit 0\n");
  installFakeBrowserNpm(fakeBin);
  const env = { PATH: `${fakeBin}:${process.env.PATH}`, SHELL: "/bin/bash" };
  try {
    const install = invokeCli(agentDir, ["install", "--yes", "--skip-tool-install", "--skip-shell"], env);
    assert.equal(install.status, 0, install.stderr);
    const runtime = path.join(agentDir, "zenpi", "browser-runtime");
    assert.ok(fs.existsSync(path.join(runtime, "zenpi-runtime.json")));

    const doctor = invokeCli(agentDir, ["doctor"], env);
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.match(doctor.stdout, /BROWSER Browser smoke passed/);
    assert.match(doctor.stdout, /CAPABILITY local-browser-automation verified by browser-runtime-smoke/);

    const update = invokeCli(agentDir, ["update", "--yes", "--skip-tool-install", "--skip-shell"], env);
    assert.equal(update.status, 0, update.stderr);
    assert.match(update.stdout, /passed its launch smoke; reusing/);

    fs.writeFileSync(path.join(runtime, "node_modules", "playwright", "index.js"), "throw new Error('broken runtime');\n");
    const repaired = invokeCli(agentDir, ["update", "--yes", "--skip-tool-install", "--skip-shell"], env);
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.match(repaired.stderr, /failed validation and will be replaced/);
    const repairedDoctor = invokeCli(agentDir, ["doctor"], env);
    assert.equal(repairedDoctor.status, 0, repairedDoctor.stderr);

    const uninstall = invokeCli(agentDir, ["uninstall", "--yes"], env);
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.equal(fs.existsSync(runtime), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("default package and shell paths work with an isolated fake pi", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-shell-test-"));
  const agentDir = path.join(root, "agent");
  const shellRc = path.join(root, ".bashrc");
  const fakeBin = path.join(root, "bin");
  const log = path.join(root, "pi.log");
  writeExecutable(
    path.join(fakeBin, "pi"),
    "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 0.84.3; exit 0; fi\nprintf '%s\\n' \"$*\" >> \"$ZENPI_FAKE_LOG\"\nexit 0\n",
  );
  fs.writeFileSync(shellRc, "# personal shell\n");
  const env = {
    PATH: `${fakeBin}:${process.env.PATH}`,
    SHELL: "/bin/bash",
    ZENPI_SHELL_RC: shellRc,
    ZENPI_FAKE_LOG: log,
  };

  try {
    const install = invokeCli(agentDir, ["install", "--yes", "--skip-browser-install", "--skip-tool-install"], env);
    assert.equal(install.status, 0, install.stderr);
    const shell = fs.readFileSync(shellRc, "utf8");
    assert.match(shell, /# >>> ZenPi >>>/);
    assert.ok(fs.existsSync(path.join(agentDir, "zenpi", "pi-profiles.sh")));
    const calls = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.equal(calls.filter((line) => line.startsWith("install ")).length, 7);
    assert.ok(calls.some((line) => line.startsWith("--offline --list-models")));

    const update = invokeCli(
      agentDir,
      ["update", "--yes", "--skip-package-install", "--skip-tool-install", "--skip-shell"],
      env,
    );
    assert.equal(update.status, 0, update.stderr);
    assert.ok(fs.existsSync(path.join(agentDir, "zenpi", "pi-profiles.sh")));
    assert.match(fs.readFileSync(shellRc, "utf8"), /# >>> ZenPi >>>/);

    const uninstall = invokeCli(agentDir, ["uninstall", "--yes"], env);
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.equal(fs.readFileSync(shellRc, "utf8"), "# personal shell\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed package installation rolls configuration back and releases the lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-failure-test-"));
  const agentDir = path.join(root, "agent");
  const fakeBin = path.join(root, "bin");
  const settingsPath = path.join(agentDir, "settings.json");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(settingsPath, '{"untouched":true}\n');
  writeExecutable(
    path.join(fakeBin, "pi"),
    "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 0.84.3; exit 0; fi\ncase \"$*\" in *pi-subagents*) exit 9;; esac\nexit 0\n",
  );
  installFakeBrowserNpm(fakeBin);
  const env = { PATH: `${fakeBin}:${process.env.PATH}`, SHELL: "/bin/bash" };

  try {
    const result = invokeCli(agentDir, ["install", "--yes", "--skip-tool-install", "--skip-shell"], env);
    assert.notEqual(result.status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), { untouched: true });
    assert.equal(fs.existsSync(path.join(agentDir, "zenpi", "manifest.json")), false);
    assert.equal(fs.existsSync(path.join(agentDir, "zenpi", "browser-runtime")), false);
    assert.equal(fs.existsSync(path.join(agentDir, "zenpi", "install.lock")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("settings symlinks remain symlinks through install and uninstall", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-symlink-test-"));
  const agentDir = path.join(root, "agent");
  const target = path.join(root, "settings-target.json");
  const link = path.join(agentDir, "settings.json");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(target, '{"kept":true}\n');
  fs.symlinkSync(target, link);

  try {
    runCli(agentDir, "install", "--yes", "--skip-package-install", "--skip-tool-install", "--skip-shell");
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    runCli(agentDir, "uninstall", "--yes");
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { kept: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("empty AGENTS and shell symlink targets remain linked after uninstall", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-block-symlink-test-"));
  const agentDir = path.join(root, "agent");
  const agentsTarget = path.join(root, "AGENTS-target.md");
  const shellTarget = path.join(root, "shell-target.rc");
  const agentsLink = path.join(agentDir, "AGENTS.md");
  const shellLink = path.join(root, ".bashrc");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(agentsTarget, "");
  fs.writeFileSync(shellTarget, "");
  fs.symlinkSync(agentsTarget, agentsLink);
  fs.symlinkSync(shellTarget, shellLink);
  const env = { SHELL: "/bin/bash", ZENPI_SHELL_RC: shellLink };

  try {
    const install = invokeCli(
      agentDir,
      ["install", "--yes", "--skip-package-install", "--skip-tool-install"],
      env,
    );
    assert.equal(install.status, 0, install.stderr);
    const uninstall = invokeCli(agentDir, ["uninstall", "--yes"], env);
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.equal(fs.lstatSync(agentsLink).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(shellLink).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(agentsTarget, "utf8"), "");
    assert.equal(fs.readFileSync(shellTarget, "utf8"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("broken managed-path symlinks fail without leaving a lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenpi-broken-link-test-"));
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.symlinkSync(path.join(root, "missing-settings.json"), path.join(agentDir, "settings.json"));

  try {
    const result = invokeCli(
      agentDir,
      ["install", "--yes", "--skip-package-install", "--skip-tool-install", "--skip-shell"],
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Broken symlink is unsupported/);
    assert.equal(fs.existsSync(path.join(agentDir, "zenpi", "install.lock")), false);
    assert.equal(fs.lstatSync(path.join(agentDir, "settings.json")).isSymbolicLink(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
