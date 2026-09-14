import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { mentionAtCursor, completeAcceptedMention } = require("../vscode/media/chat-extras.js");

test("file mention discovery follows the cursor and excludes emails or selections", () => {
    const draft = "Please inspect @src/app.ts and explain";
    const cursor = draft.indexOf(" and");
    const mention = mentionAtCursor(draft, cursor);
    assert.deepEqual(mention, { draft, start: 15, end: cursor, token: "@src/app.ts", query: "src/app.ts" });
    assert.equal(mentionAtCursor("hello@example.com", 17), null);
    assert.equal(mentionAtCursor("@@file", 6), null);
    assert.equal(mentionAtCursor(draft, 15, cursor), null);
    assert.equal(mentionAtCursor("@" + "x".repeat(257), 258), null);
    assert.equal(mentionAtCursor("@file", -1), null);
    assert.equal(mentionAtCursor("@file", 6), null);
    assert.equal(mentionAtCursor("Hello\n@", 7)?.query, "");
    assert.deepEqual(mentionAtCursor("@src/main.ts", 5), {
        draft: "@src/main.ts",
        start: 0,
        end: 12,
        token: "@src/main.ts",
        query: "src/",
    });
});

test("confirmed mentions complete the selected path and preserve surrounding text", () => {
    const draft = "Compare @src/one.ts with @src/two.ts";
    const cursor = draft.indexOf(" with");
    const mention = mentionAtCursor(draft, cursor);
    assert.deepEqual(completeAcceptedMention(draft, mention, "src/selected.ts"), {
        text: "Compare @src/selected.ts with @src/two.ts",
        cursor: 25,
    });
    const short = "Inspect @src";
    assert.deepEqual(completeAcceptedMention(short, mentionAtCursor(short, short.length), "src/my file.ts"), {
        text: 'Inspect @"src/my file.ts" ',
        cursor: 26,
    });
    assert.equal(completeAcceptedMention(draft + " please", mention, "file.ts"), null);
    assert.equal(completeAcceptedMention(draft.replace("one", "new"), mention, "file.ts"), null);
    assert.equal(completeAcceptedMention("", mention, "file.ts"), null);
    assert.equal(completeAcceptedMention(draft, null, "file.ts"), null);
});

test("confirmed folder mentions keep the trailing slash", () => {
    const draft = "Review @comp";
    const mention = mentionAtCursor(draft, draft.length);
    assert.deepEqual(completeAcceptedMention(draft, mention, "src/components/"), {
        text: "Review @src/components/ ",
        cursor: 24,
    });
});
