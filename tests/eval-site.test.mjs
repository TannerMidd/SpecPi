import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collect } from "../scripts/eval-site.mjs";

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
