#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const [command, ...options] = process.argv.slice(2);
const help =
    "Usage: specpi-browser-qa setup [--with-deps] | doctor\nSetup explicitly downloads Playwright Chromium; --with-deps may install system packages.\nDoctor runs offline rendering, pixel comparison, and accessibility checks. No Bun required.";

function run(script, args, timeout) {
    const result = spawnSync(process.execPath, [script, ...args], {
        stdio: "inherit",
        windowsHide: true,
        timeout,
        env: process.env,
    });
    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(`Browser QA check failed (${result.signal ?? result.status}).`);
    }
}

try {
    if ((!command || command === "--help" || command === "help") && options.length === 0) {
        console.log(help);
    } else if (command === "doctor" && options.length === 0) {
        run(fileURLToPath(new URL("../src/smoke.mjs", import.meta.url)), [], 60000);
        console.log("Browser QA is ready.");
    } else if (
        command === "setup" &&
        (options.length === 0 || (options.length === 1 && options[0] === "--with-deps"))
    ) {
        console.log("Installing the package-pinned Playwright Chromium browser...");
        run(
            path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js"),
            ["install", "chromium", ...options],
            600000,
        );
        run(fileURLToPath(new URL("../src/smoke.mjs", import.meta.url)), [], 60000);
        console.log("Browser QA is ready.");
    } else {
        throw new Error(help);
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
