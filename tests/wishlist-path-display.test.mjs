import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readDecisionsFile, refreshWishlist } from "../extensions/tool-wishlist/core.mjs";
import { markdownPathLabel } from "../extensions/workflow-controls/task-contract.mjs";

test("wishlist symlink and lock errors escape hostile state directory names", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-path-%`\u2028\u202e-"));
    try {
        const target = path.join(root, "target");
        const linked = path.join(root, "linked");
        fs.mkdirSync(target);
        fs.symlinkSync(target, linked, process.platform === "win32" ? "junction" : "dir");
        assert.throws(
            () => readDecisionsFile(linked),
            (error) => {
                assert.ok(error.message.includes(markdownPathLabel(linked)), error.message);
                assert.doesNotMatch(error.message, /[\u2028\u202e`]/u);

                return true;
            },
        );
        const lock = path.join(root, ".tool-wishlist.lock");
        fs.mkdirSync(lock);
        await assert.rejects(refreshWishlist({ stateDir: root }), (error) => {
            assert.ok(error.message.includes(markdownPathLabel(lock)), error.message);
            assert.doesNotMatch(error.message, /[\u2028\u202e`]/u);
            assert.equal(fs.existsSync(lock), true, "the unverified lock was unexpectedly removed");

            return true;
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
