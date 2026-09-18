import assert from "node:assert/strict";
import test from "node:test";

import { attemptEffort, compositeScore, effortBreakdown, toolCallTotal } from "../scripts/eval-effort.mjs";
import { attemptScore } from "../scripts/eval-report.mjs";
import { listTasks, loadTask } from "../scripts/eval-tasks.mjs";

const task = (referenceCalls, weight) => ({ effort: { referenceCalls, weight } });
const calls = (total) => ({ tokens: { toolCalls: { bash: total } } });

test("tool calls are summed across tool names, or reported as unmeasured", () => {
    assert.equal(toolCallTotal({ tokens: { toolCalls: { bash: 3, read: 2, write: 1 } } }), 6);
    assert.equal(toolCallTotal({ tokens: { toolCalls: {} } }), null);
    assert.equal(toolCallTotal({ tokens: { toolCalls: null } }), null);
    assert.equal(toolCallTotal({ tokens: {} }), null);
    assert.equal(toolCallTotal({}), null);
    // An array would sum to a number by accident, which is worse than refusing.
    assert.equal(toolCallTotal({ tokens: { toolCalls: [1, 2] } }), null);
});

test("efficiency caps at the reference so beating it never scores above it", () => {
    assert.equal(attemptEffort(task(4), calls(4)).efficiency, 1);
    assert.equal(attemptEffort(task(4), calls(8)).efficiency, 0.5);
    // A later harness that does better than the recorded floor saturates rather than rescaling
    // everyone else, which is what keeps a frozen reference stable.
    assert.equal(attemptEffort(task(4), calls(1)).efficiency, 1);
});

test("a task with no reference, or a harness with no tool calls, is unmeasured rather than perfect", () => {
    assert.deepEqual(attemptEffort({}, calls(5)), { measured: false, reason: "no-reference" });
    assert.equal(attemptEffort(task(0), calls(5)).measured, false);
    const unmeasured = attemptEffort(task(4), { tokens: {} });
    assert.equal(unmeasured.measured, false);
    assert.equal(unmeasured.reason, "calls-not-measured");
    // Unmeasured must fall through to bare correctness, never to a free 1.0 or a punitive 0.
    assert.equal(compositeScore(task(4), { correctness: 1, tokens: {} }).score, 1);
    assert.equal(compositeScore(task(4), { correctness: 0.5, tokens: {} }).score, 0.5);
});

test("correctness multiplies, so being fast and wrong earns nothing", () => {
    assert.equal(compositeScore(task(2, 0.5), { correctness: 0, ...calls(2) }).score, 0);
    assert.equal(compositeScore(task(2, 0.5), { correctness: 0, ...calls(99) }).score, 0);
    // Half credit at the floor keeps half the weight; the effort term cannot invent correctness.
    assert.equal(compositeScore(task(2, 0.5), { correctness: 0.5, ...calls(2) }).score, 0.5);
});

test("weight bounds how far effort can move a correct answer", () => {
    // At weight 0.5 a correct answer taking twice the floor lands halfway down the allowed range.
    assert.equal(compositeScore(task(2, 0.5), { correctness: 1, ...calls(4) }).score, 0.75);
    assert.equal(compositeScore(task(2, 0.5), { correctness: 1, ...calls(2) }).score, 1);
    // At weight 0.25 the same run is trimmed rather than halved.
    assert.equal(compositeScore(task(2, 0.25), { correctness: 1, ...calls(4) }).score, 0.875);
    // Weights outside 0..1 are clamped rather than producing a score above 1 or below 0.
    assert.equal(compositeScore(task(2, 5), { correctness: 1, ...calls(4) }).score, 0.5);
    assert.equal(compositeScore(task(2, -5), { correctness: 1, ...calls(4) }).score, 1);
});

test("a composite score can always be taken apart in the report", () => {
    const scored = compositeScore(task(3, 0.5), { correctness: 1, ...calls(6) });
    const rows = effortBreakdown(scored);
    assert.deepEqual(
        rows.map((row) => row.check),
        ["tool calls used", "tool calls, demonstrated floor"],
    );
    assert.equal(rows[0].got, 6);
    assert.equal(rows[1].got, 3);
    assert.equal(scored.correctness, 1);
    assert.equal(
        effortBreakdown(compositeScore({}, { correctness: 1 }))[0].check,
        "effort not measured (no-reference)",
    );
});

test("stored attempts rescore through the same function the runner uses", () => {
    const stored = { score: 1, pass: true, tokens: { toolCalls: { bash: 2, write: 2 } } };
    // Without task context there is nothing to score effort against, so correctness stands.
    assert.equal(attemptScore(stored), 1);
    const id = "t1-create-file";
    const expected = compositeScore(loadTask(id), {
        correctness: 1,
        pass: true,
        tokens: stored.tokens,
    }).score;
    assert.equal(attemptScore(stored, id), expected);
    assert.ok(expected < 1, "four calls against a floor of one should not score a perfect 1");
    // An unknown task id must not throw a renderer over; it falls back to correctness.
    assert.equal(attemptScore(stored, "t0-does-not-exist"), 1);
});

test("a report written after the composite prefers its recorded correctness", () => {
    const id = "t1-create-file";
    // `score` here is already a composite, so reusing it as correctness would compound the penalty
    // every time a report was re-rendered.
    const stored = { score: 0.625, correctness: 1, pass: true, tokens: { toolCalls: { bash: 2 } } };
    assert.equal(
        attemptScore(stored, id),
        compositeScore(loadTask(id), { correctness: 1, tokens: stored.tokens }).score,
    );
});

test("every declared reference is a floor some harness actually reached", () => {
    const declared = listTasks().filter((entry) => entry.effort);
    assert.ok(declared.length >= 13, "tiers 1 to 3 should all declare an effort reference");
    for (const entry of declared) {
        assert.ok(entry.effort.referenceCalls >= 1, `${entry.id} has a reference below one call`);
        assert.ok(entry.effort.weight > 0 && entry.effort.weight <= 1, `${entry.id} has an unusable weight`);
        assert.notEqual(
            entry.effort.demonstratedBy,
            "unrecorded",
            `${entry.id} must name the harness whose passing attempt set its floor`,
        );
    }
});
