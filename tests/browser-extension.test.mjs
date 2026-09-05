import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runPiFixture } from "../scripts/pi-test-harness.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
test(
    "registered browser tools exercise real Chromium diagnostics, interactions, refs, cancellation, and images",
    { skip: process.env.SPECPI_BROWSER_TESTS !== "1", timeout: 180000 },
    () => {
        const result = runPiFixture(path.join(root, "tests", "fixtures", "browser-harness.ts"), {
            piCommand:
                process.env.SPECPI_TEST_PI ??
                path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
            env: { SPECPI_BROWSER_RUNTIME: process.env.SPECPI_BROWSER_RUNTIME },
            timeout: 150000,
        });
        assert.equal(result.error, null, result.error?.message);
        assert.equal(result.status, 0, result.stderr);
        const output = result.stdout + result.stderr;
        const marker = output.split(/\r?\n/u).find((line) => line.startsWith("SPECPI_BROWSER_HARNESS="));
        assert.ok(marker, output);
        assert.deepEqual(JSON.parse(marker.slice("SPECPI_BROWSER_HARNESS=".length)), {
            registration: true,
            tools: 13,
            diagnostics: true,
            interactions: true,
            lifecycle: true,
            images: true,
        });
    },
);
