import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gradeFinalFiles, portableSourceDigests, variantKey } from "./replay-quality-results.mjs";
import { aggregateQuality } from "./quality-results.mjs";

export function replayOpenRouter(data) {
    if (
        data.providerExperiment !== "openrouter-glm" ||
        !(data.runs?.length > 0) ||
        data.runs.length > 384 ||
        (data.cohortStatus !== "interrupted" && data.runs.length !== 384) ||
        JSON.stringify(data.grading.portableSourceDigests) !== JSON.stringify(portableSourceDigests())
    ) {
        throw new Error("Replay requires the complete GLM archive and its frozen grader sources.");
    }

    const results = new Map();
    const indexes = new Set();
    let protocolFailures = 0;
    for (const run of data.runs) {
        const planned = data.manifest.schedule[run.index];
        if (
            !planned ||
            indexes.has(run.index) ||
            run.error ||
            ["experiment", "task", "condition", "repetition"].some((key) => run[key] !== planned[key])
        ) {
            throw new Error("Duplicate, invalid or unscheduled GLM trial.");
        }

        indexes.add(run.index);
        const key = variantKey(run.task, run.finalFiles);
        if (!results.has(key)) {
            results.set(key, gradeFinalFiles(run.task, run.finalFiles, data.blobs));
        }

        const actual = results.get(key).acceptance;
        const protocolFailure = run.calls.some((call) => call.protocolFailure);
        if (protocolFailure) {
            protocolFailures += 1;
        }

        if (
            Boolean(run.modelFailure) !== protocolFailure ||
            run.oracle.acceptance !== actual ||
            run.acceptance !== (protocolFailure ? "failed" : actual)
        ) {
            throw new Error(`Replay differs: ${run.id}`);
        }
    }

    if (JSON.stringify(aggregateQuality(data.runs, data.catalog)) !== JSON.stringify(data.summary)) {
        throw new Error("Published aggregate differs from trial evidence.");
    }

    return { trials: data.runs.length, distinctVariants: results.size, protocolFailures, matched: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [file] = process.argv.slice(2);
    if (!file || process.argv.length !== 3) {
        throw new Error("Usage: node scripts/replay-openrouter-quality.mjs <public-glm-results.json>");
    }

    process.stdout.write(JSON.stringify(replayOpenRouter(JSON.parse(fs.readFileSync(file, "utf8")))) + "\n");
}
