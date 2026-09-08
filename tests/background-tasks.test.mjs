import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
    TaskRunner,
    OutputRing,
    LIMITS,
    normalizeStart,
    terminateOwned,
} from "../extensions/background-tasks/core.mjs";

const command = (code) => `"${process.execPath}" -e "${code}"`;
const looping = command("console.log('READY');setInterval(()=>{},1000)");
const fastTerminate = (task) => terminateOwned(task, { graceMs: 30, observeMs: 3000 });
async function until(check, timeout = 10000) {
    const end = Date.now() + timeout;
    while (!check()) {
        if (Date.now() >= end) {
            throw new Error("Condition deadline exceeded");
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

test("input and byte cursor bounds, split UTF-8, mixed streams and control escaping", () => {
    for (const input of [
        {},
        { command: "x", timeoutSeconds: 0 },
        { command: "x", timeoutSeconds: 28801 },
        { command: "x", timeoutSeconds: 1.2 },
        { command: "x", cwd: "missing-background-cwd" },
        { command: "x", extra: true },
        { command: "é".repeat(LIMITS.command) },
    ]) {
        assert.throws(() => normalizeStart(input, process.cwd()));
    }

    const ring = new OutputRing();
    const bytes = Buffer.from("€😀");
    ring.append("stdout", bytes.subarray(0, 2));
    assert.equal(ring.end, 0);
    ring.append("stdout", bytes.subarray(2));
    ring.append("stderr", Buffer.from("\x1b[2JERROR"));
    const first = ring.read();
    assert.match(first.output, /€😀/);
    assert.match(first.output, /\[stderr\]/);
    assert.equal(first.output.includes("\x1b"), false);
    assert.equal(ring.read(first.nextOffset).output, "");
    assert.throws(() => ring.read(first.endOffset + 1));
    assert.throws(() => ring.read(-1));
    assert.throws(() => ring.read(0.5));
    ring.append("stdout", Buffer.from("€".repeat(200000)));
    const flooded = ring.read(0);
    assert.ok(ring.bytes.length <= LIMITS.buffer);
    assert.ok(Buffer.byteLength(flooded.output) <= LIMITS.read);
    assert.ok(flooded.lostBytes > 0 && flooded.truncated);
    assert.equal(flooded.output.includes("�"), false);
    assert.equal(ring.read(flooded.nextOffset).lostBytes, 0);
    const controls = new OutputRing();
    controls.append("stdout", Buffer.alloc(LIMITS.buffer * 2, 1));
    const response = controls.read();
    assert.ok(Buffer.byteLength(JSON.stringify(response)) < 512 * 1024);
    let cursor = response.nextOffset;
    while (cursor < controls.end) {
        const page = controls.read(cursor);
        assert.equal(page.lostBytes, 0);
        assert.ok(page.nextOffset > cursor);
        cursor = page.nextOffset;
    }

    controls.append("stderr", Buffer.from([0xe2, 0x82]));
    controls.append("stderr", undefined, true);
    assert.match(controls.read(cursor).output, /�/);
});

test("owned trees stop idempotently, caps are atomic, and shutdown closes admission", async () => {
    const runner = new TaskRunner({ terminate: fastTerminate });
    try {
        const tree = normalizeStart(
            { command: `"${process.execPath}" "${path.resolve("tests/fixtures/background-tree.mjs")}"` },
            process.cwd(),
        );
        const started = await runner.start(tree, 1);
        const task = runner.get(started.id);
        await until(() => /LEAF=\d+/.test(task.ring.read().output));
        const pids = [...task.ring.read().output.matchAll(/(?:LEAF|PARENT)=(\d+)/g)].map((match) => Number(match[1]));
        assert.equal(pids.length, 2);
        const stops = await Promise.all([runner.stop(started.id), runner.stop(started.id)]);
        assert.equal(stops[0].cleanup, "confirmed");
        assert.equal(stops[1].cleanup, "confirmed");
        for (const pid of pids) {
            await until(() => {
                try {
                    process.kill(pid, 0);

                    return false;
                } catch (error) {
                    return error.code === "ESRCH";
                }
            });
        }

        if (process.platform !== "win32") {
            const orphan = await runner.start(
                normalizeStart(
                    { command: `"${process.execPath}" "${path.resolve("tests/fixtures/background-tree.mjs")}" orphan` },
                    process.cwd(),
                ),
                1,
            );
            const orphanTask = runner.get(orphan.id);
            await until(() => orphanTask.cleanup === "confirmed");
            const leaf = Number(orphanTask.ring.read().output.match(/LEAF=(\d+)/)?.[1]);
            assert.ok(leaf > 0);
            assert.throws(
                () => process.kill(leaf, 0),
                (error) => error.code === "ESRCH",
            );
        }

        const spec = normalizeStart({ command: looping }, process.cwd());
        const results = await Promise.allSettled(Array.from({ length: 5 }, () => runner.start(spec, 2)));
        assert.equal(results.filter((value) => value.status === "fulfilled").length, 4);
        assert.equal(results.filter((value) => value.status === "rejected").length, 1);
        const shutdown = await runner.shutdown();
        assert.ok(shutdown.every((value) => value.cleanup === "confirmed"));
        await assert.rejects(runner.start(spec, 2), /closed/);
        assert.throws(() => runner.get("not-a-task"));
    } finally {
        await runner.shutdown();
    }
});

test("natural exit, deadline, cancellation and unconfirmed cleanup remain observable", async () => {
    const runner = new TaskRunner({ terminate: fastTerminate });
    try {
        const natural = await runner.start(
            normalizeStart({ command: command("console.log('DONE');process.exitCode=7") }, process.cwd()),
            1,
        );
        await until(() => runner.get(natural.id).cleanup === "confirmed");
        assert.equal(runner.get(natural.id).status, "exited");
        assert.equal(runner.get(natural.id).exitCode, 7);
        assert.match(runner.get(natural.id).ring.read().output, /DONE/);
        const timed = await runner.start(normalizeStart({ command: looping, timeoutSeconds: 1 }, process.cwd()), 1);
        runner.terminate = async () => false;
        await until(() => runner.get(timed.id).cleanup === "unconfirmed");
        assert.equal(runner.get(timed.id).status, "cleanup-unconfirmed");
        assert.equal(runner.get(timed.id).reason, "timeout");
        runner.terminate = fastTerminate;
        assert.equal((await runner.stop(timed.id)).status, "killed");
        const controller = new AbortController();
        const promise = runner.start(normalizeStart({ command: looping }, process.cwd()), 1, controller.signal);
        controller.abort();
        const cancelled = await promise;
        assert.equal(cancelled.cleanup, "confirmed");
        assert.equal(cancelled.status, "killed");
        const owned = await runner.start(normalizeStart({ command: looping }, process.cwd()), 1);
        runner.terminate = async () => false;
        assert.equal((await runner.stop(owned.id)).status, "cleanup-unconfirmed");
        assert.ok(runner.tasks.has(owned.id));
        runner.terminate = fastTerminate;
        assert.equal((await runner.stop(owned.id)).cleanup, "confirmed");
    } finally {
        runner.terminate = fastTerminate;
        await runner.shutdown();
    }
});

test("spawn failure and completed record eviction do not leak admission slots", async () => {
    const runner = new TaskRunner({
        spawnProcess() {
            throw new Error("fixture spawn failure");
        },
    });
    for (let index = 0; index < 40; index += 1) {
        assert.equal((await runner.start(normalizeStart({ command: "unused" }, process.cwd()), 1)).status, "failed");
    }

    assert.equal(runner.list().length, LIMITS.completed);
    runner.terminate = async () => false;
    for (let index = 0; index < LIMITS.active; index += 1) {
        assert.equal(
            (await runner.start(normalizeStart({ command: "unused" }, process.cwd()), 1)).status,
            "cleanup-unconfirmed",
        );
    }

    await assert.rejects(runner.start(normalizeStart({ command: "unused" }, process.cwd()), 1), /four active/);
    runner.evict();
    assert.equal(runner.list().filter((task) => task.cleanup === "unconfirmed").length, 4);
    const asyncFailure = new TaskRunner({
        spawnProcess: () =>
            spawn("specpi-missing-background-executable", [], { stdio: ["ignore", "pipe", "pipe", "ipc"] }),
    });
    assert.equal((await asyncFailure.start(normalizeStart({ command: "unused" }, process.cwd()), 1)).status, "failed");
    assert.equal(
        await terminateOwned({ child: { pid: 2147483647 }, rootExited: true }, { graceMs: 0, observeMs: 0 }),
        process.platform !== "win32",
    );
});

test("extension approvals and Guard integration fail closed", () => {
    const result = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "tests/fixtures/background-extension-harness.ts"],
        { encoding: "utf8", timeout: 60000 },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /BACKGROUND_EXTENSION=passed/);
});
