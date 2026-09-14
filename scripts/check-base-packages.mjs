#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { basePackages } from "./packages.mjs";
import { runPiFixture } from "./pi-test-harness.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const piRoot = path.join(repoRoot, "node_modules/@earendil-works/pi-coding-agent");
const piCli = path.join(piRoot, "dist/cli.js");
assert.equal(JSON.parse(fs.readFileSync(path.join(piRoot, "package.json"))).version, "0.84.4");
const cli = path.join(repoRoot, "scripts/specpi.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-base-check-"));
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir);
const userConfig = path.join(root, "npmrc");
fs.writeFileSync(userConfig, "");
const env = { SPECPI_PI: piCli, NPM_CONFIG_USERCONFIG: userConfig, npm_config_cache: path.join(root, "npm-cache") };
for (const name of Object.keys(process.env)) {
    if (name.toLowerCase() === "npm_config_cache") {
        env[name] = env.npm_config_cache;
    }
}

const run = (command, args) => {
    const result = runPiFixture(cli, { piCommand: command, cwd: root, agentDir, args, env, timeout: 900_000 });
    assert.equal(result.status, 0, `${result.error?.message || ""}\n${result.stdout}\n${result.stderr}`);

    return result.stdout;
};

let passed = false;
try {
    console.log("Installing the eight default packages in isolated state (network required).");
    const authPath = path.join(agentDir, "auth.json");
    fs.writeFileSync(authPath, "{}\n");
    run(cli, ["plan"]);
    run(cli, ["install", "--yes"]);
    run(cli, ["doctor"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"))).packages, basePackages);
    const probe = path.join(root, "resource-probe.mjs");
    fs.writeFileSync(
        probe,
        `
import { DefaultResourceLoader } from ${JSON.stringify(pathToFileURL(path.join(piRoot, "dist/index.js")).href)};
const loader = new DefaultResourceLoader(${JSON.stringify({ cwd: root, agentDir })});
await loader.reload();
const result = loader.getExtensions();
console.log('SPECPI_BASE=' + JSON.stringify({
    errors: result.errors,
    paths: result.extensions.map((e) => e.resolvedPath),
    commands: result.extensions.flatMap((e) => [...e.commands.keys()]),
    tools: result.extensions.flatMap((e) => [...e.tools.keys()]),
}));
process.exit(0);
`,
    );
    console.log("Loading all default resources together through Pi 0.84.4.");
    const output = run(probe, []);
    const line = output.split(/\r?\n/).find((entry) => entry.startsWith("SPECPI_BASE="));
    assert.ok(line, output);
    const resources = JSON.parse(line.slice("SPECPI_BASE=".length));
    assert.deepEqual(resources.errors, [], JSON.stringify(resources.errors));
    // Background Tasks supplies two extensions; each other upstream package supplies one.
    assert.equal(resources.paths.length, 11, JSON.stringify(resources.paths));
    for (const command of ["scope", "wishlist", "harness-improvement"]) {
        assert.ok(resources.commands.includes(command), `Missing /${command}`);
    }

    assert.equal(
        new Set(resources.tools).size,
        resources.tools.length,
        "Default packages registered conflicting tool names",
    );
    console.log("Checking the complete base over Chat RPC, including upstream permission replies.");
    env.SPECPI_CHAT_BASE_SMOKE = "1";
    const chatReport = run(process.execPath, ["--test", path.join(repoRoot, "tests/vscode-base-packages.test.mjs")]);
    assert.doesNotMatch(chatReport, /# skipped [1-9]|ℹ skipped [1-9]/u);
    run(cli, ["update", "--yes", "--skip-package-install"]);
    run(cli, ["doctor"]);
    run(cli, ["uninstall", "--yes"]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"))).packages, undefined);
    assert.equal(fs.readFileSync(authPath, "utf8"), "{}\n");
    console.log(
        `OK: eight package pins acquired, ${resources.paths.length} extensions loaded without errors or tool collisions, lifecycle and synthetic auth canary verified.`,
    );
    passed = true;
} finally {
    if (passed) {
        fs.rmSync(root, { recursive: true, force: true });
    } else {
        console.error(`Failed isolated base check retained for diagnosis: ${root}`);
    }
}
