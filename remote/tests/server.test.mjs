// End-to-end over real HTTP against the synthetic peer.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RpcBridge } from "../src/rpc-bridge.js";
import { RemoteServer } from "../src/server.js";
import { TokenAuth } from "../src/auth.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const TOKEN = "test-token-value";
const silent = { log() {}, error() {} };

async function startServer() {
    const agentDir = await mkdtemp(path.join(tmpdir(), "specpi-remote-"));
    const bridge = new RpcBridge({
        command: process.execPath,
        args: [fixture],
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        requestTimeoutMs: 4000,
    });
    const auth = new TokenAuth({ token: TOKEN });
    const server = new RemoteServer({ bridge, auth, port: 0, logger: silent });
    bridge.start();
    const address = await server.listen();
    const streams = [];

    return {
        base: `http://127.0.0.1:${address.port}`,
        server,
        bridge,
        track(stream) {
            streams.push(stream);

            return stream;
        },
        async dispose() {
            for (const stream of streams) {
                stream.close();
            }

            await server.close();
            await bridge.stop();
            await rm(agentDir, { recursive: true, force: true });
        },
    };
}

function authed(extra = {}) {
    return { authorization: `Bearer ${TOKEN}`, ...extra };
}

async function post(base, route, body, headers = {}) {
    return fetch(`${base}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authed(headers) },
        body: JSON.stringify(body),
    });
}

// One reader for the life of the stream. Cancelling a reader closes the HTTP
// connection, and the daemon treats that as a disconnect — which cancels any
// pending approval. A test that wants to answer one has to keep it open.
async function openStream(base, headers = {}) {
    // An AbortController rather than reader.cancel(): aborting tears the socket
    // down at once, so the daemon sees the disconnect immediately instead of
    // waiting for the stream to drain.
    const controller = new AbortController();
    const response = await fetch(`${base}/events`, {
        headers: authed(headers),
        signal: controller.signal,
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const seen = [];
    let waiter = null;
    let buffer = "";

    const pump = (async () => {
        for (;;) {
            const { value, done } = await reader.read().catch(() => ({ done: true }));
            if (done) {
                return;
            }

            buffer += decoder.decode(value, { stream: true });
            let index = buffer.indexOf("\n\n");
            while (index >= 0) {
                const frame = buffer.slice(0, index);
                buffer = buffer.slice(index + 2);
                const line = frame.split("\n").find((part) => part.startsWith("data: "));
                index = buffer.indexOf("\n\n");
                if (!line) {
                    continue;
                }

                const payload = JSON.parse(line.slice(6));
                seen.push(payload);
                if (waiter && waiter.predicate(payload)) {
                    waiter.resolve(payload);
                    waiter = null;
                }
            }
        }
    })();

    return {
        response,
        seen,
        waitFor(predicate, budgetMs = 4000) {
            const existing = seen.find(predicate);
            if (existing) {
                return Promise.resolve(existing);
            }

            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    waiter = null;
                    reject(new Error(`No matching event within ${budgetMs}ms. Saw: ${JSON.stringify(seen)}`));
                }, budgetMs);
                waiter = {
                    predicate,
                    resolve(payload) {
                        clearTimeout(timer);
                        resolve(payload);
                    },
                };
            });
        },
        // Fire and forget. Awaiting the pump promise costs seconds on undici
        // after an abort, which says nothing about the daemon: measured
        // separately, it sees the disconnect in ~4ms and cancels in ~5ms.
        close() {
            controller.abort();
            pump.catch(() => {});
        },
    };
}

// Resolves with the extension_ui_response the daemon sent, which the fixture
// echoes back as a dialog_answered event.
function nextDialogAnswer(bridge) {
    return new Promise((resolve) => {
        const listener = (event) => {
            if (event.type === "dialog_answered") {
                bridge.off("event", listener);
                resolve(event.answer);
            }
        };

        bridge.on("event", listener);
    });
}

test("every route refuses an unauthenticated request", async (t) => {
    const context = await startServer();
    t.after(context.dispose);
    for (const route of ["/", "/app.js", "/events", "/manifest.webmanifest"]) {
        const response = await fetch(`${context.base}${route}`);
        assert.equal(response.status, 401, `${route} should be 401`);
    }

    const command = await fetch(`${context.base}/command`, {
        method: "POST",
        body: JSON.stringify({ type: "get_state" }),
    });
    assert.equal(command.status, 401);
});

test("a wrong token is refused", async (t) => {
    const context = await startServer();
    t.after(context.dispose);
    const response = await fetch(`${context.base}/`, { headers: { authorization: "Bearer nope" } });
    assert.equal(response.status, 401);
});

test("the client is served only after authentication", async (t) => {
    const context = await startServer();
    t.after(context.dispose);
    const response = await fetch(`${context.base}/`, { headers: authed() });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /SpecPi Remote/u);
    assert.match(response.headers.get("content-security-policy"), /default-src 'none'/u);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("the pairing link moves the token into a cookie", async (t) => {
    const context = await startServer();
    t.after(context.dispose);
    const response = await fetch(`${context.base}/?t=${TOKEN}`, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/");
    assert.match(response.headers.get("set-cookie"), /HttpOnly/u);
});

test("an unknown route is a 404 once authenticated", async (t) => {
    const context = await startServer();
    t.after(context.dispose);
    const response = await fetch(`${context.base}/../package.json`, { headers: authed() });
    assert.equal(response.status, 404);
});

test("a command reaches Pi and its response comes back", async (t) => {
    const context = await startServer();
    t.after(context.dispose);
    const response = await post(context.base, "/command", { type: "get_state" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.model.id, "synthetic-model");
});

test("a command outside the allowlist is refused with 403", async (t) => {
    const context = await startServer();
    t.after(context.dispose);
    const response = await post(context.base, "/command", { type: "bash", command: "whoami" });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /not permitted/u);
});

test("an oversized body is rejected", async (t) => {
    const context = await startServer();
    t.after(context.dispose);
    const response = await fetch(`${context.base}/command`, {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
        body: JSON.stringify({ type: "prompt", message: "x".repeat(2 * 1024 * 1024) }),
    });
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /too large/u);
});

test("malformed JSON is rejected", async (t) => {
    const context = await startServer();
    t.after(context.dispose);
    const response = await fetch(`${context.base}/command`, {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
        body: "{not json",
    });
    assert.equal(response.status, 400);
});

test("the stream opens and announces the connection id", async (t) => {
    const context = await startServer();
    t.after(context.dispose);
    const stream = context.track(await openStream(context.base));
    assert.match(stream.response.headers.get("content-type"), /text\/event-stream/u);
    const connected = await stream.waitFor((event) => event.type === "connected");
    assert.ok(connected.connectionId);
});

test("agent events reach the stream", async (t) => {
    const context = await startServer();
    t.after(context.dispose);
    const stream = context.track(await openStream(context.base));
    await stream.waitFor((event) => event.type === "connected");
    await post(context.base, "/command", { type: "prompt", message: "hello" });
    const settled = await stream.waitFor((event) => event.type === "agent" && event.event.type === "agent_settled");
    assert.ok(settled);
});

test("an approval is delivered, answered, and forwarded to Pi", async (t) => {
    const context = await startServer();
    t.after(context.dispose);
    const stream = context.track(await openStream(context.base));
    const connected = await stream.waitFor((event) => event.type === "connected");
    const answered = nextDialogAnswer(context.bridge);

    await post(context.base, "/command", { type: "prompt", message: "DIALOG:select" });
    const approval = await stream.waitFor((event) => event.type === "approval");
    assert.equal(approval.request.method, "select");

    const response = await post(context.base, "/approval", {
        id: approval.request.id,
        connectionId: connected.connectionId,
        value: "Allow",
    });
    assert.equal(response.status, 200);

    const sent = await answered;
    assert.deepEqual(sent, {
        type: "extension_ui_response",
        id: approval.request.id,
        value: "Allow",
    });
    await stream.waitFor((event) => event.type === "approvalResolved");
});

test("a confirm dialog round-trips as a boolean", async (t) => {
    const context = await startServer();
    t.after(context.dispose);
    const stream = context.track(await openStream(context.base));
    const connected = await stream.waitFor((event) => event.type === "connected");
    const answered = nextDialogAnswer(context.bridge);

    await post(context.base, "/command", { type: "prompt", message: "DIALOG:confirm" });
    const approval = await stream.waitFor((event) => event.type === "approval");
    await post(context.base, "/approval", {
        id: approval.request.id,
        connectionId: connected.connectionId,
        confirmed: false,
    });
    assert.equal((await answered).confirmed, false);
});

test("an approval from the wrong connection is refused", async (t) => {
    const context = await startServer();
    t.after(context.dispose);
    const stream = context.track(await openStream(context.base));
    await stream.waitFor((event) => event.type === "connected");
    await post(context.base, "/command", { type: "prompt", message: "DIALOG:select" });
    const approval = await stream.waitFor((event) => event.type === "approval");

    const response = await post(context.base, "/approval", {
        id: approval.request.id,
        connectionId: "a-connection-that-never-existed",
        value: "Allow",
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "wrong-connection");
});

test("an approval naming an option Pi never offered is refused", async (t) => {
    const context = await startServer();
    t.after(context.dispose);
    const stream = context.track(await openStream(context.base));
    const connected = await stream.waitFor((event) => event.type === "connected");
    await post(context.base, "/command", { type: "prompt", message: "DIALOG:select" });
    const approval = await stream.waitFor((event) => event.type === "approval");

    const response = await post(context.base, "/approval", {
        id: approval.request.id,
        connectionId: connected.connectionId,
        value: "Allow everything forever",
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "invalid-response");
});

test("a dialog raised with no stream open is cancelled immediately", async (t) => {
    const context = await startServer();
    t.after(context.dispose);
    const answered = nextDialogAnswer(context.bridge);
    await post(context.base, "/command", { type: "prompt", message: "DIALOG:select" });
    const answer = await answered;
    assert.equal(answer.cancelled, true);
    assert.equal(answer.value, undefined);
});

test("closing the stream cancels the approval it owned", async (t) => {
    const context = await startServer();
    t.after(context.dispose);
    const stream = await openStream(context.base);
    await stream.waitFor((event) => event.type === "connected");
    await post(context.base, "/command", { type: "prompt", message: "DIALOG:select" });
    await stream.waitFor((event) => event.type === "approval");

    const answered = nextDialogAnswer(context.bridge);
    stream.close();
    assert.equal((await answered).cancelled, true);
});

test("an oversized dialog is cancelled rather than rendered", async (t) => {
    const context = await startServer();
    t.after(context.dispose);
    const stream = context.track(await openStream(context.base));
    await stream.waitFor((event) => event.type === "connected");
    const answered = nextDialogAnswer(context.bridge);
    await post(context.base, "/command", { type: "prompt", message: "DIALOG:huge" });
    assert.equal((await answered).cancelled, true);
});

test("a fire-and-forget notify is shown but never answered", async (t) => {
    const context = await startServer();
    t.after(context.dispose);
    const stream = context.track(await openStream(context.base));
    await stream.waitFor((event) => event.type === "connected");

    let answered = false;
    context.bridge.on("event", (event) => {
        if (event.type === "dialog_answered") {
            answered = true;
        }
    });
    await post(context.base, "/command", { type: "prompt", message: "DIALOG:notify" });
    const notice = await stream.waitFor((event) => event.type === "notice");
    assert.equal(notice.request.method, "notify");
    // Answering a fire-and-forget request desynchronises the sub-protocol.
    assert.equal(answered, false);
});

test("a second stream supersedes the first and cancels its approvals", async (t) => {
    const context = await startServer();
    t.after(context.dispose);
    const first = await openStream(context.base);
    const firstConnection = await first.waitFor((event) => event.type === "connected");
    await post(context.base, "/command", { type: "prompt", message: "DIALOG:select" });
    const approval = await first.waitFor((event) => event.type === "approval");

    const answered = nextDialogAnswer(context.bridge);
    const second = context.track(await openStream(context.base));
    const secondConnection = await second.waitFor((event) => event.type === "connected");
    assert.notEqual(secondConnection.connectionId, firstConnection.connectionId);

    // The superseded stream's dialog is cancelled, never handed over.
    assert.equal((await answered).cancelled, true);
    const response = await post(context.base, "/approval", {
        id: approval.request.id,
        connectionId: secondConnection.connectionId,
        value: "Allow",
    });
    assert.equal(response.status, 409);
    first.close();
});

test("the daemon's timer cancels an expiring dialog before the agent auto-resolves", async (t) => {
    const context = await startServer();
    t.after(context.dispose);
    const stream = context.track(await openStream(context.base));
    await stream.waitFor((event) => event.type === "connected");

    const answered = nextDialogAnswer(context.bridge);
    // 1700ms agent timeout leaves the daemon 250ms after its 1500ms margin.
    await post(context.base, "/command", { type: "prompt", message: "DIALOG:timed:1700" });
    const approval = await stream.waitFor((event) => event.type === "approval");
    assert.ok(approval.expiresAt <= Date.now() + 1700);
    assert.equal((await answered).cancelled, true);
});

test("shutdown cancels a pending approval instead of granting it", async (t) => {
    const context = await startServer();
    const stream = await openStream(context.base);
    await stream.waitFor((event) => event.type === "connected");
    await post(context.base, "/command", { type: "prompt", message: "DIALOG:select" });
    await stream.waitFor((event) => event.type === "approval");

    const answered = nextDialogAnswer(context.bridge);
    await context.server.close();
    assert.equal((await answered).cancelled, true);
    stream.close();
    await context.bridge.stop();
});
