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
            for (const [name, viewport] of Object.entries({
                ...VIEWPORT_PRESETS,
                fullDesktop: { width: 1920, height: 1080 },
            })) {
                for (const { route, theme } of ["", "wiki/", "single-agent/", "why-pi/"].flatMap((route) =>
                    ["light", "dark"].map((theme) => ({ route, theme })),
                )) {
                    await t.test(`${name} ${theme}: /SpecPi/${route}`, async () => {
                        const context = await browser.newContext({
                            reducedMotion: "reduce",
                            serviceWorkers: "block",
                            colorScheme: "light",
                            viewport,
                        });
                        await context.addInitScript((value) => localStorage.setItem("specpi-site-theme", value), theme);
                        const page = await context.newPage();
                        try {
                            await checkRenderedPage(page, { origin, route, viewport });
                            assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
                        } catch (error) {
                            const directory = path.join(root, ".specpi-test", "browser-artifacts");
                            await fs.mkdir(directory, { recursive: true });
                            const file = path.join(
                                directory,
                                `${name}-${theme}-${route.replaceAll("/", "") || "home"}.png`,
                            );
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
    "showcase stays idle until playback, pauses when closed, and opens from README links",
    { skip: !enabled, timeout: 60000 },
    async (t) => {
        await withBrowser(async (browser, origin) => {
            for (const [name, viewport] of Object.entries(VIEWPORT_PRESETS)) {
                await t.test(name, async () => {
                    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
                    try {
                        const page = await context.newPage();
                        const errors = [];
                        const mediaRequests = [];
                        page.on("pageerror", (error) => errors.push(error.message));
                        page.on("request", (request) => {
                            if (request.url().endsWith("specpi-showcase.mp4")) {
                                mediaRequests.push(request.url());
                            }
                        });
                        await page.goto(`${origin}/SpecPi/`, { waitUntil: "networkidle" });
                        const video = page.locator("#showcase-video");
                        const toggle = page.locator("#showcase > summary");
                        assert.equal(await page.locator("#showcase").getAttribute("open"), null);
                        assert.equal(await video.evaluate((element) => element.paused), true);
                        assert.equal(mediaRequests.length, 0, "closed showcase must not fetch video");
                        await toggle.focus();
                        await page.keyboard.press("Enter");
                        await video.waitFor({ state: "visible" });
                        assert.equal(await video.evaluate((element) => element.paused), true);
                        assert.equal(mediaRequests.length, 0, "opening the disclosure must not preload video");
                        assert.equal(
                            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
                            false,
                        );
                        const directory = path.join(root, ".specpi-test", "browser-artifacts");
                        await fs.mkdir(directory, { recursive: true });
                        await page.locator("#showcase").screenshot({
                            path: path.join(directory, `showcase-${name}.png`),
                        });
                        await video.evaluate((element) => element.play());
                        await page.waitForFunction(() => document.getElementById("showcase-video").currentTime > 0.1);
                        assert.ok(mediaRequests.length > 0);
                        assert.ok(Math.abs((await video.evaluate((element) => element.duration)) - 51) < 0.1);
                        await toggle.click();
                        await page.waitForFunction(() => document.getElementById("showcase-video").paused);
                        await page.goto(`${origin}/SpecPi/#showcase`, { waitUntil: "networkidle" });
                        await video.waitFor({ state: "visible" });
                        assert.equal(await video.evaluate((element) => element.paused), true);
                        await page.locator(".showcase-transcript > summary").click();
                        assert.match(await page.locator(".showcase-transcript").innerText(), /CC BY 4\.0/u);
                        assert.deepEqual(errors, []);
                    } finally {
                        await context.close();
                    }
                });
            }

            const context = await browser.newContext({ javaScriptEnabled: false, viewport: VIEWPORT_PRESETS.mobile });
            try {
                const page = await context.newPage();
                await page.goto(`${origin}/SpecPi/`);
                await page.locator("#showcase > summary").click();
                await page.locator("#showcase-video").waitFor({ state: "visible" });
                assert.equal(await page.locator("#showcase-video").getAttribute("controls"), "");
            } finally {
                await context.close();
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

test(
    "theme choice survives navigation and reload, and works without storage",
    { skip: !enabled, timeout: 60000 },
    async () => {
        await withBrowser(async (browser, origin) => {
            const context = await browser.newContext({ viewport: VIEWPORT_PRESETS.mobile });
            try {
                const page = await context.newPage();
                async function assertPreview(theme) {
                    const previews = page.locator(".product-preview .preview-panels:visible");
                    assert.equal(await previews.count(), 1);
                    assert.equal(await previews.getAttribute("data-preview-theme"), theme);
                    const expected = theme === "light" ? "media/specpi-chat-light.png" : "media/specpi-chat.png";
                    assert.deepEqual(
                        await previews
                            .locator("img")
                            .evaluateAll((images) => images.map((image) => image.getAttribute("src"))),
                        [expected, expected],
                    );
                }

                await page.goto(`${origin}/SpecPi/`);
                assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
                await assertPreview("light");
                await page.getByRole("button", { name: "Dark mode" }).press("Enter");
                assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
                await assertPreview("dark");
                for (const route of ["wiki/", "single-agent/", "why-pi/", ""]) {
                    await page.goto(`${origin}/SpecPi/${route}`);
                    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
                    assert.equal(
                        await page.getByRole("button", { name: "Dark mode" }).getAttribute("aria-pressed"),
                        "true",
                    );
                }

                await page.reload();
                assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
                await assertPreview("dark");
                await page.getByRole("button", { name: "Dark mode" }).click();
                await page.reload();
                assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
                await assertPreview("light");
                await page.goto(`${origin}/SpecPi/#loop`);
                assert.equal(await page.locator("#loop img:visible").isVisible(), true);
                assert.equal(await page.locator("#loop summary, #loop button").count(), 0);
                await page.goto(`${origin}/SpecPi/#guard`);
                assert.equal(await page.locator("#guard").evaluate((element) => element.open), true);
            } finally {
                await context.close();
            }

            const privateContext = await browser.newContext();
            try {
                await privateContext.addInitScript(() => {
                    Object.defineProperty(window, "localStorage", {
                        get() {
                            throw new Error("Storage disabled");
                        },
                    });
                });
                const page = await privateContext.newPage();
                const errors = [];
                page.on("pageerror", (error) => errors.push(error.message));
                await page.goto(`${origin}/SpecPi/`);
                await page.getByRole("button", { name: "Dark mode" }).click();
                assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
                assert.deepEqual(errors, []);
            } finally {
                await privateContext.close();
            }
        });
    },
);
