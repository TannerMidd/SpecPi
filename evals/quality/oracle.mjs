import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { qualityTask } from "./fixtures.mjs";

export async function evaluateTask(id, directory, { chromium } = {}) {
    const root = path.resolve(directory);
    const task = qualityTask(id);
    const load = (file) => import(pathToFileURL(path.join(root, file)).href);
    if (id === "page-boundary") {
        const { pageInfo } = await load("main.mjs");
        for (const [total, page, size, hasNext, count] of [
            [10, 0, 10, false, 10],
            [11, 0, 10, true, 10],
            [11, 1, 10, false, 1],
            [0, 0, 10, false, 0],
            [3, 2, 2, false, 0],
        ]) {
            assert.deepEqual(pageInfo(total, page, size), { hasNext, count });
        }
    } else if (id === "explicit-zero") {
        const { retryDelay } = await load("main.mjs");
        assert.deepEqual(retryDelay({ retries: 0, delayMs: 0 }), { retries: 0, delayMs: 0 });
        assert.deepEqual(retryDelay(), { retries: 3, delayMs: 100 });
        assert.equal(retryDelay({ retries: null }).retries, 3);
        assert.equal(retryDelay({ retries: 7 }).retries, 7);
    } else if (id === "caller-migration") {
        const { formatAmount } = await load("format.mjs");
        const { cartTotal } = await load("main.mjs");
        const { invoiceTotal } = await load("billing/invoice.mjs");
        assert.equal(formatAmount(120, { currency: "CAD" }), "CAD 1.20");
        assert.equal(formatAmount(0), "USD 0.00");
        assert.equal(cartTotal(2099), "EUR 20.99");
        assert.equal(invoiceTotal(-250), "GBP -2.50");
    } else if (id === "path-boundary") {
        const { isWithin } = await load("main.mjs");
        assert.equal(isWithin("/repo", "/repository/file"), false);
        assert.equal(isWithin("/repo", "/repo-old"), false);
        assert.equal(isWithin("/repo", "/repo"), true);
        assert.equal(isWithin("/repo", "/repo/lib/file"), true);
        assert.equal(isWithin("/", "/any/path"), true);
    } else if (id === "stale-check") {
        const { receiptFresh } = await load("main.mjs");
        const before = { head: "abc", inputs: { "source.mjs": "a", "check.mjs": "b", "config.json": "c" } };
        assert.equal(receiptFresh(before, structuredClone(before)), true);
        assert.equal(
            receiptFresh(before, { ...before, inputs: Object.fromEntries(Object.entries(before.inputs).reverse()) }),
            true,
        );
        for (const key of Object.keys(before.inputs)) {
            const after = structuredClone(before);
            after.inputs[key] += "changed";
            assert.equal(receiptFresh(before, after), false);
            delete after.inputs[key];
            assert.equal(receiptFresh(before, after), false);
        }

        assert.equal(receiptFresh(before, { ...before, inputs: { ...before.inputs, "new.mjs": "new" } }), false);
        assert.equal(
            fs.readFileSync(path.join(root, "known-baseline.test.mjs"), "utf8"),
            task.files["known-baseline.test.mjs"],
        );
    } else if (id === "existing-reuse") {
        const { list } = await load("main.mjs");
        const { detail } = await load("detail.mjs");
        assert.deepEqual(list(["pending", "done", "missing"]), [
            "Status: Awaiting review",
            "Status: Complete",
            "Status: Unknown",
        ]);
        assert.deepEqual(list(["done", "missing"]), [detail("done"), detail("missing")]);
    } else if (id === "intentional-interface") {
        const { FormatterRegistry } = await load("main.mjs");
        const registry = new FormatterRegistry();
        registry.register("external", (value) => `external:${value}`);
        assert.equal(registry.format("external", "ok"), "external:ok");
        assert.throws(() => registry.register("external", String), /Duplicate/);
        assert.throws(() => registry.format("missing", "ok"), /Unknown/);
    } else if (id === "browser-persistence") {
        if (!chromium) {
            throw new Error("Browser oracle requires Chromium; missing coverage is not a pass");
        }

        const server = createServer((request, response) => {
            const name = request.url === "/" ? "index.html" : request.url === "/app.mjs" ? "app.mjs" : null;
            if (!name) {
                response.writeHead(404).end();

                return;
            }

            try {
                response.setHeader("Content-Type", name.endsWith("html") ? "text/html" : "text/javascript");
                response.end(fs.readFileSync(path.join(root, name)));
            } catch {
                response.writeHead(404).end();
            }
        });
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        let browser;
        try {
            browser = await chromium.launch({ headless: true });
            const page = await browser.newPage();
            await page.goto(`http://127.0.0.1:${server.address().port}/`);
            const name = '<img src=x onerror="window.injected=true">';
            await page.getByRole("textbox", { name: "Name" }).fill(`  ${name}  `);
            await page.getByRole("button", { name: "Save" }).click();
            await page.reload();
            assert.equal(await page.locator("#saved").textContent(), name);
            assert.equal(await page.locator("#saved img").count(), 0);
            await page.getByRole("textbox", { name: "Name" }).fill("   ");
            await page.getByRole("button", { name: "Save" }).click();
            await page.reload();
            assert.equal(await page.locator("#saved").textContent(), name);
        } finally {
            await browser?.close();
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    }

    return { task: id, acceptance: "passed", maintainability: "requires-human-review" };
}
