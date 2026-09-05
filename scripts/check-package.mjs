#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const npmCli = process.env.npm_execpath;
const artifactIndex = process.argv.indexOf("--artifact");
const manifestIndex = process.argv.indexOf("--manifest");
const artifactPath = artifactIndex >= 0 ? process.argv[artifactIndex + 1] : undefined;
const artifactManifestPath = manifestIndex >= 0 ? process.argv[manifestIndex + 1] : undefined;
const hasArtifact = artifactIndex >= 0;
const hasManifest = manifestIndex >= 0;

if (
    hasArtifact !== hasManifest ||
    (hasArtifact && (!artifactPath || !artifactManifestPath)) ||
    (!hasArtifact && process.argv.length > 2)
) {
    throw new Error("Use no arguments, or supply --artifact <tarball> and --manifest <npm-pack.json> together");
}

if (!npmCli || !fs.existsSync(npmCli)) {
    throw new Error("Run package validation through npm so npm_execpath identifies the active npm CLI");
}

const requiredFiles = [
    "CHANGELOG.md",
    "LICENSE",
    "NPM_RELEASE.md",
    "README.md",
    "SECURITY.md",
    "SECURITY_MODEL.md",
    "THIRD_PARTY.md",
    "browser-runtime/package-lock.json",
    "browser-runtime/package.json",
    "docs/delegation/README.md",
    "docs/delegation/design.md",
    "docs/delegation/design-protocol.md",
    "docs/delegation/evaluation.md",
    "docs/delegation/protocol.md",
    "docs/delegation/research.md",
    "extensions/browser/core.mjs",
    "extensions/browser/index.ts",
    "extensions/browser/smoke.mjs",
    "extensions/command-guard/bash.mjs",
    "extensions/command-guard/cmd.mjs",
    "extensions/command-guard/core.mjs",
    "extensions/command-guard/index.ts",
    "extensions/command-guard/managed-files.mjs",
    "extensions/command-guard/paths.mjs",
    "extensions/command-guard/powershell-parser.ps1",
    "extensions/command-guard/powershell.mjs",
    "extensions/command-guard/redact.mjs",
    "extensions/command-guard/rules.mjs",
    "extensions/command-guard/smoke.mjs",
    "extensions/files/core.mjs",
    "extensions/delegation/core.mjs",
    "extensions/delegation/extension.mjs",
    "extensions/delegation/index.ts",
    "extensions/delegation/native.mjs",
    "extensions/delegation/protocol.mjs",
    "extensions/delegation/provider.mjs",
    "extensions/delegation/snapshot.mjs",
    "extensions/delegation/worker.mjs",
    "extensions/files/index.ts",
    "extensions/spec.ts",
    "extensions/spec/core.mjs",
    "extensions/tool-wishlist/capabilities.json",
    "extensions/tool-wishlist/core.mjs",
    "extensions/tool-wishlist/index.ts",
    "extensions/tool-wishlist/registry.mjs",
    "extensions/tool-wishlist/validators.mjs",
    "extensions/tool-wishlist/verification.mjs",
    "extensions/ui-refresh/index.ts",
    "extensions/workflow-controls/challenge.mjs",
    "extensions/workflow-controls/experiments.mjs",
    "extensions/workflow-controls/index.ts",
    "extensions/workflow-controls/scope.mjs",
    "extensions/workflow-controls/smoke.mjs",
    "extensions/workflow-controls/task-contract.mjs",
    "package.json",
    "scripts/check-package.mjs",
    "scripts/check-pi-package.mjs",
    "scripts/check-release-order.mjs",
    "scripts/lib.mjs",
    "scripts/lock.mjs",
    "scripts/pi-test-harness.mjs",
    "scripts/specpi.mjs",
    "scripts/verify-artifact.mjs",
    "shell/pi-profiles.sh",
    "site/logo.svg",
    "site/self-improvement-loop-v2.svg",
    "skills/donsetch/SKILL.md",
    "skills/specpi-improve/SKILL.md",
    "specpi",
    "specpi.cmd",
    "templates/AGENTS.md",
    "templates/settings.json",
    "themes/specpi-spec.json",
    "themes/tea-house.json",
];

const hostPeerPackages = [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
];

const forbiddenPrefixes = [
    ".git/",
    ".github/",
    ".pi/",
    "design/",
    "node_modules/",
    "tests/",
    "browser-runtime/node_modules/",
];

function runNode(args, options = {}) {
    const result = spawnSync(process.execPath, args, {
        cwd: options.cwd || repoRoot,
        env: options.env || process.env,
        encoding: "utf8",
        windowsHide: true,
        timeout: options.timeout || 180_000,
        maxBuffer: 20 * 1024 * 1024,
    });
    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(
            `${process.execPath} ${args.join(" ")} failed (${result.status})\n${result.stdout || ""}${result.stderr || ""}`,
        );
    }

    return result;
}

function runNpm(args, options = {}) {
    return runNode([npmCli, ...args], options);
}

function quoteWindowsCommandArg(value) {
    const text = String(value);
    if (text.includes("%")) {
        throw new Error(`cmd.exe expands "%" on its command line and cannot receive this argument safely: ${text}`);
    }

    return `"${text.replaceAll('"', '""')}"`;
}

function runInstalledBin(binPath, args, options = {}) {
    const common = {
        cwd: options.cwd || repoRoot,
        env: options.env || process.env,
        encoding: "utf8",
        windowsHide: true,
        timeout: options.timeout || 180_000,
        maxBuffer: 20 * 1024 * 1024,
    };
    const result =
        process.platform === "win32"
            ? spawnSync([binPath, ...args].map(quoteWindowsCommandArg).join(" "), {
                  ...common,
                  shell: process.env.ComSpec || "cmd.exe",
              })
            : spawnSync(binPath, args, common);
    if (result.error) {
        throw result.error;
    }

    if (options.expectFailure) {
        assert.notEqual(result.status, 0, `installed SpecPi bin ${args.join(" ")} unexpectedly succeeded`);
    } else if (result.status !== 0) {
        throw new Error(
            `installed SpecPi bin ${args.join(" ")} failed (${result.status})\n${result.stdout || ""}${result.stderr || ""}`,
        );
    }

    return result;
}

function snapshotTree(root, ignoredPrefixes = []) {
    const snapshot = {};
    const visit = (directory, relativeDirectory = "") => {
        for (const entry of fs
            .readdirSync(directory, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name))) {
            const relativePath = path.posix.join(relativeDirectory.replaceAll("\\", "/"), entry.name);
            if (ignoredPrefixes.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`))) {
                continue;
            }

            const absolutePath = path.join(directory, entry.name);
            const stats = fs.lstatSync(absolutePath);
            if (stats.isDirectory()) {
                snapshot[relativePath] = { type: "directory" };
                visit(absolutePath, relativePath);
            } else if (stats.isSymbolicLink()) {
                snapshot[relativePath] = { type: "symlink", target: fs.readlinkSync(absolutePath) };
            } else if (stats.isFile()) {
                snapshot[relativePath] = { type: "file", data: fs.readFileSync(absolutePath).toString("base64") };
            } else {
                snapshot[relativePath] = { type: "other" };
            }
        }
    };

    visit(root);

    return snapshot;
}

function packageRootForPrefix(prefix, env) {
    const root = runNpm(["root", "--global", "--prefix", prefix], { env }).stdout.trim();
    assert.ok(root, "npm did not report a global package root");

    return path.join(root, "specpi");
}

function writeFakePi(directory) {
    fs.mkdirSync(directory, { recursive: true });
    if (process.platform === "win32") {
        fs.writeFileSync(
            path.join(directory, "pi.cmd"),
            '@echo off\r\nif "%~1"=="--version" (echo 0.84.4& exit /b 0)\r\nexit /b 0\r\n',
        );
    } else {
        const target = path.join(directory, "pi");
        fs.writeFileSync(target, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.84.4; fi\nexit 0\n');
        fs.chmodSync(target, 0o755);
    }
}

function assertPackageMetadata(packageJson) {
    assert.equal(packageJson.name, "specpi");
    assert.match(packageJson.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    assert.equal(packageJson.license, "MIT");
    assert.equal(packageJson.author, "Tanner Middleton");
    assert.equal(packageJson.repository?.url, "git+https://github.com/TannerMidd/SpecPi.git");
    assert.equal(packageJson.bugs?.url, "https://github.com/TannerMidd/SpecPi/issues");
    assert.equal(packageJson.homepage, "https://github.com/TannerMidd/SpecPi#readme");
    assert.equal(packageJson.engines?.node, ">=22.19.0");
    assert.equal(packageJson.bin?.specpi, "./scripts/specpi.mjs");
    assert.ok(packageJson.keywords?.includes("pi-package"));
    assert.deepEqual(packageJson.pi, {
        extensions: ["./extensions"],
        skills: ["./skills"],
        themes: ["./themes"],
    });
    assert.equal(packageJson.publishConfig?.access, "public");
    assert.equal(packageJson.publishConfig?.provenance, true);
    assert.equal(packageJson.scripts?.preinstall, undefined);
    assert.equal(packageJson.scripts?.install, undefined);
    assert.equal(packageJson.scripts?.postinstall, undefined);
    assert.deepEqual(Object.keys(packageJson.dependencies || {}), []);
    assert.deepEqual(Object.keys(packageJson.optionalDependencies || {}), []);

    assert.deepEqual(Object.keys(packageJson.peerDependencies || {}).sort(), hostPeerPackages);
    for (const peer of hostPeerPackages) {
        assert.equal(packageJson.peerDependencies[peer], "*");
        assert.equal(packageJson.peerDependenciesMeta?.[peer]?.optional, true);
    }
}

function assertArtifactMatchesManifest(tarball, packResult) {
    const bytes = fs.readFileSync(tarball);
    assert.equal(fs.statSync(tarball).size, packResult.size, "artifact size differs from its npm manifest");
    assert.equal(
        createHash("sha1").update(bytes).digest("hex"),
        packResult.shasum,
        "artifact SHA-1 differs from its npm manifest",
    );
    assert.equal(
        `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        packResult.integrity,
        "artifact integrity differs from its npm manifest",
    );
}

function assertPackageFiles(packResult) {
    const entries = new Map(packResult.files.map((entry) => [entry.path.replaceAll("\\", "/"), entry]));
    assert.deepEqual(
        [...entries.keys()].sort(),
        [...requiredFiles].sort(),
        "packed artifact file manifest differs from the reviewed allow-list",
    );

    const forbidden = [...entries.keys()].filter(
        (file) =>
            forbiddenPrefixes.some((prefix) => file === prefix.slice(0, -1) || file.startsWith(prefix)) ||
            file.endsWith(".tgz") ||
            file.endsWith(".log") ||
            file.includes("Screenshot"),
    );
    assert.deepEqual(forbidden, [], "packed artifact contains forbidden files");

    const binEntry = entries.get("scripts/specpi.mjs");
    assert.ok(binEntry, "packed artifact is missing its bin target");
    if (process.platform !== "win32") {
        assert.ok((binEntry.mode & 0o111) !== 0, "packed bin target is not executable");
    }
}

function assertReadmeAssets(packageRoot) {
    const readme = fs.readFileSync(path.join(packageRoot, "README.md"), "utf8");
    const localSources = [...readme.matchAll(/<img\s+[^>]*src="([^"]+)"/g)]
        .map((match) => match[1])
        .filter((source) => !/^https?:\/\//.test(source));
    assert.ok(localSources.length > 0, "README package check did not find any local image assets");
    for (const source of localSources) {
        assert.ok(fs.existsSync(path.join(packageRoot, source)), `README image is missing from package: ${source}`);
    }
}

function assertInstalledLifecycle(packageRoot, binPath, temporaryRoot, baseEnv) {
    const agentDir = path.join(temporaryRoot, "agent");
    const fakeBin = path.join(temporaryRoot, "fake-bin");
    writeFakePi(fakeBin);
    const pathKey = Object.keys(baseEnv).find((key) => key.toLowerCase() === "path") || "PATH";
    const env = {
        ...baseEnv,
        PI_CODING_AGENT_DIR: agentDir,
        GIT_AUTHOR_NAME: "SpecPi Package Check",
        GIT_AUTHOR_EMAIL: "specpi-package-check@example.invalid",
        GIT_COMMITTER_NAME: "SpecPi Package Check",
        GIT_COMMITTER_EMAIL: "specpi-package-check@example.invalid",
    };
    env[pathKey] = `${fakeBin}${path.delimiter}${baseEnv[pathKey] || ""}`;
    const lifecycleCwd = path.join(temporaryRoot, "lifecycle-cwd");
    fs.mkdirSync(lifecycleCwd, { recursive: true });
    const runCli = (args, options = {}) => runInstalledBin(binPath, args, { cwd: lifecycleCwd, env, ...options });
    const help = runCli(["help"]);
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    assert.match(help.stdout, new RegExp(`SpecPi ${packageJson.version.replaceAll(".", "\\.")}`));
    assert.doesNotMatch(help.stdout, /specpi agent/u);
    const retiredLauncher = runCli(["agent"], { expectFailure: true });
    assert.match(`${retiredLauncher.stdout}\n${retiredLauncher.stderr}`, /Unknown command: agent/u);
    assert.equal(fs.existsSync(agentDir), false, "unsupported launcher mutated the isolated Pi directory");

    runCli(["plan", "--skip-package-install", "--skip-browser-install", "--skip-tool-install", "--skip-shell"]);
    assert.equal(fs.existsSync(agentDir), false, "plan mutated the isolated agent directory");
    const unknown = runCli(["unknown-package-smoke-command"], { expectFailure: true });
    assert.match(`${unknown.stdout}\n${unknown.stderr}`, /Unknown command: unknown-package-smoke-command/);
    assert.equal(fs.existsSync(agentDir), false, "unknown command mutated the isolated agent directory");

    const lifecycleFlags = [
        "--yes",
        "--skip-package-install",
        "--skip-browser-install",
        "--skip-tool-install",
        "--skip-shell",
    ];
    runCli(["install", ...lifecycleFlags]);
    runCli(["doctor"], { timeout: 300_000 });

    const guardDirectory = path.join(agentDir, "extensions", "command-guard");
    const driftedGuardPath = path.join(guardDirectory, "index.ts");
    fs.appendFileSync(driftedGuardPath, "\n// package-check rollback drift\n");
    const treeBeforeFailure = snapshotTree(agentDir, ["specpi/backups"]);
    const failedUpdate = runCli(["update", ...lifecycleFlags, "--force"], {
        expectFailure: true,
        env: {
            ...env,
            SPECPI_TESTING: "1",
            SPECPI_TEST_FAIL_POINT: "after-first-command-guard-file",
        },
    });
    assert.match(`${failedUpdate.stdout}\n${failedUpdate.stderr}`, /SpecPi-managed changes rolled back/);
    assert.deepEqual(
        snapshotTree(agentDir, ["specpi/backups"]),
        treeBeforeFailure,
        "failed update did not restore the complete managed tree",
    );

    const privateEvidence = new Map([
        [path.join(agentDir, "specpi", "wishlist", "observations.jsonl"), '{"private":true}\n'],
        [
            path.join(agentDir, "specpi", "wishlist", "decisions.jsonl"),
            '{"action":"retire","journal":{"schema":1,"evidence":["private proof"],"gates":["npm run check"],"version":"0.10.0"}}\n',
        ],
        [path.join(agentDir, "specpi", "experiments", "registry.json"), '{"private":true}\n'],
        [path.join(agentDir, "specpi", "experiments", "patches", "package-smoke.patch"), "private patch\n"],
    ]);
    for (const [file, content] of privateEvidence) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, { mode: 0o600 });
    }

    runCli(["update", ...lifecycleFlags, "--force"]);
    runCli(["doctor"], { timeout: 300_000 });
    runCli(["uninstall", "--yes"]);

    assert.equal(
        fs.existsSync(path.join(agentDir, "extensions", "command-guard", "index.ts")),
        false,
        "uninstall left a managed extension behind",
    );
    assert.equal(
        fs.existsSync(path.join(agentDir, "extensions", "delegation", "index.ts")),
        false,
        "uninstall left native delegation installed",
    );
    for (const [file, expected] of privateEvidence) {
        assert.equal(fs.existsSync(file), true, `uninstall removed private SpecPi evidence: ${file}`);
        assert.equal(fs.readFileSync(file, "utf8"), expected, `uninstall changed private SpecPi evidence: ${file}`);
    }
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-package-check-"));
try {
    const packDirectory = path.join(temporaryRoot, "pack");
    const prefix = path.join(temporaryRoot, "prefix");
    fs.mkdirSync(packDirectory, { recursive: true });
    fs.mkdirSync(prefix, { recursive: true });

    let packResult;
    let tarball;
    if (artifactPath) {
        const results = JSON.parse(fs.readFileSync(path.resolve(artifactManifestPath), "utf8"));
        assert.equal(results.length, 1, "artifact manifest does not describe exactly one package");
        packResult = results[0];
        tarball = path.resolve(artifactPath);
        assert.equal(path.basename(tarball), packResult.filename, "artifact filename differs from its npm manifest");
    } else {
        const packed = runNpm(["pack", "--pack-destination", packDirectory, "--json", "--ignore-scripts"]);
        assert.equal(packed.stderr.trim(), "", `npm pack emitted warnings:\n${packed.stderr}`);
        const results = JSON.parse(packed.stdout);
        assert.equal(results.length, 1, "npm pack did not produce exactly one artifact");
        packResult = results[0];
        tarball = path.join(packDirectory, packResult.filename);
    }

    assertPackageFiles(packResult);

    const sourcePackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    assertPackageMetadata(sourcePackage);
    assert.equal(packResult.name, sourcePackage.name);
    assert.equal(packResult.version, sourcePackage.version);
    assert.deepEqual(packResult.bundled || [], [], "packed artifact unexpectedly bundles dependencies");
    assert.ok(packResult.size < 300_000, `packed artifact unexpectedly exceeds 300 KB: ${packResult.size}`);
    assert.ok(
        packResult.unpackedSize < 1_300_000,
        `unpacked artifact unexpectedly exceeds 1.3 MB (including delegation runtime and protocol docs): ${packResult.unpackedSize}`,
    );

    assert.ok(fs.existsSync(tarball), "the reported npm tarball does not exist");
    assertArtifactMatchesManifest(tarball, packResult);

    const installEnv = { ...process.env, npm_config_audit: "false", npm_config_fund: "false" };
    runNpm(
        [
            "install",
            "--global",
            "--prefix",
            prefix,
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--offline",
            tarball,
        ],
        { env: installEnv },
    );

    const packageRoot = packageRootForPrefix(prefix, installEnv);
    assert.ok(fs.existsSync(packageRoot), "npm did not install SpecPi under the temporary global prefix");
    const binPath = process.platform === "win32" ? path.join(prefix, "specpi.cmd") : path.join(prefix, "bin", "specpi");
    assert.ok(fs.existsSync(binPath), "npm did not create the platform CLI shim");
    assert.match(
        runInstalledBin(binPath, ["help"], { env: installEnv }).stdout,
        new RegExp(`SpecPi ${sourcePackage.version.replaceAll(".", "\\.")}`),
    );

    const installedRoot = path.dirname(packageRoot);
    for (const peer of hostPeerPackages) {
        const peerSegments = peer.split("/");
        assert.equal(
            fs.existsSync(path.join(installedRoot, ...peerSegments)),
            false,
            `npm installed optional host peer beside SpecPi: ${peer}`,
        );
        assert.equal(
            fs.existsSync(path.join(packageRoot, "node_modules", ...peerSegments)),
            false,
            `npm installed optional host peer inside SpecPi: ${peer}`,
        );
    }

    assertPackageMetadata(JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")));
    assertReadmeAssets(packageRoot);
    assertInstalledLifecycle(packageRoot, binPath, temporaryRoot, installEnv);

    console.log(
        `Package check passed: ${packResult.filename} (${packResult.entryCount} files, ${packResult.size} bytes compressed)`,
    );
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
