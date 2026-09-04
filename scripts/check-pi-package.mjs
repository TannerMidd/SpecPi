#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runPiFixture } from "./pi-test-harness.mjs";

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
        input: options.input,
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

function readHarnessReport(result, marker, label) {
    assert.equal(result.unavailable, false, `${label} could not find the pinned Pi CLI`);
    assert.equal(result.status, 0, `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(result.error, null, `${label} could not start Pi: ${result.error}`);
    const output = `${result.stdout}\n${result.stderr}`;
    const line = output.split(/\r?\n/u).find((entry) => entry.startsWith(marker));
    assert.ok(line, `${label} did not return ${marker}\n${output}`);

    return JSON.parse(line.slice(marker.length));
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

    // The resource probe above exercises discovery. These isolated extension fixtures additionally exercise Pi's
    // actual extension loader and event/command hooks through the pinned host runtime.
    const workflowAgentDir = path.join(temporaryRoot, "workflow-agent");
    const wishlistAgentDir = path.join(temporaryRoot, "wishlist-agent");
    fs.mkdirSync(workflowAgentDir);
    fs.mkdirSync(wishlistAgentDir);
    const workflowReport = readHarnessReport(
        runPiFixture(path.join(repoRoot, "tests", "fixtures", "workflow-controls-harness.ts"), {
            piCommand: piCli,
            cwd: temporaryRoot,
            agentDir: workflowAgentDir,
        }),
        "WORKFLOW_CONTROLS_HARNESS=",
        "workflow extension harness",
    );
    assert.deepEqual(workflowReport.commands, ["challenge", "experiment", "guard", "scope", "task"]);
    assert.equal(workflowReport.toolRegistered, true);
    assert.equal(workflowReport.emittedScopeStatus, true);

    const wishlistReport = readHarnessReport(
        runPiFixture(path.join(repoRoot, "tests", "fixtures", "wishlist-extension-harness.ts"), {
            piCommand: piCli,
            cwd: temporaryRoot,
            agentDir: wishlistAgentDir,
        }),
        "SPECPI_WISHLIST_HARNESS=",
        "wishlist extension harness",
    );
    assert.equal(wishlistReport.completionToolExposed, true);
    assert.equal(wishlistReport.reportStableAfterRetirement, true);
    assert.equal(wishlistReport.checksumsValid, true);

    // These suites may skip without a local Pi runtime during the ordinary repository check. The pinned host here
    // must execute their behavioral assertions in CI, including task display and rejected verification races.
    const fixtureTestEnvironment = { ...env, SPECPI_TEST_PI: piCli };
    delete fixtureTestEnvironment.NODE_TEST_CONTEXT;
    const fixtureTests = runNode(
        [
            "--test",
            "--test-reporter=tap",
            path.join(repoRoot, "tests", "workflow-controls-extension.test.mjs"),
            path.join(repoRoot, "tests", "spec-task-extension.test.mjs"),
            path.join(repoRoot, "tests", "wishlist-verification-extension.test.mjs"),
        ],
        { cwd: repoRoot, env: fixtureTestEnvironment, timeout: 120_000 },
    );
    assert.match(fixtureTests.stdout, /# tests [1-9]\d*/u, "the pinned extension suites did not execute");
    assert.doesNotMatch(fixtureTests.stdout, /# skipped [1-9]\d*/u, "the pinned extension suites skipped coverage");

    // Exercise the installed package through Pi's actual resource loader and RPC mode without sending a prompt.
    // Closing stdin after the two requests is the bounded shutdown path, and --no-session keeps the RPC process from
    // creating session history. The temporary agent already contains the candidate package settings and installation.
    const rpcFixture = path.join(repoRoot, "tests", "fixtures", "workflow-controls-harness.ts");
    const rpcResult = runPiFixture(rpcFixture, {
        piCommand: piCli,
        cwd: temporaryRoot,
        agentDir,
        args: ["--mode", "rpc", "--offline", "--no-session", "--no-context-files"],
        input:
            `${JSON.stringify({ id: "commands", type: "get_commands" })}\n` +
            `${JSON.stringify({ id: "state", type: "get_state" })}\n`,
        timeout: 120_000,
    });
    assert.equal(rpcResult.unavailable, false, "Pi RPC smoke could not find the pinned Pi CLI");
    assert.equal(
        rpcResult.status,
        0,
        `Pi RPC smoke failed\nstdout:\n${rpcResult.stdout}\nstderr:\n${rpcResult.stderr}`,
    );
    assert.equal(rpcResult.error, null, `Pi RPC smoke could not start Pi: ${rpcResult.error}`);
    assert.doesNotMatch(
        `${rpcResult.stdout}\n${rpcResult.stderr}`,
        /failed to load|cannot find package|ERR_MODULE_NOT_FOUND/i,
    );
    const rpcMessages = rpcResult.stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
            try {
                return [JSON.parse(line)];
            } catch {
                return [];
            }
        });
    const commandsResponse = rpcMessages.find((message) => message.type === "response" && message.id === "commands");
    const stateResponse = rpcMessages.find((message) => message.type === "response" && message.id === "state");
    assert.equal(commandsResponse?.success, true, `Pi RPC get_commands failed:\n${rpcResult.stdout}`);
    assert.equal(stateResponse?.success, true, `Pi RPC get_state failed:\n${rpcResult.stdout}`);
    const registeredCommands = commandsResponse.data?.commands?.map((command) => command.name) ?? [];
    assert.ok(registeredCommands.includes("guard"), JSON.stringify(registeredCommands));
    assert.ok(registeredCommands.includes("scope"), JSON.stringify(registeredCommands));
    assert.ok(registeredCommands.includes("task"), JSON.stringify(registeredCommands));
    assert.equal(stateResponse.data?.isStreaming, false, JSON.stringify(stateResponse));
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
