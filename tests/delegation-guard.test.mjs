import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

for (const [proof, description] of [
    ["policy", "Strict delegation approval binds the exact call and host capability generation"],
    ["lifecycle", "reused Guard sessions restore one responder and preserve optional-Guard admission semantics"],
    ["mutations", "only accepted Guard policy mutations revoke delegation"],
    ["dialogs", "stale Guard startup and mode confirmations cannot downgrade a later lock or session"],
]) {
    test(description, () => {
        const result = spawnSync(
            process.execPath,
            ["--experimental-strip-types", path.resolve("tests/fixtures/delegation-guard-harness.ts"), proof],
            { encoding: "utf8", timeout: 30000, windowsHide: true },
        );
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.ok(result.stdout.includes(`DELEGATION_GUARD_HARNESS=${proof}:passed`));
    });
}
