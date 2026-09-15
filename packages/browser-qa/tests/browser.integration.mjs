import assert from "node:assert/strict";
import test from "node:test";
import { runFixture } from "./pi-fixture.mjs";

test(
    "registered tools exercise Chromium interactions, accessibility, diagnostics, images and cancellation",
    { timeout: 180000 },
    () => {
        assert.deepEqual(runFixture(), {
            registration: true,
            tools: 14,
            diagnostics: true,
            interactions: true,
            lifecycle: true,
            images: true,
        });
    },
);
