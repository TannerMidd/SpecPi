import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
    BrowserDiagnostics,
    sanitizeDiagnostic,
    sanitizeUrl,
    MAX_RECORD_BYTES,
    MAX_DIAGNOSTIC_BYTES,
} from "../extensions/browser/diagnostics.ts";

test("diagnostic sanitation removes URL secrets, credentials, terminal escapes, and bounds Unicode", () => {
    assert.equal(
        sanitizeUrl("https://user:URLCANARY@example.test/path?token=QUERYCANARY#HASHCANARY"),
        "https://example.test/path",
    );
    assert.equal(sanitizeUrl("data:text/plain,PRIVATECANARY"), "[non-http location]");
    const source =
        'https://user:URLCANARY@example.test/a?token=QUERYCANARY#HASHCANARY password=PASSWORDCANARY "api_key":"KEYCANARY" Authorization: Bearer BEARERCANARY secret="SECRET CANARY" \x1b[31mred\x1b[0m \x1b]8;;https://unsafe.test\x07link\x1b]8;;\x07';
    const clean = sanitizeDiagnostic(source);
    assert.doesNotMatch(clean, /CANARY|SECRET|\x1b|\x07/u);
    assert.match(clean, /redacted/u);
    assert.equal(sanitizeDiagnostic("a".repeat(699) + "😀").isWellFormed(), true);
    assert.ok(sanitizeDiagnostic("x".repeat(1000000)).length <= 700);
});

test("diagnostics bound retained bytes, record count, response budgets, pagination and cursor gaps", () => {
    const diagnostics = new BrowserDiagnostics();
    const first = diagnostics.read().nextCursor;
    for (let index = 0; index < 600; index++) {
        diagnostics.record("console", `${index} ${'😀"'.repeat(1000)}`);
    }

    const report = diagnostics.read({ cursor: first, maxEntries: 100, maxChars: 1000 });
    assert.ok(report.retainedRecords <= 200);
    assert.ok(report.retainedBytes <= MAX_DIAGNOSTIC_BYTES);
    assert.ok(report.droppedRecords > 0);
    assert.equal(report.cursorGap, true);
    assert.equal(report.hasMore, true);
    assert.ok(JSON.stringify(report).length <= 1000);
    assert.equal(report.records.length, 1);
    assert.equal(report.records[0].truncated, true);
    let cursor = report.nextCursor;
    let lastSequence = report.records[0].sequence;
    let remaining = true;
    while (remaining) {
        const next = diagnostics.read({ cursor, maxChars: 30000 });
        assert.ok(JSON.stringify(next).length <= 30000);
        for (const entry of next.records) {
            assert.ok(Buffer.byteLength(JSON.stringify(entry)) <= MAX_RECORD_BYTES);
            assert.ok(entry.sequence > lastSequence);
            lastSequence = entry.sequence;
        }

        remaining = next.hasMore;
        cursor = next.nextCursor;
    }

    assert.equal(lastSequence, 600);
});

test("filter and atomic clear disclose all discarded records; navigation preserves and reset isolates", () => {
    const diagnostics = new BrowserDiagnostics();
    diagnostics.record("pageerror", "startup");
    diagnostics.navigated();
    diagnostics.record("http", "HTTP 500", "https://test.invalid/?secret=hidden", { status: 500 });
    const report = diagnostics.read({ category: "pageerror", clear: true });
    assert.equal(report.records.length, 1);
    assert.equal(report.clearedRecords, 2);
    assert.equal(diagnostics.read().records.length, 0);
    assert.equal(diagnostics.read({ cursor: `${report.context}:0` }).cursorGap, true);
    diagnostics.record("console", "after clear");
    assert.equal(diagnostics.read().records[0].navigation, 1);
    diagnostics.reset();
    const fresh = diagnostics.read({ cursor: report.nextCursor });
    assert.equal(fresh.contextChanged, true);
    assert.equal(fresh.cursorGap, true);
    assert.equal(fresh.retainedBytes, 0);
    assert.equal(fresh.droppedRecords, 0);
});

test("redaction expansion and shortened metadata disclose truncation", () => {
    const diagnostics = new BrowserDiagnostics();
    diagnostics.record("console", "token=x ".repeat(60));
    diagnostics.record("requestfailed", "failure", "", { method: "M".repeat(21), resourceType: "r".repeat(31) });
    diagnostics.record("console", `https://example.test/${"p".repeat(350)}`);
    const encodedUrl = `https://example.test/${"é".repeat(60)}`;
    assert.ok(encodedUrl.length < 300);
    diagnostics.record("console", encodedUrl);
    diagnostics.record("http", "HTTP 500", encodedUrl);
    const records = diagnostics.read().records;
    assert.ok(records.every((entry) => entry.truncated));
    assert.ok(records[0].message.length <= 700);
    assert.doesNotMatch(records[0].message, /token=x/u);
});

test("diagnostics reject malformed bounds/cursors instead of silent incomplete success", () => {
    const diagnostics = new BrowserDiagnostics();
    for (const query of [
        { maxEntries: 0 },
        { maxEntries: Infinity },
        { maxChars: 999 },
        { maxChars: 30001 },
        { cursor: "bad" },
        { category: "log" },
        { clear: "yes" },
    ]) {
        assert.throws(() => diagnostics.read(query));
    }

    const report = diagnostics.read();
    assert.throws(() => diagnostics.read({ cursor: `${report.context}:1` }));
});

test("listeners distinguish HTTP and transport errors and detach without duplicates", () => {
    const page = new EventEmitter();
    const diagnostics = new BrowserDiagnostics();
    const off = diagnostics.attach(page);
    page.emit("pageerror", new Error("broken"));
    page.emit("console", { type: () => "log", text: () => "ignore" });
    page.emit("console", {
        type: () => "error",
        text: () => "console",
        location: () => ({ url: "https://test.invalid" }),
    });
    const request = {
        failure: () => ({ errorText: "failed" }),
        url: () => "https://test.invalid/?token=canary",
        method: () => "GET",
        resourceType: () => "fetch",
    };
    page.emit("requestfailed", request);
    page.emit("response", { status: () => 200 });
    page.emit("response", { status: () => 500, request: () => request, url: request.url });
    assert.deepEqual(
        diagnostics.read().records.map((entry) => entry.category),
        ["pageerror", "console", "requestfailed", "http"],
    );
    off();
    off();
    assert.equal(page.eventNames().length, 0);
});
