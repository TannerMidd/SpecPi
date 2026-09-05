import assert from "node:assert/strict";
import test from "node:test";
import { BrowserCleanupError, CLEANUP_TIMEOUT_MS, settleBrowserCleanup } from "../extensions/browser/lifecycle.ts";

test("browser cleanup settles normal closes and reports rejected closes without raw errors", async () => {
    await settleBrowserCleanup([Promise.resolve(), Promise.resolve()]);
    await assert.rejects(
        settleBrowserCleanup([Promise.reject(new Error("password=CANARY"))]),
        (error) => error instanceof BrowserCleanupError && !error.message.includes("CANARY"),
    );
});

test(
    "stalled browser close has a bounded settlement and explicitly discloses a possibly remaining process",
    { timeout: 5000 },
    async () => {
        let release;
        const stalled = new Promise((resolve) => {
            release = resolve;
        });
        const started = Date.now();
        await assert.rejects(settleBrowserCleanup([stalled]), /browser process may remain/u);
        assert.ok(Date.now() - started >= CLEANUP_TIMEOUT_MS - 20);
        assert.ok(Date.now() - started < 3000);
        release();
    },
);
