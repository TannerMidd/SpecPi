import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { tasks } from "../evals/quality/catalog.mjs";
import { materializeTask } from "../evals/quality/fixtures.mjs";
import { evaluateTask } from "../evals/quality/oracle.mjs";
import { applyReferenceRepair } from "../evals/quality/reference.mjs";
import { anchoredSnapshot, resolveAnchoredEdit } from "../evals/quality/anchored-edit.mjs";
import { codexEventReader } from "../evals/quality/events.mjs";
import { applyWrongRepair } from "../evals/quality/mutations.mjs";
import { buildSchedule, promptFor } from "../evals/quality/run.mjs";

test("Codex protocol accounting distinguishes reasoning and retains early tool events", () => {
    const reader = codexEventReader();
    for (const type of ["reasoning", "agent_message", "todo_list"]) {
        reader.write(Buffer.from(JSON.stringify({ type: "item.completed", item: { id: type, type } }) + "\n"));
    }

    assert.deepEqual(reader.state.toolEvents, []);
    reader.write(Buffer.from('{"type":"item.started","item":{"id":"x","type":"command_execution"}}\n'));
    for (let index = 0; index < 1200; index += 1) {
        reader.write(
            Buffer.from(
                JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "a".repeat(1000) } }) +
                    "\n",
            ),
        );
    }

    reader.write(Buffer.from('{"type":"turn.completed","usage":{"input_tokens":2}}\n'));
    assert.deepEqual(reader.end(), {
        usage: { input_tokens: 2 },
        toolEvents: ["command_execution"],
        error: null,
        completed: true,
    });
    const malformed = codexEventReader();
    malformed.write(Buffer.from("not JSON\n"));
    assert.match(malformed.end().error, /malformed/);
});

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
        const wrong = materializeTask(task.id, path.join(root, `${task.id}-wrong`)).root;
        applyReferenceRepair(task.id, wrong);
        applyWrongRepair(task.id, wrong);
        await assert.rejects(evaluateTask(task.id, wrong), `Plausible wrong repair passed: ${task.id}`);
    }
});

test("paired schedules cover all difficulty strata, conditions and repetitions", () => {
    assert.equal(tasks.length, 32);
    assert.deepEqual(
        ["easy", "medium", "hard"].map((difficulty) => tasks.filter((task) => task.difficulty === difficulty).length),
        [8, 12, 12],
    );
    assert.equal(tasks.filter((task) => task.category === "negative-control").length, 4);
    for (const experiment of ["review", "editing"]) {
        const schedule = buildSchedule(experiment);
        assert.equal(schedule.length, 192);
        assert.equal(new Set(schedule.map((run) => `${run.task.id}/${run.condition}/${run.repetition}`)).size, 192);
        for (let index = 0; index < schedule.length; index += 2) {
            assert.equal(schedule[index].task.id, schedule[index + 1].task.id);
            assert.notEqual(schedule[index].condition, schedule[index + 1].condition);
        }

        assert.notEqual(schedule[0].condition, schedule[64].condition);
    }
});

test("repair prompts include advisory review and edit feedback without hidden graders", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-prompt-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const task = tasks.find((item) => item.id === "inflight-invalidation");
    const fixture = materializeTask(task.id, path.join(root, "fixture"));
    const prompt = promptFor(
        task,
        fixture.root,
        "native",
        "edit",
        [{ error: "ambiguous old text" }],
        [{ issue: "stale cache entry" }],
    );
    assert.ok(prompt.includes("ambiguous old text"));
    assert.ok(prompt.includes("stale cache entry"));
    assert.equal(prompt.includes("old-rejection-cannot-evict-new-pending"), false);
    assert.equal(prompt.includes("challenge-reference.mjs"), false);
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
