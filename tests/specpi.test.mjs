import assert from "node:assert/strict";

import fs from "node:fs";

import os from "node:os";

import path from "node:path";

import { spawnSync } from "node:child_process";

import test from "node:test";

import { fileURLToPath, pathToFileURL } from "node:url";

import { runPiFixture } from "../scripts/pi-test-harness.mjs";

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

import { acquireSpecPiLock } from "../scripts/lock.mjs";

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

const cli = path.join(repoRoot, "scripts", "specpi.mjs");

function installerFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-minimal-install-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const agentDir = path.join(root, "agent");
    const stateDir = path.join(agentDir, "specpi");
    const manifestPath = path.join(stateDir, "manifest.json");

    return { root, agentDir, stateDir, manifestPath };
}

test("minimal installer plan and unconfirmed installation do not mutate the destination", (t) => {
    const { agentDir } = installerFixture(t);
    runCli(agentDir, "plan");
    assert.equal(fs.existsSync(agentDir), false);
    const rejected = invokeCli(agentDir, ["install"]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Confirmation requires a TTY/);
    assert.equal(fs.existsSync(agentDir), false);
});

test("minimal installer completes the lifecycle without changing settings or private state", (t) => {
    const { agentDir, manifestPath } = installerFixture(t);
    fs.mkdirSync(agentDir);
    const canaries = new Map([
        ["settings.json", '{"theme":"user-theme","packages":["npm:user-package@1.0.0"],"defaultProvider":"test"}\n'],
        ["auth.json", "synthetic credential canary\n"],
        ["trust.json", "synthetic trust canary\n"],
        ["sessions/canary", "synthetic session canary\n"],
        ["specpi/wishlist/events.jsonl", "synthetic local evidence\n"],
        ["specpi/browser-runtime/user.txt", "unowned runtime path\n"],
        ["specpi/bin/user-tool", "unowned tool path\n"],
    ]);
    for (const [relative, content] of canaries) {
        const file = path.join(agentDir, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }

    fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "Human guidance\n");
    runCli(agentDir, "install", "--yes");
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    assert.equal(Object.keys(manifest.files).length, 28);
    assert.ok(
        Object.keys(manifest.files).every((file) =>
            /workflow-controls|tool-wishlist|jev-advisor|specpi-improve/.test(file),
        ),
    );
    runCli(agentDir, "doctor");
    const retained = path.join(agentDir, "extensions/workflow-controls/index.ts");
    fs.appendFileSync(retained, "\n// local change\n");
    assert.notEqual(invokeCli(agentDir, ["update", "--yes"]).status, 0);
    assert.notEqual(invokeCli(agentDir, ["doctor"]).status, 0);
    runCli(agentDir, "update", "--yes", "--force");
    runCli(agentDir, "doctor");
    runCli(agentDir, "uninstall", "--yes");
    assert.equal(fs.existsSync(manifestPath), false);
    assert.equal(fs.existsSync(retained), false);
    assert.equal(fs.readFileSync(path.join(agentDir, "AGENTS.md"), "utf8"), "Human guidance\n");
    for (const [relative, content] of canaries) {
        assert.equal(fs.readFileSync(path.join(agentDir, relative), "utf8"), content);
    }
});

test("legacy migration retires modified extras and runtimes with backup, preserves user settings, and rolls back", (t) => {
    const { root, agentDir, stateDir, manifestPath } = installerFixture(t);
    runCli(agentDir, "install", "--yes");
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    const extra = path.join(agentDir, "extensions/delegation/index.ts");
    fs.mkdirSync(path.dirname(extra), { recursive: true });
    fs.writeFileSync(extra, "// local modification of a retired extension\n");
    manifest.files[extra] = { existed: false, installedHash: sha256("// old shipped extension\n") };
    manifest.settingsChanges = [
        {
            path: ["theme"],
            beforeExists: true,
            before: "old-user-theme",
            installedExists: true,
            installed: "specpi-spec",
        },
    ];
    manifest.packageChanges = [
        { identity: "npm:pi-web-access", beforeExists: false, installed: "npm:pi-web-access@0.25.0" },
        { identity: "npm:user-modified", beforeExists: false, installed: "npm:user-modified@1.0.0" },
    ];
    manifest.packagesKeyBeforeExists = false;
    manifest.structuralRuntime = { installed: true };
    const settingsPath = path.join(agentDir, "settings.json");
    fs.writeFileSync(
        settingsPath,
        JSON.stringify({
            theme: "specpi-spec",
            packages: ["npm:pi-web-access@0.25.0", "npm:user-modified@2.0.0", "npm:unrelated"],
            unrelated: true,
        }),
    );
    const shellPath = path.join(root, "shellrc");
    fs.writeFileSync(shellPath, "before\n\n# >>> SpecPi >>>\nold integration\n# <<< SpecPi <<<\n\nafter\n");
    manifest.shellRc = shellPath;
    manifest.blockFiles.shell = { existed: true };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const runtime = path.join(stateDir, "structural-runtime");
    fs.mkdirSync(runtime);
    fs.writeFileSync(path.join(runtime, "modified-runtime.txt"), "local runtime bytes");
    const observed = [manifestPath, settingsPath, shellPath, extra, ...Object.keys(manifest.files)];
    const original = new Map(observed.map((file) => [file, fs.readFileSync(file)]));
    for (const point of ["after-settings", "after-first-managed-file", "after-retirement", "after-manifest"]) {
        const failed = invokeCli(agentDir, ["update", "--yes"], { SPECPI_TESTING: "1", SPECPI_TEST_FAIL_POINT: point });
        assert.notEqual(failed.status, 0, point);
        assert.match(failed.stderr, /rolled back/);
        for (const [file, content] of original) {
            assert.deepEqual(fs.readFileSync(file), content, `${point}: ${file}`);
        }

        assert.equal(fs.readFileSync(path.join(runtime, "modified-runtime.txt"), "utf8"), "local runtime bytes");
    }

    runCli(agentDir, "update", "--yes");
    assert.equal(fs.existsSync(extra), false);
    assert.equal(fs.existsSync(runtime), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath)), {
        theme: "old-user-theme",
        packages: ["npm:user-modified@2.0.0", "npm:unrelated"],
        unrelated: true,
    });
    assert.equal(fs.readFileSync(shellPath, "utf8").trimEnd(), "before\n\nafter");
    const updated = JSON.parse(fs.readFileSync(manifestPath));
    const backup = path.join(stateDir, updated.backups.at(-1));
    assert.equal(
        fs.readFileSync(path.join(backup, "structural-runtime/modified-runtime.txt"), "utf8"),
        "local runtime bytes",
    );
    const inventory = JSON.parse(fs.readFileSync(path.join(backup, "inventory.json")));
    const record = inventory.find((entry) => entry.target === extra);
    assert.deepEqual(fs.readFileSync(path.join(backup, record.file)), original.get(extra));
    runCli(agentDir, "doctor");
    runCli(agentDir, "uninstall", "--yes");
});

test("installer rejects manifest paths outside the managed resource inventory before mutation", (t) => {
    const { root, agentDir, manifestPath } = installerFixture(t);
    runCli(agentDir, "install", "--yes");
    const protectedFile = path.join(root, "outside.txt");
    fs.writeFileSync(protectedFile, "keep");
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    manifest.files[protectedFile] = { existed: false, installedHash: sha256("keep") };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const rejected = invokeCli(agentDir, ["update", "--yes"]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /outside its expected directory/);
    assert.equal(fs.readFileSync(protectedFile, "utf8"), "keep");
});

test("migration preserves a removed or non-array package setting", (t) => {
    const { agentDir, manifestPath } = installerFixture(t);
    runCli(agentDir, "install", "--yes");
    for (const settings of [{ unrelated: true }, { packages: { userValue: true }, unrelated: true }]) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath));
        manifest.packageChanges = [
            { identity: "npm:pi-web-access", beforeExists: false, installed: "npm:pi-web-access@0.25.0" },
        ];
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        const settingsPath = path.join(agentDir, "settings.json");
        fs.writeFileSync(settingsPath, JSON.stringify(settings));
        runCli(agentDir, "update", "--yes");
        assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath)), settings);
    }
});

function invokeCli(agentDir, args, extraEnv = {}) {
    return spawnSync(process.execPath, [cli, ...args, "--skip-package-install"], {
        cwd: repoRoot,
        env: { ...process.env, ...extraEnv, PI_CODING_AGENT_DIR: agentDir },
        encoding: "utf8",
    });
}

function runCli(agentDir, ...args) {
    const result = invokeCli(agentDir, args);
    if (result.status !== 0) {
        throw new Error(`specpi ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }

    return result;
}

async function recordTestGap(options) {
    if (readCollectionMode(options.stateDir) !== "on") {
        await setCollectionMode({ stateDir: options.stateDir, mode: "on" });
    }

    return recordCapabilityGap(options);
}

function runWishlistExtensionHarness(agentDir) {
    const harness = path.join(repoRoot, "tests", "fixtures", "wishlist-extension-harness.ts");
    fs.mkdirSync(agentDir, { recursive: true });
    const result = runPiFixture(harness, { agentDir, cwd: repoRoot });
    if (result.unavailable) {
        return undefined;
    }

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(`wishlist extension harness failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }

    const output = `${result.stdout}\n${result.stderr}`;
    const marker = output.split("\n").find((line) => line.startsWith("SPECPI_WISHLIST_HARNESS="));
    if (!marker) {
        throw new Error(`wishlist extension harness result missing\n${output}`);
    }

    return JSON.parse(marker.slice("SPECPI_WISHLIST_HARNESS=".length));
}

test("npm package identities ignore pinned versions", () => {
    assert.equal(packageIdentity("npm:pi-web-access@0.25.0"), "npm:pi-web-access");
    assert.equal(packageIdentity("npm:@scope/example@1.2.3"), "npm:@scope/example");
    assert.equal(packageIdentity({ source: "npm:@scope/example" }), "npm:@scope/example");
});

test("package merge replaces matching identities and preserves unrelated entries", () => {
    const existing = ["npm:other@1.0.0", { source: "npm:pi-web-access@0.1.0", skills: [] }];
    assert.deepEqual(mergePackages(existing, ["npm:pi-web-access@0.25.0"]), [
        "npm:other@1.0.0",
        "npm:pi-web-access@0.25.0",
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

test("shared SpecPi lock fails closed and release preserves a substituted lock", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-lock-"));
    const agentDir = path.join(root, "agent");
    const lockPath = path.join(agentDir, "specpi", "install.lock");
    try {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, "malformed\n");
        assert.throws(() => acquireSpecPiLock(agentDir), /malformed/);
        fs.rmSync(lockPath);
        const release = acquireSpecPiLock(agentDir);
        fs.writeFileSync(lockPath, '{"pid":999999,"token":"replacement"}\n');
        release();
        assert.equal(fs.existsSync(lockPath), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("platform launchers invoke Node directly", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const windowsLauncher = fs.readFileSync(path.join(repoRoot, "specpi.cmd"), "utf8");
    assert.equal(manifest.bin.specpi, "./scripts/specpi.mjs");
    assert.match(windowsLauncher, /node "%~dp0scripts\\specpi\.mjs" %\*/i);
    assert.ok(fs.readFileSync(path.join(repoRoot, "specpi"), "utf8").startsWith("#!/usr/bin/env sh\n"));
});

test("release order guard classifies SemVer and rejects dist-tag regressions", () => {
    const script = path.join(repoRoot, "scripts", "check-release-order.mjs");
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    for (const [version, expectedTag] of [
        ["0.10.0", "latest"],
        ["0.10.0+build-foo", "latest"],
        ["0.10.0-next.1", "next"],
    ]) {
        const tagged = run("tag", version);
        assert.equal(tagged.status, 0, tagged.stderr);
        assert.equal(tagged.stdout.trim(), expectedTag);
    }

    for (const [candidate, current] of [
        ["0.10.0", "0.9.9"],
        ["0.10.0", "0.10.0-next.9"],
        ["0.10.0-next.10", "0.10.0-next.2"],
        ["0.10.0-next.9007199254740993", "0.10.0-next.9007199254740992"],
        ["9007199254740993.0.0", "9007199254740992.999999999999999999999.999999999999999999999"],
        ["0.10.0-rc.1", "0.10.0-beta.9"],
    ]) {
        const newer = run("advance", candidate, current);
        assert.equal(newer.status, 0, newer.stderr);
        assert.match(newer.stdout, /advances its dist-tag/);
    }

    for (const [candidate, current] of [
        ["0.10.0", "0.10.0"],
        ["0.9.9", "0.10.0"],
        ["0.10.0-next.1", "0.10.0-next.2"],
        ["0.10.0+build.2", "0.10.0+build.1"],
        ["0.10.0-next.01", "0.10.0-next.0"],
    ]) {
        const rejected = run("advance", candidate, current);
        assert.notEqual(rejected.status, 0, `${candidate} should not advance ${current}`);
    }
});

test("npm release metadata, docs, and protected workflow stay aligned", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
    const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
    const publish = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "npm-publish.yml"), "utf8");
    const releaseRunbook = fs.readFileSync(path.join(repoRoot, "NPM_RELEASE.md"), "utf8");
    const ci = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");

    assert.equal(manifest.publishConfig.access, "public");
    assert.equal(manifest.publishConfig.provenance, true);
    assert.equal(manifest.scripts.preinstall, undefined);
    assert.equal(manifest.scripts.install, undefined);
    assert.equal(manifest.scripts.postinstall, undefined);
    assert.match(readme, /npm install --global specpi@latest/);
    assert.match(readme, /\[Release notes\]\(CHANGELOG\.md\)/);
    assert.match(changelog, new RegExp(`^## ${manifest.version.replaceAll(".", "\\.")} - \\d{4}-\\d{2}-\\d{2}$`, "m"));
    assert.match(publish, /release:\s*\n\s*types: \[published\]/);
    assert.match(publish, /environment: npm/);
    assert.match(publish, /concurrency:\s*\n\s*group: npm-publish\s*\n\s*cancel-in-progress: false/);
    assert.match(publish, /RELEASE_NPM_VERSION: "11\.19\.1"/);
    assert.equal(publish.match(/npm@\$\{RELEASE_NPM_VERSION\}/g)?.length, 3);
    assert.match(publish, /NPM_CONFIG_REGISTRY: "https:\/\/registry\.npmjs\.org"/);
    assert.doesNotMatch(publish, /^\s+registry-url:/m);
    assert.match(publish, /id-token: write/);
    assert.match(publish, /npm publish --dry-run --ignore-scripts --provenance=false/);
    assert.match(publish, /npm publish --ignore-scripts --access public --provenance/);
    assert.match(publish, /TARBALL="\$\{GITHUB_WORKSPACE\}\/dist\/specpi-\$\{VERSION\}\.tgz"/);
    assert.equal(publish.match(/node scripts\/verify-artifact\.mjs/g)?.length, 2);
    assert.match(publish, /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
    assert.match(publish, /--artifact "\$\{TARBALL\}" --manifest "\$\{MANIFEST\}"/);
    assert.match(publish, /check:pi-package -- --artifact "\$\{TARBALL\}"/);
    assert.match(publish, /check-release-order\.mjs tag "\$\{VERSION\}"/);
    assert.match(publish, /check-release-order\.mjs advance "\$\{VERSION\}" "\$\{LOOKUP\}"/);
    assert.match(publish, /dist\.attestations\.url/);
    assert.doesNotMatch(publish, /NODE_AUTH_TOKEN|secrets\.|uses: actions\/[^\s]+@v\d/);
    assert.match(releaseRunbook, /--provenance=false/);
    assert.match(releaseRunbook, /Do not publish a GitHub Release for that same bootstrap version/);
    assert.match(releaseRunbook, /Publication is a post-merge operation/);
    assert.match(releaseRunbook, /never publish from an unmerged commit/);
    assert.match(ci, /os: \[windows-latest, macos-latest\]/);
    assert.equal(ci.match(/npm run check:package/g)?.length, 1);
    assert.equal(ci.match(/npm run check:pi-package/g)?.length, 2);
});

test("capability keys and registry validation are exact", () => {
    assert.equal(normalizeCapability("Missing Browser Automation Tools"), "browser-automation");
    assert.equal(normalizeCapability("browser automations"), "browser-automation");
    assert.equal(isImplementedCapability("Scope drift monitoring"), true);
    assert.equal(isImplementedCapability("Local browser automation"), false);
    assert.equal(isImplementedCapability("Browser automation with persisted authentication"), false);
    assert.throws(
        () =>
            validateCapabilityRegistry({
                schema: 1,
                capabilities: [
                    {
                        id: "browser-automation",
                        title: "Browser automation",
                        aliases: ["shared-alias"],
                        shippedVersion: "1.0.0",
                        shippedAt: "2026-01-01T00:00:00.000Z",
                        validations: ["scope-drift-monitor-smoke"],
                    },
                    {
                        id: "visual-regression",
                        title: "Visual regression",
                        aliases: ["shared-alias"],
                        shippedVersion: "1.0.0",
                        shippedAt: "2026-01-01T00:00:00.000Z",
                        validations: ["scope-drift-monitor-smoke"],
                    },
                ],
            }),
        /duplicate or invalid capability alias/,
    );
    assert.throws(
        () =>
            validateCapabilityRegistry({
                schema: 1,
                capabilities: [
                    {
                        id: "browser-automation",
                        title: "Browser automation",
                        aliases: [],
                        shippedVersion: "1.0.0",
                        shippedAt: "2026-01-01T00:00:00.000Z",
                        validations: ["shell-command"],
                    },
                ],
            }),
        /invalid capability entry/,
    );
});

test("tool wishlist deduplicates a gap per task and stores privacy-minimized metrics", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-wishlist-test-"));
    const stateDir = path.join(root, "specpi");
    const gap = {
        capability: "Local audio transcription",
        scenario: "Interact with src/private/customer.ts in a dynamic web application\nwithout a browser interface",
        limitation:
            "Static fetching at https://private.example/token with Authorization: Bearer eyJheader123.eyJpayload123.signature could not complete the interactive flow",
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
        assert.doesNotMatch(
            eventText,
            /private\.example|private\/fallback|private\/customer|sk-secretvalue123|eyJheader123/,
        );
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-wishlist-refresh-test-"));
    const stateDir = path.join(root, "specpi");
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
        canonicalKey: "scope-drift-monitoring",
        runHash: "implemented-run-hash",
        capability: "Scope drift monitoring",
    };
    const localAutomationEvent = {
        ...implementedEvent,
        canonicalKey: "scope-drift-monitor",
        runHash: "local-automation-run-hash",
        capability: "Scope drift monitor",
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
        assert.doesNotMatch(refreshed.report, /## Scope drift monitoring/);
        assert.doesNotMatch(refreshed.report, /## Scope drift monitor/);
        assert.match(refreshed.report, /# Retired/);
        assert.equal(refreshed.report, fs.readFileSync(path.join(stateDir, "TOOL_WISHLIST.md"), "utf8"));

        const eventHistory = fs.readFileSync(eventsPath, "utf8");
        const resolved = await recordTestGap({
            stateDir,
            sessionId: "session-two",
            runId: "run-two",
            cwd: root,
            gap: {
                capability: "Scope drift monitoring",
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
                capability: "Scope drift monitor",
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
        {
            ...base,
            canonicalKey: "beta",
            runHash: "b2",
            projectHash: "project-2",
            timestamp: "2026-01-01T00:00:00.000Z",
            impact: "minor",
        },
        { ...base, canonicalKey: "alpha", runHash: "a2", timestamp: "2026-02-01T00:00:00.000Z", impact: "minor" },
    ];
    const ranked = aggregateEvents(events);
    assert.equal(ranked[0].canonicalKey, "beta");
    assert.equal(ranked[0].projects, 2);

    const sameTaskAfterMerge = aggregateEvents(
        [
            {
                ...base,
                observedKey: "left-gap",
                canonicalKey: "left-gap",
                runHash: "same",
                timestamp: "2026-03-01T00:00:00.000Z",
                impact: "minor",
            },
            {
                ...base,
                observedKey: "right-gap",
                canonicalKey: "right-gap",
                runHash: "same",
                timestamp: "2026-03-02T00:00:00.000Z",
                impact: "blocked",
            },
        ],
        {
            decisions: [
                {
                    schema: 1,
                    id: "merge-1",
                    timestamp: "2026-03-03T00:00:00.000Z",
                    action: "merge",
                    canonicalKey: "left-gap",
                    targetKey: "right-gap",
                    reverses: "",
                    note: "",
                },
            ],
        },
    );
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-wishlist-next-"));
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-wishlist-consent-"));
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-wishlist-lifecycle-"));
    const gap = {
        capability: "Local audio transcription",
        scenario: "Transcribe a local recording",
        limitation: "No local transcription capability was available",
        impact: "blocked",
        workaround: "Manual transcription",
        suggestedFix: "tool",
    };
    try {
        await recordTestGap({
            stateDir: root,
            sessionId: "s1",
            runId: "r1",
            cwd: root,
            gap,
            now: "2026-01-01T00:00:00.000Z",
        });
        await appendWishlistDecision({
            stateDir: root,
            action: "select",
            canonicalKey: "local-audio-transcription",
            now: "2026-01-02T00:00:00.000Z",
        });
        await assert.rejects(
            () =>
                appendWishlistDecision({ stateDir: root, action: "retire", canonicalKey: "local-audio-transcription" }),
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

        const regression = await recordTestGap({
            stateDir: root,
            sessionId: "s2",
            runId: "r2",
            cwd: root,
            gap,
            now: "2026-01-04T00:00:00.000Z",
        });
        assert.equal(regression.regression, true);
        report = await refreshWishlist({ stateDir: root });
        assert.equal(regression.uniqueGaps, 0);
        assert.equal(regression.reviewNeeded, true);
        assert.match(report.report, /# Needs review/);
        assert.match(report.report, /Unresolved post-retirement signals: 1/);
        assert.match(report.report, /- Status: retired/);

        await appendWishlistDecision({
            stateDir: root,
            action: "reopen",
            canonicalKey: "local-audio-transcription",
            now: "2026-01-05T00:00:00.000Z",
        });
        report = await refreshWishlist({ stateDir: root });
        assert.match(report.report, /- Status: open/);
        assert.doesNotMatch(report.report, /# Needs review/);

        await appendWishlistDecision({
            stateDir: root,
            action: "select",
            canonicalKey: "local-audio-transcription",
            now: "2026-01-06T00:00:00.000Z",
        });
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-wishlist-alias-"));
    const gap = (capability) => ({
        capability,
        scenario: "Exercise a reusable workflow",
        limitation: "No matching capability was available",
        impact: "degraded",
        workaround: "Manual fallback",
        suggestedFix: "skill",
    });
    try {
        await recordTestGap({
            stateDir: root,
            sessionId: "s",
            runId: "left",
            cwd: root,
            gap: gap("Audio transcript generation"),
        });
        await recordTestGap({
            stateDir: root,
            sessionId: "s",
            runId: "right",
            cwd: root,
            gap: gap("Audio transcription"),
        });
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-wishlist-registry-merge-"));
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
            targetKey: "scope-drift-monitor",
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-wishlist-archive-"));
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

test("wishlist extension runs the one-command improvement loop and preserves consent, drafts, reset, and checksums", (context) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-wishlist-extension-")));
    try {
        const result = runWishlistExtensionHarness(path.join(root, "agent"));
        if (!result) {
            context.skip("Pi is not available for the wishlist extension harness");

            return;
        }

        assert.deepEqual(result.toolNames, [
            "report_capability_gap",
            "record_harness_contract",
            "finish_harness_improvement",
        ]);
        assert.deepEqual(result.commandNames, ["harness-improvement", "wishlist"]);
        assert.equal(result.completionToolExposed, true);
        assert.equal(result.lifecycleBypassBlocked, true);
        assert.match(result.consent, /salted task, session, and project hashes locally/);
        assert.equal(result.resetConfirmed, true);
        assert.equal(result.reportStableAfterRetirement, true);
        assert.match(result.improvementMenu.title, /Choose one harness improvement/);
        assert.match(result.improvementMenu.options[0], /REVIEW · Scope drift monitor · scope-drift-monitor/);
        assert.match(result.reopenMenu.options[0], /REVIEW · Scope drift monitor · scope-drift-monitor/);
        assert.match(result.unauthorizedCompletion, /not authorized by \/harness-improvement in the current session/);
        assert.match(
            result.implementationStarted,
            /Begin the selected SpecPi harness improvement: scope-drift-monitor/,
        );
        const commands = result.verificationCommands.map((item) => item.args);
        const validatorInvocation = [
            path.join(root, "agent", "project", "extensions", "tool-wishlist", "validators.mjs"),
            "scope-drift-monitor-smoke",
            "--state-dir",
            path.join(root, "agent", "specpi"),
            "--cwd",
            path.join(root, "agent", "project"),
        ];
        const checks = commands.filter((args) => args[0] === "run");
        assert.ok(checks.length >= 3, "the failure, retry, and successful completion must execute repository checks");
        for (const args of checks) {
            assert.deepEqual(args, ["run", "check"]);
        }

        const validators = commands.filter((args) => args[0] === validatorInvocation[0]);
        assert.ok(validators.length >= 2, "the failing and successful validators must both execute");
        for (const args of validators) {
            assert.deepEqual(args, validatorInvocation);
        }

        const logs = commands.filter((args) => args[0] === "log");
        assert.ok(logs.length > 0, "reopening must collect bounded local change context");
        for (const args of logs) {
            assert.match(args[1], /^--since=/);
            assert.deepEqual(args.slice(2), ["--format=%h %s", "-8"]);
        }

        assert.equal(result.journalPersisted, true);
        assert.equal(result.contractRecorded, true);
        assert.equal(result.reportPathRenderingSafe, true);
        assert.equal(result.receiptPersisted, true);
        assert.deepEqual(result.journalChangedFiles, [
            "README.md",
            "extensions/tool-wishlist/core.mjs",
            "tests/new.test.mjs",
        ]);
        assert.equal(result.rawSessionIdPersisted, false);
        assert.match(result.failedGate, /repository verification failed/);
        assert.equal(result.selectedAfterFailedGate, true);
        assert.match(
            result.failedValidatorGate,
            /Capability validator scope-drift-monitor-smoke failed[\s\S]*validator exploded/,
        );
        assert.equal(result.selectedAfterFailedValidator, true);
        assert.match(result.reopenPrompt, /Begin the selected SpecPi harness improvement: scope-drift-monitor/);
        assert.match(
            result.reopenPrompt,
            /Original proof from the improvement journal:\n- Browser interaction and visual comparison smoke passed/,
        );
        assert.match(
            result.reopenPrompt,
            /Files touched by the original change:\n- README\.md\n- extensions\/tool-wishlist\/core\.mjs/,
        );
        assert.match(
            result.reopenPrompt,
            /Changed since the retirement \(untrusted, sanitized Git metadata\):\n- abc1234 Fixed the thing/,
        );
        assert.equal(result.gitMetadataSanitizedAndBounded, true);
        assert.equal(result.reopenLinkPersisted, true);
        assert.equal(result.reopenEvidenceIncludesWindow, true);
        assert.equal(result.historyEntryRendered, true);
        assert.equal(result.evidenceRenderedInHistory, true);
        assert.match(result.statusMetrics, /retirements 1, reopen rate 100%, open reviews 0/);
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-wishlist-capacity-test-"));
    const stateDir = path.join(root, "specpi");
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-wishlist-lock-test-"));
    const stateDir = path.join(root, "specpi");
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-wishlist-lock-replacement-test-"));
    const stateDir = path.join(root, "specpi");
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
