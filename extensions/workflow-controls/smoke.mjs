#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compareWorktreeSnapshots, createWorktreeSnapshot, normalizeScopeEntries } from "./scope.mjs";
import {
    TASK_CONTRACT_ENTRY,
    createTaskContract,
    readTaskContract,
    taskContractScopeViolations,
} from "./task-contract.mjs";

function git(root, ...args) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000 });
    if (result.status !== 0) {
        throw new Error((result.stderr || result.stdout || "Git failed").trim());
    }

    return result.stdout;
}

function repositoryFixture(prefix) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    git(root, "init");
    git(root, "config", "user.email", "workflow-smoke@example.invalid");
    git(root, "config", "user.name", "Workflow Smoke");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "inside.txt"), "inside\n");
    fs.writeFileSync(path.join(root, "outside.txt"), "outside\n");
    fs.writeFileSync(path.join(root, "latin1.txt"), Buffer.from("caf\u00e9 latin1\n", "latin1"));
    fs.writeFileSync(path.join(root, ".gitignore"), "ignored-work/\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "base");

    return root;
}

function status(root) {
    return git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all");
}

async function scopeSmoke() {
    const root = repositoryFixture("specpi-scope-smoke-");
    try {
        const entries = normalizeScopeEntries(root, ["src/"]);
        const before = createWorktreeSnapshot(root, status(root));
        fs.writeFileSync(path.join(root, "outside.txt"), "changed\n");
        const after = createWorktreeSnapshot(root, status(root));
        const drift = compareWorktreeSnapshots(before, after, entries);
        assert.deepEqual(drift.outside, ["outside.txt"]);
        assert.throws(() => normalizeScopeEntries(root, ["../escape"]), /escapes/);

        return "scope-drift-monitor-smoke passed: path boundary and observed outside-scope mutation verified";
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

async function taskContractSmoke() {
    const root = repositoryFixture("specpi-task-contract-smoke-");
    try {
        const contract = createTaskContract(
            {
                objective: "Keep a bounded task card",
                requirements: [
                    { id: "R1", description: "Render the objective", acceptance: "The card is visible" },
                    { id: "R2", description: "Keep paths explicit", acceptance: "Only declared paths are imported" },
                ],
                paths: ["src/"],
                nonGoals: ["No automatic scope expansion"],
            },
            { root, origin: "human" },
        );
        const setEntry = {
            type: "custom",
            customType: TASK_CONTRACT_ENTRY,
            data: { kind: "set", contract },
        };
        const restored = readTaskContract([setEntry], root);
        assert.deepEqual(restored, contract);
        assert.deepEqual(taskContractScopeViolations(contract, ["src/inside.txt", "outside.txt"]), ["outside.txt"]);
        assert.equal(readTaskContract([setEntry, { ...setEntry, data: { kind: "cleared" } }], root), undefined);
        assert.throws(
            () =>
                createTaskContract(
                    {
                        objective: "unsafe",
                        hypothesis: "The bounded card is safe",
                        requirements: [{ description: "r", acceptance: "a" }],
                        paths: ["."],
                        rollback: "Clear the card",
                    },
                    { root, origin: "improvement", gapId: "gap", selectionId: "selection" },
                ),
            /project root/,
        );

        return "task-contract-smoke passed: canonical digest, branch clear, scope boundary, and improvement path gates verified";
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

export async function runWorkflowControlsSmoke(validator) {
    if (validator === "task-contract-smoke") {
        return taskContractSmoke();
    }

    if (validator === "scope-drift-monitor-smoke") {
        await taskContractSmoke();

        return scopeSmoke();
    }

    throw new Error(`Unknown workflow validator: ${validator}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    console.log(await runWorkflowControlsSmoke(process.argv[2]));
}
