#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtime = path.join(root, ".specpi-test", "browser-runtime");
fs.mkdirSync(runtime, { recursive: true });
for (const file of ["package.json", "package-lock.json"]) {
    fs.copyFileSync(path.join(root, "browser-runtime", file), path.join(runtime, file));
}

if (!process.env.npm_execpath || process.argv.slice(2).some((arg) => arg !== "--with-deps")) {
    throw new Error("Use npm run setup:browser [-- --with-deps]. OS dependencies are opt-in (CI Linux only).");
}

for (const args of [
    [process.env.npm_execpath, "ci", "--prefix", runtime, "--ignore-scripts", "--no-audit", "--no-fund"],
    [
        path.join(runtime, "node_modules", "playwright", "cli.js"),
        "install",
        ...(process.argv.includes("--with-deps") ? ["--with-deps"] : []),
        "chromium",
    ],
]) {
    const result = spawnSync(process.execPath, args, {
        cwd: root,
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(runtime, "browsers") },
        stdio: "inherit",
        timeout: 600000,
    });
    if (result.error || result.status !== 0) {
        throw new Error(`Browser test setup failed (${result.status}): ${result.error?.message ?? "see output above"}`);
    }
}

console.log("Browser test runtime ready in .specpi-test/browser-runtime/; no live Pi state used.");
