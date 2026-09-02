#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const npmCli = process.env.npm_execpath;

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
    "extensions/files/index.ts",
    "extensions/spec.ts",
    "extensions/spec/core.mjs",
    "extensions/tool-wishlist/capabilities.json",
    "extensions/tool-wishlist/core.mjs",
    "extensions/tool-wishlist/index.ts",
    "extensions/tool-wishlist/registry.mjs",
    "extensions/tool-wishlist/validators.mjs",
    "extensions/ui-refresh/index.ts",
    "extensions/workflow-controls/challenge.mjs",
    "extensions/workflow-controls/experiments.mjs",
    "extensions/workflow-controls/index.ts",
    "extensions/workflow-controls/scope.mjs",
    "extensions/workflow-controls/smoke.mjs",
    "package.json",
    "scripts/check-package.mjs",
    "scripts/check-pi-package.mjs",
    "scripts/lib.mjs",
    "scripts/lock.mjs",
    "scripts/specpi.mjs",
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

function runNodeFailure(args, options = {}) {
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

    assert.notEqual(result.status, 0, `${process.execPath} ${args.join(" ")} unexpectedly succeeded`);

    return result;
}

function runNpm(args, options = {}) {
    return runNode([npmCli, ...args], options);
}

function quoteWindowsCommandArg(value) {
    return `"${String(value).replaceAll("%", "%%").replaceAll('"', '""')}"`;
}

function runInstalledBin(binPath, env) {
    const common = {
        cwd: repoRoot,
        env,
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
    };
    const result =
        process.platform === "win32"
            ? spawnSync([binPath, "help"].map(quoteWindowsCommandArg).join(" "), {
                  ...common,
                  shell: process.env.ComSpec || "cmd.exe",
              })
            : spawnSync(binPath, ["help"], common);
    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(`installed SpecPi bin failed (${result.status})\n${result.stdout || ""}${result.stderr || ""}`);
    }

    return result;
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

    const expectedPeers = [
        "@earendil-works/pi-ai",
        "@earendil-works/pi-coding-agent",
        "@earendil-works/pi-tui",
        "typebox",
    ];
    assert.deepEqual(Object.keys(packageJson.peerDependencies || {}).sort(), expectedPeers);
    for (const peer of expectedPeers) {
        assert.equal(packageJson.peerDependencies[peer], "*");
        assert.equal(packageJson.peerDependenciesMeta?.[peer]?.optional, true);
    }
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

function assertInstalledLifecycle(packageRoot, temporaryRoot, baseEnv) {
    const agentDir = path.join(temporaryRoot, "agent");
    const fakeBin = path.join(temporaryRoot, "fake-bin");
    writeFakePi(fakeBin);
    const env = {
        ...baseEnv,
        PATH: `${fakeBin}${path.delimiter}${baseEnv.PATH || ""}`,
        PI_CODING_AGENT_DIR: agentDir,
    };
    const cli = path.join(packageRoot, "scripts", "specpi.mjs");

    const help = runNode([cli, "help"], { env });
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    assert.match(help.stdout, new RegExp(`SpecPi ${packageJson.version.replaceAll(".", "\\.")}`));

    runNode([cli, "plan", "--skip-package-install", "--skip-browser-install", "--skip-tool-install", "--skip-shell"], {
        env,
    });
    assert.equal(fs.existsSync(agentDir), false, "plan mutated the isolated agent directory");
    const unknown = runNodeFailure([cli, "unknown-package-smoke-command"], { env });
    assert.match(`${unknown.stdout}\n${unknown.stderr}`, /Unknown command: unknown-package-smoke-command/);
    assert.equal(fs.existsSync(agentDir), false, "unknown command mutated the isolated agent directory");

    const lifecycleFlags = [
        "--yes",
        "--skip-package-install",
        "--skip-browser-install",
        "--skip-tool-install",
        "--skip-shell",
    ];
    runNode([cli, "install", ...lifecycleFlags], { env });
    runNode([cli, "doctor"], { env, timeout: 300_000 });

    const settingsPath = path.join(agentDir, "settings.json");
    const manifestPath = path.join(agentDir, "specpi", "manifest.json");
    const guardDirectory = path.join(agentDir, "extensions", "command-guard");
    const settingsBeforeFailure = fs.readFileSync(settingsPath);
    const manifestBeforeFailure = fs.readFileSync(manifestPath);
    const guardBeforeFailure = new Map(
        fs.readdirSync(guardDirectory).map((name) => [name, fs.readFileSync(path.join(guardDirectory, name))]),
    );
    const failedUpdate = runNodeFailure([cli, "update", ...lifecycleFlags], {
        env: {
            ...env,
            SPECPI_TESTING: "1",
            SPECPI_TEST_FAIL_POINT: "after-first-command-guard-file",
        },
    });
    assert.match(`${failedUpdate.stdout}\n${failedUpdate.stderr}`, /SpecPi-managed changes rolled back/);
    assert.deepEqual(fs.readFileSync(settingsPath), settingsBeforeFailure);
    assert.deepEqual(fs.readFileSync(manifestPath), manifestBeforeFailure);
    for (const [name, expected] of guardBeforeFailure) {
        assert.deepEqual(fs.readFileSync(path.join(guardDirectory, name)), expected);
    }

    const privateEvidence = [
        path.join(agentDir, "specpi", "wishlist", "observations.jsonl"),
        path.join(agentDir, "specpi", "wishlist", "decisions.jsonl"),
        path.join(agentDir, "specpi", "experiments", "registry.json"),
        path.join(agentDir, "specpi", "experiments", "patches", "package-smoke.patch"),
    ];
    for (const file of privateEvidence) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{"private":true}\n', { mode: 0o600 });
    }

    runNode([cli, "update", ...lifecycleFlags], { env });
    runNode([cli, "doctor"], { env, timeout: 300_000 });
    runNode([cli, "uninstall", "--yes"], { env });

    assert.equal(
        fs.existsSync(path.join(agentDir, "extensions", "command-guard", "index.ts")),
        false,
        "uninstall left a managed extension behind",
    );
    for (const file of privateEvidence) {
        assert.equal(fs.existsSync(file), true, `uninstall removed private SpecPi evidence: ${file}`);
    }
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-package-check-"));
try {
    const packDirectory = path.join(temporaryRoot, "pack");
    const prefix = path.join(temporaryRoot, "prefix");
    fs.mkdirSync(packDirectory, { recursive: true });
    fs.mkdirSync(prefix, { recursive: true });

    const packed = runNpm(["pack", "--pack-destination", packDirectory, "--json", "--ignore-scripts"]);
    assert.equal(packed.stderr.trim(), "", `npm pack emitted warnings:\n${packed.stderr}`);
    const results = JSON.parse(packed.stdout);
    assert.equal(results.length, 1, "npm pack did not produce exactly one artifact");
    const packResult = results[0];
    assertPackageFiles(packResult);

    const sourcePackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    assertPackageMetadata(sourcePackage);
    assert.equal(packResult.name, sourcePackage.name);
    assert.equal(packResult.version, sourcePackage.version);
    assert.deepEqual(packResult.bundled || [], [], "packed artifact unexpectedly bundles dependencies");
    assert.ok(packResult.size < 300_000, `packed artifact unexpectedly exceeds 300 KB: ${packResult.size}`);
    assert.ok(packResult.unpackedSize < 1_000_000, `unpacked artifact unexpectedly exceeds 1 MB`);

    const tarball = path.join(packDirectory, packResult.filename);
    assert.ok(fs.existsSync(tarball), "npm pack did not create the reported tarball");

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
        runInstalledBin(binPath, installEnv).stdout,
        new RegExp(`SpecPi ${sourcePackage.version.replaceAll(".", "\\.")}`),
    );

    const installedRoot = path.dirname(packageRoot);
    assert.equal(
        fs.existsSync(path.join(installedRoot, "@earendil-works")),
        false,
        "npm installed optional Pi host peers",
    );
    assert.equal(
        fs.existsSync(path.join(installedRoot, "typebox")),
        false,
        "npm installed the optional typebox host peer",
    );

    assertPackageMetadata(JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")));
    assertReadmeAssets(packageRoot);
    assertInstalledLifecycle(packageRoot, temporaryRoot, installEnv);

    console.log(
        `Package check passed: ${packResult.filename} (${packResult.entryCount} files, ${packResult.size} bytes compressed)`,
    );
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
