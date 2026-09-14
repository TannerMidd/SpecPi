import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { resolveLaunch } from "../vscode/src/launch.js";
import { RpcClient } from "../vscode/src/rpc-client.js";

const fixture = fileURLToPath(new URL("./fixtures/vscode-fake-pi.mjs", import.meta.url));

async function syntheticClient(t, options = {}) {
    const client = new RpcClient({ command: process.execPath, args: [fixture], ...options });
    t.after(() => client.stop());
    await client.start();

    return client;
}

function mockChild({ write, autoSpawn = true, ignoreStop = false } = {}) {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.writes = [];
    child.kills = [];
    child.stdin = new Writable({
        write(chunk, encoding, callback) {
            child.writes.push(chunk.toString());
            if (write) {
                write(chunk, callback);
            } else {
                callback();
            }
        },
        final(callback) {
            callback();
            if (!ignoreStop) {
                queueMicrotask(() => child.emit("exit", 0, null));
            }
        },
    });
    child.kill = (signal) => {
        child.kills.push(signal);
        if (!ignoreStop) {
            child.signalCode = signal;
            queueMicrotask(() => child.emit("exit", null, signal));
        }

        return true;
    };

    child.unref = () => {};

    if (autoSpawn) {
        queueMicrotask(() => child.emit("spawn"));
    }

    return child;
}

async function temporaryDirectory(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "specpi-vscode-launch-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));

    return directory;
}

async function writeFile(filename, data = "synthetic") {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, data);
}

test("VS Code RPC correlates concurrent responses and returns only their data", async (t) => {
    const client = await syntheticClient(t);
    const slow = client.request("delayed", { value: "slow", delay: 40 });
    const fast = client.request("echo", { value: "fast", id: "untrusted-id", type: "hold" });
    assert.deepEqual(await fast, { value: "fast" });
    assert.deepEqual(await slow, { value: "slow" });
    assert.equal(client.pending.size, 0);
    await assert.rejects(client.request("fail"), /Synthetic rejection/);
});

test("VS Code RPC frames UTF-8, CRLF, and Unicode separators without corrupting events", async (t) => {
    const client = await syntheticClient(t);
    const event = once(client, "event");
    await client.request("unicode");
    assert.deepEqual((await event)[0], { type: "synthetic", value: "split 😀 text\u2028and\u2029separators" });
});

test("VS Code RPC carries a 20 MiB image batch and image-bearing transcript without truncation", async (t) => {
    const child = mockChild();
    const client = new RpcClient({ command: "synthetic", spawn: () => child });
    t.after(() => client.stop());
    await client.start();
    const image = { type: "image", mimeType: "image/png", data: Buffer.alloc(20 * 1024 * 1024, 17).toString("base64") };
    const prompt = client.request("prompt", { message: "Inspect this image", images: [image] });
    const encodedPrompt = child.writes[0];
    assert.ok(Buffer.byteLength(encodedPrompt, "utf8") > 16 * 1024 * 1024);
    const request = JSON.parse(encodedPrompt);
    assert.equal(request.images[0].data, image.data);
    child.stdout.write(`${JSON.stringify({ type: "response", id: request.id, command: "prompt", success: true })}\n`);
    await prompt;

    const messages = client.request("get_messages");
    const historyRequest = JSON.parse(child.writes[1]);
    const reply = JSON.stringify({
        type: "response",
        id: historyRequest.id,
        command: "get_messages",
        success: true,
        data: { messages: [{ role: "user", content: [{ type: "text", text: "Inspect this image" }, image] }] },
    });
    for (let offset = 0; offset < reply.length; offset += 1024 * 1024) {
        child.stdout.write(reply.slice(offset, offset + 1024 * 1024));
    }

    child.stdout.write("\n");
    const restored = await messages;
    assert.deepEqual(restored.messages[0].content[0], { type: "text", text: "Inspect this image" });
    assert.equal(restored.messages[0].content[1].mimeType, image.mimeType);
    assert.equal(restored.messages[0].content[1].data, image.data);
    assert.equal(client.pending.size, 0);
    assert.equal(client.lineBytes, 0);
});

test("VS Code RPC delivers extension UI responses without creating pending requests", async (t) => {
    const client = await syntheticClient(t);
    const event = once(client, "event");
    assert.equal(client.send({ type: "extension_ui_response", id: "synthetic", cancelled: true }), true);
    assert.deepEqual((await event)[0], {
        type: "synthetic_ui_response",
        response: { type: "extension_ui_response", id: "synthetic", cancelled: true },
    });
    assert.equal(client.pending.size, 0);
});

test("VS Code RPC withholds raw stderr and malformed output while preserving valid responses", async (t) => {
    const client = await syntheticClient(t);
    const diagnostics = [];
    client.on("diagnostic", (message) => diagnostics.push(message));
    await client.request("stderr");
    await client.request("stderr");
    await client.request("malformed");
    assert.equal(diagnostics.filter((message) => message.includes("diagnostic output")).length, 1);
    assert.match(diagnostics.join("\n"), /withheld/);
    assert.doesNotMatch(diagnostics.join("\n"), /TEST_SECRET|TEST_PRIVATE/);
});

test("VS Code RPC expires pending requests and ignores their late responses", async (t) => {
    const client = await syntheticClient(t);
    await assert.rejects(client.request("delayed", { delay: 60 }, { timeoutMs: 10 }), /did not respond/);
    assert.equal(client.pending.size, 0);
    assert.deepEqual(await client.request("delayed", { value: "next", delay: 70 }), { value: "next" });
    assert.equal(client.pending.size, 0);
});

test("VS Code RPC startup waits beyond ordinary deadlines without extending later requests", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const child = mockChild();
    const client = new RpcClient({ command: "synthetic-pi", spawn: () => child });
    t.after(() => client.stop());
    await client.start();
    const ready = client.waitUntilReady();
    const request = JSON.parse(child.writes[0]);
    assert.equal(request.type, "get_state");
    t.mock.timers.tick(30_600);
    assert.equal(client.pending.size, 1, "Startup must survive the legacy Guard's 30-second fallback");
    child.stdout.write(
        `${JSON.stringify({ type: "response", id: request.id, command: "get_state", success: true, data: { isStreaming: false } })}\n`,
    );
    assert.deepEqual(await ready, { isStreaming: false });
    const ordinary = assert.rejects(client.request("get_commands"), { code: "PI_RPC_TIMEOUT" });
    t.mock.timers.tick(30_000);
    await ordinary;
    assert.equal(client.pending.size, 0);
});

test("VS Code RPC startup is bounded and explains extension startup failures", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const child = mockChild();
    const client = new RpcClient({ command: "synthetic-pi", spawn: () => child });
    t.after(() => client.stop());
    await client.start();
    const ready = assert.rejects(client.waitUntilReady(), (error) => {
        assert.equal(error.code, "PI_STARTUP_TIMEOUT");
        assert.match(error.message, /startup dialog/);
        assert.match(error.message, /VSIX alone does not update the harness/);

        return true;
    });
    t.mock.timers.tick(89_999);
    assert.equal(client.pending.size, 1);
    t.mock.timers.tick(1);
    await ready;
    assert.equal(client.pending.size, 0);
});

test("VS Code RPC startup cancellation and exit settle immediately", async (t) => {
    const child = mockChild();
    const client = new RpcClient({ command: "synthetic-pi", spawn: () => child });
    t.after(() => client.stop());
    await client.start();
    const controller = new AbortController();
    const cancelled = assert.rejects(client.waitUntilReady({ signal: controller.signal }), { name: "AbortError" });
    controller.abort();
    await cancelled;
    const closed = assert.rejects(client.waitUntilReady(), /disconnected/);
    await client.stop();
    await closed;
    assert.equal(client.pending.size, 0);
});

test("VS Code RPC allows a caller to disable timeouts for long prompts and dialogs", async (t) => {
    const client = await syntheticClient(t, { requestTimeout: 1 });
    assert.deepEqual(await client.request("delayed", { delay: 30, value: "completed" }, { timeoutMs: 0 }), {
        value: "completed",
    });
});

test("VS Code RPC request cancellation cleans pending listeners without stopping the connection", async (t) => {
    const client = await syntheticClient(t);
    const controller = new AbortController();
    const held = client.request("hold", {}, { signal: controller.signal, timeoutMs: 0 });
    const rejection = assert.rejects(held, { name: "AbortError" });
    controller.abort();
    await rejection;
    assert.equal(client.pending.size, 0);
    assert.deepEqual(await client.request("echo", { value: "connected" }), { value: "connected" });
    await assert.rejects(client.request("echo", {}, { signal: controller.signal }), { name: "AbortError" });
});

test("VS Code RPC can clear queues and abort while the agent is streaming", async (t) => {
    const client = await syntheticClient(t);
    const events = [];
    client.on("event", (event) => events.push(event));
    await client.request("prompt", { message: "synthetic-long" }, { timeoutMs: 0 });
    assert.equal((await client.request("get_state")).isStreaming, true);
    assert.deepEqual(await client.request("clear_queue"), { steering: [], followUp: [] });
    await client.request("abort");
    assert.equal((await client.request("get_state")).isStreaming, false);
    assert.equal(
        events.some((event) => event.type === "agent_end"),
        true,
    );
    assert.equal(
        events.some((event) => event.type === "agent_settled"),
        true,
    );
});

test("VS Code RPC gates requests on spawn and launches with no shell or visible console", async (t) => {
    const child = mockChild({ autoSpawn: false });
    let observed;
    const client = new RpcClient({
        command: "synthetic-command",
        args: ["a path with spaces", "--mode", "rpc"],
        cwd: "synthetic-workspace",
        env: { SYNTHETIC_ONLY: "true" },
        spawn: (...args) => {
            observed = args;

            return child;
        },
    });
    t.after(() => client.stop());
    const started = client.start();
    const request = client.request("get_state");
    assert.deepEqual(child.writes, []);
    child.emit("spawn");
    await started;
    await Promise.resolve();
    const sent = JSON.parse(child.writes[0]);
    child.stdout.write(
        `${JSON.stringify({ type: "response", command: sent.type, id: sent.id, success: true, data: { ready: true } })}\n`,
    );
    assert.deepEqual(await request, { ready: true });
    assert.equal(observed[0], "synthetic-command");
    assert.deepEqual(observed[1], ["a path with spaces", "--mode", "rpc"]);
    assert.deepEqual(observed[2], {
        cwd: "synthetic-workspace",
        env: { SYNTHETIC_ONLY: "true" },
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
    });
});

test("VS Code RPC handles asynchronous and synchronous spawn failures without leaking details", async () => {
    const synchronous = new RpcClient({
        command: "synthetic",
        spawn() {
            throw new Error("PRIVATE_SPAWN_DETAIL");
        },
    });
    await assert.rejects(synchronous.start(), /Pi could not be started/);
    await synchronous.stop();
    const child = mockChild({ autoSpawn: false });
    const asynchronous = new RpcClient({ command: "synthetic", spawn: () => child });
    const started = asynchronous.start();
    child.emit("error", new Error("PRIVATE_SPAWN_DETAIL"));
    await assert.rejects(started, /Pi process could not run/);
    await asynchronous.stop();
});

test("VS Code RPC aborts startup and refuses writes after intentional shutdown", async () => {
    const child = mockChild({ autoSpawn: false });
    const client = new RpcClient({ command: "synthetic", spawn: () => child });
    const controller = new AbortController();
    const started = client.start({ signal: controller.signal });
    const rejection = assert.rejects(started, { name: "AbortError" });
    controller.abort();
    await rejection;
    await client.stop();
    assert.equal(client.send({ type: "extension_ui_response", cancelled: true }), false);
    await assert.rejects(client.request("get_state"), /not connected/);
    await assert.rejects(client.start(), /already been closed/);
});

test("VS Code RPC cancels requests queued during startup without sending their payload", async () => {
    const child = mockChild({ autoSpawn: false });
    const client = new RpcClient({ command: "synthetic", spawn: () => child });
    const started = client.start();
    const controller = new AbortController();
    const pending = client.request("echo", { value: "must not be sent" }, { signal: controller.signal });
    const rejected = assert.rejects(pending, { name: "AbortError" });
    controller.abort();
    await rejected;
    assert.deepEqual(child.writes, []);
    child.emit("spawn");
    await started;
    await client.stop();
    assert.deepEqual(child.writes, []);
});

test("VS Code RPC rejects all pending requests on exit and emits one exit event", async (t) => {
    const client = await syntheticClient(t);
    const exits = [];
    client.on("exit", (event) => exits.push(event));
    const pending = client.request("hold", {}, { timeoutMs: 0 });
    const heldRejected = assert.rejects(pending, /Pi (?:exited|closed)/);
    await assert.rejects(client.request("exit"), /Pi (?:exited|closed)/);
    await heldRejected;
    await client.stop();
    assert.equal(client.pending.size, 0);
    assert.equal(exits.length, 1);
    assert.deepEqual(exits[0], { code: 3, signal: null });
});

test("VS Code RPC handles stdin stream errors, callback errors, and synchronous write throws", async (t) => {
    for (const failure of ["event", "callback", "throw"]) {
        await t.test(failure, async () => {
            let child;
            child = mockChild({
                write(chunk, callback) {
                    if (failure === "callback") {
                        callback(new Error("PRIVATE_WRITE_DETAIL"));
                    } else if (failure === "event") {
                        child.stdin.emit("error", new Error("PRIVATE_WRITE_DETAIL"));
                        callback();
                    } else {
                        throw new Error("PRIVATE_WRITE_DETAIL");
                    }
                },
            });
            const client = new RpcClient({ command: "synthetic", spawn: () => child });
            const diagnostics = [];
            client.on("diagnostic", (message) => diagnostics.push(message));
            await client.start();
            await assert.rejects(client.request("get_state"), /connection to Pi closed/);
            await client.stop();
            assert.equal(client.pending.size, 0);
            assert.doesNotMatch(diagnostics.join("\n"), /PRIVATE_WRITE_DETAIL/);
        });
    }
});

test("VS Code RPC rejects malformed correlated responses and oversized JSON lines", async () => {
    const child = mockChild();
    const client = new RpcClient({ command: "synthetic", spawn: () => child });
    await client.start();
    const malformed = client.request("get_state");
    const malformedRejected = assert.rejects(malformed, /invalid response/);
    const request = JSON.parse(child.writes[0]);
    child.stdout.write(`${JSON.stringify({ type: "response", id: request.id, command: "other", success: true })}\n`);
    await malformedRejected;
    const pending = client.request("hold");
    const pendingRejected = assert.rejects(pending, /larger than the connection limit/);
    const chunk = "a".repeat(8 * 1024 * 1024);
    for (let index = 0; index < 8; index += 1) {
        child.stdout.write(chunk);
    }

    assert.equal(client.state, "running", "The inbound record limit is 64 MiB");
    child.stdout.write("a");
    await pendingRejected;
    await client.stop();
    assert.equal(client.lineBytes, 0);
});

function oversizedHistoryRow(child, header) {
    for (const part of [header.slice(0, 8), header.slice(8, 31), header.slice(31)]) {
        child.stdout.write(part);
    }

    const chunk = Buffer.alloc(1024 * 1024, 97);
    for (let index = 0; index < 64; index += 1) {
        child.stdout.write(chunk);
    }
}

test("VS Code RPC skips oversized correlated history and reads the next response in the same chunk", async (t) => {
    for (const command of ["get_messages", "get_entries"]) {
        await t.test(command, async (t) => {
            const child = mockChild();
            const client = new RpcClient({ command: "synthetic", spawn: () => child });
            t.after(() => client.stop());
            await client.start();
            const diagnostics = [];
            client.on("diagnostic", (message) => diagnostics.push(message));
            const history = client.request(command, {}, { timeoutMs: 0 });
            const rejected = assert.rejects(history, { code: "PI_RPC_HISTORY_TOO_LARGE" });
            const request = JSON.parse(child.writes[0]);
            const header = `{"id":"${request.id}","type":"response","command":"${command}","success":true,"data":{"messages":["`;
            oversizedHistoryRow(child, header);
            assert.equal(client.state, "running");
            assert.equal(client.line, "", "Discarding history must release the buffered body immediately");
            assert.equal(client.lineBytes, 0);
            assert.equal(client.linePrefix, "");
            assert.equal(client.pending.size, 1, "History remains pending until its newline or ordinary deadline");
            child.stdout.write("more discarded body");
            assert.equal(client.lineBytes, 0);
            const next = client.request("get_state", {}, { timeoutMs: 0 });
            const nextRequest = JSON.parse(child.writes[1]);
            child.stdout.write(`"]}}\r`);
            assert.equal(client.pending.size, 2);
            child.stdout.write(
                `\n${JSON.stringify({ id: nextRequest.id, type: "response", command: "get_state", success: true, data: { ready: true } })}\n`,
            );
            await rejected;
            assert.deepEqual(await next, { ready: true });
            assert.equal(client.pending.size, 0);
            assert.equal(client.state, "running");
            assert.equal(client.discardHistoryId, null);
            assert.deepEqual(diagnostics, [], "Oversized history contents must never be logged");
        });
    }
});

test("VS Code RPC history discard preserves request deadlines and resumes after a late newline", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const child = mockChild();
    const client = new RpcClient({ command: "synthetic", spawn: () => child });
    t.after(() => client.stop());
    await client.start();
    const timedOut = assert.rejects(client.request("get_messages", {}, { timeoutMs: 20 }), { code: "PI_RPC_TIMEOUT" });
    const request = JSON.parse(child.writes[0]);
    oversizedHistoryRow(
        child,
        `{"id":"${request.id}","type":"response","command":"get_messages","success":true,"data":{"messages":["`,
    );
    t.mock.timers.tick(20);
    await timedOut;
    assert.equal(client.pending.size, 0);
    assert.equal(client.state, "running");
    child.stdout.write("discarded late body\n");
    assert.equal(client.discardHistoryId, null);
    const next = client.request("get_state", {}, { timeoutMs: 0 });
    const nextRequest = JSON.parse(child.writes[1]);
    child.stdout.write(
        `${JSON.stringify({ id: nextRequest.id, type: "response", command: "get_state", success: true, data: { recovered: true } })}\n`,
    );
    assert.deepEqual(await next, { recovered: true });
});

test("VS Code RPC keeps oversized records fatal when history headers do not exactly correlate", async (t) => {
    const cases = [
        ["unknown id", () => `{"id":"specpi-999","type":"response","command":"get_messages","success":true,"data":`],
        ["wrong command", (id) => `{"id":"${id}","type":"response","command":"get_entries","success":true,"data":`],
        [
            "wrong property order",
            (id) => `{"type":"response","id":"${id}","command":"get_messages","success":true,"data":`,
        ],
        [
            "unsuccessful history",
            (id) => `{"id":"${id}","type":"response","command":"get_messages","success":false,"data":`,
        ],
        ["malformed header", (id) => `{"id":"${id}","type":"response","command":"get_messages","success":true "data":`],
    ];
    for (const [name, header] of cases) {
        await t.test(name, async (t) => {
            const child = mockChild();
            const client = new RpcClient({ command: "synthetic", spawn: () => child });
            t.after(() => client.stop());
            await client.start();
            const rejected = assert.rejects(
                client.request("get_messages", {}, { timeoutMs: 0 }),
                /larger than the connection limit/u,
            );
            const request = JSON.parse(child.writes[0]);
            oversizedHistoryRow(child, header(request.id));
            await rejected;
            await client.stop();
            assert.equal(client.state, "stopped");
            assert.equal(client.line, "");
            assert.equal(client.linePrefix, "");
            assert.equal(client.discardHistoryId, null);
        });
    }
});

test("VS Code RPC bounds outbound encoding and pending request count", async () => {
    const child = mockChild();
    const client = new RpcClient({ command: "synthetic", spawn: () => child });
    await client.start();
    const cyclic = {};
    cyclic.self = cyclic;
    await assert.rejects(client.request("echo", cyclic), /cannot be encoded/);
    await assert.rejects(client.request("echo", { value: "a".repeat(64 * 1024 * 1024) }), /too large/);
    assert.equal(child.writes.length, 0, "Oversized requests must fail before writing to Pi");
    await assert.rejects(client.request("echo", {}, { timeoutMs: -1 }), /timeout/);
    const requests = Array.from({ length: 256 }, () => client.request("hold", {}, { timeoutMs: 0 }));
    const allRejected = Promise.all(requests.map((request) => assert.rejects(request, /disconnected/)));
    await assert.rejects(client.request("hold"), /too many pending/);
    await client.stop();
    await allRejected;
    assert.equal(client.pending.size, 0);
});

test("VS Code RPC shutdown is bounded when the child ignores EOF and signals", async () => {
    const child = mockChild({ ignoreStop: true });
    const client = new RpcClient({ command: "synthetic", spawn: () => child });
    await client.start();
    const started = Date.now();
    await client.stop();
    assert.ok(Date.now() - started < 5000);
    assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
    assert.equal(child.stdin.destroyed, true);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(client.state, "stopped");
});

test("VS Code RPC releases inherited pipes when the child exits without a close event", async () => {
    const child = mockChild({ ignoreStop: true });
    const client = new RpcClient({ command: "synthetic", spawn: () => child });
    await client.start();
    const stopped = client.stop();
    child.emit("exit", 0, null);
    await stopped;
    assert.equal(child.stdin.destroyed, true);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
});

test("VS Code RPC bounds writes when the child stops consuming input", async () => {
    const child = mockChild({ write() {} });
    const client = new RpcClient({ command: "synthetic", spawn: () => child });
    await client.start();
    const first = client.request("hold", { value: "a".repeat(23 * 1024 * 1024) }, { timeoutMs: 0 });
    const second = client.request("hold", { value: "b".repeat(23 * 1024 * 1024) }, { timeoutMs: 0 });
    const rejected = Promise.all([assert.rejects(first, /disconnected/), assert.rejects(second, /disconnected/)]);
    await assert.rejects(client.request("hold", { value: "c".repeat(23 * 1024 * 1024) }), /request buffer is full/);
    const stopped = client.stop();
    child.emit("exit", 0, null);
    await stopped;
    await rejected;
});

test("VS Code launcher resolves JavaScript Pi using external Node with no extra arguments", async (t) => {
    const directory = await temporaryDirectory(t);
    const cli = path.join(directory, "Pi with spaces", "cli.js");
    await writeFile(cli);
    assert.deepEqual(await resolveLaunch({ piPath: cli, nodePath: process.execPath }), {
        command: process.execPath,
        args: [await fs.realpath(cli)],
    });
});

test("VS Code launcher resolves modern and legacy npm shims without executing their contents", async (t) => {
    for (const packageName of ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"]) {
        const directory = await temporaryDirectory(t);
        const shim = path.join(directory, "pi.cmd");
        const cli = path.join(directory, "node_modules", packageName, "dist", "bundle", "cli.js");
        await writeFile(shim, "This is deliberately not executable shell code.");
        await writeFile(cli);
        assert.deepEqual(await resolveLaunch({ piPath: shim, nodePath: process.execPath }), {
            command: process.execPath,
            args: [cli],
        });
    }
});

test("VS Code launcher resolves a local npm .bin shim and legacy unbundled CLI", async (t) => {
    const directory = await temporaryDirectory(t);
    const shim = path.join(directory, "node_modules", ".bin", "pi.cmd");
    const cli = path.join(directory, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    await writeFile(shim);
    await writeFile(cli);
    assert.deepEqual(await resolveLaunch({ piPath: shim, nodePath: process.execPath }), {
        command: process.execPath,
        args: [cli],
    });
});

test("VS Code launcher searches only absolute PATH entries and respects Windows PATH casing", async (t) => {
    const directory = await temporaryDirectory(t);
    const shim = path.join(directory, "pi.cmd");
    const cli = path.join(directory, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    await writeFile(shim);
    await writeFile(cli);
    assert.deepEqual(
        await resolveLaunch({
            nodePath: process.execPath,
            env: { Path: `;.;node_modules/.bin;${directory}` },
            platform: "win32",
        }),
        {
            command: process.execPath,
            args: [cli],
        },
    );
    await assert.rejects(
        resolveLaunch({ env: { PATH: ";.;node_modules/.bin" }, platform: "win32" }),
        /Pi was not found/,
    );
});

test("VS Code launcher accepts a native Pi executable without requiring Node", async (t) => {
    const directory = await temporaryDirectory(t);
    const executable = path.join(directory, "pi.exe");
    await writeFile(executable, "MZ synthetic native executable");
    const launch = await resolveLaunch({ piPath: executable, nodePath: "missing-node", platform: "win32", env: {} });
    assert.deepEqual(launch, { command: await fs.realpath(executable), args: [] });
});

test("VS Code launcher rejects ambiguous, missing, and unsupported launch configurations", async (t) => {
    const directory = await temporaryDirectory(t);
    const shim = path.join(directory, "pi.cmd");
    const cli = path.join(directory, "cli.js");
    const powershell = path.join(directory, "pi.ps1");
    await writeFile(shim);
    await writeFile(cli);
    await writeFile(powershell);
    await assert.rejects(resolveLaunch({ piPath: "./pi" }), /absolute path/);
    await assert.rejects(resolveLaunch({ piPath: "pi\nmalicious" }), /without arguments/);
    await assert.rejects(resolveLaunch({ piPath: path.join(directory, "missing.exe") }), /does not exist/);
    await assert.rejects(resolveLaunch({ piPath: shim }), /no adjacent Pi installation/);
    await assert.rejects(resolveLaunch({ piPath: powershell, platform: "win32" }), /PowerShell launch scripts/);
    await assert.rejects(resolveLaunch({ piPath: cli, nodePath: shim }), /native Node.js executable/);
    await assert.rejects(resolveLaunch({ piPath: cli, env: {} }), /Node.js was not found/);
});

test(
    "VS Code launcher handles POSIX npm symlinks through external Node",
    { skip: process.platform === "win32" },
    async (t) => {
        const directory = await temporaryDirectory(t);
        const cli = path.join(
            directory,
            "lib",
            "node_modules",
            "@earendil-works",
            "pi-coding-agent",
            "dist",
            "bundle",
            "cli.js",
        );
        const shim = path.join(directory, "bin", "pi");
        await writeFile(cli, "#!/usr/bin/env node\n");
        await fs.chmod(cli, 0o755);
        await fs.mkdir(path.dirname(shim));
        await fs.symlink(cli, shim);
        assert.deepEqual(await resolveLaunch({ piPath: shim, nodePath: process.execPath }), {
            command: process.execPath,
            args: [await fs.realpath(cli)],
        });
    },
);
