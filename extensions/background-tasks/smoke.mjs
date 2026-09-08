import assert from "node:assert/strict";
import { TaskRunner, OutputRing, normalizeStart, terminateOwned } from "./core.mjs";

const ring = new OutputRing(32);
ring.append("stdout", Buffer.from("x".repeat(100)));
assert.equal(ring.read().lostBytes > 0, true);
const runner = new TaskRunner({ terminate: (task) => terminateOwned(task, { graceMs: 20, observeMs: 2000 }) });
try {
    const spec = normalizeStart(
        { command: `"${process.execPath}" -e "process.stdout.write('background-smoke');setInterval(()=>{},1000)"` },
        process.cwd(),
    );
    const started = await runner.start(spec, 1);
    assert.equal(started.status, "running");
    const task = runner.get(started.id);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            clearInterval(poll);
            reject(new Error("Smoke output deadline exceeded"));
        }, 10000);
        const poll = setInterval(() => {
            if (task.ring.read().output.includes("background-smoke")) {
                clearInterval(poll);
                clearTimeout(timer);
                resolve();
            }
        }, 20);
    });
    assert.equal((await runner.stop(started.id)).cleanup, "confirmed");
    console.log("BACKGROUND_TASKS_SMOKE=passed");
} finally {
    await runner.shutdown();
}
