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
const piPackage = "@earendil-works/pi-coding-agent";
const piVersion = "0.84.4";

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
    const packed = runNpm(["pack", "--pack-destination", packDirectory, "--json", "--ignore-scripts"], { env });
    const packResult = JSON.parse(packed.stdout)[0];
    assert.ok(packResult?.filename, "npm pack did not report the SpecPi tarball");
    const tarball = path.join(packDirectory, packResult.filename);

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
            tarball,
        ],
        { env, timeout: 600_000 },
    );

    const globalRoot = runNpm(["root", "--global", "--prefix", prefix], { env }).stdout.trim();
    const specpiRoot = path.join(globalRoot, "specpi");
    const piRoot = path.join(globalRoot, "@earendil-works", "pi-coding-agent");
    const piManifest = JSON.parse(fs.readFileSync(path.join(piRoot, "package.json"), "utf8"));
    assert.equal(piManifest.version, piVersion);
    const piBin = typeof piManifest.bin === "string" ? piManifest.bin : piManifest.bin?.pi;
    assert.equal(typeof piBin, "string");
    const piCli = path.join(piRoot, piBin);
    assert.ok(fs.existsSync(piCli), "the pinned Pi package did not provide its CLI entrypoint");

    const loaded = runNode(
        [
            piCli,
            "--offline",
            "--no-session",
            "--no-context-files",
            "--no-extensions",
            "-e",
            specpiRoot,
            "--list-models",
            "gpt",
        ],
        { env, timeout: 300_000 },
    );
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

    console.log(`Pi package check passed: ${packResult.filename} loaded through Pi ${piVersion}`);
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
