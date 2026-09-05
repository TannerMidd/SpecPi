import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadBrowserRuntime, VIEWPORT_PRESETS, MAX_PNG_BYTES } from "../extensions/browser/core.mjs";
import { startSiteServer, checkRenderedPage } from "../scripts/site-browser.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const enabled = process.env.SPECPI_BROWSER_TESTS === "1";
async function withBrowser(operation) {
    const server = await startSiteServer();
    let browser;
    try {
        const runtime = await loadBrowserRuntime(process.env.SPECPI_BROWSER_RUNTIME);
        browser = await runtime.playwright.chromium.launch({ headless: true });
        await operation(browser, server.origin);
    } finally {
        await browser?.close();
        await server.close();
    }
}

test(
    "rendered public site passes the viewport/page matrix under its deployment subpath",
    { skip: !enabled, timeout: 180000 },
    async (t) => {
        await withBrowser(async (browser, origin) => {
            for (const [name, viewport] of Object.entries(VIEWPORT_PRESETS)) {
                for (const route of ["", "wiki/", "single-agent/"]) {
                    await t.test(`${name}: /SpecPi/${route}`, async () => {
                        const context = await browser.newContext({
                            reducedMotion: "reduce",
                            serviceWorkers: "block",
                            colorScheme: "light",
                            viewport,
                        });
                        const page = await context.newPage();
                        try {
                            await checkRenderedPage(page, { origin, route, viewport });
                        } catch (error) {
                            const directory = path.join(root, ".specpi-test", "browser-artifacts");
                            await fs.mkdir(directory, { recursive: true });
                            const file = path.join(directory, `${name}-${route.replaceAll("/", "") || "home"}.png`);
                            const image = await page.screenshot({ type: "png", timeout: 5000 }).catch(() => undefined);
                            if (image && image.length <= MAX_PNG_BYTES) {
                                await fs.writeFile(file, image);
                                t.diagnostic(`Failure screenshot (not a baseline): ${file}`);
                            }

                            throw error;
                        } finally {
                            await context.close();
                        }
                    });
                }
            }
        });
    },
);

test(
    "rendered checks reject injected runtime, interaction, and layout faults",
    { skip: !enabled, timeout: 60000 },
    async () => {
        await withBrowser(async (browser, origin) => {
            for (const [fault, pattern] of [
                ["runtime", /unexpected browser diagnostics/u],
                ["interaction", /Timeout/u],
                ["layout", /horizontal document overflow/u],
            ]) {
                const context = await browser.newContext({ reducedMotion: "reduce", serviceWorkers: "block" });
                try {
                    const page = await context.newPage();
                    await assert.rejects(
                        checkRenderedPage(page, { origin, route: "", viewport: VIEWPORT_PRESETS.mobile, fault }),
                        pattern,
                        fault,
                    );
                } finally {
                    await context.close();
                }
            }
        });
    },
);
