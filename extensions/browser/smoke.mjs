#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadBrowserRuntime } from "./core.mjs";

const runtimeDir = process.argv[2];
if (!runtimeDir) throw new Error("Usage: smoke.mjs <browser-runtime-dir>");

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zenpi-browser-smoke-"));
let browser;
try {
  const { playwright } = await loadBrowserRuntime(path.resolve(runtimeDir));
  browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 800, height: 600 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.setContent("<!doctype html><title>ZenPi Browser Smoke</title><main><h1>ZenPi Browser Smoke</h1><p>Rendered successfully.</p></main>");
  const screenshot = path.join(tempDir, "smoke.png");
  await page.screenshot({ path: screenshot, type: "png" });
  const stats = await fs.stat(screenshot);
  if (stats.size < 100) throw new Error("Browser smoke screenshot was unexpectedly empty.");
  console.log(`Browser smoke passed: ${stats.size} byte PNG`);
} finally {
  await browser?.close().catch(() => {});
  await fs.rm(tempDir, { recursive: true, force: true });
}
