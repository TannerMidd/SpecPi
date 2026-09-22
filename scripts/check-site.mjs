#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.join(root, "site");
const readJson = async (file) => JSON.parse(await fs.readFile(path.join(root, file), "utf8"));
const manifest = await readJson("package.json");
const chat = await readJson("vscode/package.json");
const settings = await readJson("templates/settings.json");

// Versions are spelled out in prose and in download URLs across the docs as well as the site.
// They drift: both extension docs sat on the v0.23.0 tag through a release, so their download
// links would have 404'd against the next VSIX filename, and nothing here looked at them. The
// site's own link was checked against the manifests; these spellings were not.
const documents = [
    "README.md",
    "vscode/README.md",
    "vscode/GUIDE.md",
    "site/index.html",
    "site/wiki/index.html",
    "site/research/index.html",
    "site/evaluations/index.html",
    "site/jev/index.html",
];
for (const file of documents) {
    const text = await fs.readFile(path.join(root, file), "utf8");
    const spelled = (pattern, expected, label) => {
        for (const [match, found] of text.matchAll(pattern)) {
            assert.equal(found, expected, `${file} names ${label} ${found} rather than ${expected}: "${match}"`);
        }
    };

    // The site's version badges name the extension without the product in front of it, so a
    // bare "Chat 0.11.1" there has to be current. Prose may name an old one on purpose --
    // GUIDE.md troubleshoots a get_state timeout against Chat 0.1.0 -- so the documents are
    // held only to the "SpecPi Chat" form that states what this release ships.
    const names = file.startsWith("site/") ? /Chat \*{0,2}(\d+\.\d+\.\d+)/gu : /SpecPi Chat \*{0,2}(\d+\.\d+\.\d+)/gu;
    spelled(names, chat.version, "Chat");
    spelled(/SpecPi (?!Chat)\*{0,2}(\d+\.\d+\.\d+)/gu, manifest.version, "SpecPi");
    spelled(/specpi-chat-(\d+\.\d+\.\d+)\.vsix/gu, chat.version, "a VSIX built from Chat");
    spelled(/releases\/download\/v(\d+\.\d+\.\d+)/gu, manifest.version, "the release tag");
}

const routes = new Map([
    ["/SpecPi/", ["index.html", "text/html"]],
    ["/SpecPi/styles.css", ["styles.css", "text/css"]],
    ["/SpecPi/wiki.css", ["wiki.css", "text/css"]],
    ["/SpecPi/research.css", ["research.css", "text/css"]],
    ["/SpecPi/research/context-measurement.json", ["research/context-measurement.json", "application/json"]],
    ["/SpecPi/evaluations/terminal-bench-2.json", ["evaluations/terminal-bench-2.json", "application/json"]],
    ["/SpecPi/theme.js", ["theme.js", "text/javascript"]],
    ["/SpecPi/page.js", ["page.js", "text/javascript"]],
    ["/SpecPi/logo.svg", ["logo.svg", "image/svg+xml"]],
    ...["wiki", "research", "evaluations", "jev", "why-pi", "single-agent"].map((name) => [
        `/SpecPi/${name}/`,
        [`${name}/index.html`, "text/html"],
    ]),
]);
for (const directory of ["fonts", "media"]) {
    for (const file of await fs.readdir(path.join(site, directory))) {
        const contentType = { ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" }[
            path.extname(file)
        ];
        if (contentType) {
            routes.set(`/SpecPi/${directory}/${file}`, [`${directory}/${file}`, contentType]);
        }
    }
}

const server = http.createServer(async (request, response) => {
    const route = routes.get(new URL(request.url, "http://localhost").pathname);
    if (!route) {
        response.writeHead(404).end();

        return;
    }

    try {
        response.writeHead(200, { "Content-Type": `${route[1]}; charset=utf-8` });
        response.end(await fs.readFile(path.join(site, route[0])));
    } catch {
        response.destroy();
    }
});
await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const screenshots = path.join(root, ".specpi-test", "site");
await fs.mkdir(screenshots, { recursive: true });
let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
        if (message.type() === "error") {
            errors.push(message.text());
        }
    });
    page.on("response", (response) => {
        if (response.status() >= 400) {
            errors.push(`${response.status()} ${response.url()}`);
        }
    });
    for (const [name, width, height, colorScheme] of [
        ["desktop", 1440, 1000, "light"],
        ["tablet", 820, 1180, "light"],
        ["mobile", 390, 844, "light"],
        ["mobile-dark", 390, 844, "dark"],
    ]) {
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme });
        await page.goto(`${origin}/SpecPi/`);
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.locator("h1").innerText(), "Pi, beside\nyour code.");
        assert.ok((await page.locator(".edition").innerText()).includes(manifest.version));
        if ((await page.locator("html").getAttribute("data-theme")) !== colorScheme) {
            await page.getByRole("button", { name: "Dark mode", exact: true }).click();
        }

        assert.equal(await page.locator("html").getAttribute("data-theme"), colorScheme);
        assert.equal(await page.evaluate(() => document.fonts.check('400 16px "Plex Sans"')), true);
        const rows = await page.locator(".package-grid li").allTextContents();
        assert.equal(rows.length, settings.packages.length);
        for (const source of settings.packages) {
            const at = source.lastIndexOf("@");
            const name = source.slice(4, at);
            const version = source.slice(at + 1);
            assert.ok(
                rows.some((row) => row.includes(name) && row.includes(version)),
                `${name} pin is out of date`,
            );
        }

        const download = `https://github.com/TannerMidd/SpecPi/releases/download/v${manifest.version}/${chat.name}-${chat.version}.vsix`;
        assert.equal(
            await page.getByRole("link", { name: `Download SpecPi Chat ${chat.version}` }).getAttribute("href"),
            download,
        );
        const layout = await page.evaluate(() => ({
            width: document.documentElement.clientWidth,
            contentWidth: document.documentElement.scrollWidth,
            missingAnchors: [...document.querySelectorAll('a[href^="#"]')]
                .map((link) => link.getAttribute("href").slice(1))
                .filter((id) => !document.getElementById(id)),
        }));
        assert.ok(layout.contentWidth <= layout.width, `${name} has horizontal page overflow`);
        assert.deepEqual(layout.missingAnchors, []);
        await page.getByRole("link", { name: "Install SpecPi", exact: true }).click();
        assert.equal(new URL(page.url()).hash, "#install");
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
        await page.getByRole("button", { name: "Copy commands", exact: true }).click();
        assert.equal(
            (await page.evaluate(() => navigator.clipboard.readText())).replaceAll("\r\n", "\n"),
            await page.locator("#install-command").innerText(),
        );
        await page.screenshot({ path: path.join(screenshots, `${name}.png`), fullPage: true });
        await page.getByRole("link", { name: "Docs", exact: true }).click();
        await page.waitForURL(`${origin}/SpecPi/wiki/`);
        assert.ok((await page.locator(".index-meta").innerText()).includes(manifest.version));
        assert.equal(await page.locator("html").getAttribute("data-theme"), colorScheme);
        assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
            true,
            `${name} docs overflow`,
        );
        await page.locator('.wiki-sidebar a[href="#scope"]').click();
        assert.equal(new URL(page.url()).hash, "#scope");
        await page.screenshot({ path: path.join(screenshots, `docs-${name}.png`), fullPage: true });
        await page.getByRole("link", { name: "Research", exact: true }).click();
        await page.waitForURL(`${origin}/SpecPi/research/`);
        assert.ok((await page.locator(".index-meta").innerText()).includes(chat.version));
        assert.equal(await page.locator("html").getAttribute("data-theme"), colorScheme);
        const research = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            missingAnchors: [...document.querySelectorAll('a[href^="#"]')]
                .map((link) => link.getAttribute("href").slice(1))
                .filter((id) => !document.getElementById(id)),
            sections: document.querySelectorAll(".doc-section").length,
            navLinks: document.querySelectorAll(".wiki-sidebar nav a").length,
        }));
        assert.equal(research.overflow, false, `${name} research overflows`);
        assert.deepEqual(research.missingAnchors, []);
        // Every sidebar entry must reach a section, or the contents read as broken.
        assert.equal(research.sections, research.navLinks);
        await page.screenshot({ path: path.join(screenshots, `research-${name}.png`), fullPage: true });
        await page.locator("#chart-context").screenshot({ path: path.join(screenshots, `context-${name}.png`) });
        await page.locator("#chart-capability").screenshot({ path: path.join(screenshots, `capability-${name}.png`) });
        const measurement = await page.request.get(`${origin}/SpecPi/research/context-measurement.json`);
        assert.equal(measurement.status(), 200);

        // The evaluations page draws itself from terminal-bench-2.json: every figure is
        // injected by scripts/tb2-site.mjs and the headline metrics are read at load. An
        // empty slot means a run was published without regenerating the page, which would
        // leave prose asserting numbers no chart supports.
        await page.getByRole("link", { name: "Evals", exact: true }).click();
        await page.waitForURL(`${origin}/SpecPi/evaluations/`);
        assert.equal(await page.locator("html").getAttribute("data-theme"), colorScheme);
        assert.ok((await page.locator(".index-meta").innerText()).includes(manifest.version));
        await page.locator("#metric-row div").first().waitFor();
        const evaluations = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            missingAnchors: [...document.querySelectorAll('a[href^="#"]')]
                .map((link) => link.getAttribute("href").slice(1))
                .filter((id) => !document.getElementById(id)),
            sections: document.querySelectorAll(".doc-section").length,
            navLinks: document.querySelectorAll(".wiki-sidebar nav a").length,
            charts: document.querySelectorAll(".chart").length,
            tableRows: document.querySelectorAll("#table-overall tbody tr").length,
            metrics: document.querySelectorAll("#metric-row div").length,
            unfilled: [...document.querySelectorAll("[data-eval]")].filter((node) => node.textContent.trim() === "")
                .length,
            generated: document.getElementById("meta-generated").textContent,
        }));
        assert.equal(evaluations.overflow, false, `${name} evaluations overflows`);
        assert.deepEqual(evaluations.missingAnchors, []);
        assert.equal(evaluations.sections, evaluations.navLinks);
        assert.equal(evaluations.charts, 5, "every chart slot must hold a rendered figure");
        assert.ok(evaluations.tableRows > 0, "the summary table was not generated");
        assert.equal(evaluations.metrics, 4, "headline metrics did not load from terminal-bench-2.json");
        assert.equal(evaluations.unfilled, 0, "a figure quoted in the prose was not filled from the dataset");
        assert.match(evaluations.generated, /^Run \d{4}-\d{2}-\d{2}$/u);
        await page.screenshot({ path: path.join(screenshots, `evaluations-${name}.png`), fullPage: true });

        await page.getByRole("link", { name: "Jev", exact: true }).click();
        await page.waitForURL(`${origin}/SpecPi/jev/`);
        assert.ok((await page.locator(".index-meta").innerText()).includes(manifest.version));
        assert.equal(await page.locator("html").getAttribute("data-theme"), colorScheme);
        const flows = page.locator("details.system-flow");
        assert.equal(await flows.count(), 6);
        assert.equal(await page.locator("details.system-flow[open]").count(), 0);
        await page.screenshot({ path: path.join(screenshots, `jev-${name}.png`), fullPage: true });
        for (const flow of await flows.all()) {
            await flow.locator("summary").click();
            assert.notEqual(await flow.getAttribute("open"), null);
            const id = await flow.locator("svg").getAttribute("id");
            assert.ok(await flow.locator("svg").getAttribute("aria-label"));
            const frame = flow.locator("div");
            await frame.screenshot({ path: path.join(screenshots, `${id}-${name}.png`) });
            const scroll = await frame.evaluate((element) => {
                element.scrollLeft = element.scrollWidth;

                return { overflow: element.scrollWidth > element.clientWidth, left: element.scrollLeft };
            });
            if (scroll.overflow) {
                assert.ok(scroll.left > 0, `${id} must scroll inside its container`);
                await frame.screenshot({ path: path.join(screenshots, `${id}-${name}-right.png`) });
            }

            await flow.locator("summary").focus();
            await page.keyboard.press("Enter");
            assert.equal(await flow.getAttribute("open"), null);
            await page.keyboard.press("Enter");
            assert.notEqual(await flow.getAttribute("open"), null);
        }

        const jev = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            missingAnchors: [...document.querySelectorAll('a[href^="#"]')]
                .map((link) => link.getAttribute("href").slice(1))
                .filter((id) => !document.getElementById(id)),
            boxes: [...document.querySelectorAll(".system-flow .dg-box")].map((box) => getComputedStyle(box).fill),
        }));
        assert.equal(jev.overflow, false, `${name} expanded Jev diagrams overflow the page`);
        assert.deepEqual(jev.missingAnchors, []);
        assert.ok(
            jev.boxes.length > 0 && jev.boxes.every((fill) => !["rgb(0, 0, 0)", "none"].includes(fill)),
            "diagram surfaces must resolve their theme tokens",
        );
        process.stdout.write(`Site ${name}: PASS\n`);
    }

    for (const [route, anchor] of [
        ["why-pi", "core"],
        ["single-agent", "packages"],
    ]) {
        await page.goto(`${origin}/SpecPi/${route}/`);
        await page.waitForURL(`${origin}/SpecPi/#${anchor}`);
    }

    assert.deepEqual(errors, []);
    process.stdout.write(
        "Site versions, package pins, fonts, themes, clipboard, documentation, redirects, and console: PASS\n",
    );
} finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
}
