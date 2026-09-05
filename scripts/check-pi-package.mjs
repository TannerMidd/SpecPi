#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const npmCli = process.env.npm_execpath;
const artifactIndex = process.argv.indexOf("--artifact");
const artifactPath = artifactIndex >= 0 ? process.argv[artifactIndex + 1] : undefined;
const piPackage = "@earendil-works/pi-coding-agent";
const piVersion = "0.84.4";
const specpiVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
const hostPeerPackages = [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
];

if ((artifactIndex >= 0 && !artifactPath) || (artifactIndex < 0 && process.argv.length > 2)) {
    throw new Error("Use no arguments, or supply --artifact <tarball>");
}

if (!npmCli || !fs.existsSync(npmCli)) {
    throw new Error("Run Pi package validation through npm so npm_execpath identifies the active npm CLI");
}

function runNode(args, options = {}) {
    const result = spawnSync(process.execPath, args, {
        cwd: options.cwd || repoRoot,
        env: options.env || process.env,
        encoding: "utf8",
        windowsHide: true,
        timeout: options.timeout || 300_000,
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

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-pi-package-check-"));
try {
    const prefix = path.join(temporaryRoot, "prefix");
    const packDirectory = path.join(temporaryRoot, "pack");
    const agentDir = path.join(temporaryRoot, "agent");
    fs.mkdirSync(prefix, { recursive: true });
    fs.mkdirSync(packDirectory, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    const authPath = path.join(agentDir, "auth.json");
    const authCanary = "{}\n";
    fs.writeFileSync(authPath, authCanary, { mode: 0o600 });

    const env = {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        npm_config_audit: "false",
        npm_config_fund: "false",
    };
    let tarball;
    let artifactLabel;
    if (artifactPath) {
        tarball = path.resolve(artifactPath);
        artifactLabel = path.basename(tarball);
    } else {
        const packed = runNpm(["pack", "--pack-destination", packDirectory, "--json", "--ignore-scripts"], {
            env,
        });
        const packResult = JSON.parse(packed.stdout)[0];
        assert.ok(packResult?.filename, "npm pack did not report the SpecPi tarball");
        tarball = path.join(packDirectory, packResult.filename);
        artifactLabel = packResult.filename;
    }

    assert.ok(fs.existsSync(tarball), "the SpecPi tarball does not exist");

    runNpm(
        [
            "install",
            "--global",
            "--prefix",
            prefix,
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            `${piPackage}@${piVersion}`,
        ],
        { env, timeout: 600_000 },
    );

    const globalRoot = runNpm(["root", "--global", "--prefix", prefix], { env }).stdout.trim();
    const piRoot = path.join(globalRoot, "@earendil-works", "pi-coding-agent");
    const piManifest = JSON.parse(fs.readFileSync(path.join(piRoot, "package.json"), "utf8"));
    assert.equal(piManifest.version, piVersion);
    const piBin = typeof piManifest.bin === "string" ? piManifest.bin : piManifest.bin?.pi;
    assert.equal(typeof piBin, "string");
    const piCli = path.join(piRoot, piBin);
    assert.ok(fs.existsSync(piCli), "the pinned Pi package did not provide its CLI entrypoint");
    assert.equal(fs.existsSync(path.join(globalRoot, "specpi")), false, "SpecPi shared Pi's npm installation tree");

    const npmWrapper = path.join(temporaryRoot, "candidate-npm.mjs");
    fs.writeFileSync(
        npmWrapper,
        `import process from "node:process";\n` +
            `import { spawnSync } from "node:child_process";\n` +
            `const npmCli = ${JSON.stringify(npmCli)};\n` +
            `const candidate = ${JSON.stringify(tarball)};\n` +
            `const requested = ${JSON.stringify(`specpi@${specpiVersion}`)};\n` +
            `const args = process.argv.slice(2).map((arg) => arg === requested ? candidate : arg);\n` +
            `const result = spawnSync(process.execPath, [npmCli, ...args], { env: process.env, stdio: "inherit" });\n` +
            `if (result.error) throw result.error;\n` +
            `process.exitCode = result.status ?? 1;\n`,
    );
    fs.writeFileSync(
        path.join(agentDir, "settings.json"),
        `${JSON.stringify({ npmCommand: [process.execPath, npmWrapper] }, null, 2)}\n`,
        { mode: 0o600 },
    );

    const npmSource = `npm:specpi@${specpiVersion}`;
    runNode([piCli, "install", npmSource], { cwd: temporaryRoot, env });
    const specpiRoot = path.join(agentDir, "npm", "node_modules", "specpi");
    assert.ok(fs.existsSync(path.join(specpiRoot, "package.json")), "Pi did not install the npm package candidate");
    assert.equal(JSON.parse(fs.readFileSync(path.join(specpiRoot, "package.json"), "utf8")).version, specpiVersion);
    for (const peer of hostPeerPackages) {
        const peerSegments = peer.split("/");
        assert.equal(
            fs.existsSync(path.join(agentDir, "npm", "node_modules", ...peerSegments)),
            false,
            `Pi installed host peer beside SpecPi: ${peer}`,
        );
        assert.equal(
            fs.existsSync(path.join(specpiRoot, "node_modules", ...peerSegments)),
            false,
            `Pi installed host peer inside SpecPi: ${peer}`,
        );
    }

    const listed = runNode([piCli, "list"], { cwd: temporaryRoot, env });
    assert.match(listed.stdout, /User packages:/);
    assert.match(listed.stdout, new RegExp(`npm:specpi@${specpiVersion.replaceAll(".", "\\.")}`));

    const probePath = path.join(temporaryRoot, "resource-probe.mjs");
    const piEntryUrl = pathToFileURL(path.join(piRoot, "dist", "index.js")).href;
    fs.writeFileSync(
        probePath,
        `import { DefaultResourceLoader } from ${JSON.stringify(piEntryUrl)};\n` +
            `const loader = new DefaultResourceLoader(${JSON.stringify({ cwd: temporaryRoot, agentDir })});\n` +
            "await loader.reload();\n" +
            "const extensionResult = loader.getExtensions();\n" +
            "console.log('SPECPI_RESOURCE_PROBE=' + JSON.stringify({\n" +
            "  extensionPaths: extensionResult.extensions.map((extension) => extension.resolvedPath),\n" +
            "  extensionErrors: extensionResult.errors,\n" +
            "  skillNames: loader.getSkills().skills.map((skill) => skill.name),\n" +
            "  themeNames: loader.getThemes().themes.map((theme) => theme.name),\n" +
            "}));\n",
    );
    const probeResult = runNode([probePath], { cwd: temporaryRoot, env });
    const probeLine = probeResult.stdout.split(/\r?\n/).find((line) => line.startsWith("SPECPI_RESOURCE_PROBE="));
    assert.ok(probeLine, `Pi resource probe did not return structured output:\n${probeResult.stdout}`);
    const resources = JSON.parse(probeLine.slice("SPECPI_RESOURCE_PROBE=".length));
    for (const expected of [
        "/extensions/browser/index.ts",
        "/extensions/command-guard/index.ts",
        "/extensions/files/index.ts",
        "/extensions/spec.ts",
        "/extensions/tool-wishlist/index.ts",
        "/extensions/ui-refresh/index.ts",
        "/extensions/workflow-controls/index.ts",
    ]) {
        assert.ok(
            resources.extensionPaths.some((entry) => entry.replaceAll("\\", "/").endsWith(expected)),
            `Pi did not discover ${expected}: ${JSON.stringify(resources)}`,
        );
    }

    assert.deepEqual(resources.extensionErrors, [], `Pi reported extension load errors: ${JSON.stringify(resources)}`);
    assert.ok(resources.skillNames.includes("specpi-improve"), "Pi did not discover the SpecPi improvement skill");
    assert.ok(resources.skillNames.includes("donsetch"), "Pi did not discover the DonSeTch skill");
    assert.ok(resources.themeNames.includes("specpi-spec"), "Pi did not discover the SpecPi theme");
    assert.ok(resources.themeNames.includes("tea-house"), "Pi did not discover the tea-house theme");

    const loaded = runNode([piCli, "--offline", "--no-session", "--no-context-files", "--list-models", "gpt"], {
        env,
        timeout: 300_000,
    });
    assert.doesNotMatch(
        `${loaded.stdout}\n${loaded.stderr}`,
        /failed to load|cannot find package|ERR_MODULE_NOT_FOUND/i,
    );
    assert.equal(fs.readFileSync(authPath, "utf8"), authCanary, "Pi package smoke modified authentication state");
    assert.equal(
        fs.existsSync(path.join(specpiRoot, "browser-runtime", "node_modules")),
        false,
        "native package unexpectedly bundled the managed browser runtime",
    );
    const browserCore = await import(pathToFileURL(path.join(specpiRoot, "extensions", "browser", "core.mjs")).href);
    await assert.rejects(
        browserCore.loadBrowserRuntime(path.join(agentDir, "specpi", "browser-runtime")),
        /SpecPi browser runtime is not installed.*Run specpi update/s,
    );

    console.log(`Pi package check passed: ${artifactLabel} loaded through Pi ${piVersion}`);
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
