import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tasks, suiteVersion } from "../evals/quality/catalog.mjs";
import { fixtureDigest } from "../evals/quality/fixtures.mjs";
import { repositoryRoot, sourceDigests, sha256 } from "../evals/quality/provenance.mjs";
import { buildProviderSchedule, resumeState, profiles } from "./openrouter-quality.mjs";
import { gradeFinalFiles, variantKey, portableSourceDigests } from "./replay-quality-results.mjs";
import { aggregateQuality } from "./quality-results.mjs";
import { QualityBudget } from "./quality-budget.mjs";

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
function sanitize(value, roots) {
    if (typeof value === "string") {
        return roots.reduce(
            (text, root) => text.replaceAll(root, "<local>").replaceAll(root.replaceAll("\\", "/"), "<local>"),
            value,
        );
    }

    if (Array.isArray(value)) {
        return value.map((item) => sanitize(item, roots));
    }

    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item, roots)]));
    }

    return value;
}

export function collectOpenRouter(directory, ledger, pilotDirectories = [], { allowIncomplete = false } = {}) {
    const root = path.resolve(directory);
    const manifest = read(path.join(root, "manifest.json"));
    const profile = manifest.profile ?? "glm";
    const schedule = buildProviderSchedule().map(({ task, ...run }) => ({ ...run, task: task.id }));
    if (
        manifest.mode !== "full" ||
        !Object.hasOwn(profiles, profile) ||
        manifest.settings?.model !== profiles[profile].model ||
        manifest.suiteVersion !== suiteVersion ||
        JSON.stringify(manifest.schedule) !== JSON.stringify(schedule) ||
        JSON.stringify(manifest.sourceDigests) !== JSON.stringify(sourceDigests()) ||
        tasks.some((task) => manifest.fixtureDigests[task.id] !== fixtureDigest(task))
    ) {
        throw new Error("Export requires the unchanged full schedule and qualified sources.");
    }

    const expectedAdapters = ["openrouter-quality.mjs", "quality-budget.mjs", "replay-quality-results.mjs"];
    if (
        JSON.stringify(Object.keys(manifest.adapterDigests)) !== JSON.stringify(expectedAdapters) ||
        expectedAdapters.some(
            (file) =>
                sha256(fs.readFileSync(path.join(repositoryRoot, "scripts", file))) !== manifest.adapterDigests[file],
        )
    ) {
        throw new Error("Provider adapter differs from the frozen run.");
    }

    const retained = resumeState(root, manifest);
    const completion = read(path.join(root, "completion.json"));
    if (!allowIncomplete && (retained.valid.size !== 384 || completion.status !== "complete")) {
        throw new Error("All 384 valid behavioral outcomes are required for publication.");
    }

    const catalog = read(path.join(repositoryRoot, "evals/quality/results/2026-09-13-v2.json")).catalog;
    const blobs = {};
    const variants = new Map();
    const runs = [];
    for (const [index, record] of [...retained.valid].sort(([a], [b]) => a - b)) {
        if (retained.attempts.get(index) !== record.attempt) {
            throw new Error("An attempt was scheduled after a valid behavioral result.");
        }

        const fixture = path.join(root, `${record.id}-attempt${record.attempt}`, "fixture");
        for (const [name, hash] of Object.entries(record.finalFiles)) {
            if (!Object.hasOwn(tasks.find((task) => task.id === record.task).files, name)) {
                throw new Error("Unknown fixture file.");
            }

            const content = fs.readFileSync(path.join(fixture, name), "utf8");
            if (sha256(content) !== hash) {
                throw new Error("Retained final fixture changed.");
            }

            blobs[hash] = content;
        }

        const key = variantKey(record.task, record.finalFiles);
        if (!variants.has(key)) {
            variants.set(key, gradeFinalFiles(record.task, record.finalFiles, blobs));
        }

        const graded = variants.get(key);
        const protocolFailure = record.calls.some((call) => call.protocolFailure);
        if (
            Boolean(record.modelFailure) !== protocolFailure ||
            record.oracle.acceptance !== graded.acceptance ||
            record.acceptance !== (protocolFailure ? "failed" : graded.acceptance)
        ) {
            throw new Error(`Replay differs from recorded outcome at schedule index ${index}.`);
        }

        const clean = structuredClone(record);
        clean.resultSha256 = sha256(
            fs.readFileSync(path.join(root, `${record.id}-attempt${record.attempt}`, "result.json")),
        );
        for (const call of clean.calls) {
            delete call.response;
        }

        runs.push(sanitize(clean, [root, repositoryRoot, os.tmpdir()]));
    }

    const invalidAttempts = [];
    for (const name of fs.readdirSync(root).filter((item) => /-attempt\d+$/u.test(item))) {
        const file = path.join(root, name, "result.json");
        if (!fs.existsSync(file)) {
            invalidAttempts.push({ directory: name, error: "Interrupted before result was written." });
        } else {
            const record = read(file);
            if (record.error) {
                invalidAttempts.push(sanitize(record, [root, repositoryRoot, os.tmpdir()]));
            }
        }
    }

    const budget = new QualityBudget(path.resolve(ledger), manifest.capUsd);
    const pilots = pilotDirectories.map((item) => {
        const pilot = path.resolve(item);
        const meta = read(path.join(pilot, "manifest.json"));
        if (meta.mode !== "pilot") {
            throw new Error("Excluded pilot directory has a non-pilot manifest.");
        }

        return {
            manifest: meta,
            manifestSha256: sha256(fs.readFileSync(path.join(pilot, "manifest.json"))),
            completion: read(path.join(pilot, "completion.json")),
            outcomes: fs
                .readdirSync(pilot)
                .filter((name) => /-attempt\d+$/u.test(name))
                .map((name) => {
                    const file = path.join(pilot, name, "result.json");
                    if (!fs.existsSync(file)) {
                        return { directory: name, error: "Interrupted before result was written." };
                    }

                    const record = read(file);

                    return {
                        id: record.id,
                        acceptance: record.acceptance,
                        error: record.error,
                        modelFailure: record.modelFailure,
                        resultSha256: sha256(fs.readFileSync(file)),
                    };
                }),
        };
    });

    return {
        schema: 2,
        suiteVersion,
        generatedAt: new Date().toISOString(),
        providerExperiment: `openrouter-${profile}`,
        cohortStatus: allowIncomplete ? "interrupted" : "complete",
        completion,
        plannedTrials: manifest.schedule.length,
        manifest,
        generationSources: Object.fromEntries(
            expectedAdapters.map((file) => [file, fs.readFileSync(path.join(repositoryRoot, "scripts", file), "utf8")]),
        ),
        manifestSha256: sha256(fs.readFileSync(path.join(root, "manifest.json"))),
        grading: { portableSourceDigests: portableSourceDigests(), distinctVariants: variants.size, replayed: true },
        catalog,
        runs,
        invalidAttempts,
        pilots,
        blobs,
        summary: aggregateQuality(runs, catalog),
        budget: {
            ...budget.data,
            conservativeChargeUsd: budget.totalMicros() / 1e6,
            reportedCostUsd: budget.data.requests.reduce((sum, item) => sum + (item.reportedCostUsd ?? 0), 0),
            unresolvedReservations: budget.data.requests.filter((item) => item.status === "reserved").length,
        },
        limitations: [
            "A different model family from the suite author; this is not proof of no training contamination or independent human grading.",
            "Paired conditions share the frozen Pi provider adapter. Model cohorts can differ in transport, system context, reasoning settings and output budgets; do not interpret between-model differences as a causal model ranking.",
            "Supplied-context text-only evaluation with no native tools registered; not a full installed Pi conversation or an adversarial grading sandbox.",
            "Review receives an implementation and requested behavior without a proposed Git diff, while the review skill is intended for reviewing changes; this limits transfer to real pull-request review.",
            "Malformed structured responses, refusals and output limits count as behavioral failures, including on otherwise-correct controls.",
            "Transport retries are retained separately, with no hidden acceptance feedback and no retries of valid behavioral failures.",
            "Reported costs exclude unknown charges; conservative reservations include those unknown requests, pilots, retries and 10% headroom under the shared explicitly authorized cap.",
        ],
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const allowIncomplete = args[0] === "--partial";
    if (allowIncomplete) {
        args.shift();
    }

    const [directory, ledger, destination, ...pilots] = args;
    if (!directory || !ledger || !destination || fs.existsSync(destination)) {
        throw new Error(
            "Usage: export-openrouter-quality.mjs <full-run> <ledger> <new-public-archive> [excluded-pilot ...]",
        );
    }

    const data = collectOpenRouter(directory, ledger, pilots, { allowIncomplete });
    fs.writeFileSync(destination, JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
    process.stdout.write(
        JSON.stringify({
            runs: data.runs.length,
            variants: data.grading.distinctVariants,
            budget: data.budget.conservativeChargeUsd,
        }) + "\n",
    );
}
