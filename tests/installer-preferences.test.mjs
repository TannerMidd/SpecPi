import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../scripts/specpi.mjs", import.meta.url));
const skip = ["--skip-package-install", "--skip-browser-install", "--skip-tool-install", "--skip-shell"];

test("theme preferences survive the isolated installer lifecycle without changing privacy settings", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-preferences-"));
    const agentDir = path.join(root, "agent");
    const fakeBin = path.join(root, "bin");
    fs.mkdirSync(agentDir);
    fs.mkdirSync(fakeBin);
    const settingsPath = path.join(agentDir, "settings.json");
    const original = { theme: "dark", enableInstallTelemetry: false, unrelated: { preserve: true } };
    fs.writeFileSync(settingsPath, JSON.stringify(original));
    // Resolve the installer-owned probes before any personal tool shims on PATH.
    for (const [name, version] of [
        ["pi", "0.84.4"],
        ["donsetch", "fixture"],
    ]) {
        fs.writeFileSync(
            path.join(fakeBin, process.platform === "win32" ? `${name}.cmd` : name),
            process.platform === "win32" ? `@echo off\r\necho ${version}\r\n` : `#!/bin/sh\necho ${version}\n`,
            { mode: 0o755 },
        );
    }

    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = `${fakeBin}${path.delimiter}${env[pathKey] ?? ""}`;
    const run = (...args) => {
        const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", timeout: 120_000 });
        assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

        return result;
    };

    const settings = () => JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    try {
        const before = fs.readFileSync(settingsPath);
        const plan = run("plan", ...skip);
        assert.deepEqual(fs.readFileSync(settingsPath), before);
        assert.match(plan.stdout, /existing valid user choices are preserved/);
        assert.match(plan.stdout, /this does not make Pi offline/);
        run("install", "--yes", ...skip);
        assert.equal(settings().theme, "dark", "installation must preserve an existing Pi theme");
        fs.writeFileSync(settingsPath, JSON.stringify({ ...settings(), theme: "light" }));
        run("doctor");
        run("update", "--yes", ...skip);
        assert.equal(settings().theme, "light", "update must preserve a changed preference");
        run("doctor");
        run("uninstall", "--yes");
        assert.deepEqual(settings(), { ...original, theme: "light" });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
