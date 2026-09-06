import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { conversationItems, dateGroup, relativeTime, conversationStatus } = require("../vscode/media/chat-picker.js");

test("conversation history separates archived entries, searches titles and workspaces, and sorts by activity", () => {
    const entries = [
        { id: "first", title: "  Review branch  ", updatedAt: 100 },
        { id: "second", title: "Plan sidebar", workspaceName: "SpecPi", updatedAt: new Date(300).toISOString() },
        { id: "archive", title: "Archived branch", updatedAt: 400, archived: true },
        { id: "third", title: "Review tests", updatedAt: 200 },
    ];
    assert.deepEqual(
        conversationItems(entries, { now: 500 }).map((item) => item.id),
        ["second", "third", "first"],
    );
    assert.deepEqual(
        conversationItems(entries, { query: " REVIEW ", now: 500 }).map((item) => item.title),
        ["Review tests", "Review branch"],
    );
    assert.deepEqual(
        conversationItems(entries, { query: "specpi", now: 500 }).map((item) => item.id),
        ["second"],
    );
    assert.deepEqual(
        conversationItems(entries, { archived: true, now: 500 }).map((item) => item.id),
        ["archive"],
    );
    assert.equal(entries[0].title, "  Review branch  ");
});

test("conversation history bounds malformed metadata without interpreting titles as markup", () => {
    const now = 500;
    const entries = [
        null,
        { id: "" },
        { id: 12 },
        { id: "x".repeat(4097) },
        { id: "script", title: '<img src="remote" onerror="run()">', updatedAt: "not a date" },
        { id: "script", title: "duplicate" },
        { id: "blank", title: "  ", updatedAt: -2 },
        { id: "long", title: "x".repeat(1000), workspaceName: "w".repeat(1000), updatedAt: now + 1000 },
    ];
    const items = conversationItems(entries, { now });
    assert.equal(items.length, 3);
    assert.equal(items[0].title.length, 500);
    assert.equal(items[0].workspaceName.length, 160);
    assert.equal(items[0].updatedAt, now);
    assert.equal(items.find((item) => item.id === "script").title, '<img src="remote" onerror="run()">');
    assert.equal(items.find((item) => item.id === "blank").title, "Untitled conversation");
    assert.equal(items.find((item) => item.id === "blank").updatedAt, 0);
    assert.deepEqual(conversationItems(undefined), []);
    assert.equal(conversationItems(Array.from({ length: 1200 }, (_, index) => ({ id: String(index) }))).length, 1000);
});

test("history date groups use local calendar days rather than elapsed 24-hour buckets", () => {
    const now = new Date(2026, 8, 5, 0, 5).getTime();
    assert.equal(dateGroup(new Date(2026, 8, 5, 0, 1).getTime(), now), "Today");
    assert.equal(dateGroup(new Date(2026, 8, 4, 23, 59).getTime(), now), "Yesterday");
    assert.equal(dateGroup(new Date(2026, 8, 2, 23, 59).getTime(), now), "Previous 7 days");
    assert.equal(dateGroup(new Date(2026, 7, 1).getTime(), now), "Earlier");
    assert.equal(dateGroup(0, now), "Earlier");
    assert.equal(relativeTime(now, now), "now");
    assert.equal(relativeTime(now - 120000, now), "2m");
    assert.equal(relativeTime(now - 4 * 3600000, now), "4h");
    assert.equal(relativeTime(now - 3 * 86400000, now), "3d");
    assert.equal(relativeTime(0, now), "");
});

test("conversation status prioritizes active work and input requests over unread completion", () => {
    assert.equal(conversationStatus({ status: "ready" }), "");
    assert.equal(conversationStatus({ status: "ready", unread: true }), "Unread");
    assert.equal(conversationStatus({ status: "busy", unread: true }), "Running");
    assert.equal(conversationStatus({ status: "retrying" }), "Running");
    assert.equal(conversationStatus({ status: "compacting" }), "Running");
    assert.equal(conversationStatus({ status: "needs-input", unread: true }), "Needs input");
    assert.equal(conversationStatus({ status: "connecting" }), "Connecting");
    assert.equal(conversationStatus({ status: "error" }), "Error");
});
