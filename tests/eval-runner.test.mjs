import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { harnessAdapters, resolveHarnesses } from "../scripts/eval-harnesses.mjs";

function runEval(args, extraEnv = {}) {
    return spawnSync(process.execPath, ["scripts/eval-run.mjs", ...args], {
        cwd: path.resolve("."),
        env: { ...process.env, ...extraEnv },
        encoding: "utf8",
        timeout: 120000,
    });
}

test("eval runner resolves known harnesses and rejects unknown ones", () => {
    const harnesses = resolveHarnesses(["fake"]);
    assert.equal(harnesses.length, 1);
    assert.equal(harnesses[0].id, "fake");
    assert.throws(() => resolveHarnesses(["nope"]), /Unknown harness/u);
    assert.equal(harnessAdapters.fake.isAvailable().available, true);
    assert.equal(harnessAdapters["failing-fake"].isAvailable().available, true);
});

test("eval runner lists and dry-runs without touching homes", () => {
    const listed = runEval(["--list", "--harness=fake,failing-fake", "--tier=1"]);
    assert.equal(listed.status, 0, `${listed.stderr}\n${listed.stdout}`);
    assert.match(listed.stdout, /fake/u);
    const dry = runEval(["--dry-run", "--harness=fake", "--tier=1", "--attempts=2"]);
    assert.equal(dry.status, 0, `${dry.stderr}\n${dry.stdout}`);
    assert.match(dry.stdout, /dry run/u);
});

test("eval runner completes a Tier 1 offline run with the expected split", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-eval-out-"));
    try {
        const result = runEval([
            "--harness=fake,failing-fake",
            "--tier=1",
            "--attempts=1",
            "--model=fake-model",
            `--out=${outDir}`,
        ]);
        assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
        const report = JSON.parse(fs.readFileSync(path.join(outDir, "report.json"), "utf8"));
        assert.equal(report.schema, 1);
        assert.equal(report.model, "fake-model");
        assert.equal(report.results.length, 8);
        for (const cell of report.results) {
            assert.equal(cell.attempts.length, 1);
            assert.equal(cell.attempts[0].cost, 0);
            assert.equal(cell.attempts[0].costComplete, true);
        }

        const fakeCells = report.results.filter((cell) => cell.harness === "fake");
        const failingCells = report.results.filter((cell) => cell.harness === "failing-fake");
        assert.ok(
            fakeCells.every((cell) => cell.attempts[0].pass),
            "reference harness must pass Tier 1",
        );
        assert.ok(
            failingCells.every((cell) => !cell.attempts[0].pass),
            "negative control must fail Tier 1",
        );
    } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
    }
});
