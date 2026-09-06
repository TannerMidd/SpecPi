import assert from "node:assert/strict";
import test from "node:test";
import imageQueueModule from "../vscode/src/image-queue.js";

const { ImageQueue } = imageQueueModule;

function image(id = "image", byteLength = 3) {
    // Synthetic prevalidated host attachments: the ledger must not parse pixels.
    return {
        id,
        kind: "image",
        type: "image",
        data: Buffer.alloc(byteLength, id.charCodeAt(0)).toString("base64"),
        mimeType: "image/png",
        byteLength,
        width: 1,
        height: 1,
        label: `${id}.png`,
        detail: "1 × 1",
        name: `${id}.png`,
    };
}

function tracked(queue, id, text = "Review", attachments = [image(id)]) {
    return queue.track({ id, text, message: `Formatted: ${text}`, attachments });
}

function userMessage(snapshot) {
    return {
        role: "user",
        content: [
            { type: "text", text: snapshot.message },
            ...snapshot.attachments
                .filter((attachment) => attachment.kind === "image")
                .map(({ data, mimeType }) => ({ type: "image", data, mimeType })),
        ],
    };
}

test("image queue recovers exact cleared strings and preserves unmatched plain-text prompts", () => {
    const queue = new ImageQueue();
    const first = tracked(queue, "first", "Review source", [
        { id: "file", label: "source.js", detail: "3 bytes", text: "abc" },
        image(),
    ]);
    const other = tracked(queue, "other", "Possibly running");
    const result = queue.recover({
        steering: [first.message, "Text-only steering"],
        followUp: ["Text-only follow-up"],
    });
    assert.deepEqual(result.drafts, [{ id: "first", text: "Review source", attachments: first.attachments }]);
    assert.deepEqual(result.remainingTexts, ["Text-only steering", "Text-only follow-up"]);
    assert.equal(result.droppedCount, 1);
    assert.equal(queue.pending.length, 0);
    assert.equal(queue.recovered.length, 1);
    assert.equal(queue.discard(other.id), false, "Uncertain running prompts must not be retained for recovery");
    assert.equal(queue.discard("first"), true);
    assert.equal(queue.recovered.length, 0);
});

test("identical queued text with different images consumes by exact image content then recovers FIFO", () => {
    const queue = new ImageQueue();
    const first = tracked(queue, "alpha");
    const second = tracked(queue, "beta");
    const third = tracked(queue, "gamma");
    assert.equal(queue.consume(userMessage(second)), true);
    assert.deepEqual(
        queue.pending.map((entry) => entry.id),
        ["alpha", "gamma"],
    );
    const result = queue.recover({ steering: [first.message], followUp: [third.message] });
    assert.deepEqual(
        result.drafts.map((entry) => entry.id),
        ["alpha", "gamma"],
    );
    assert.deepEqual(
        result.drafts.map((entry) => entry.attachments[0].data),
        [first.attachments[0].data, third.attachments[0].data],
    );
    assert.equal(result.droppedCount, 0);
    assert.deepEqual(result.remainingTexts, []);
});

test("identical queued text and images consume the first snapshot only", () => {
    const queue = new ImageQueue();
    const sameImage = image("same");
    const first = tracked(queue, "first", "Same", [sameImage]);
    tracked(queue, "second", "Same", [sameImage]);
    assert.equal(queue.consume({ type: "message_start", message: userMessage(first) }), true);
    assert.deepEqual(
        queue.pending.map((entry) => entry.id),
        ["second"],
    );
    assert.equal(queue.recover({ steering: [], followUp: [first.message] }).drafts[0].id, "second");
});

test("partial identical-text groups with different images cannot recover an uncertain image", () => {
    const queue = new ImageQueue();
    const first = tracked(queue, "alpha", "Identical text");
    tracked(queue, "beta", "Identical text");
    assert.deepEqual(queue.recover({ steering: [first.message], followUp: [] }), {
        drafts: [],
        remainingTexts: [first.message],
        droppedCount: 2,
    });
    assert.equal(queue.pending.length + queue.recovered.length, 0);
});

test("partial duplicate groups recover FIFO only when their image and file context is identical", () => {
    const queue = new ImageQueue();
    const attachment = image("same");
    const first = tracked(queue, "first", "Identical", [attachment]);
    tracked(queue, "second", "Identical", [attachment]);
    const result = queue.recover({ steering: [], followUp: [first.message] });
    assert.equal(result.drafts[0].id, "first");
    assert.equal(result.droppedCount, 1);
    assert.deepEqual(result.remainingTexts, []);
    queue.clear();
    const one = tracked(queue, "context-one", "Identical", [
        attachment,
        { id: "one-file", label: "one.js", text: "first content" },
    ]);
    tracked(queue, "context-two", "Identical", [
        attachment,
        { id: "two-file", label: "two.js", text: "different content" },
    ]);
    assert.deepEqual(queue.recover({ steering: [one.message], followUp: [] }), {
        drafts: [],
        remainingTexts: [one.message],
        droppedCount: 2,
    });
});

test("accepted user messages are not recovered and unrelated events cannot consume images", () => {
    const queue = new ImageQueue();
    const snapshot = tracked(queue, "accepted");
    assert.equal(queue.consume({ role: "assistant", content: userMessage(snapshot).content }), false);
    assert.equal(queue.consume({ role: "user", content: snapshot.message }), false);
    assert.equal(
        queue.consume({
            role: "user",
            content: [{ type: "text", text: "Changed formatted prompt" }, ...userMessage(snapshot).content.slice(1)],
        }),
        false,
    );
    assert.equal(queue.consume(userMessage(snapshot)), true);
    assert.equal(queue.consume(userMessage(snapshot)), false);
    assert.deepEqual(queue.recover({ steering: [], followUp: [] }), {
        drafts: [],
        remainingTexts: [],
        droppedCount: 0,
    });
});

test("repeated user-message start and end cannot consume a second identical queued prompt", () => {
    const queue = new ImageQueue();
    const same = image("same");
    const first = tracked(queue, "first", "Identical", [same]);
    tracked(queue, "second", "Identical", [same]);
    const message = { ...userMessage(first), timestamp: 123 };
    assert.equal(queue.consume({ type: "message_start", message }), true);
    assert.equal(queue.consume({ type: "message_end", message: structuredClone(message) }), false);
    assert.deepEqual(
        queue.pending.map((entry) => entry.id),
        ["second"],
    );
    assert.equal(queue.consume({ ...userMessage(first), timestamp: 124 }), true);
    assert.equal(queue.pending.length, 0);
});

test("image queue snapshots attachments immutably and copies only relevant fields", () => {
    const queue = new ImageQueue();
    const attachment = { ...image(), label: "a\nname", arbitrary: { private: true } };
    const input = [attachment];
    const snapshot = tracked(queue, "snapshot", "Original text", input);
    attachment.data = "changed";
    input.push(image("new"));
    assert.equal(snapshot.attachments.length, 1);
    assert.notEqual(snapshot.attachments[0].data, attachment.data);
    assert.equal(snapshot.attachments[0].label, "a name");
    assert.equal(snapshot.attachments[0].arbitrary, undefined);
    assert.throws(() => {
        snapshot.attachments[0].data = "replacement";
    }, TypeError);
    assert.throws(() => {
        queue.pending.push(snapshot);
    }, TypeError);
    const recovered = queue.recover({ steering: [], followUp: [snapshot.message] }).drafts[0];
    assert.throws(() => {
        recovered.attachments.push(image());
    }, TypeError);
    assert.equal(recovered.message, undefined);
});

test("image queue budgets include pending and recovered drafts until discard", () => {
    const queue = new ImageQueue();
    for (let index = 0; index < 8; index += 1) {
        tracked(queue, `queued-${index}`);
    }

    assert.throws(() => tracked(queue, "ninth"), /eight images and 20 MiB/u);
    queue.recover({ steering: queue.pending.map((entry) => entry.message), followUp: [] });
    assert.equal(queue.recovered.length, 8);
    assert.throws(() => tracked(queue, "still-full"), /eight images and 20 MiB/u);
    assert.equal(queue.discard("queued-0"), true);
    tracked(queue, "available");
    assert.equal(queue.pending.length, 1);
    assert.equal(queue.recovered.length, 7);
    queue.clear();
    assert.equal(queue.pending.length + queue.recovered.length, 0);
    const large = image("large", 5 * 1024 * 1024);
    tracked(
        queue,
        "limit",
        "Large files",
        Array.from({ length: 4 }, () => large),
    );
    assert.throws(() => tracked(queue, "over-byte-limit"), /eight images and 20 MiB/u);
});

test("image queue rejects malformed snapshots and duplicate identifiers without losing earlier entries", () => {
    const queue = new ImageQueue();
    const first = tracked(queue, "first");
    assert.throws(() => tracked(queue, "first"), /unique identifier/u);
    assert.throws(() => tracked(queue, "unsafe\nid"), /unique identifier/u);
    assert.throws(
        () => tracked(queue, "no-images", "Plain", [{ id: "text", label: "text", text: "context" }]),
        /containing images/u,
    );
    assert.throws(() => tracked(queue, "bad-image", "Bad", [{ ...image(), byteLength: 99 }]), /already be validated/u);
    assert.throws(() => tracked(queue, "big-text", "x".repeat(64 * 1024 + 1)), /text limit/u);
    assert.deepEqual(
        queue.pending.map((entry) => entry.id),
        [first.id],
    );
});

test("malformed clear_queue drops uncertain pending snapshots without inventing recovered images", () => {
    const queue = new ImageQueue();
    tracked(queue, "uncertain");
    assert.deepEqual(queue.recover({ steering: "invalid", followUp: [] }), {
        drafts: [],
        remainingTexts: [],
        droppedCount: 1,
    });
    assert.equal(queue.pending.length + queue.recovered.length, 0);
    tracked(queue, "another");
    assert.deepEqual(queue.recover(null), { drafts: [], remainingTexts: [], droppedCount: 1 });
    const valid = tracked(queue, "valid");
    assert.equal(queue.recover({ steering: [null, {}, valid.message], followUp: [42] }).drafts[0].id, "valid");
    queue.clear();
    assert.deepEqual(queue.recovered, []);
    assert.deepEqual(queue.recover({ steering: [], followUp: [] }), {
        drafts: [],
        remainingTexts: [],
        droppedCount: 0,
    });
});
