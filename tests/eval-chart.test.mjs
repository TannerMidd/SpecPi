import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { aggregateSeries, groupSeries, renderCharts, renderComparison } from "../scripts/eval-chart.mjs";

function attempt({ pass, cost = 0.001, firstStep = 10000, tools = {} }) {
    return {
        pass,
        cost,
        costComplete: true,
        modelRequests: 2,
        firstCall: { toolCount: 0, toolNames: [], toolSchemaChars: 8, instructionChars: 0 },
        tokens: { inputTokens: 100, outputTokens: 10, cachedTokens: 0, withUsage: 2, toolCalls: tools },
        native: { firstStepInputTokens: firstStep, toolCalls: tools },
    };
}

function report({ model, label, cells }) {
    return {
        schema: 1,
        createdAt: "2026-09-18T00:00:00.000Z",
        specpiVersion: "0.26.0",
        piVersion: "0.84.4",
        nodeVersion: "v24.18.0",
        platform: "win32",
        model,
        attemptsPerCell: 2,
        forwarded: false,
        pricesSha256: "probe",
        pricesDated: "2026-09-17",
        method: "probe method",
        results: cells.map(([task, tier, category, passes]) => ({
            harness: "opencode",
            label,
            task,
            tier,
            category,
            attempts: passes.map((pass) => attempt({ pass })),
        })),
    };
}

const deepseek = report({
    model: "deepseek-v4.1-flash",
    label: "OpenCode",
    cells: [
        ["t1-create-file", 1, "terminal", [true, true]],
        ["t1-fix-script", 1, "repair", [true, false]],
    ],
});
const spark = report({
    model: "muse-spark-1.3-contributor",
    label: "OpenCode",
    cells: [
        ["t1-create-file", 1, "terminal", [true, true]],
        ["t1-fix-script", 1, "repair", [false, false]],
    ],
});

test("eval chart groups series by harness and model", () => {
    const grouped = groupSeries([deepseek, spark]);
    assert.equal(grouped.length, 2);
    assert.deepEqual(
        grouped.map((entry) => entry.key),
        ["OpenCode · deepseek-v4.1-flash", "OpenCode · muse-spark-1.3-contributor"],
    );
    assert.throws(() => groupSeries([{ schema: 99 }]), /Unsupported eval report/u);
});

test("eval chart aggregates categories and overall honestly", () => {
    const [first, second] = groupSeries([deepseek, spark]).map(aggregateSeries);
    assert.equal(first.overall.solved, 3);
    assert.equal(first.overall.attempts, 4);
    assert.equal(first.overall.solveRate, 0.75);
    assert.equal(second.overall.solved, 2);
    assert.equal(second.overall.solveRate, 0.5);
    assert.deepEqual(
        first.rows.map((row) => [row.category, row.solved, row.attempts]),
        [
            ["terminal", 2, 2],
            ["repair", 1, 2],
        ],
    );
    assert.equal(first.overall.meanFirstTokens, 10000);
    assert.equal(first.overall.contextEstimated, false);
});

test("eval chart estimates context for proxy-only attempts and says so", () => {
    const proxy = report({
        model: "measure-model",
        label: "Pi (stock)",
        cells: [["t1-create-file", 1, "terminal", [true]]],
    });
    proxy.results[0].attempts[0].native = null;
    proxy.results[0].attempts[0].firstCall = {
        toolCount: 1,
        toolNames: ["read"],
        toolSchemaChars: 4000,
        instructionChars: 0,
    };
    const [entry] = groupSeries([proxy]).map(aggregateSeries);
    assert.equal(entry.overall.meanFirstTokens, 1000);
    assert.equal(entry.overall.contextEstimated, true);
    const charts = renderCharts([entry]);
    assert.match(charts.context, /chars ÷ 4/u);
});

test("eval chart renders solve, cost and context SVGs with values", () => {
    const aggregated = groupSeries([deepseek, spark]).map(aggregateSeries);
    const charts = renderCharts(aggregated);
    for (const svg of [charts.solve, charts.cost, charts.context]) {
        assert.match(svg, /<svg xmlns/u);
        assert.match(svg, /OpenCode · deepseek-v4\.1-flash/u);
    }

    assert.match(charts.solve, /75%/u);
    assert.match(charts.solve, /50%/u);
    const comparison = renderComparison(aggregated, [deepseek, spark]);
    assert.match(comparison, /\| OpenCode · deepseek-v4\.1-flash \| 2 \| 3\/4 \| 75% \|/u);
});

test("eval chart writes SUMMARY.md and three SVGs end to end", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-eval-chart-"));
    try {
        const first = path.join(outDir, "deepseek.json");
        const second = path.join(outDir, "spark.json");
        fs.writeFileSync(first, JSON.stringify(deepseek));
        fs.writeFileSync(second, JSON.stringify(spark));
        const result = spawnSync(process.execPath, ["scripts/eval-chart.mjs", `--out=${outDir}`, first, second], {
            cwd: path.resolve("."),
            encoding: "utf8",
            timeout: 60000,
        });
        assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
        for (const name of ["SUMMARY.md", "chart-solve.svg", "chart-cost.svg", "chart-context.svg"]) {
            assert.ok(fs.existsSync(path.join(outDir, name)), name);
        }

        const summary = fs.readFileSync(path.join(outDir, "SUMMARY.md"), "utf8");
        assert.match(summary, /# Eval comparison/u);
    } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
    }
});
