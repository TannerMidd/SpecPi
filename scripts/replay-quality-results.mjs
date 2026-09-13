import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tasks } from "../evals/quality/catalog.mjs";
import { repositoryRoot, sha256, sourceDigests } from "../evals/quality/provenance.mjs";

// Git checkouts can translate CRLF/LF. Keep raw generation fingerprints, but
// compare normalized text when replaying a recorded grader on another platform.
export function portableSourceDigests() {
    return Object.fromEntries(
        Object.keys(sourceDigests()).map((name) => {
            const relative =
                name === "package.json"
                    ? name
                    : name === "specpi-review/SKILL.md"
                      ? `skills/${name}`
                      : name.endsWith(".test.mjs")
                        ? `tests/${name}`
                        : `evals/quality/${name}`;

            return [
                name,
                sha256(fs.readFileSync(path.join(repositoryRoot, relative), "utf8").replaceAll("\r\n", "\n")),
            ];
        }),
    );
}

export function variantKey(task, finalFiles) {
    return sha256(JSON.stringify({ task, files: Object.entries(finalFiles).sort(([a], [b]) => a.localeCompare(b)) }));
}

export function gradeFinalFiles(taskId, finalFiles, blobs) {
    const task = tasks.find((item) => item.id === taskId);
    if (!task || Object.keys(finalFiles).length !== Object.keys(task.files).length) {
        throw new Error("Incomplete replay inventory.");
    }

    for (const [file, hash] of Object.entries(finalFiles)) {
        if (!Object.hasOwn(task.files, file) || typeof blobs[hash] !== "string" || sha256(blobs[hash]) !== hash) {
            throw new Error("Invalid replay file or content digest.");
        }
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-regrade-"));
    try {
        for (const [file, hash] of Object.entries(finalFiles)) {
            const target = path.join(root, file);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, blobs[hash], { flag: "wx" });
        }

        const checked = spawnSync(
            process.execPath,
            [path.join(repositoryRoot, "evals/quality/check.mjs"), taskId, root],
            { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 65536 },
        );
        const lines = checked.stdout?.trim().split(/\r?\n/u) ?? [];
        if (checked.error?.code === "ETIMEDOUT" && lines.some((line) => line.includes('"event":"oracle.started"'))) {
            return { task: taskId, acceptance: "failed", reason: "Candidate exceeded the 30-second grading budget." };
        }

        let result;
        try {
            result = JSON.parse(lines.at(-1));
        } catch {}

        if (
            ![0, 1].includes(checked.status) ||
            result?.task !== taskId ||
            !["passed", "failed"].includes(result?.acceptance)
        ) {
            throw new Error(
                `Replay infrastructure failed for ${taskId}: ${checked.error?.message ?? checked.stderr?.slice(-1000) ?? "No result"}`,
            );
        }

        return result;
    } finally {
        if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith("specpi-regrade-")) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [file] = process.argv.slice(2);
    if (!file || process.argv.length !== 3) {
        throw new Error("Usage: node scripts/replay-quality-results.mjs <public-results.json>");
    }

    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (JSON.stringify(data.grading.portableSourceDigests) !== JSON.stringify(portableSourceDigests())) {
        throw new Error("Replay requires the archived grader sources (ignoring checkout line endings).");
    }

    const results = new Map();
    for (const run of data.runs) {
        const key = variantKey(run.task, run.finalFiles);
        if (!results.has(key)) {
            results.set(key, gradeFinalFiles(run.task, run.finalFiles, data.blobs));
        }

        if (results.get(key).acceptance !== run.acceptance) {
            throw new Error(`Replay differs: ${run.id}`);
        }
    }

    process.stdout.write(
        JSON.stringify({ trials: data.runs.length, distinctVariants: results.size, matched: true }) + "\n",
    );
}
