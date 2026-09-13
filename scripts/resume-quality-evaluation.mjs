import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tasks, suiteVersion } from "../evals/quality/catalog.mjs";
import { sourceDigests, repositoryRoot } from "../evals/quality/provenance.mjs";
import { executeTrial } from "../evals/quality/run.mjs";
import { readExperiment, readJson, trialId, gradingCorrection } from "./quality-protocol.mjs";

const [parent, destination, qualificationFile, ...priorContinuations] = process.argv.slice(2);
if (!parent || !destination || !qualificationFile) {
    throw new Error(
        "Usage: node scripts/resume-quality-evaluation.mjs <original-batch> <new-directory> <qualification.json> [prior-continuation ...]",
    );
}

const experiment = readExperiment(parent, priorContinuations);
const qualified = readJson(qualificationFile);
const currentSources = sourceDigests();
if (
    qualified.suiteVersion !== suiteVersion ||
    qualified.tasks !== tasks.length ||
    JSON.stringify(qualified.sourceDigests) !== JSON.stringify(currentSources)
) {
    throw new Error("Continuation requires current qualification.");
}

const pending = experiment.schedule.filter((item) => !experiment.selected.has(trialId(item)));
if (!pending.length) {
    throw new Error("No missing or invalid trials need continuation.");
}

const codex = process.env.SPECPI_EVAL_CODEX || "codex";
const version = spawnSync(codex, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
if (
    version.status !== 0 ||
    version.stdout.trim() !== experiment.manifest.cliVersion ||
    process.version !== experiment.manifest.node ||
    process.platform !== experiment.manifest.platform
) {
    throw new Error("Continuation runtime differs from original.");
}

const relative = path.relative(repositoryRoot, os.tmpdir());
if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    throw new Error("Continuation TEMP must be outside repository.");
}

const output = path.resolve(destination);
fs.mkdirSync(output);
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-eval-"));
const config = {
    ...experiment.manifest,
    codex,
    scratchRoot,
    sourceDigests: currentSources,
    humanInterventions: experiment.batches.length,
};
const manifest = {
    ...config,
    qualification: qualified,
    scheduled: pending.length,
    startedAt: new Date().toISOString(),
    continuation: {
        parentManifestSha256: experiment.parentHash,
        priorManifestSha256: experiment.batches.map((batch) => batch.manifestSha256),
        retained: [...experiment.selected].map(([id, attempt]) => ({ id, resultSha256: attempt.resultSha256 })),
        invalidAttempts: experiment.invalid.map((attempt) => ({
            id: attempt.record.id,
            resultSha256: attempt.resultSha256,
        })),
        reason: "Continue only missing/invalid trials; retain every completed behavioral outcome without rerunning.",
        sourceChanges: experiment.sourcesChanged,
        gradingCorrection,
    },
};
fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(output, "schedule.json"), JSON.stringify(pending, null, 2));
let next = 0;
let halted = false;
const records = [];
try {
    const worker = async () => {
        while (!halted && next < pending.length) {
            const item = pending[next++];
            const task = tasks.find((task) => task.id === item.task);
            const result = await executeTrial(
                { task, repetition: item.repetition, condition: item.condition },
                item.index,
                output,
                config,
            );
            records.push(result);
            if (result.error) {
                halted = true;
            }
        }
    };

    await Promise.all(Array.from({ length: config.concurrency }, worker));
} finally {
    fs.writeFileSync(
        path.join(output, "completion.json"),
        JSON.stringify(
            {
                status: halted ? "invalid-run" : records.length === pending.length ? "complete" : "incomplete",
                scheduled: pending.length,
                completed: records.length,
                valid: records.filter((record) => !record.error).length,
                endedAt: new Date().toISOString(),
            },
            null,
            2,
        ),
    );
    if (
        path.dirname(scratchRoot) === path.resolve(os.tmpdir()) &&
        path.basename(scratchRoot).startsWith("specpi-eval-")
    ) {
        fs.rmSync(scratchRoot, { recursive: true, force: true });
    }
}

if (halted) {
    throw new Error("Continuation stopped on another invalid trial; all attempts retained.");
}
