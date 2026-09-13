import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { tasks } from "../evals/quality/tasks.mjs";
import { materializeTask } from "../evals/quality/fixtures.mjs";
import { evaluateTask } from "../evals/quality/oracle.mjs";
import { applyReferenceRepair } from "../evals/quality/reference.mjs";
import { anchoredSnapshot, resolveAnchoredEdit } from "../evals/quality/anchored-edit.mjs";

test("independent quality oracles reject seeded failures and accept reference repairs", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-oracle-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const task of tasks.filter((item) => item.category !== "browser")) {
        const broken = materializeTask(task.id, path.join(root, `${task.id}-seed`)).root;
        if (task.category === "negative-control") {
            assert.equal((await evaluateTask(task.id, broken)).acceptance, "passed");
        } else {
            await assert.rejects(evaluateTask(task.id, broken));
        }

        const repaired = materializeTask(task.id, path.join(root, `${task.id}-reference`)).root;
        applyReferenceRepair(task.id, repaired);
        assert.equal((await evaluateTask(task.id, repaired)).acceptance, "passed");
        assert.throws(() => materializeTask(task.id, repaired), /EEXIST/);
    }
});

test("anchored editing resolves duplicate lines atomically and preserves BOM, Unicode and untouched bytes", () => {
    const bytes = Buffer.from("\ufeffsame\r\n😀 value\r\nsame\r\nlast");
    const snapshot = anchoredSnapshot(bytes);
    const result = resolveAnchoredEdit(bytes, {
        sha256: snapshot.sha256,
        edits: [{ startLine: 3, endLine: 3, newText: "changed\n" }],
    });
    assert.deepEqual(result.bytes, Buffer.from("\ufeffsame\r\n😀 value\r\nchanged\r\nlast"));
    assert.throws(
        () =>
            resolveAnchoredEdit(result.bytes, {
                sha256: snapshot.sha256,
                edits: [{ startLine: 1, endLine: 1, newText: "stale" }],
            }),
        /Stale/,
    );
    for (const edits of [
        [
            { startLine: 1, endLine: 3, newText: "a" },
            { startLine: 2, endLine: 2, newText: "b" },
        ],
        [{ startLine: 0, endLine: 1, newText: "bad" }],
        [{ startLine: 4, endLine: 5, newText: "bad" }],
        [],
    ]) {
        assert.throws(() => resolveAnchoredEdit(bytes, { sha256: snapshot.sha256, edits }));
    }

    assert.deepEqual(bytes, Buffer.from("\ufeffsame\r\n😀 value\r\nsame\r\nlast"));
    const multiple = resolveAnchoredEdit(Buffer.from("a\nb\nc"), {
        sha256: anchoredSnapshot(Buffer.from("a\nb\nc")).sha256,
        edits: [
            { startLine: 3, endLine: 3, newText: "C" },
            { startLine: 1, endLine: 1, newText: "A\n" },
        ],
    });
    assert.equal(multiple.bytes.toString(), "A\nb\nC");
});
