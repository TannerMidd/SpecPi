import assert from "node:assert/strict";
import test from "node:test";
import { aggregateQuality } from "../scripts/quality-results.mjs";
import { assertGenerationCompatibility } from "../scripts/quality-protocol.mjs";
import { gradeFinalFiles } from "../scripts/replay-quality-results.mjs";
import { tasks, suiteVersion } from "../evals/quality/catalog.mjs";
import { fixtureDigest } from "../evals/quality/fixtures.mjs";
import { sourceDigests } from "../evals/quality/provenance.mjs";

test("evaluation continuation rejects generation drift and replay rejects changed bytes", () => {
    const original = {
        suiteVersion,
        fixtureDigests: Object.fromEntries(tasks.map((task) => [task.id, fixtureDigest(task)])),
        sourceDigests: sourceDigests(),
    };
    assert.deepEqual(assertGenerationCompatibility(original), []);
    const requestDrift = structuredClone(original);
    requestDrift.fixtureDigests[tasks[0].id] = "changed";
    assert.throws(() => assertGenerationCompatibility(requestDrift), /task changed/);
    const toolDrift = structuredClone(original);
    toolDrift.sourceDigests["anchored-edit.mjs"] = "changed";
    assert.throws(() => assertGenerationCompatibility(toolDrift), /Generation source/);
    assert.throws(
        () =>
            gradeFinalFiles("intentional-interface", { "main.mjs": "bad-digest" }, { "bad-digest": "different code" }),
        /content digest/,
    );
});

test("quality summaries preserve pairs, invalid denominators and missing token fields", () => {
    const catalog = [
        { id: "a", difficulty: "hard", negativeControl: false },
        { id: "b", difficulty: "easy", negativeControl: true },
    ];
    const make = (task, condition, repetition, acceptance, error) => ({
        experiment: "review",
        task,
        condition,
        repetition,
        acceptance,
        ...(error ? { error } : {}),
        calls: [{ elapsedMs: 10, usage: { input_tokens: 5 }, toolEvents: [] }],
        changedFiles: [],
        editRounds: 1,
        editRejections: 0,
    });
    const runs = [
        make("a", "baseline", 1, "failed"),
        make("a", "skill", 1, "passed"),
        make("a", "baseline", 2, "passed"),
        make("a", "skill", 2, "failed"),
        make("a", "baseline", 3, "passed"),
        make("a", "skill", 3, null, "infrastructure"),
        make("b", "baseline", 1, "passed"),
    ];
    const result = aggregateQuality(runs, catalog).review;
    assert.deepEqual(result.paired, {
        baselineOnly: 1,
        candidateOnly: 1,
        bothPassed: 0,
        bothFailed: 0,
        invalidOrMissing: 2,
    });
    assert.equal(result.conditions.skill.valid, 2);
    assert.equal(result.conditions.skill.invalid, 1);
    assert.equal(result.conditions.skill.usage.output_tokens.total, null);
    assert.equal(result.conditions.skill.usage.input_tokens.total, 15);
    assert.equal(result.conditions.baseline.tasksPassedEveryRepeat, 0);
    assert.throws(() => aggregateQuality([...runs, runs[0]], catalog), /Duplicate trial/);
});
