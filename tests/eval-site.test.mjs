import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collect } from "../scripts/eval-site.mjs";
import { harnessRow, ledgerRollup } from "../scripts/jev-effect.mjs";

function report(directory, name, model, cells) {
    const file = path.join(directory, `${name}.json`);
    fs.writeFileSync(
        file,
        JSON.stringify({
            model,
            attemptsPerCell: 1,
            specpiVersion: "0.0.0",
            piVersion: "0.0.0",
            platform: "test",
            pricesDated: "2026-09-17",
            results: cells,
        }),
    );

    return file;
}

const cell = (harness, task, tier) => ({
    harness,
    task,
    tier,
    attempts: [{ pass: true, score: 1, modelRequests: 1, tokens: { toolCalls: { bash: 1 } } }],
});

function withDirectory(run) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-site-"));
    try {
        return run(directory);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

// The page prints one model name and prices every row against one frozen entry for it. Metadata is
// read from whichever report sorted last, so a set spanning two models would publish one label over
// both and nothing would look wrong. The same shape was already caught once for attempts per cell.
test("a set spanning two models is refused rather than labelled with one of them", () => {
    withDirectory((directory) => {
        const files = [
            report(directory, "a", "deepseek-v4.1-flash", [cell("pi", "t1-create-file", 1)]),
            report(directory, "b", "muse-spark-1.3-contributor", [cell("pi", "t1-edit-file", 1)]),
        ];
        assert.throws(() => collect(files), /span 2 models/u);
        // Both names appear, because the caller has to decide which run to publish.
        assert.throws(() => collect(files), /deepseek-v4\.1-flash/u);
        assert.throws(() => collect(files), /muse-spark-1\.3-contributor/u);
    });
});

test("a uniform set still renders, whichever model it is on", () => {
    withDirectory((directory) => {
        for (const model of ["deepseek-v4.1-flash", "muse-spark-1.3-contributor"]) {
            const files = [
                report(directory, "one", model, [cell("pi", "t1-create-file", 1)]),
                report(directory, "two", model, [cell("specpi-default", "t1-create-file", 1)]),
            ];
            const data = collect(files);
            assert.equal(data.model, model);
            assert.deepEqual(data.tiers, [1]);
        }
    });
});

// A run's ledger lives per attempt, because that is where it is collected out of the disposable
// home. Rolling it up is the only way to answer "did this system ever do anything", and the answer
// has to survive addition: counts add, and an `outcomes` map has to merge rather than average.
test("the advisor's ledger rolls up across attempts without losing why it declined", () => {
    withDirectory((directory) => {
        const ledger = (system, calls, applied, outcomes, savedBytes = 0) => ({
            bySystem: { [system]: { calls, failed: 0, applied, savedBytes, outcomes } },
        });
        const file = report(directory, "jev", "deepseek-v4.1-flash", [
            {
                harness: "specpi-jev",
                task: "t1-create-file",
                tier: 1,
                attempts: [
                    {
                        pass: true,
                        score: 1,
                        modelRequests: 1,
                        tokens: { toolCalls: { bash: 1 } },
                        advisor: { ledger: ledger("retention", 3, 0, { "relevance-low-confidence": 3 }) },
                    },
                    {
                        pass: true,
                        score: 1,
                        modelRequests: 1,
                        tokens: { toolCalls: { bash: 1 } },
                        advisor: {
                            ledger: ledger(
                                "retention",
                                2,
                                1,
                                { "relevance-low-confidence": 1, "relevance-high": 1 },
                                512,
                            ),
                        },
                    },
                    // An attempt that made no call at all: a real outcome, and a different one from
                    // an attempt whose ledger was never read.
                    { pass: true, score: 1, modelRequests: 1, tokens: { toolCalls: { bash: 1 } }, advisor: {} },
                ],
            },
        ]);

        const rollup = ledgerRollup([file]);
        assert.equal(rollup.attempts, 3);
        assert.equal(rollup.measured, 2, "the denominator is attempts that recorded a ledger");
        assert.equal(rollup.calls, 5);
        assert.equal(rollup.applied, 1);
        assert.equal(rollup.savedBytes, 512);
        assert.deepEqual(rollup.bySystem.retention.outcomes, {
            "relevance-low-confidence": 4,
            "relevance-high": 1,
        });
    });
});

test("a harness that never ran in a set of reports is a missing column, not a zero", () => {
    // The comparison puts the control and the layer side by side from different files. A harness
    // read as zero where it is simply absent would publish "0.000" as a score it never earned.
    withDirectory((directory) => {
        const file = report(directory, "one", "deepseek-v4.1-flash", [cell("specpi-jev", "t1-create-file", 1)]);
        assert.equal(harnessRow([file], "specpi-default"), undefined);
        assert.equal(harnessRow([path.join(directory, "absent.json")], "specpi-jev"), undefined);
        assert.equal(harnessRow([file], "specpi-jev").overall.attempts, 1);
    });
});
