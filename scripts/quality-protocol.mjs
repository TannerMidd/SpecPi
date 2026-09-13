import fs from "node:fs";
import path from "node:path";
import { tasks, suiteVersion } from "../evals/quality/catalog.mjs";
import { fixtureDigest } from "../evals/quality/fixtures.mjs";
import { sourceDigests, repositoryRoot, sha256 } from "../evals/quality/provenance.mjs";

export const gradingCorrection = {
    revision: 2,
    task: "lazy-iterator",
    reason: "Model reviews exposed a source-exception masking defect in an initially mislabeled negative control. Local reproduction confirmed it. Add exception-priority checks and reclassify the unchanged task as a repair. Regrade every final output; never retry a valid behavioral failure.",
    unchanged:
        "Model requests, supplied files, acceptance descriptions, fixture digests, prompts, edit tools, budgets and model settings are unchanged. Original outcomes and source fingerprints remain archived.",
};
export const trialId = (item) =>
    `${String(item.index + 1).padStart(3, "0")}-${item.task}-${item.condition}-r${item.repetition}`;
export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

export function assertGenerationCompatibility(original) {
    const current = sourceDigests();
    const allowed = new Set([
        "challenge-oracle.mjs",
        "challenge-reference.mjs",
        "challenge-tasks.mjs",
        "quality-evaluation.test.mjs",
        "run.mjs",
    ]);
    if (
        original.suiteVersion !== suiteVersion ||
        tasks.some((task) => original.fixtureDigests[task.id] !== fixtureDigest(task))
    ) {
        throw new Error("Supplied model task changed; old trials cannot be reused.");
    }

    if (Object.keys(original.sourceDigests).length !== Object.keys(current).length) {
        throw new Error("Evaluator inventory changed.");
    }

    const changes = Object.keys(current).filter((name) => original.sourceDigests[name] !== current[name]);
    if (changes.some((name) => !allowed.has(name))) {
        throw new Error("Generation source changed beyond the documented correction.");
    }

    const driver = fs.readFileSync(path.join(repositoryRoot, "evals/quality/run.mjs"), "utf8");
    if (
        changes.includes("run.mjs") &&
        sha256(driver.replace("export async function executeTrial(", "async function executeTrial(")) !==
            original.sourceDigests["run.mjs"]
    ) {
        throw new Error("Model driver changed beyond exporting executeTrial.");
    }

    return changes.map((name) => ({ name, before: original.sourceDigests[name], after: current[name] }));
}

export function readExperiment(rootDirectory, continuations = []) {
    const root = path.resolve(rootDirectory);
    const manifest = readJson(path.join(root, "manifest.json"));
    const parentHash = sha256(fs.readFileSync(path.join(root, "manifest.json")));
    const schedule = readJson(path.join(root, "schedule.json"));
    if (manifest.pilot || manifest.continuation || manifest.scheduled !== 192 || schedule.length !== 192) {
        throw new Error("Expected full original experiment.");
    }

    const sourcesChanged = assertGenerationCompatibility(manifest);
    const expected = new Map(schedule.map((item) => [trialId(item), item]));
    if (expected.size !== 192) {
        throw new Error("Duplicate scheduled trial.");
    }

    const selected = new Map();
    const invalid = [];
    const batches = [];
    for (const directory of [root, ...continuations.map((item) => path.resolve(item))]) {
        const meta = readJson(path.join(directory, "manifest.json"));
        const batchSchedule = readJson(path.join(directory, "schedule.json"));
        assertGenerationCompatibility(meta);
        for (const key of [
            "experiment",
            "model",
            "thinking",
            "provider",
            "repetitions",
            "concurrency",
            "maxEditRounds",
            "timeoutSeconds",
            "cliVersion",
            "node",
            "platform",
            "piVersion",
        ]) {
            if (meta[key] !== manifest[key]) {
                throw new Error(`Continuation changes ${key}.`);
            }
        }

        if (directory !== root && meta.continuation?.parentManifestSha256 !== parentHash) {
            throw new Error("Continuation belongs to different original experiment.");
        }

        if (batchSchedule.length !== meta.scheduled) {
            throw new Error("Batch schedule length mismatch.");
        }

        const ids = new Set();
        for (const item of batchSchedule) {
            const id = trialId(item);
            if (directory !== root && selected.has(id)) {
                throw new Error("Continuation scheduled an already-valid behavioral trial.");
            }

            const planned = expected.get(id);
            if (
                !planned ||
                ids.has(id) ||
                ["index", "task", "condition", "repetition"].some((key) => item[key] !== planned[key])
            ) {
                throw new Error("Unexpected or duplicate trial.");
            }

            ids.add(id);
            const resultFile = path.join(directory, id, "result.json");
            if (!fs.existsSync(resultFile)) {
                continue;
            }

            const record = readJson(resultFile);
            if (
                record.id !== id ||
                record.experiment !== manifest.experiment ||
                ["task", "condition", "repetition"].some((key) => record[key] !== planned[key]) ||
                record.fixtureDigest !== manifest.fixtureDigests[item.task]
            ) {
                throw new Error("Trial identity differs from schedule.");
            }

            const attempt = {
                record,
                directory: path.join(directory, id),
                resultSha256: sha256(fs.readFileSync(resultFile)),
                batch: batches.length,
            };
            if (record.error) {
                invalid.push(attempt);
            } else if (["passed", "failed"].includes(record.acceptance)) {
                if (selected.has(id)) {
                    throw new Error("Valid behavioral trial rerun; selection is ambiguous.");
                }

                selected.set(id, attempt);
            } else {
                throw new Error("Trial neither valid nor explicitly invalid.");
            }
        }

        batches.push({
            directory,
            manifest: meta,
            manifestSha256: sha256(fs.readFileSync(path.join(directory, "manifest.json"))),
            completion: readJson(path.join(directory, "completion.json")),
        });
    }

    return { root, manifest, parentHash, schedule, selected, invalid, batches, sourcesChanged };
}
