import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { runPiFixture } from "../scripts/pi-test-harness.mjs";

const fixture = path.resolve("tests/fixtures/workflow-controls-harness.ts");

test("workflow-controls extension composes scope and improvement contract lifecycle", (context) => {
    const result = runPiFixture(fixture);
    if (result.unavailable) {
        context.skip(result.error?.message ?? "Pi is not available for the extension harness");

        return;
    }

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const output = `${result.stdout}\n${result.stderr}`;
    const match = output.match(/WORKFLOW_CONTROLS_HARNESS=(.+)/u);
    assert.ok(match, output);
    const report = JSON.parse(match[1]);
    assert.deepEqual(report.commands, ["capability", "scope", "webaccess"]);
    // The capability request is the only tool this extension offers, and it stays active all
    // session: everything else it controls is withdrawn until a human grants it.
    assert.deepEqual(report.toolNames, ["request_capability"]);
    for (const [name, value] of Object.entries(report)) {
        if (!["commands", "toolNames"].includes(name)) {
            assert.equal(value, true, name);
        }
    }
});
