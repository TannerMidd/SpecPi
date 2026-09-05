import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

test("Strict delegation approval binds the exact call and host capability generation", () => {
    const result = spawnSync(
        process.execPath,
        ["--experimental-strip-types", path.resolve("tests/fixtures/delegation-guard-harness.ts")],
        { encoding: "utf8", timeout: 30000, windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /DELEGATION_GUARD_HARNESS=passed/u);
});
