import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export function runFixture(registrationOnly = false) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-qa-fixture-"));
    const agent = path.join(root, "agent");
    fs.mkdirSync(agent);
    const env = Object.fromEntries(
        Object.entries(process.env).filter(
            ([name]) =>
                !/^(?:PI_|SPECPI_|HOME$|USERPROFILE$|APPDATA$|LOCALAPPDATA$|HOMEDRIVE$|HOMEPATH$|XDG_)/iu.test(name) &&
                !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/iu.test(name),
        ),
    );
    Object.assign(env, {
        HOME: root,
        USERPROFILE: root,
        APPDATA: path.join(root, "roaming"),
        LOCALAPPDATA: path.join(root, "local"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
        TEMP: root,
        TMP: root,
        TMPDIR: root,
        PI_CODING_AGENT_DIR: agent,
        PI_OFFLINE: "1",
        SPECPI_BROWSER_REGISTRATION_ONLY: registrationOnly ? "1" : "0",
    });
    if (process.platform === "win32") {
        env.HOMEDRIVE = root.slice(0, 2);
        env.HOMEPATH = root.slice(2);
    }

    // Capture the standard browser cache before changing HOME, or use the explicit test cache.
    if (!registrationOnly && !env.PLAYWRIGHT_BROWSERS_PATH) {
        let directory = path.dirname(require("playwright").chromium.executablePath());
        while (!/^chromium-\d+$/u.test(path.basename(directory))) {
            const parent = path.dirname(directory);
            assert.notEqual(
                parent,
                directory,
                "Could not locate the Playwright browser cache; set PLAYWRIGHT_BROWSERS_PATH.",
            );
            directory = parent;
        }

        env.PLAYWRIGHT_BROWSERS_PATH = path.dirname(directory);
    }

    try {
        const cli = path.join(
            path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
            "cli.js",
        );
        const result = spawnSync(
            process.execPath,
            [
                cli,
                "--mode",
                "rpc",
                "--offline",
                "--no-session",
                "--no-context-files",
                "--no-extensions",
                "--no-skills",
                "-e",
                fileURLToPath(new URL("./fixtures/browser-harness.ts", import.meta.url)),
            ],
            {
                cwd: root,
                env,
                input: '{"type":"get_state"}\n',
                encoding: "utf8",
                timeout: 150000,
                maxBuffer: 4 * 1024 * 1024,
                windowsHide: true,
            },
        );
        assert.equal(result.error, undefined, result.error?.message);
        const output = result.stdout + result.stderr;
        assert.equal(result.status, 0, output);
        const marker = output.split(/\r?\n/u).find((line) => line.startsWith("SPECPI_BROWSER_HARNESS="));
        assert.ok(marker, output);

        return JSON.parse(marker.slice("SPECPI_BROWSER_HARNESS=".length));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}
