// Generates t4-cost-ladder's budgets and fixture hashes.
//
// Nothing here writes the workspace — the engine, the cost model and the
// query bank are hand-written source. What this script does is measure: it
// runs the shipped engine and the reference engine over the same bank and
// records what each one cost, so the ladder a harness climbs is anchored to
// two implementations that exist rather than to two numbers someone chose.
//
// Run after changing any of src/, .bench-impl.mjs or reference-engine.mjs:
//
//     node evals/tasks/t4-cost-ladder/generate.mjs \
//         evals/tasks/t4-cost-ladder/workspace

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const root = path.resolve(process.argv[2]);
const taskDir = path.dirname(root);

const bench = await import(pathToFileURL(path.join(root, ".bench-impl.mjs")).href);

async function costsOf(engineUrl) {
    const run = await bench.runBank({ seed: bench.VISIBLE_SEED, engineUrl });
    const perKind = {};
    for (const kind of bench.KINDS) {
        const own = run.results.filter((entry) => entry.kind === kind);
        perKind[kind] = own.reduce((total, entry) => total + entry.reads, 0) + run.prepareReads / bench.KINDS.length;
    }

    return { perKind, run };
}

const shipped = await costsOf(pathToFileURL(path.join(root, "src", "engine.mjs")).href);
const reference = await costsOf(pathToFileURL(path.join(taskDir, "reference-engine.mjs")).href);

const wrong = [...shipped.run.results, ...reference.run.results].filter((entry) => !entry.correct);
if (wrong.length > 0) {
    console.error(`engines disagree with the query bank on ${wrong.length} query/queries`);
    for (const entry of wrong.slice(0, 5)) {
        console.error(`  ${entry.kind}${entry.failure === null ? "" : `: ${entry.failure}`}`);
    }

    process.exitCode = 1;
}

// One pass over the table, split six ways: the floor, because an engine that
// reads no rows at all cannot answer anything.
const target = bench.ROW_COUNT / bench.KINDS.length;
const budget = {
    rows: bench.ROW_COUNT,
    target,
    shipped: Object.fromEntries(bench.KINDS.map((kind) => [kind, Math.round(shipped.perKind[kind])])),
};
fs.writeFileSync(path.join(root, ".budgets.json"), `${JSON.stringify(budget, null, 2)}\n`);

const shippedScore = bench.scoreRun(shipped.run, budget);
const referenceScore = bench.scoreRun(reference.run, budget);
console.log("kind          shipped     reference       span");
for (const kind of bench.KINDS) {
    const span = Math.log(budget.shipped[kind] / target);
    console.log(
        `${kind.padEnd(12)}${String(budget.shipped[kind]).padStart(11)}${reference.perKind[kind].toFixed(0).padStart(14)}${span.toFixed(2).padStart(11)}`,
    );
}

console.log(`\nshipped efficiency   ${shippedScore.efficiency.toFixed(4)}`);
console.log(`reference efficiency ${referenceScore.efficiency.toFixed(4)}`);

const fixtures = {};
const add = (relative) => {
    const text = fs.readFileSync(path.join(root, relative), "utf8").split("\r\n").join("\n");
    fixtures[relative] = createHash("sha256").update(text).digest("hex");
};

for (const relative of ["src/data.mjs", "src/workloads.mjs", ".bench-impl.mjs", ".budgets.json"]) {
    add(relative);
}

fs.writeFileSync(path.join(taskDir, "FIXTURES.json"), `${JSON.stringify(fixtures, null, 2)}\n`);

// The ladder has to have room on it. A kind whose shipped cost is already
// near the floor cannot be improved, so it would be a free mark for doing
// nothing — and a reference that does not reach the floor would make a
// perfect score unreachable.
const problems = [];
for (const kind of bench.KINDS) {
    if (budget.shipped[kind] < target * 4) {
        problems.push(`${kind} ships at ${budget.shipped[kind]} reads, too close to the ${target} floor to score`);
    }
}

if (referenceScore.efficiency < 0.999) {
    problems.push(`reference engine scores ${referenceScore.efficiency.toFixed(4)}, so a perfect score is unreachable`);
}

if (shippedScore.efficiency > 0.001) {
    problems.push(`shipped engine already scores ${shippedScore.efficiency.toFixed(4)}`);
}

for (const problem of problems) {
    console.error(problem);
}

if (problems.length > 0) {
    process.exitCode = 1;
}
