// Drives the real bridge against the synthetic peer. No Pi, no provider, no
// user configuration: PI_CODING_AGENT_DIR points at a throwaway directory so a
// regression cannot reach the developer's live agent state.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { RpcBridge } from "../src/rpc-bridge.js";

// U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR, built at runtime so
// the literal characters never sit in this source file and cannot be quietly
// re-escaped into an inert string by tooling.
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);
const SEPARATOR_TEXT = `line${LINE_SEPARATOR}still${PARAGRAPH_SEPARATOR}same`;

const fixture = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

async function startBridge() {
    const agentDir = await mkdtemp(path.join(tmpdir(), "specpi-remote-"));
    const bridge = new RpcBridge({
        command: process.execPath,
        args: [fixture],
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        requestTimeoutMs: 4000,
    });
    bridge.start();

    return {
        bridge,
        async dispose() {
            await bridge.stop();
            await rm(agentDir, { recursive: true, force: true });
        },
    };
}

test("correlates a response with its command", async (t) => {
    const { bridge, dispose } = await startBridge();
    t.after(dispose);
    const response = await bridge.send({ type: "get_state" });
    assert.equal(response.success, true);
    assert.equal(response.data.model.id, "synthetic-model");
});

test("keeps concurrent commands apart", async (t) => {
    const { bridge, dispose } = await startBridge();
    t.after(dispose);
    const [state, models, stats] = await Promise.all([
        bridge.send({ type: "get_state" }),
        bridge.send({ type: "get_available_models" }),
        bridge.send({ type: "get_session_stats" }),
    ]);
    assert.equal(state.command, "get_state");
    assert.equal(models.command, "get_available_models");
    assert.equal(stats.command, "get_session_stats");
});

test("refuses a command outside the allowlist without touching Pi", async (t) => {
    const { bridge, dispose } = await startBridge();
    t.after(dispose);
    // A remote shell is the specific thing this gate exists to stop.
    await assert.rejects(() => bridge.send({ type: "bash", command: "whoami" }), /not permitted/u);
    await assert.rejects(() => bridge.send({ type: "abort_bash" }), /not permitted/u);
});

test("U+2028 survives the round trip", async (t) => {
    const { bridge, dispose } = await startBridge();
    t.after(dispose);
    const seen = [];
    bridge.on("event", (event) => seen.push(event));
    bridge.on("protocolError", (error) => assert.fail(`framing broke: ${error.message}`));
    await bridge.send({ type: "prompt", message: "SPLIT" });
    await once(bridge, "event");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const message = seen.find((event) => event.type === "message_end");
    assert.equal(message.message.content, SEPARATOR_TEXT);
});

test("surfaces an extension UI request as an event", async (t) => {
    const { bridge, dispose } = await startBridge();
    t.after(dispose);
    const pending = once(bridge, "uiRequest");
    await bridge.send({ type: "prompt", message: "DIALOG:select" });
    const [request] = await pending;
    assert.equal(request.method, "select");
    assert.deepEqual(request.options, ["Allow", "Block"]);
});

test("steer and abort interleave with a running turn", async (t) => {
    const { bridge, dispose } = await startBridge();
    t.after(dispose);
    // Deliberately not awaited: this prompt never gets a response, which is the
    // point — steering and aborting must work while a turn is outstanding.
    bridge.send({ type: "prompt", message: "NOREPLY-please-keep-running" }).catch(() => {});
    const [steer, abort] = await Promise.all([
        bridge.send({ type: "steer", message: "focus on tests" }),
        bridge.send({ type: "abort" }),
    ]);
    assert.equal(steer.command, "steer");
    assert.equal(abort.command, "abort");
});

test("a command with no reply times out instead of hanging", async (t) => {
    const agentDir = await mkdtemp(path.join(tmpdir(), "specpi-remote-"));
    const bridge = new RpcBridge({
        command: process.execPath,
        args: [fixture],
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        requestTimeoutMs: 300,
    });
    bridge.start();
    t.after(async () => {
        await bridge.stop();
        await rm(agentDir, { recursive: true, force: true });
    });
    await assert.rejects(() => bridge.send({ type: "prompt", message: "NOREPLY" }), /Timed out/u);
});

test("a failed response is reported rather than thrown away", async (t) => {
    const { bridge, dispose } = await startBridge();
    t.after(dispose);
    // Mirrors get_entries rejecting a cursor it no longer recognises.
    const response = await bridge.send({ type: "get_entries", since: "stale-cursor" });
    assert.equal(response.success, false);
});

test("a stale cursor is distinguishable from a valid one", async (t) => {
    const { bridge, dispose } = await startBridge();
    t.after(dispose);
    const good = await bridge.send({ type: "get_entries", since: "known-entry" });
    assert.equal(good.success, true);
    assert.equal(good.data.leafId, "known-entry");
});

test("pending commands reject when Pi exits", async (t) => {
    const { bridge, dispose } = await startBridge();
    t.after(dispose);
    const closed = once(bridge, "closed");
    const pending = bridge.send({ type: "prompt", message: "NOREPLY" });
    bridge.child.kill("SIGKILL");
    await closed;
    await assert.rejects(() => pending, /Pi exited|shutting down/u);
});

test("sending after Pi exits reports the reason", async (t) => {
    const { bridge, dispose } = await startBridge();
    t.after(dispose);
    const closed = once(bridge, "closed");
    bridge.child.kill("SIGKILL");
    await closed;
    await assert.rejects(() => bridge.send({ type: "get_state" }), /Pi exited/u);
});
