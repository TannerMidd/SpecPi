import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { prepareFaults, readFaults, withFaultPath } from "../scripts/eval-faults.mjs";

function scratch(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("an injected fault fails a fixed number of times and then clears", () => {
    const home = scratch("faults-home-");
    const workspace = scratch("faults-work-");
    try {
        fs.writeFileSync(path.join(workspace, "real.mjs"), 'console.log("REAL");');
        const task = {
            faults: [{ command: "flaky", real: "real.mjs", failures: 2, exitCode: 3, stderr: "flaky: down" }],
        };
        const handle = prepareFaults(task, home, workspace);
        const env = withFaultPath({ ...process.env }, handle);
        const run = () => spawnSync("flaky", [], { cwd: workspace, env, shell: true, encoding: "utf8" });

        const first = run();
        assert.equal(first.status, 3);
        assert.match(first.stderr, /flaky: down/u);
        assert.equal(run().status, 3);

        // The third call is past the injected failures, so the real command runs.
        const third = run();
        assert.equal(third.status, 0);
        assert.match(third.stdout, /REAL/u);

        const outcome = readFaults(handle);
        assert.equal(outcome.injected, 2);
        assert.equal(outcome.triggered, 2);
        assert.deepEqual(outcome.abandoned, []);
        assert.equal(outcome.commands[0].seen, 3);
        assert.equal(outcome.commands[0].passed, 1);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test("giving up before the fault clears is recorded as abandoned", () => {
    const home = scratch("faults-home-");
    const workspace = scratch("faults-work-");
    try {
        fs.writeFileSync(path.join(workspace, "real.mjs"), "\n");
        const task = { faults: [{ command: "flaky", real: "real.mjs", failures: 3 }] };
        const handle = prepareFaults(task, home, workspace);
        const env = withFaultPath({ ...process.env }, handle);
        // One attempt, then the harness stops trying.
        spawnSync("flaky", [], { cwd: workspace, env, shell: true, encoding: "utf8" });

        const outcome = readFaults(handle);
        assert.equal(outcome.triggered, 1);
        assert.deepEqual(outcome.abandoned, ["flaky"]);
        assert.equal(outcome.recoveredCommands, 0);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test("a task declaring no faults gets no shim and no PATH change", () => {
    const home = scratch("faults-home-");
    try {
        assert.equal(prepareFaults({ faults: [] }, home, home), null);
        assert.equal(readFaults(null), null);
        const env = { PATH: "/usr/bin" };
        assert.deepEqual(withFaultPath(env, null), env);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});
