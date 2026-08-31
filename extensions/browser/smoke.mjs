#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { comparePngBuffers, loadBrowserRuntime } from "./core.mjs";

const runtimeDir = process.argv[2];
if (!runtimeDir) {
    throw new Error("Usage: smoke.mjs <browser-runtime-dir>");
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenpi-browser-smoke-"));
let browser;
try {
    const runtime = await loadBrowserRuntime(path.resolve(runtimeDir));
    browser = await runtime.playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 800, height: 600 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.setContent(
        "<!doctype html><title>ZenPi Browser Smoke</title><main><h1>ZenPi Browser Smoke</h1><p>Rendered successfully.</p></main>",
    );
    const screenshot = path.join(tempDir, "smoke.png");
    await page.screenshot({ path: screenshot, type: "png" });
    const baseline = await fs.readFile(screenshot);
    if (baseline.length < 100) {
        throw new Error("Browser smoke screenshot was unexpectedly empty.");
    }

    const exact = comparePngBuffers(baseline, baseline, runtime);
    if (!exact.pass || exact.diffPixels !== 0) {
        throw new Error("Exact browser visual comparison did not pass.");
    }

    await page.locator("p").evaluate((element) => {
        element.textContent = "Changed for visual comparison.";
    });
    const changed = await page.screenshot({ type: "png" });
    const difference = comparePngBuffers(baseline, changed, runtime, { maxDiffPixelRatio: 0 });
    if (difference.pass || difference.diffPixels === 0) {
        throw new Error("Changed browser visual comparison was not detected.");
    }

    console.log(`Browser smoke passed: ${baseline.length} byte PNG; exact and changed visual comparisons verified`);
} finally {
    await browser?.close().catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
}
