import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { tasks, baselineCommit, suiteVersion } from "./catalog.mjs";

export function qualityTask(id) {
    const task = tasks.find((entry) => entry.id === id);
    if (!task) {
        throw new Error("Unknown quality task");
    }

    return task;
}

export function fixtureDigest(task) {
    return createHash("sha256")
        .update(
            JSON.stringify({
                suiteVersion,
                base: baselineCommit,
                request: task.request,
                files: task.files,
                acceptance: task.acceptance,
                provenance: task.provenance,
            }),
        )
        .digest("hex");
}

export function materializeTask(id, directory) {
    const task = qualityTask(id);
    const root = path.resolve(directory);
    // Claim a new destination exclusively; never overwrite a checkout or a previous run.
    fs.mkdirSync(root);
    for (const [name, content] of Object.entries(task.files)) {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, { flag: "wx" });
    }

    return { task: task.id, root, baselineCommit, fixtureDigest: fixtureDigest(task) };
}
