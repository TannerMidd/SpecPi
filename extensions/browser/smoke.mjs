#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { comparePngBuffers, loadBrowserRuntime } from "./core.mjs";

const runtimeDir = process.argv[2];
if (!runtimeDir) {
    throw new Error("Usage: smoke.mjs <browser-runtime-dir>");
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "specpi-browser-smoke-"));
let browser;
try {
    const runtime = await loadBrowserRuntime(path.resolve(runtimeDir));
    browser = await runtime.playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 800, height: 600 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.setContent(
        "<!doctype html><title>SpecPi Browser Smoke</title><main><h1>SpecPi Browser Smoke</h1><p>Rendered successfully.</p></main>",
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

    if (process.argv.includes("--accessibility")) {
        const require = createRequire(path.join(path.resolve(runtimeDir), "package.json"));
        const AxeBuilder = require("@axe-core/playwright").default;
        if (require("axe-core/package.json").version !== "4.13.0") {
            throw new Error("Accessibility runtime version mismatch.");
        }

        await page.setContent(
            '<!doctype html><html lang="en"><title>Fixture</title><main><button></button></main></html>',
        );
        const broken = await new AxeBuilder({ page }).withTags(["wcag2a"]).analyze();
        if (!broken.violations.some((finding) => finding.id === "button-name")) {
            throw new Error("Accessibility smoke missed an unnamed button.");
        }

        await page.setContent(
            '<!doctype html><html lang="en"><title>Fixture</title><main><button>Save</button></main></html>',
        );
        const fixed = await new AxeBuilder({ page }).withTags(["wcag2a"]).analyze();
        if (fixed.violations.some((finding) => finding.id === "button-name")) {
            throw new Error("Accessibility smoke did not recognize the repair.");
        }
    }

    console.log(`Browser smoke passed: ${baseline.length} byte PNG; exact and changed visual comparisons verified`);
    if (process.argv.includes("--accessibility")) {
        console.log("ACCESSIBILITY_SMOKE=passed");
    }
} finally {
    await browser?.close().catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
}
