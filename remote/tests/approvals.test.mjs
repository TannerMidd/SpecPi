import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ApprovalRegistry, buildResponse } from "../src/approvals.js";

function harness({ displayBudgetBytes } = {}) {
    const written = [];
    const broadcasts = [];
    const registry = new ApprovalRegistry({
        bridge: { write: (record) => written.push(record) },
        broadcast: (payload) => broadcasts.push(payload),
        ...(displayBudgetBytes ? { displayBudgetBytes } : {}),
    });

    return { registry, written, broadcasts };
}

const selectRequest = {
    type: "extension_ui_request",
    id: "req-1",
    method: "select",
    title: "Allow dangerous command?",
    options: ["Allow", "Block"],
};

test("a dialog with no live connection is cancelled immediately", () => {
    const { registry, written } = harness();
    const result = registry.handleRequest(selectRequest, null);
    assert.equal(result.outcome, "cancelled");
    assert.equal(result.reason, "no-connection");
    assert.deepEqual(written, [{ type: "extension_ui_response", id: "req-1", cancelled: true }]);
});

test("a dialog past the display budget is cancelled, not truncated", () => {
    const { registry, written } = harness({ displayBudgetBytes: 200 });
    const result = registry.handleRequest({ ...selectRequest, message: "x".repeat(5000) }, "conn-1");
    assert.equal(result.reason, "display-budget");
    assert.equal(written[0].cancelled, true);
});

test("an unknown dialog method is cancelled", () => {
    const { registry, written } = harness();
    const result = registry.handleRequest({ ...selectRequest, method: "hologram" }, "conn-1");
    assert.equal(result.reason, "unsupported-dialog");
    assert.equal(written[0].cancelled, true);
});

test("a fire-and-forget request is shown but never answered", () => {
    const { registry, written, broadcasts } = harness();
    const result = registry.handleRequest({ id: "n-1", method: "notify", message: "hi" }, "conn-1");
    assert.equal(result.outcome, "notice");
    // Answering a fire-and-forget method desynchronises the sub-protocol.
    assert.equal(written.length, 0);
    assert.equal(broadcasts[0].type, "notice");
});

test("expiry cancels rather than granting, ahead of the agent's own timeout", async () => {
    const { registry, written } = harness();
    const result = registry.handleRequest({ ...selectRequest, timeout: 1800 }, "conn-1");
    assert.equal(result.outcome, "pending");
    // 1800ms agent timeout minus the 1500ms margin leaves 300ms for us.
    assert.ok(result.expiresInMs < 1800, "daemon must fire before the agent auto-resolves");
    await delay(result.expiresInMs + 150);
    assert.deepEqual(written, [{ type: "extension_ui_response", id: "req-1", cancelled: true }]);
});

test("a very short agent timeout still leaves a usable floor", () => {
    const { registry } = harness();
    const result = registry.handleRequest({ ...selectRequest, timeout: 100 }, "conn-1");
    assert.ok(result.expiresInMs >= 250);
});

test("only the owning connection can answer", () => {
    const { registry, written } = harness();
    registry.handleRequest(selectRequest, "conn-1");
    const wrong = registry.answer("req-1", "conn-2", { value: "Allow" });
    assert.deepEqual(wrong, { ok: false, reason: "wrong-connection" });
    assert.equal(written.length, 0);

    const right = registry.answer("req-1", "conn-1", { value: "Allow" });
    assert.equal(right.ok, true);
    assert.deepEqual(written, [{ type: "extension_ui_response", id: "req-1", value: "Allow" }]);
});

test("answering an unknown request is refused", () => {
    const { registry } = harness();
    assert.deepEqual(registry.answer("nope", "conn-1", { value: "Allow" }), {
        ok: false,
        reason: "unknown-request",
    });
});

test("disconnect cancels everything that connection owned", () => {
    const { registry, written } = harness();
    registry.handleRequest(selectRequest, "conn-1");
    registry.handleRequest({ ...selectRequest, id: "req-2" }, "conn-1");
    registry.handleRequest({ ...selectRequest, id: "req-3" }, "conn-2");

    const cancelled = registry.cancelForConnection("conn-1");
    assert.deepEqual(cancelled.sort(), ["req-1", "req-2"]);
    assert.equal(written.length, 2);
    assert.ok(written.every((record) => record.cancelled === true));
    // The other connection's dialog is untouched.
    assert.equal(registry.snapshot().length, 1);
});

test("a cancelled dialog cannot then be answered", () => {
    const { registry } = harness();
    registry.handleRequest(selectRequest, "conn-1");
    registry.cancelForConnection("conn-1");
    assert.deepEqual(registry.answer("req-1", "conn-1", { value: "Allow" }), {
        ok: false,
        reason: "unknown-request",
    });
});

test("shutdown cancels every pending dialog", () => {
    const { registry, written } = harness();
    registry.handleRequest(selectRequest, "conn-1");
    registry.handleRequest({ ...selectRequest, id: "req-2" }, "conn-2");
    registry.cancelAll();
    assert.equal(written.length, 2);
    assert.equal(registry.snapshot().length, 0);
});

test("a dead agent does not crash the cancel path", () => {
    const registry = new ApprovalRegistry({
        bridge: {
            write() {
                throw new Error("Pi is not running");
            },
        },
        broadcast() {},
    });
    registry.handleRequest(selectRequest, "conn-1");
    assert.doesNotThrow(() => registry.cancelAll());
});

test("buildResponse refuses an answer that does not fit its dialog", () => {
    // A malformed confirm must not be coerced into a grant.
    assert.equal(buildResponse({ id: "a", method: "confirm" }, { value: "yes" }), null);
    assert.equal(buildResponse({ id: "a", method: "confirm" }, {}), null);
    assert.equal(buildResponse({ id: "a", method: "input" }, { value: 42 }), null);
    assert.equal(buildResponse({ id: "a", method: "select" }, null), null);
});

test("buildResponse refuses a select option the agent never offered", () => {
    const request = { id: "a", method: "select", options: ["Allow", "Block"] };
    assert.equal(buildResponse(request, { value: "Allow forever" }), null);
    assert.deepEqual(buildResponse(request, { value: "Block" }), {
        type: "extension_ui_response",
        id: "a",
        value: "Block",
    });
});

test("buildResponse honours an explicit cancel for any dialog kind", () => {
    for (const method of ["select", "confirm", "input", "editor"]) {
        assert.deepEqual(buildResponse({ id: "a", method }, { cancelled: true }), {
            type: "extension_ui_response",
            id: "a",
            cancelled: true,
        });
    }
});

test("buildResponse maps confirm to a boolean", () => {
    assert.deepEqual(buildResponse({ id: "a", method: "confirm" }, { confirmed: false }), {
        type: "extension_ui_response",
        id: "a",
        confirmed: false,
    });
});
