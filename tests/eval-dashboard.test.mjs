import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { buildDashboard, dashboardData } from "../scripts/eval-dashboard.mjs";

function attempt({ pass, cost = 0.002, firstStep = 10000 }) {
    return {
        pass,
        cost,
        costComplete: true,
        modelRequests: 3,
        firstCall: { toolCount: 4, toolNames: ["read"], toolSchemaChars: 4000, instructionChars: 4000 },
        tokens: { inputTokens: 100, outputTokens: 10, cachedTokens: 0, withUsage: 3, toolCalls: {} },
        native: { firstStepInputTokens: firstStep, toolCalls: {} },
    };
}

function report({ model, label, tier, category, passes }) {
    return {
        schema: 1,
        createdAt: "2026-09-18T00:00:00.000Z",
        specpiVersion: "0.26.0",
        piVersion: "0.84.4",
        nodeVersion: "v24.18.0",
        platform: "win32",
        model,
        attemptsPerCell: 2,
        forwarded: true,
        pricesSha256: "probe",
        pricesDated: "2026-09-17",
        method: "probe",
        results: [
            { harness: "pi", label, task: "t-task", tier, category, attempts: passes.map((pass) => attempt({ pass })) },
        ],
    };
}

const tier1 = report({
    model: "deepseek-v4.1-flash",
    label: "Pi (stock)",
    tier: 1,
    category: "terminal",
    passes: [true, true],
});
const tier2a = report({
    model: "deepseek-v4.1-flash",
    label: "Pi (stock)",
    tier: 2,
    category: "repair",
    passes: [true, false],
});
const tier2b = report({
    model: "deepseek-v4.1-flash",
    label: "OpenCode",
    tier: 2,
    category: "repair",
    passes: [true, true],
});

test("eval dashboard splits series by tier", () => {
    const data = dashboardData([tier1, tier2a, tier2b]);
    assert.deepEqual(data.tierNumbers, [1, 2]);
    assert.equal(data.series.length, 2);
    const pi = data.series.find((entry) => entry.label === "Pi (stock)");
    assert.equal(pi.byTier.get(1).overall.solveRate, 1);
    assert.equal(pi.byTier.get(2).overall.solveRate, 0.5);
});

test("eval dashboard renders one svg with the table and every tier chart", () => {
    const svg = buildDashboard([tier1, tier2a, tier2b]);
    assert.match(svg, /^<svg xmlns/u);
    assert.match(svg, /<\/svg>\n$/u);
    assert.match(svg, /Pi \(stock\) · deepseek-v4\.1-flash/u);
    assert.match(svg, /Tier 1 · smoke/u);
    assert.match(svg, /Tier 2/u);
    // The table carries one solved/attempts column per tier; the percentage
    // moved to the charts so the columns still fit once a run spans four tiers.
    assert.match(svg, /<text x="\d+" y="\d+"[^>]*>1\/2<\/text>/u);
    assert.match(svg, />T1</u);
    assert.match(svg, />T2</u);
    // Root document plus three charts per tier present.
    assert.ok(svg.split("<svg").length - 1 >= 7, "expected nested chart documents");
    assert.throws(() => buildDashboard([]), /at least one report/u);
});

test("eval dashboard writes a file end to end", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-eval-dashboard-"));
    try {
        const first = path.join(dir, "one.json");
        const out = path.join(dir, "all.svg");
        fs.writeFileSync(first, JSON.stringify(tier2a));
        const result = spawnSync(process.execPath, ["scripts/eval-dashboard.mjs", `--out=${out}`, first], {
            cwd: path.resolve("."),
            encoding: "utf8",
            timeout: 60000,
        });
        assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
        const written = fs.readFileSync(out, "utf8");
        assert.match(written, /^<svg xmlns/u);
        assert.match(written, /Pi \(stock\)/u);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
