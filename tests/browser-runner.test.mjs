import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertBrowserCoverage } from "../scripts/run-browser-tests.mjs";

test("required browser runner accepts passing coverage and rejects real TODO/skip-only Node runs", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-browser-runner-"));
    const file = path.join(directory, "fixture.mjs");
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    try {
        for (const [body, accepted] of [
            ["test('passing', () => {});", true],
            ["test.todo('not implemented');", false],
            ["test.skip('not exercised', () => {});", false],
        ]) {
            fs.writeFileSync(file, `import test from 'node:test';\n${body}\n`);
            const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", file], {
                encoding: "utf8",
                timeout: 10000,
                env,
            });
            assert.equal(result.status, 0);
            if (accepted) {
                assert.doesNotThrow(() => assertBrowserCoverage(result));
            } else {
                assert.throws(() => assertBrowserCoverage(result), /skipped\/TODO/u);
            }
        }

        assert.throws(() => assertBrowserCoverage({ status: 0, stdout: "" }));
        assert.throws(() =>
            assertBrowserCoverage({
                status: 1,
                stdout: "# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n",
            }),
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
