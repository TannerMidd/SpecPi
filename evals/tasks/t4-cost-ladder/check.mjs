import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// A seed and a row count the workspace never sees. An engine that answers
// from a table it reconstructed, or from results it remembered, is correct on
// the bank in front of it and wrong here — and here is what scores.
const HIDDEN_SEED = 1483927561;
const HIDDEN_ROWS = 9173;

// Correctness gates the score rather than adding to it. The engine ships
// correct, so paying for correctness would hand a harness that changed
// nothing a large fraction of the mark — and what this task measures is the
// distance travelled from that starting point, not the starting point.

function taskDir() {
    return path.dirname(fileURLToPath(import.meta.url));
}

function sha(text) {
    return createHash("sha256").update(String(text).split("\r\n").join("\n")).digest("hex");
}

export default async function check(workspaceDir) {
    const fixtures = JSON.parse(fs.readFileSync(path.join(taskDir(), "FIXTURES.json"), "utf8"));
    for (const [relative, digest] of Object.entries(fixtures)) {
        const file = path.join(workspaceDir, relative);
        if (!fs.existsSync(file)) {
            return { pass: false, score: 0, notes: `${relative} is missing; the cost model is fixed` };
        }

        if (sha(fs.readFileSync(file, "utf8")) !== digest) {
            return { pass: false, score: 0, notes: `${relative} was modified; the cost model is fixed` };
        }
    }

    const engineFile = path.join(workspaceDir, "src", "engine.mjs");
    if (!fs.existsSync(engineFile)) {
        return { pass: false, score: 0, notes: "src/engine.mjs is missing" };
    }

    let bench = null;
    try {
        bench = await import(`${pathToFileURL(path.join(workspaceDir, ".bench-impl.mjs")).href}?t=${Date.now()}`);
    } catch (error) {
        return { pass: false, score: 0, notes: `the bench could not load: ${String(error?.message ?? error)}` };
    }

    const budget = JSON.parse(fs.readFileSync(path.join(workspaceDir, ".budgets.json"), "utf8"));
    const engineUrl = `${pathToFileURL(engineFile).href}?t=${fs.statSync(engineFile).mtimeMs}`;
    let visible = null;
    let hidden = null;
    try {
        visible = await bench.runBank({ seed: bench.VISIBLE_SEED, engineUrl });
        hidden = await bench.runBank({ seed: HIDDEN_SEED, rowCount: HIDDEN_ROWS, engineUrl });
    } catch (error) {
        return { pass: false, score: 0, notes: `the engine did not run: ${String(error?.message ?? error)}` };
    }

    // The hidden bank has a different row count, so its floor is a different
    // number of reads. Scaling the budget rather than reusing it keeps the
    // ladder the same shape on both banks.
    const scale = HIDDEN_ROWS / budget.rows;
    const hiddenBudget = {
        rows: HIDDEN_ROWS,
        target: budget.target * scale,
        shipped: Object.fromEntries(Object.entries(budget.shipped).map(([kind, cost]) => [kind, cost * scale])),
    };
    const visibleScore = bench.scoreRun(visible, budget);
    const hiddenScore = bench.scoreRun(hidden, hiddenBudget);

    const answered = visibleScore.correct + hiddenScore.correct;
    const asked = visibleScore.total + hiddenScore.total;
    const correctness = answered / asked;
    // Efficiency is read off the hidden bank only. An engine tuned to the
    // visible seed is not a faster engine, and scoring the bank it was tuned
    // against would pay it for that.
    const score = correctness * hiddenScore.efficiency;

    const breakdown = [
        { check: "queries answered correctly", got: answered, of: asked },
        ...hiddenScore.rows.map((row) => ({
            check: `ladder: ${row.kind}`,
            got: Number(row.score.toFixed(3)),
            of: 1,
        })),
    ];

    const behind = hiddenScore.rows.filter((row) => row.score < 0.999).map((row) => row.kind);

    return {
        pass: correctness === 1 && hiddenScore.efficiency >= 0.999,
        score: Math.min(1, Math.max(0, score)),
        breakdown,
        notes:
            correctness < 1
                ? `${answered}/${asked} queries correct; efficiency is only scored on correct ones`
                : `all ${asked} queries correct, efficiency ${hiddenScore.efficiency.toFixed(3)}${behind.length > 0 ? `, still at shipped cost on: ${behind.join(", ")}` : ""}`,
    };
}
