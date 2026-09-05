#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { BrowserDiagnostics } from "../extensions/browser/diagnostics.ts";
import { GUARD_MODES, CYCLE_STAGES } from "../site/cycle.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const mime = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".csv": "text/csv",
    ".json": "application/json",
};

export async function startSiteServer(siteRoot = path.join(root, "site")) {
    const canonicalRoot = await fs.realpath(siteRoot);
    const server = http.createServer(async (request, response) => {
        try {
            const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
            if (
                !["GET", "HEAD"].includes(request.method) ||
                !pathname.startsWith("/SpecPi/") ||
                /[\\\0:]/u.test(pathname)
            ) {
                response.writeHead(404).end();

                return;
            }

            const relative = pathname.slice("/SpecPi/".length);
            const candidate = path.resolve(
                canonicalRoot,
                relative.endsWith("/") || !relative ? `${relative}index.html` : relative,
            );
            const file = await fs.realpath(candidate);
            const inside = path.relative(canonicalRoot, file);
            if (inside.startsWith(`..${path.sep}`) || inside === ".." || path.isAbsolute(inside)) {
                response.writeHead(404).end();

                return;
            }

            const data = await fs.readFile(file);
            response.writeHead(200, {
                "Content-Type": mime[path.extname(file)] ?? "application/octet-stream",
                "Cache-Control": "no-store",
            });
            response.end(request.method === "HEAD" ? undefined : data);
        } catch {
            response.writeHead(404).end();
        }
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const close = async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    };

    return { origin, close };
}

async function expectText(page, selector, text) {
    await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.trim() === text, {
        selector,
        text,
    });
}

async function selectedTab(page, selector, panel) {
    const tab = page.locator(selector);
    assert.equal(await tab.getAttribute("aria-selected"), "true", `${selector}: selected state`);
    assert.equal(await tab.getAttribute("tabindex"), "0", `${selector}: roving tab stop`);
    assert.equal(await page.locator(panel).getAttribute("aria-labelledby"), await tab.getAttribute("id"));
}

export async function checkRenderedPage(page, { origin, route, viewport, fault }) {
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(10000);
    await page.setViewportSize(viewport);
    const diagnostics = new BrowserDiagnostics();
    const detach = diagnostics.attach(page);
    const externalRequests = [];
    await page.route("**/*", (route) => {
        if (new URL(route.request().url()).origin !== origin) {
            externalRequests.push("unexpected external request");

            return route.abort();
        }

        return route.continue();
    });
    try {
        // Synthetic clipboard stub: never read/write the OS clipboard or request a persistent permission.
        await page.addInitScript(() =>
            Object.defineProperty(navigator, "clipboard", {
                configurable: true,
                value: {
                    writeText: async (value) => {
                        window.__copied = value;
                    },
                },
            }),
        );
        const response = await page.goto(`${origin}/SpecPi/${route}`, { waitUntil: "load" });
        assert.equal(response.status(), 200);
        await page.locator("h1").waitFor({ state: "visible" });
        assert.ok((await page.locator("h1").innerText()).trim().length > 5);
        await page.evaluate(async () => {
            await document.fonts.ready;
            await document.fonts.load('16px "Plex Sans"');
            await document.fonts.load('16px "Plex Mono"');
        });
        assert.equal(
            await page.evaluate(
                () => document.fonts.check('16px "Plex Sans"') && document.fonts.check('16px "Plex Mono"'),
            ),
            true,
        );
        if (fault === "runtime") {
            await page.evaluate(() =>
                setTimeout(() => {
                    throw new Error("injected runtime fault");
                }, 0),
            );
            await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
        }

        if (fault === "layout") {
            await page.addStyleTag({ content: "body { min-width: 6000px !important; }" });
        }

        if (fault === "interaction") {
            await page
                .locator('[data-guard-mode="strict"]')
                .evaluate((element) => element.replaceWith(element.cloneNode(true)));
        }

        if (!route) {
            for (const [mode, expected] of Object.entries(GUARD_MODES)) {
                await page.locator(`[data-guard-mode="${mode}"]`).click();
                await expectText(page, "[data-guard-current]", mode);
                await selectedTab(page, `[data-guard-mode="${mode}"]`, "#guard-comparison");
                assert.deepEqual(
                    await page.locator("[data-guard-verdict]").allTextContents(),
                    expected.verdicts.map(([text]) => text),
                );
            }

            await page.locator('[data-guard-mode="off"]').press("Home");
            await selectedTab(page, '[data-guard-mode="guard"]', "#guard-comparison");
            assert.equal(
                await page
                    .locator('[data-guard-mode="guard"]')
                    .evaluate((element) => element === document.activeElement),
                true,
            );
            await page.keyboard.press("ArrowRight");
            await selectedTab(page, '[data-guard-mode="strict"]', "#guard-comparison");
            for (let index = 0; index < CYCLE_STAGES.length; index++) {
                await page.locator(`[data-cycle-step="${index}"]`).click();
                await expectText(page, "[data-cycle-status]", CYCLE_STAGES[index].status);
                await expectText(page, "[data-cycle-number]", String(index + 1).padStart(2, "0"));
                await selectedTab(page, `[data-cycle-step="${index}"]`, "#cycle-panel");
            }

            await page.locator('[data-cycle-step="6"]').press("Home");
            await selectedTab(page, '[data-cycle-step="0"]', "#cycle-panel");
            await page.keyboard.press("End");
            await selectedTab(page, '[data-cycle-step="6"]', "#cycle-panel");
            await page.locator("[data-copy-target]").click();
            await expectText(page, "[data-copy-status]", "Commands copied.");
            assert.equal(
                await page.evaluate(() => window.__copied),
                await page.locator("#install-command").textContent(),
            );
            await page.evaluate(() =>
                Object.defineProperty(navigator, "clipboard", {
                    value: {
                        writeText: async () => {
                            throw new Error("synthetic clipboard denial");
                        },
                    },
                }),
            );
            await page.locator("[data-copy-target]").click();
            await expectText(
                page,
                "[data-copy-status]",
                "Clipboard unavailable. Select and copy the commands in the terminal block.",
            );
        }

        for (const details of await page.locator("details").all()) {
            const summary = details.locator(":scope > summary");
            if (!(await details.evaluate((element) => element.open))) {
                await summary.click();
            }

            assert.equal(await details.evaluate((element) => element.open), true);
        }

        await page.evaluate(() => {
            for (const image of document.images) {
                image.loading = "eager";
            }
        });
        await page.waitForFunction(() =>
            [...document.images].every((image) => image.complete && image.naturalWidth > 0),
        );
        assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            true,
            "horizontal document overflow",
        );
        const localNavigation = page.locator(".header-nav a");
        const hrefs = await localNavigation.evaluateAll((elements) => elements.map((element) => element.href));
        for (const href of hrefs.filter((href) => href.startsWith(`${origin}/SpecPi/`))) {
            const link = page.locator(".header-nav a").filter({ visible: true });
            const index = await link.evaluateAll(
                (elements, href) => elements.findIndex((element) => element.href === href),
                href,
            );
            assert.ok(index >= 0, "local navigation reachable");
            await link.nth(index).click();
            await page.waitForURL((url) => url.href === href);
            await page.locator("h1").waitFor({ state: "visible" });
        }

        await page.goto(`${origin}/SpecPi/${route}`, { waitUntil: "load" });
        const fragment = page.locator(".skip-link");
        if (await fragment.count()) {
            const href = await fragment.getAttribute("href");
            await page.keyboard.press("Tab");
            assert.equal(
                await fragment.evaluate((element) => element === document.activeElement),
                true,
                "skip link is the first keyboard stop",
            );
            await fragment.press("Enter");
            await page.waitForURL((url) => url.hash === href);
            await page.locator(href).waitFor({ state: "visible" });
        }

        assert.deepEqual(externalRequests, []);
        assert.deepEqual(diagnostics.read({ maxEntries: 100 }).records, [], "unexpected browser diagnostics");
        assert.equal(diagnostics.read().droppedRecords, 0, "diagnostics overflow must not hide errors");
    } finally {
        detach();
        await page.unrouteAll({ behavior: "wait" });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const server = await startSiteServer();
    console.log(`${server.origin}/SpecPi/`);
    for (const event of ["SIGINT", "SIGTERM"]) {
        process.once(event, async () => {
            await server.close();
        });
    }
}
