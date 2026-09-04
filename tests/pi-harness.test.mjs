import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { runPiFixture } from "../scripts/pi-test-harness.mjs";

const fixture = path.resolve("tests/fixtures/workflow-controls-harness.ts");

function makeTemporaryRoot(label) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `specpi-${label}-`));
}

function writeNodeFixture(root, name, source) {
    const file = path.join(root, name);
    fs.writeFileSync(file, `${source}\n`);

    return file;
}

function readMarker(stdout) {
    const marker = stdout.split(/\r?\n/u).find((line) => line.startsWith("PI_HARNESS_PROBE="));
    assert.ok(marker, stdout);

    return JSON.parse(marker.slice("PI_HARNESS_PROBE=".length));
}

test("Pi harness runs a JavaScript CLI with a private temporary agent directory", () => {
    const root = makeTemporaryRoot("pi-cli");
    try {
        const cli = writeNodeFixture(
            root,
            "fake-pi.mjs",
            [
                "const args = process.argv.slice(2);",
                "console.log(`PI_HARNESS_PROBE=${JSON.stringify({ args, agentDir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE })}`);",
            ].join("\n"),
        );
        const result = runPiFixture(fixture, {
            piCommand: cli,
            env: { PI_CODING_AGENT_DIR: path.join(root, "user-agent"), PI_OFFLINE: "0" },
        });

        assert.equal(result.unavailable, false);
        assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
        assert.equal(result.error, null);
        const probe = readMarker(result.stdout);
        assert.equal(probe.offline, "1");
        assert.notEqual(probe.agentDir, path.join(root, "user-agent"));
        assert.ok(probe.agentDir.startsWith(os.tmpdir()), probe.agentDir);
        assert.deepEqual(probe.args, [
            "--mode",
            "rpc",
            "--offline",
            "--no-session",
            "--no-context-files",
            "--no-extensions",
            "--no-skills",
            "-e",
            fixture,
        ]);
        assert.equal(fs.existsSync(result.agentDir), false, "the helper-owned agent was not cleaned up");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("Pi harness preserves an explicitly supplied temporary agent directory", () => {
    const root = makeTemporaryRoot("pi-agent");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(agentDir);
    try {
        const cli = writeNodeFixture(
            root,
            "fake-pi.mjs",
            [
                'import fs from "node:fs";',
                'fs.writeFileSync(`${process.env.PI_CODING_AGENT_DIR}/seen.txt`, "ok\\n");',
                "console.log(`PI_HARNESS_PROBE=${JSON.stringify({ agentDir: process.env.PI_CODING_AGENT_DIR })}`);",
            ].join("\n"),
        );
        const result = runPiFixture(fixture, {
            piCommand: cli,
            agentDir,
        });

        assert.equal(result.unavailable, false);
        assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
        assert.equal(result.agentDir, agentDir);
        assert.equal(readMarker(result.stdout).agentDir, agentDir);
        assert.equal(fs.readFileSync(path.join(agentDir, "seen.txt"), "utf8"), "ok\n");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("Pi harness marks only a missing executable as unavailable", () => {
    const root = makeTemporaryRoot("pi-missing");
    try {
        const result = runPiFixture(fixture, {
            piCommand: path.join(root, "does-not-exist.mjs"),
        });

        assert.equal(result.unavailable, true);
        assert.equal(result.status, null);
        assert.equal(result.error?.code, "ENOENT");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("Pi harness rejects an agent directory outside its dedicated temporary root", () => {
    assert.throws(
        () => runPiFixture(fixture, { agentDir: path.dirname(fs.realpathSync(os.tmpdir())) }),
        /dedicated directory under/u,
    );
});

test("Pi harness reports an available CLI failure instead of skipping it", () => {
    const root = makeTemporaryRoot("pi-failure");
    try {
        const cli = writeNodeFixture(root, "fake-pi.mjs", "process.exit(7);");
        const result = runPiFixture(fixture, {
            piCommand: cli,
        });

        assert.equal(result.unavailable, false);
        assert.equal(result.status, 7);
        assert.equal(result.error, null);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("Pi harness safely launches a Windows command shim", { skip: process.platform !== "win32" }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-pi-harness-% space-"));
    try {
        writeNodeFixture(root, "fake pi.mjs", "console.log(`PI_HARNESS_PROBE=${JSON.stringify({ ok: true })}`);");
        const shim = path.join(root, "fake pi.cmd");
        fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0fake pi.mjs" %*\r\n`);
        const result = runPiFixture(fixture, { piCommand: shim });

        assert.equal(result.unavailable, false);
        assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
        assert.deepEqual(readMarker(result.stdout), { ok: true });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test(
    "Pi harness resolves the Windows executable when npm also provides a Unix shim",
    { skip: process.platform !== "win32" },
    () => {
        const root = makeTemporaryRoot("pi-paired-shims");
        try {
            writeNodeFixture(root, "fake-pi.mjs", "console.log(`PI_HARNESS_PROBE=${JSON.stringify({ ok: true })}`);");
            fs.writeFileSync(path.join(root, "pi"), "#!/bin/sh\nexit 99\n");
            fs.writeFileSync(path.join(root, "pi.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0fake-pi.mjs" %*\r\n`);
            for (const piCommand of ["pi", path.join(root, "pi")]) {
                const result = runPiFixture(fixture, {
                    piCommand,
                    env: { PATH: root, Path: root, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
                });

                assert.equal(result.unavailable, false);
                assert.equal(result.status, 0, `${piCommand}: ${result.stderr}\n${result.stdout}`);
                assert.equal(result.error, null);
                assert.deepEqual(readMarker(result.stdout), { ok: true });
            }
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    },
);
