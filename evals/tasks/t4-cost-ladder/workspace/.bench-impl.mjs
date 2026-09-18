#!/usr/bin/env node
// bench — run the query bank against src/engine.mjs and report what it cost.
//
// The number that matters is `reads`: calls to `table.row()`, the only way
// the engine can see a row. It is a property of the algorithm rather than of
// the machine, so two runs of the same engine report the same figure in CI
// and on a laptop. Wall clock would not.
//
// Each kind of query is scored against its own shipped cost, not against the
// total. Scoring the total would mean fixing five kinds of six moved the
// number barely at all, because whichever kind was left unfixed would still
// dominate the sum — and partial work is most of what there is time for here.
//
// `prepare` runs once and serves every kind, so its cost is split evenly
// across the six. Building one index for one kind therefore still costs a
// share of the pass it took, which is what it actually cost.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildRows, makeTable } from "./src/data.mjs";
import { answer, buildQueries } from "./src/workloads.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export const VISIBLE_SEED = 7310241;
export const ROW_COUNT = 12000;
export const KINDS = ["get", "range", "group", "topk", "distinct", "partner"];

export function budgets() {
    return JSON.parse(fs.readFileSync(path.join(here, ".budgets.json"), "utf8"));
}

export async function runBank({ seed, rowCount = ROW_COUNT, engineUrl }) {
    const engine = await import(engineUrl);
    const rows = buildRows(seed, rowCount);
    const queries = buildQueries(seed, rowCount);
    const { table, meter } = makeTable(rows);
    const results = [];
    let state = {};
    let prepareFailure = null;
    try {
        state = await engine.prepare(table);
    } catch (error) {
        prepareFailure = String(error?.message ?? error);
    }

    const prepareReads = meter.reads;
    for (const request of queries) {
        const before = meter.reads;
        let produced = null;
        let failure = prepareFailure;
        if (failure === null) {
            try {
                produced = await engine.query(state, table, request);
            } catch (error) {
                failure = String(error?.message ?? error);
            }
        }

        const expected = answer(rows, request);
        results.push({
            kind: request.kind,
            reads: meter.reads - before,
            correct: failure === null && JSON.stringify(produced) === JSON.stringify(expected),
            failure,
        });
    }

    return { prepareReads, totalReads: meter.reads, results };
}

// Progress along a log scale from the shipped engine to a good one. Linear
// would make the first easy win look like the whole job: going from fourteen
// million reads to one million is one step of several, not 93% done.
export function ladder(cost, shipped, target) {
    if (!Number.isFinite(cost) || cost <= 0 || shipped <= target) {
        return 0;
    }

    return Math.min(1, Math.max(0, Math.log(shipped / cost) / Math.log(shipped / target)));
}

// A kind whose queries are not all correct scores nothing for speed, because
// the cheapest wrong engine is always cheaper than the cheapest right one.
export function scoreRun(run, budget) {
    const share = run.prepareReads / KINDS.length;
    const rows = KINDS.map((kind) => {
        const own = run.results.filter((entry) => entry.kind === kind);
        const reads = own.reduce((total, entry) => total + entry.reads, 0);
        const correct = own.filter((entry) => entry.correct).length;
        const cost = reads + share;
        const score = correct === own.length && own.length > 0 ? ladder(cost, budget.shipped[kind], budget.target) : 0;

        return { kind, queries: own.length, correct, reads, cost, score };
    });

    return {
        rows,
        efficiency: rows.reduce((total, row) => total + row.score, 0) / rows.length,
        correct: run.results.filter((entry) => entry.correct).length,
        total: run.results.length,
    };
}

async function main() {
    const engineUrl = pathToFileURL(path.join(here, "src", "engine.mjs")).href;
    const run = await runBank({ seed: VISIBLE_SEED, engineUrl: `${engineUrl}?t=${Date.now()}` });
    const budget = budgets();
    const scored = scoreRun(run, budget);
    console.log(`rows ${ROW_COUNT}, queries ${scored.total}, correct ${scored.correct}/${scored.total}`);
    console.log(`prepare cost ${run.prepareReads} reads, charged ${(run.prepareReads / KINDS.length).toFixed(0)} to each kind`);
    console.log("");
    console.log("kind        queries  correct         reads          cost       shipped   score");
    for (const row of scored.rows) {
        console.log(
            [
                row.kind.padEnd(12),
                String(row.queries).padStart(7),
                String(row.correct).padStart(9),
                String(row.reads).padStart(14),
                row.cost.toFixed(0).padStart(14),
                String(budget.shipped[row.kind]).padStart(14),
                row.score.toFixed(3).padStart(8),
            ].join(""),
        );
    }

    console.log("");
    console.log(`target per kind   ${budget.target.toFixed(0)} reads (one pass over the table, shared six ways)`);
    console.log(`efficiency        ${scored.efficiency.toFixed(4)}  (0 = as shipped, 1 = at target on every kind)`);
    for (const entry of run.results.filter((result) => !result.correct)) {
        console.log(`WRONG ${entry.kind}${entry.failure === null ? "" : `: ${entry.failure}`}`);
    }

    return scored.correct === scored.total ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    try {
        process.exitCode = await main();
    } catch (error) {
        console.error(String(error?.stack ?? error));
        process.exitCode = 2;
    }
}
