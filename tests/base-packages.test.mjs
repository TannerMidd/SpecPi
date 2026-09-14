import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { basePackages } from "../scripts/packages.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(repoRoot, "scripts/specpi.mjs");

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-base-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const agent = path.join(root, "agent");
    fs.mkdirSync(agent);
    const settings = path.join(agent, "settings.json");
    const log = path.join(root, "calls.jsonl");
    const fake = path.join(root, "fake pi.mjs");
    fs.writeFileSync(
        fake,
        `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (process.env.npm_config_save_exact !== 'true' || process.env.NPM_CONFIG_SAVE_EXACT !== 'true') {
    throw new Error('Pi must save exact npm versions for every package install');
}
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n');
const source = args[1];
const at = source.lastIndexOf('@');
const name = source.slice(4, at);
const identity = (entry) => (typeof entry === 'string' ? entry : entry.source).replace(/@[^/@]+$/, '');
const file = path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json');
const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
const entries = settings.packages || [];
const i = entries.findIndex((entry) => identity(entry) === 'npm:' + name);
if (i < 0) { entries.push(source); }
else { entries[i] = typeof entries[i] === 'string' ? source : {...entries[i], source}; }
settings.packages = entries;
fs.writeFileSync(file, JSON.stringify(settings));
const dir = path.join(process.env.PI_CODING_AGENT_DIR, 'npm/node_modules', name);
fs.mkdirSync(dir, {recursive:true});
const version = source === process.env.FAKE_DRIFT ? '0.0.0' : source.slice(at + 1);
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version}));
if (source === process.env.FAKE_FAIL) { process.exit(1); }
`,
    );
    const invoke = (args, extraEnv = {}) =>
        spawnSync(process.execPath, [cli, ...args], {
            cwd: root,
            env: {
                ...process.env,
                PI_CODING_AGENT_DIR: agent,
                SPECPI_PI: fake,
                FAKE_LOG: log,
                npm_config_save_exact: "false",
                NPM_CONFIG_SAVE_EXACT: "false",
                ...extraEnv,
            },
            encoding: "utf8",
            windowsHide: true,
        });
    const run = (...args) => {
        const result = invoke(args);
        assert.equal(result.status, 0, result.stdout + result.stderr);

        return result;
    };

    return { root, agent, settings, log, fake, invoke, run };
}

test("the default base is exactly the seven human-selected pinned packages", () => {
    assert.deepEqual(basePackages, [
        "npm:pi-web-access@0.29.0",
        "npm:betterwright@2.8.1",
        "npm:pi-subagents@0.67.0",
        "npm:pi-lens@4.1.6",
        "npm:pi-goal-x@0.31.2",
        "npm:@sreetej510/pi-usage@0.10.0",
        "npm:@gotgenes/pi-permission-system@32.0.2",
    ]);
});

test("default lifecycle installs each pin through Pi, preserves filters, and restores original settings", (t) => {
    const f = fixture(t);
    const before = {
        theme: "user",
        packages: [
            "npm:user-tool@1.0.0",
            { source: "npm:pi-web-access@0.25.0", extensions: ["index.ts"], skills: [] },
            { source: "npm:pi-background-tasks@2.5.0", extensions: [] },
        ],
    };
    fs.writeFileSync(f.settings, JSON.stringify(before));
    fs.writeFileSync(path.join(f.agent, "auth.json"), "synthetic private canary");
    f.run("plan");
    assert.equal(fs.existsSync(f.log), false);
    assert.notEqual(f.invoke(["install"]).status, 0);
    assert.equal(fs.existsSync(f.log), false);
    f.run("install", "--yes");
    assert.deepEqual(
        fs.readFileSync(f.log, "utf8").trim().split("\n").map(JSON.parse),
        basePackages.map((source) => ["install", source]),
    );
    const installed = JSON.parse(fs.readFileSync(f.settings));
    assert.deepEqual(installed.packages[1], { ...before.packages[1], source: basePackages[0] });
    assert.equal(installed.theme, before.theme);
    assert.equal(installed.packages.length, basePackages.length + 2);
    assert.deepEqual(installed.packages[2], before.packages[2]);
    f.run("doctor");
    f.run("update", "--yes", "--skip-package-install");
    assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)), installed);
    assert.equal(fs.readFileSync(f.log, "utf8").trim().split("\n").length, basePackages.length);
    f.run("update", "--yes");
    assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)), installed);
    f.run("uninstall", "--yes");
    assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)), before);
    assert.equal(fs.readFileSync(path.join(f.agent, "auth.json"), "utf8"), "synthetic private canary");
    assert.ok(fs.existsSync(path.join(f.agent, "npm/node_modules/betterwright/package.json")));
});

test("updates retire only unchanged SpecPi-added background-task entries", async (t) => {
    for (const modified of [false, true]) {
        await t.test(modified ? "user edit survives" : "owned entry retires", (t) => {
            const f = fixture(t);
            f.run("install", "--yes");
            const removed = "npm:pi-background-tasks@2.5.0";
            const current = modified ? { source: removed, extensions: [] } : removed;
            const settings = JSON.parse(fs.readFileSync(f.settings));
            settings.packages.push(current);
            fs.writeFileSync(f.settings, JSON.stringify(settings));
            const manifestPath = path.join(f.agent, "specpi/manifest.json");
            const manifest = JSON.parse(fs.readFileSync(manifestPath));
            manifest.basePackages.push(removed);
            manifest.packageChanges.push({
                identity: "npm:pi-background-tasks",
                beforeExists: false,
                installed: removed,
            });
            fs.writeFileSync(manifestPath, JSON.stringify(manifest));
            const downloaded = path.join(f.agent, "npm/node_modules/pi-background-tasks/package.json");
            fs.mkdirSync(path.dirname(downloaded), { recursive: true });
            const bytes = JSON.stringify({ name: "pi-background-tasks", version: "2.5.0" });
            fs.writeFileSync(downloaded, bytes);

            f.run("plan");
            assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)), settings);
            f.run("update", "--yes", "--skip-package-install");
            assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)), settings);
            f.run("update", "--yes");
            const after = JSON.parse(fs.readFileSync(f.settings));
            assert.deepEqual(after.packages, modified ? [current, ...basePackages] : basePackages);
            assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath)).basePackages, basePackages);
            assert.equal(fs.readFileSync(downloaded, "utf8"), bytes);
            assert.deepEqual(
                fs.readFileSync(f.log, "utf8").trim().split("\n").map(JSON.parse),
                [...basePackages, ...basePackages].map((source) => ["install", source]),
            );
            f.run("doctor");
            f.run("uninstall", "--yes");
            assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)).packages, modified ? [current] : undefined);
        });
    }
});

test("failed package acquisition restores configuration and managed files with explicit cache limitation", (t) => {
    const f = fixture(t);
    const before = '{"theme":"user"}\n';
    fs.writeFileSync(f.settings, before);
    f.run("install", "--yes", "--skip-package-install");
    const manifest = path.join(f.agent, "specpi/manifest.json");
    const oldManifest = fs.readFileSync(manifest, "utf8");
    const failed = f.invoke(["update", "--yes"], { FAKE_FAIL: basePackages[2] });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /rolled back/);
    assert.match(failed.stderr, /downloaded packages.*may remain/);
    assert.equal(fs.readFileSync(f.settings, "utf8"), before);
    assert.equal(fs.readFileSync(manifest, "utf8"), oldManifest);
    assert.equal(fs.readFileSync(f.log, "utf8").trim().split("\n").length, 3);
});

test("package version drift fails installation and restores the previous managed configuration", (t) => {
    const f = fixture(t);
    const before = '{"theme":"user"}\n';
    fs.writeFileSync(f.settings, before);
    f.run("install", "--yes", "--skip-package-install");
    const manifest = path.join(f.agent, "specpi/manifest.json");
    const oldManifest = fs.readFileSync(manifest, "utf8");
    const failed = f.invoke(["update", "--yes"], { FAKE_DRIFT: basePackages[4] });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Base package version mismatch: npm:pi-goal-x/);
    assert.match(failed.stderr, /rolled back/);
    assert.equal(fs.readFileSync(f.settings, "utf8"), before);
    assert.equal(fs.readFileSync(manifest, "utf8"), oldManifest);
});

test("doctor detects missing package bytes and removal preserves user-modified package settings", (t) => {
    const f = fixture(t);
    f.run("install", "--yes");
    fs.unlinkSync(path.join(f.agent, "npm/node_modules/pi-lens/package.json"));
    assert.match(f.invoke(["doctor"]).stderr, /Missing or unreadable base package: npm:pi-lens/);
    const settings = JSON.parse(fs.readFileSync(f.settings));
    settings.packages[0] = "npm:pi-web-access@user-choice";
    fs.writeFileSync(f.settings, JSON.stringify(settings));
    f.run("uninstall", "--yes");
    assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)).packages, ["npm:pi-web-access@user-choice"]);
});

test("malformed package configuration fails before acquisition and is preserved", (t) => {
    const f = fixture(t);
    fs.writeFileSync(f.settings, '{"packages":"user-value"}\n');
    assert.match(f.invoke(["install", "--yes"]).stderr, /packages must be an array/);
    assert.equal(fs.readFileSync(f.settings, "utf8"), '{"packages":"user-value"}\n');
    assert.equal(fs.existsSync(f.log), false);
});

test("Windows Pi command shims support paths with spaces", { skip: process.platform !== "win32" }, (t) => {
    const f = fixture(t);
    const shim = path.join(f.root, "pi shim.cmd");
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${f.fake}" %*\r\n`);
    const result = f.invoke(["install", "--yes"], { SPECPI_PI: shim });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(f.log, "utf8").trim().split("\n").length, basePackages.length);
});
