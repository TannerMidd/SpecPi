import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { reduceAccessibility, scanAccessibility, MAX_ACCESSIBILITY_BYTES } from "../src/accessibility.ts";

test("accessibility evidence bounds both categories and excludes DOM/check payloads", () => {
    const finding = (id) => ({
        id,
        impact: "serious",
        help: "Fix this rule",
        helpUrl: "https://user:CANARY@example.test/rule?token=CANARY#CANARY",
        nodes: [{ target: ['[token="CANARY"]'], html: "DOMCANARY", any: [{ data: "CHECKCANARY" }] }],
    });
    const raw = {
        violations: Array.from({ length: 200 }, (_, i) => finding(`rule-${i}`)),
        incomplete: [finding("manual")],
        passes: [],
        inapplicable: [],
    };
    const reduced = reduceAccessibility(raw, 100);
    assert.equal(reduced.totals.violations, 200);
    assert.equal(reduced.incomplete.length, 1);
    assert.equal(reduced.truncated, true);
    const text = JSON.stringify(reduced);
    assert.ok(Buffer.byteLength(text) <= MAX_ACCESSIBILITY_BYTES - 4096);
    assert.doesNotMatch(text, /CANARY/u);
    assert.equal(reduced.violations[0].helpUrl, "https://example.test/rule");
});
test("scan reports unavailable scanner without opening a page", async () => {
    await assert.rejects(scanAccessibility({}, path.join(os.tmpdir(), "specpi-no-scanner")), /scanner unavailable/u);
});
test("hoisted scanner with private package metadata loads and navigation invalidates its evidence", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-a11y-race-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const axe = path.join(root, "node_modules", "axe-core");
    const adapter = path.join(root, "node_modules", "@axe-core", "playwright");
    fs.mkdirSync(axe, { recursive: true });
    fs.mkdirSync(path.join(adapter, "dist"), { recursive: true });
    const consumer = path.join(root, "consumer");
    fs.mkdirSync(consumer);
    fs.writeFileSync(path.join(consumer, "package.json"), "{}");
    fs.writeFileSync(path.join(axe, "package.json"), '{"version":"4.13.0"}');
    fs.writeFileSync(path.join(adapter, "package.json"), '{"version":"4.13.0","exports":{".":"./dist/index.js"}}');
    fs.writeFileSync(
        path.join(adapter, "dist", "index.js"),
        'module.exports.default = class { constructor({page}) { this.page=page; } withTags() { return this; } async analyze() { this.page.emit("framenavigated"); return {}; } };',
    );
    const page = new EventEmitter();
    await assert.rejects(scanAccessibility(page, consumer), /became stale/u);
    assert.equal(page.listenerCount("framenavigated"), 0);
});
