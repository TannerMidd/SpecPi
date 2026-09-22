import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { runPiFixture } from "../scripts/pi-test-harness.mjs";

test("advisor hooks use real contracts, per-job delegation, and wishlist persistence", () => {
    const result = runPiFixture(path.resolve("tests/fixtures/jev-advisor-harness.ts"));
    assert.equal(result.unavailable, false, "the pinned Pi fixture runner is required");
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /JEV_ADVISOR_HARNESS=passed/u);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Failed to load extension/u);
});
