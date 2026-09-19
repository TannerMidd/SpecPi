import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { basePackages, retiredPackages } from "../scripts/packages.mjs";

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
    const browserLog = path.join(root, "browser-calls.jsonl");
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
const browser = name === 'specpi-browser-qa';
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version, ...(browser ? {bin: {'specpi-browser-qa': './bin/browser-qa.mjs'}} : {})}));
if (browser) {
    fs.mkdirSync(path.join(dir, 'bin'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'bin/browser-qa.mjs'), \`
import fs from 'node:fs';
import path from 'node:path';
const command = process.argv[2];
fs.appendFileSync(process.env.FAKE_BROWSER_LOG, JSON.stringify({command, node: process.execPath, args: process.argv.slice(2)}) + '\\\\n');
const ready = path.join(process.env.PI_CODING_AGENT_DIR, 'fake-chromium-ready');
if (command === 'setup') {
    fs.writeFileSync(ready, 'downloaded browser bytes');
    if (process.env.FAKE_BROWSER_FAIL === 'setup') { process.exit(1); }
}
if (!fs.existsSync(ready) || process.env.FAKE_BROWSER_FAIL === 'doctor') { process.exit(1); }
console.log('Browser QA is ready.');
\`);
}
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
                FAKE_BROWSER_LOG: browserLog,
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

    return { root, agent, settings, log, browserLog, fake, invoke, run };
}

test("the default base is exactly the seven human-selected pinned packages", () => {
    assert.deepEqual(basePackages, [
        "npm:pi-web-access@0.29.0",
        "npm:specpi-browser-qa@0.3.0",
        "npm:specpi-delegation@0.2.0",
        "npm:specpi-experiments@0.1.0",
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
            { source: "npm:pi-lens@4.1.6", extensions: [] },
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
    assert.equal(installed.packages.length, basePackages.length + 3);
    assert.deepEqual(installed.packages.slice(2, 4), before.packages.slice(2, 4));
    f.run("doctor");
    f.run("update", "--yes", "--skip-package-install");
    assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)), installed);
    assert.equal(fs.readFileSync(f.log, "utf8").trim().split("\n").length, basePackages.length);
    f.run("update", "--yes");
    assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)), installed);
    f.run("uninstall", "--yes");
    assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)), before);
    assert.equal(fs.readFileSync(path.join(f.agent, "auth.json"), "utf8"), "synthetic private canary");
    assert.ok(fs.existsSync(path.join(f.agent, "npm/node_modules/specpi-browser-qa/package.json")));
    const calls = fs.readFileSync(f.browserLog, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(
        calls.map((call) => call.command),
        ["setup", "doctor", "setup"],
    );
    assert.ok(calls.every((call) => call.node === process.execPath && call.args.length === 1));
});

test("updates retire only unchanged SpecPi-added retired package entries", async (t) => {
    for (const [name, version] of [
        ["pi-background-tasks", "2.5.0"],
        ["pi-lens", "4.1.6"],
        ["betterwright", "2.8.1"],
        ["pi-subagents", "0.67.0"],
    ]) {
        for (const modified of [false, true]) {
            await t.test(`${name}: ${modified ? "user edit survives" : "owned entry retires"}`, (t) => {
                const f = fixture(t);
                f.run("install", "--yes");
                const removed = `npm:${name}@${version}`;
                const current = modified ? { source: removed, extensions: [] } : removed;
                const settings = JSON.parse(fs.readFileSync(f.settings));
                settings.packages.push(current);
                fs.writeFileSync(f.settings, JSON.stringify(settings));
                const manifestPath = path.join(f.agent, "specpi/manifest.json");
                const manifest = JSON.parse(fs.readFileSync(manifestPath));
                manifest.basePackages.push(removed);
                manifest.packageChanges.push({
                    identity: `npm:${name}`,
                    beforeExists: false,
                    installed: removed,
                });
                fs.writeFileSync(manifestPath, JSON.stringify(manifest));
                const downloaded = path.join(f.agent, "npm/node_modules", name, "package.json");
                fs.mkdirSync(path.dirname(downloaded), { recursive: true });
                const bytes = JSON.stringify({ name, version });
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
    }
});

test("a retired package is unpinned even when package acquisition is skipped", async (t) => {
    // Dropping a line from templates/settings.json stops new installs getting a package and does
    // nothing to a machine that already has it. For specpi-jev-guard that gap was not survivable:
    // it fails closed, and this release deleted both the code that kept it inert and the command
    // that could disarm it, so an install left holding it would block every shell call the moment
    // its key or endpoint went away. --skip-package-install is the case the restore path misses.
    assert.deepEqual(retiredPackages, ["npm:specpi-jev-guard"]);

    // Whatever shape the entry has, including one the user has given filters of their own. That is a
    // deliberate exception to "a modified entry is yours", and the only one: preserving a modified
    // entry preserves a fail-closed gate whose off switch this release deleted.
    for (const modified of [false, true]) {
        await t.test(modified ? "a user-modified entry goes too" : "SpecPi's own entry goes", (t) => {
            const f = fixture(t);
            f.run("install", "--yes");
            const retired = "npm:specpi-jev-guard@0.1.0";
            const entry = modified ? { source: retired, extensions: [] } : retired;
            const settings = JSON.parse(fs.readFileSync(f.settings));
            settings.packages.push(entry);
            fs.writeFileSync(f.settings, JSON.stringify(settings));

            const doctor = f.invoke(["doctor"]);
            assert.notEqual(doctor.status, 0, "doctor must report a retired package that is still loaded");
            assert.match(doctor.stdout + doctor.stderr, /Retired base package still configured/);

            const update = f.run("update", "--yes", "--skip-package-install");
            assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)).packages, basePackages);
            assert.match(update.stdout + update.stderr, /Unpinned retired package/);
            f.run("doctor");
        });
    }
});

test("a retirement that cannot be completed is rolled back with the rest of the run", (t) => {
    // The write happens outside the `--skip-package-install` guard, so the transaction's watched set
    // has to cover it on that path too. It did not, which left this one write unbacked-up and
    // un-rolled-back while every other file in the same run was both.
    const f = fixture(t);
    f.run("install", "--yes", "--skip-package-install");
    fs.writeFileSync(f.settings, JSON.stringify({ theme: "user", packages: ["npm:specpi-jev-guard@0.1.0"] }));
    const before = fs.readFileSync(f.settings, "utf8");

    const failed = f.invoke(["update", "--yes", "--skip-package-install"], {
        SPECPI_TESTING: "1",
        SPECPI_TEST_FAIL_POINT: "after-first-managed-file",
    });
    assert.notEqual(failed.status, 0);
    assert.equal(fs.readFileSync(f.settings, "utf8"), before, "the retirement must roll back with the run");

    f.run("update", "--yes", "--skip-package-install");
    const after = JSON.parse(fs.readFileSync(f.settings));
    assert.deepEqual(after.packages, [], "the retired entry is gone");
    assert.equal(after.theme, "user", "and nothing else in the file moved");
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
    const drifted = basePackages.find((entry) => entry.startsWith("npm:pi-goal-x@"));
    assert.ok(drifted, "pi-goal-x is no longer a base pin");
    const failed = f.invoke(["update", "--yes"], { FAKE_DRIFT: drifted });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Base package version mismatch: npm:pi-goal-x/);
    assert.match(failed.stderr, /rolled back/);
    assert.equal(fs.readFileSync(f.settings, "utf8"), before);
    assert.equal(fs.readFileSync(manifest, "utf8"), oldManifest);
});

test("doctor detects missing package bytes and removal preserves user-modified package settings", (t) => {
    const f = fixture(t);
    f.run("install", "--yes");
    fs.unlinkSync(path.join(f.agent, "npm/node_modules/pi-goal-x/package.json"));
    assert.match(f.invoke(["doctor"]).stderr, /Missing or unreadable base package: npm:pi-goal-x/);
    const settings = JSON.parse(fs.readFileSync(f.settings));
    settings.packages[0] = "npm:pi-web-access@user-choice";
    fs.writeFileSync(f.settings, JSON.stringify(settings));
    f.run("uninstall", "--yes");
    assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)).packages, ["npm:pi-web-access@user-choice"]);
});

test("browser skip acquires packages but doctor requires real readiness without setup", (t) => {
    const f = fixture(t);
    const plan = f.run("plan", "--skip-browser-install");
    assert.match(plan.stdout, /Chromium setup skipped/);
    assert.equal(fs.existsSync(f.browserLog), false);
    f.run("install", "--yes", "--skip-browser-install");
    assert.equal(fs.existsSync(f.browserLog), false);
    assert.equal(fs.readFileSync(f.log, "utf8").trim().split("\n").length, basePackages.length);
    assert.match(f.invoke(["doctor"]).stderr, /Browser QA doctor failed/);
    assert.equal(fs.existsSync(path.join(f.agent, "fake-chromium-ready")), false);
    f.run("update", "--yes", "--skip-browser-install");
    assert.deepEqual(
        fs
            .readFileSync(f.browserLog, "utf8")
            .trim()
            .split("\n")
            .map(JSON.parse)
            .map((call) => call.command),
        ["doctor"],
    );
    f.run("update", "--yes");
    f.run("doctor");
    assert.notEqual(f.invoke(["doctor"], { FAKE_BROWSER_FAIL: "doctor" }).status, 0);
    fs.unlinkSync(path.join(f.agent, "npm/node_modules/specpi-browser-qa/bin/browser-qa.mjs"));
    assert.match(f.invoke(["doctor"]).stderr, /Browser QA doctor failed/);
});

test("doctor refuses changed Browser QA bin metadata without executing it", (t) => {
    const f = fixture(t);
    f.run("install", "--yes", "--skip-browser-install");
    const file = path.join(f.agent, "npm/node_modules/specpi-browser-qa/package.json");
    const installed = JSON.parse(fs.readFileSync(file));
    installed.bin["specpi-browser-qa"] = "../../outside.mjs";
    fs.writeFileSync(file, JSON.stringify(installed));
    assert.match(f.invoke(["doctor"]).stderr, /changed pinned Browser QA bin metadata/);
    assert.equal(fs.existsSync(f.browserLog), false);
});

test("core-only lifecycle never acquires or checks a browser", (t) => {
    const f = fixture(t);
    f.run("plan", "--skip-package-install");
    f.run("install", "--yes", "--skip-package-install");
    f.run("update", "--yes", "--skip-package-install");
    f.run("doctor");
    f.run("uninstall", "--yes");
    assert.equal(fs.existsSync(f.log), false);
    assert.equal(fs.existsSync(f.browserLog), false);
});

test("failed Chromium setup rolls back managed configuration while browser bytes may remain", (t) => {
    const f = fixture(t);
    f.run("install", "--yes", "--skip-package-install");
    const files = ["specpi/manifest.json", "AGENTS.md", "extensions/workflow-controls/index.ts"];
    const before = files.map((file) => fs.readFileSync(path.join(f.agent, file), "utf8"));
    const failed = f.invoke(["update", "--yes"], { FAKE_BROWSER_FAIL: "setup" });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /rolled back.*Browser QA setup failed/s);
    assert.match(failed.stderr, /browser-cache bytes.*may remain/);
    assert.deepEqual(
        files.map((file) => fs.readFileSync(path.join(f.agent, file), "utf8")),
        before,
    );
    assert.equal(fs.existsSync(f.settings), false);
    assert.equal(fs.existsSync(path.join(f.agent, "fake-chromium-ready")), true);
    f.run("doctor");
});

test("pre-existing BetterWright ownership is restored through migration and uninstall", (t) => {
    const f = fixture(t);
    const original = { source: "npm:betterwright@2.7.0", extensions: [] };
    fs.writeFileSync(f.settings, JSON.stringify({ packages: [original] }));
    f.run("install", "--yes");
    const manifestPath = path.join(f.agent, "specpi/manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    const installed = { ...original, source: "npm:betterwright@2.8.1" };
    manifest.basePackages.push(installed.source);
    manifest.packageChanges.push({ identity: "npm:betterwright", beforeExists: true, before: original, installed });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const settings = JSON.parse(fs.readFileSync(f.settings));
    settings.packages[0] = installed;
    fs.writeFileSync(f.settings, JSON.stringify(settings));
    f.run("update", "--yes");
    assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)).packages, [original, ...basePackages]);
    f.run("uninstall", "--yes");
    assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)).packages, [original]);
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
