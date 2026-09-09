import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { runPiFixture } from "../scripts/pi-test-harness.mjs";

test("pinned Pi structural tool enforces source-bound Strict admission, revocation, cancellation and locks", () => {
    const result = runPiFixture(path.join(import.meta.dirname, "fixtures", "structural-harness.ts"), {
        env: {
            ...(process.env.SPECPI_STRUCTURAL_TESTS === "1"
                ? {
                      SPECPI_STRUCTURAL_RUNTIME:
                          process.env.SPECPI_STRUCTURAL_RUNTIME ??
                          path.resolve(import.meta.dirname, "../structural-runtime"),
                  }
                : {}),
        },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /STRUCTURAL_EXTENSION=passed/u);
});
