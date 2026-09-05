import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runPiFixture } from "../scripts/pi-test-harness.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
test("pinned Pi registers all browser tools without requiring a browser runtime", () => {
    const result = runPiFixture(path.join(root, "tests", "fixtures", "browser-harness.ts"), {
        piCommand:
            process.env.SPECPI_TEST_PI ??
            path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
        env: { SPECPI_BROWSER_REGISTRATION_ONLY: "1" },
    });
    assert.equal(result.error, null, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    const output = result.stdout + result.stderr;
    assert.match(output, /SPECPI_BROWSER_HARNESS=\{"registration":true,"tools":13\}/u);
});
