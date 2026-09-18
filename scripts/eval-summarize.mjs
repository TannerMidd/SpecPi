#!/usr/bin/env node
// Render report.json as a human-readable markdown summary. Costs are always
// shown as mean-per-attempt alongside cost-per-success; unknown prices keep
// their lower-bound marker. Usage: node scripts/eval-summarize.mjs <report.json>

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { attemptModelCost, formatCost, pairedContingency, summarizeAttempts } from "./eval-report.mjs";
import { repriceReport } from "./eval-prices.mjs";

export function cellSummary(cell) {
    const summary = summarizeAttempts(cell.attempts);
    const totalCost = cell.attempts.reduce((sum, attempt) => sum + attemptModelCost(attempt), 0);
    const requests = cell.attempts.map((attempt) => attempt.modelRequests ?? 0);
    const firstCalls = cell.attempts.map((attempt) => attempt.firstCall).filter(Boolean);
    const meanFirstCall =
        firstCalls.length === 0
            ? 0
            : firstCalls.reduce((sum, call) => sum + call.toolSchemaChars + call.instructionChars, 0) /
              firstCalls.length;

    const nativeFirstSteps = cell.attempts
        .map((attempt) => attempt.native?.firstStepInputTokens)
        .filter((value) => Number.isFinite(value) && value > 0);
    const meanFirstStepTokens =
        nativeFirstSteps.length === 0 ? null : nativeFirstSteps.reduce((a, b) => a + b, 0) / nativeFirstSteps.length;

    return {
        ...summary,
        totalCost,
        meanRequests: requests.reduce((a, b) => a + b, 0) / Math.max(1, requests.length),
        meanFirstCall,
        meanFirstStepTokens,
    };
}

export function renderSummary(report) {
    const lines = [];
    lines.push(`# Eval summary (${report.createdAt})`);
    lines.push("");
    lines.push(`Model ${report.model}, ${report.attemptsPerCell} attempt(s) per cell, forwarded: ${report.forwarded}.`);
    lines.push(`SpecPi ${report.specpiVersion}, Pi ${report.piVersion}, ${report.platform}.`);
    lines.push("");
    lines.push("| Harness | Task | Solved | Score | In scope | Cost/attempt | Eval overhead | Steps | First context |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const cell of report.results) {
        const summary = cellSummary(cell);
        const firstContext =
            summary.meanFirstStepTokens === null
                ? `${Math.round(summary.meanFirstCall).toLocaleString("en-US")} chars`
                : `${Math.round(summary.meanFirstStepTokens).toLocaleString("en-US")} in-tok`;
        const overhead =
            summary.meanMintCostPerAttempt > 0 ? formatCost(summary.meanMintCostPerAttempt, summary.costComplete) : "—";
        const scopeText = summary.scope.cleanRate === null ? "—" : `${summary.scope.clean}/${summary.scope.measured}`;
        lines.push(
            `| ${cell.label} | ${cell.task} | ${summary.solved}/${summary.attempts} | ` +
                `${(summary.meanScore * 100).toFixed(0)}% | ${scopeText} | ` +
                `${formatCost(summary.meanCostPerAttempt, summary.costComplete)} | ` +
                `${overhead} | ${summary.meanRequests.toFixed(1)} | ${firstContext} |`,
        );
    }

    lines.push("");
    const harnesses = [...new Set(report.results.map((cell) => cell.harness))];
    if (harnesses.length === 2) {
        const [first, second] = harnesses;
        const firstAttempts = report.results.filter((cell) => cell.harness === first).flatMap((cell) => cell.attempts);
        const secondAttempts = report.results
            .filter((cell) => cell.harness === second)
            .flatMap((cell) => cell.attempts);
        const pairs = pairedContingency(firstAttempts, secondAttempts);
        lines.push(
            `Paired outcomes (${first} vs ${second}): both ${pairs.both}, only ${first} ${pairs.onlyFirst}, only ${second} ${pairs.onlySecond}, neither ${pairs.neither}.`,
        );
        lines.push("");
    }

    lines.push(
        "_Cost/attempt is the harness's own model spend. Eval overhead is the per-attempt OpenCode session mint, " +
            "which only proxy harnesses need and which carries OpenCode's own system prompt, so it is reported beside " +
            "the harness figure rather than inside it; report.json carries modelCost, mintCost and their sum._",
    );
    lines.push("");
    lines.push(
        "_Success-conditioned cost is omitted here because it hides failures; see report.json for the raw attempts._",
    );
    lines.push("");

    return `${lines.join("\n")}\n`;
}

function main() {
    const file = process.argv[2];
    if (!file) {
        console.error("Usage: node scripts/eval-summarize.mjs <report.json>");
        process.exitCode = 2;

        return;
    }

    const report = repriceReport(JSON.parse(fs.readFileSync(path.resolve(file), "utf8")));
    console.log(renderSummary(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
