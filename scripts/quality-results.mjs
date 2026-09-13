import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tasks, suiteVersion } from "../evals/quality/catalog.mjs";
import { fixtureDigest } from "../evals/quality/fixtures.mjs";
import { repositoryRoot, sha256, sourceDigests } from "../evals/quality/provenance.mjs";
import { readExperiment, readJson, gradingCorrection, trialId } from "./quality-protocol.mjs";
import { gradeFinalFiles, variantKey, portableSourceDigests } from "./replay-quality-results.mjs";

const conditions = { review: ["baseline", "skill"], editing: ["native", "anchored"] };
const median = (values) => {
    if (!values.length) {
        return null;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function aggregateQuality(runs, catalog) {
    const byTask = Object.fromEntries(catalog.map((task) => [task.id, task]));
    const result = {};
    for (const [experiment, names] of Object.entries(conditions)) {
        const selected = runs.filter((run) => run.experiment === experiment);
        const byCondition = Object.fromEntries(
            names.map((condition) => {
                const all = selected.filter((run) => run.condition === condition);
                const valid = all.filter((run) => !run.error && ["passed", "failed"].includes(run.acceptance));
                const calls = all.flatMap((run) => run.calls);
                const usage = Object.fromEntries(
                    ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"].map((key) => {
                        const known = calls.filter((call) => Number.isFinite(call.usage?.[key]));

                        return [
                            key,
                            {
                                total:
                                    known.length === calls.length && calls.length
                                        ? known.reduce((sum, call) => sum + call.usage[key], 0)
                                        : null,
                                knownCalls: known.length,
                                calls: calls.length,
                            },
                        ];
                    }),
                );

                return [
                    condition,
                    {
                        trials: all.length,
                        valid: valid.length,
                        passed: valid.filter((run) => run.acceptance === "passed").length,
                        failed: valid.filter((run) => run.acceptance === "failed").length,
                        invalid: all.length - valid.length,
                        tasksPassedEveryRepeat: catalog.filter((task) => {
                            const group = valid.filter((run) => run.task === task.id);

                            return group.length === 3 && group.every((run) => run.acceptance === "passed");
                        }).length,
                        medianModelMs: median(
                            valid.map((run) => run.calls.reduce((sum, call) => sum + call.elapsedMs, 0)),
                        ),
                        editRejections: all.reduce((sum, run) => sum + (run.editRejections ?? 0), 0),
                        recoveryTrials: all.filter((run) => (run.editRounds ?? 0) > 1).length,
                        controlsWithFindings: valid.filter(
                            (run) => byTask[run.task]?.negativeControl && run.findings?.length,
                        ).length,
                        controlsEdited: valid.filter(
                            (run) => byTask[run.task]?.negativeControl && run.changedFiles?.length,
                        ).length,
                        nativeToolEvents: calls.reduce((sum, call) => sum + call.toolEvents.length, 0),
                        usage,
                    },
                ];
            }),
        );
        const pairs = new Map();
        for (const run of selected) {
            const key = `${run.task}/${run.repetition}`;
            const pair = pairs.get(key) ?? {};
            if (pair[run.condition]) {
                throw new Error(`Duplicate trial in quality results: ${key}/${run.condition}`);
            }

            pair[run.condition] = run;
            pairs.set(key, pair);
        }

        const paired = (difficulty) => {
            const totals = { baselineOnly: 0, candidateOnly: 0, bothPassed: 0, bothFailed: 0, invalidOrMissing: 0 };
            for (const pair of pairs.values()) {
                const a = pair[names[0]];
                const b = pair[names[1]];
                if (difficulty && byTask[(a ?? b).task]?.difficulty !== difficulty) {
                    continue;
                }

                if (
                    !a ||
                    !b ||
                    a.error ||
                    b.error ||
                    !["passed", "failed"].includes(a.acceptance) ||
                    !["passed", "failed"].includes(b.acceptance)
                ) {
                    totals.invalidOrMissing += 1;
                } else if (a.acceptance === "passed" && b.acceptance === "passed") {
                    totals.bothPassed += 1;
                } else if (a.acceptance === "failed" && b.acceptance === "failed") {
                    totals.bothFailed += 1;
                } else if (a.acceptance === "passed") {
                    totals.baselineOnly += 1;
                } else {
                    totals.candidateOnly += 1;
                }
            }

            return totals;
        };

        result[experiment] = {
            conditions: byCondition,
            paired: paired(),
            difficulty: Object.fromEntries(
                ["easy", "medium", "hard"].map((difficulty) => [difficulty, paired(difficulty)]),
            ),
        };
    }

    return result;
}

function sanitize(value, roots) {
    if (typeof value !== "string") {
        return value;
    }

    let result = value;
    for (const [root, replacement] of roots) {
        for (const spelling of new Set([root, root.replaceAll("\\", "/"), root.replaceAll("/", "\\")])) {
            result = result.split(spelling).join(replacement);
        }
    }

    return result;
}

export function collectQualityResults(directories, qualificationFile) {
    const sources = sourceDigests();
    const qualification = readJson(qualificationFile);
    if (
        JSON.stringify(qualification.sourceDigests) !== JSON.stringify(sources) ||
        qualification.tasks !== tasks.length
    ) {
        throw new Error("Export requires current grader qualification.");
    }

    const groups = directories.map((directory) => ({
        directory,
        manifest: readJson(path.join(directory, "manifest.json")),
    }));
    const originals = groups.filter((item) => !item.manifest.continuation);
    if (originals.length !== 2 || new Set(originals.map((item) => item.manifest.experiment)).size !== 2) {
        throw new Error("Both distinct experiments are required.");
    }

    const experiments = originals.map((item) =>
        readExperiment(
            item.directory,
            groups
                .filter(
                    (other) => other.manifest.continuation && other.manifest.experiment === item.manifest.experiment,
                )
                .map((other) => other.directory),
        ),
    );
    if (experiments.some((experiment) => experiment.selected.size !== 192)) {
        throw new Error("The planned 384 valid outcomes are not complete.");
    }

    const roots = [
        [repositoryRoot.replace(/[\\/]$/u, ""), "<repository>"],
        [os.homedir(), "<home>"],
        [path.resolve(os.tmpdir()), "<temp>"],
    ];
    for (const experiment of experiments) {
        for (const batch of experiment.batches) {
            roots.push([batch.directory, "<results>"], [batch.manifest.scratchRoot, "<model-cwd>"]);
        }
    }

    roots.sort(([a], [b]) => b.length - a.length);
    const clean = (value) => {
        if (Array.isArray(value)) {
            return value.map(clean);
        }

        if (value && typeof value === "object") {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]));
        }

        return sanitize(value, roots);
    };

    const calls = (record) =>
        record.calls.map((call) => ({
            stage: call.stage,
            elapsedMs: call.elapsedMs,
            usage: call.usage,
            toolEvents: call.toolEvents,
            promptDigest: call.promptDigest,
            ...(call.incomplete ? { incomplete: true } : {}),
            ...(call.editResults ? { editResults: call.editResults } : {}),
        }));
    const runs = [];
    const invalidAttempts = [];
    const manifests = {};
    const blobs = {};
    const grades = new Map();
    for (const experiment of experiments) {
        manifests[experiment.manifest.experiment] = experiment.batches.map((batch) => {
            const { codex: _codex, scratchRoot: _scratch, ...manifest } = batch.manifest;

            return { ...manifest, manifestSha256: batch.manifestSha256, completion: batch.completion };
        });
        for (const attempt of experiment.invalid) {
            invalidAttempts.push({
                id: attempt.record.id,
                experiment: attempt.record.experiment,
                task: attempt.record.task,
                condition: attempt.record.condition,
                repetition: attempt.record.repetition,
                error: attempt.record.error,
                acceptance: null,
                excludedFromBehavioralDenominator: true,
                resultSha256: attempt.resultSha256,
                batch: attempt.batch,
                calls: calls(attempt.record),
            });
        }

        for (const item of experiment.schedule) {
            const attempt = experiment.selected.get(trialId(item));
            const record = attempt.record;
            const task = tasks.find((task) => task.id === record.task);
            if (Object.keys(record.finalFiles).length !== Object.keys(task.files).length) {
                throw new Error("Final file inventory is incomplete.");
            }

            for (const [file, expected] of Object.entries(record.finalFiles)) {
                if (!Object.hasOwn(task.files, file)) {
                    throw new Error("Final file outside fixture.");
                }

                const bytes = fs.readFileSync(path.join(attempt.directory, "fixture", file));
                if (sha256(bytes) !== expected) {
                    throw new Error(`Final file changed after grading: ${record.id}/${file}`);
                }

                const content = bytes.toString("utf8");
                const normalized = content.replaceAll("\\\\", "\\").replaceAll("\\", "/").toLowerCase();
                if (roots.some(([hostPath]) => normalized.includes(hostPath.replaceAll("\\", "/").toLowerCase()))) {
                    throw new Error("Fixture contains a host path; inspect before export.");
                }

                blobs[expected] = content;
            }

            const key = variantKey(task.id, record.finalFiles);
            if (!grades.has(key)) {
                grades.set(key, gradeFinalFiles(task.id, record.finalFiles, blobs));
            }

            const oracle = grades.get(key);
            const findingPath = (value) => {
                const match = /^(.*?):(\d+)(?::\d+)?$/u.exec(value);
                const file = Object.hasOwn(task.files, value) ? value : match?.[1];

                return Object.hasOwn(task.files, file)
                    ? { path: file, ...(match ? { line: Number(match[2]) } : {}) }
                    : { path: "<outside-fixture>" };
            };

            runs.push({
                id: record.id,
                experiment: record.experiment,
                task: record.task,
                condition: record.condition,
                repetition: record.repetition,
                batch: attempt.batch,
                resultSha256: attempt.resultSha256,
                fixtureDigest: record.fixtureDigest,
                acceptance: oracle.acceptance,
                originalAcceptance: record.acceptance,
                originalOracle: record.oracle,
                oracle,
                gradingVariant: key,
                maintainability: record.maintainability,
                ...(record.findings
                    ? { findings: record.findings.map((finding) => ({ ...finding, ...findingPath(finding.path) })) }
                    : {}),
                changedFiles: record.changedFiles,
                finalFiles: record.finalFiles,
                editRejections: record.editRejections,
                editRounds: record.editRounds,
                calls: calls(record),
            });
        }
    }

    if (JSON.stringify(sourceDigests()) !== JSON.stringify(sources)) {
        throw new Error("Grader changed during export.");
    }

    const catalog = tasks.map((task) => ({
        id: task.id,
        category: task.category,
        domain: task.domain ?? task.category,
        difficulty: task.difficulty,
        negativeControl: task.category === "negative-control",
        provenance: task.provenance,
        request: task.request,
        acceptance: task.acceptance,
        files: Object.keys(task.files),
        sourceBytes: Object.values(task.files).reduce((sum, value) => sum + Buffer.byteLength(value), 0),
        fixtureDigest: fixtureDigest(task),
    }));

    return clean({
        schema: 2,
        suiteVersion,
        createdAt: new Date().toISOString(),
        catalog,
        manifests,
        runs,
        invalidAttempts,
        blobs,
        summary: aggregateQuality(runs, catalog),
        grading: {
            ...gradingCorrection,
            sourceDigests: sources,
            portableSourceDigests: portableSourceDigests(),
            qualification,
            distinctFinalVariants: grades.size,
            changedOutcomes: runs
                .filter((run) => run.acceptance !== run.originalAcceptance)
                .map((run) => ({
                    id: run.id,
                    experiment: run.experiment,
                    before: run.originalAcceptance,
                    after: run.acceptance,
                })),
        },
        excludedPilot: { trials: 4, reason: "Two-task review protocol smoke test; excluded before the full schedule." },
        limitations: [
            "Behavioral acceptance on curated JavaScript tasks is not general coding accuracy.",
            "Difficulty labels describe task design; model performance may saturate them.",
            "Three trials share a task; paired counts are descriptive, not independent population samples or significance estimates.",
            "Review precision and maintainability need human assessment; findings on controls are not automatically false positives.",
            "Supplied-context Codex adapter; not full Pi sessions, repository exploration, installed verification gates or VS Code attachments.",
            "Dollar cost is unavailable for subscription runs; missing usage fields remain null.",
            "The grader correction was made after observing model findings, then applied equally to every final fixture. Original outcomes remain available.",
        ],
    });
}
