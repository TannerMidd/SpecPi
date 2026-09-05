#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadBrowserRuntime } from "../extensions/browser/core.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

export function assertBrowserCoverage(result) {
    const count = (name) => Number(result.stdout?.match(new RegExp(`^# ${name} (\\d+)$`, "mu"))?.[1] ?? NaN);
    if (
        result.error ||
        result.status !== 0 ||
        !(count("tests") > 0) ||
        count("pass") !== count("tests") ||
        ["fail", "cancelled", "skipped", "todo"].some((name) => count(name) !== 0)
    ) {
        throw new Error("Required browser coverage failed, was missing, or contained skipped/TODO/cancelled tests.");
    }
}

async function main() {
    const mode = process.argv[2];
    if (!["extension", "site"].includes(mode) || process.argv.length !== 3) {
        throw new Error("Usage: run-browser-tests.mjs <extension|site>");
    }

    const runtime = path.join(root, ".specpi-test", "browser-runtime");
    try {
        const { playwright } = await loadBrowserRuntime(runtime);
        const browser = await playwright.chromium.launch({ headless: true });
        await browser.close();
    } catch {
        throw new Error(
            "Browser tests require the locked runtime and Chromium. Run npm run setup:browser (Linux CI: -- --with-deps).",
        );
    }

    const result = spawnSync(
        process.execPath,
        [
            "--test",
            "--test-reporter=tap",
            path.join(root, "tests", mode === "site" ? "site-browser.test.mjs" : "browser-extension.test.mjs"),
        ],
        {
            cwd: root,
            env: { ...process.env, SPECPI_BROWSER_TESTS: "1", SPECPI_BROWSER_RUNTIME: runtime },
            encoding: "utf8",
            timeout: 300000,
            maxBuffer: 5 * 1024 * 1024,
        },
    );
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    assertBrowserCoverage(result);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
