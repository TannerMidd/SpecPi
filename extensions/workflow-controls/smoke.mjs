#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compareWorktreeSnapshots, createWorktreeSnapshot, normalizeScopeEntries } from "./scope.mjs";
import {
    createExperiment,
    discardExperiment,
    experimentStatus,
    exportExperimentPatch,
    inspectRepository,
} from "./experiments.mjs";
import { validateChallengeSubmission } from "./challenge.mjs";
import {
    TASK_CONTRACT_ENTRY,
    createTaskContract,
    readTaskContract,
    taskContractScopeViolations,
} from "./task-contract.mjs";

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
        timeout: options.timeout ?? 30_000,
        maxBuffer: 40 * 1024 * 1024,
    });

    return Promise.resolve({
        code: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? (result.error ? result.error.message : ""),
    });
}

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

async function experimentSmoke() {
    const root = repositoryFixture("specpi-experiment-smoke-");
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-experiment-state-smoke-"));
    try {
        const repository = await inspectRepository(run, root);
        const head = git(root, "rev-parse", "HEAD").trim();
        const record = await createExperiment({
            exec: run,
            stateDir,
            repository,
            card: {
                name: "smoke",
                hypothesis: "Detached work keeps the base clean",
                acceptance: "Export includes tracked and untracked work",
                nonGoals: ["No merge"],
            },
        });
        fs.writeFileSync(path.join(record.worktreePath, "src", "inside.txt"), "changed\n");
        fs.writeFileSync(path.join(record.worktreePath, "new.txt"), "new\n");
        fs.writeFileSync(
            path.join(record.worktreePath, "latin1.txt"),
            Buffer.from("caf\u00e9 latin1 changed\n", "latin1"),
        );
        fs.mkdirSync(path.join(record.worktreePath, "ignored-work"));
        fs.writeFileSync(path.join(record.worktreePath, "ignored-work", "local.txt"), "ignored but real\n");

        // Committing inside an experiment moves its HEAD; work measured against HEAD would then report clean.
        fs.writeFileSync(path.join(record.worktreePath, "committed.txt"), "committed work\n");
        git(record.worktreePath, "add", "committed.txt");
        git(record.worktreePath, "commit", "-m", "experiment commit");

        // Ignored work never reaches a patch, so a discard prompt that cannot see it would delete it silently.
        const state = await experimentStatus(run, record);
        assert.equal(state.ignored, 1);
        assert.deepEqual(state.ignoredPaths, ["ignored-work/"]);
        assert.deepEqual(state.committedPaths, ["committed.txt"]);
        assert.equal(state.hasWork, true);

        const exported = await exportExperimentPatch({ exec: run, stateDir, record });
        const patchBytes = fs.readFileSync(exported.outputPath);
        const patch = patchBytes.toString("utf8");
        assert.match(patch, /src\/inside\.txt/);
        assert.match(patch, /new\.txt/);
        assert.match(patch, /committed\.txt/);
        // A UTF-8 round trip would replace the latin-1 byte and produce a patch that no longer applies.
        assert.ok(patchBytes.includes(0xe9), "exported patch lost the original non-UTF-8 bytes");
        assert.ok(!patchBytes.includes(Buffer.from("\uFFFD")), "exported patch contains a replacement character");
        assert.equal(status(root), "");
        assert.equal(git(root, "rev-parse", "HEAD").trim(), head);

        const applyTarget = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-experiment-apply-smoke-"));
        try {
            git(applyTarget, "clone", "--quiet", root, applyTarget);
            git(applyTarget, "apply", "--check", exported.outputPath);
        } finally {
            fs.rmSync(applyTarget, { recursive: true, force: true });
        }

        await discardExperiment({ exec: run, stateDir, record });
        assert.equal(fs.existsSync(record.worktreePath), false);

        return "guided-experiment-worktrees-smoke passed: detached create, byte-exact appliable export of committed and dirty work, disclosed ignored work, clean base, and discard verified";
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
}

async function challengeSmoke() {
    const submission = {
        verdict: "ready-for-human-review",
        requirements: [{ requirement: "Direct check", status: "proven", evidence: "Smoke passed" }],
        contradictions: [],
        falsePositiveChecks: [],
        scopeFindings: [],
        validationGaps: [],
        residualRisks: ["Model-authored review"],
        nextAction: "Human reviews the result",
    };
    assert.equal(validateChallengeSubmission(submission, { pendingScope: [] }).verdict, "ready-for-human-review");
    assert.throws(
        () => validateChallengeSubmission(submission, { pendingScope: ["outside.txt"] }),
        /scope drift remains pending/,
    );
    assert.throws(
        () =>
            validateChallengeSubmission({ ...submission, contradictions: ["A check disagrees"] }, { pendingScope: [] }),
        /contradictory evidence/,
    );

    return "completion-challenge-smoke passed: structured readiness and deterministic rejection gates verified";
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

export async function runWorkflowControlsSmoke(name) {
    if (name === "scope-drift-monitor-smoke") {
        return scopeSmoke();
    }

    if (name === "guided-experiment-worktrees-smoke") {
        return experimentSmoke();
    }

    if (name === "completion-challenge-smoke") {
        return challengeSmoke();
    }

    if (name === "task-contract-smoke") {
        return taskContractSmoke();
    }

    throw new Error(`Unknown workflow-controls smoke: ${name}`);
}

const invokedDirectly =
    Boolean(process.argv[1]) &&
    (process.platform === "win32"
        ? path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
        : path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (invokedDirectly) {
    runWorkflowControlsSmoke(process.argv[2])
        .then((message) => console.log(message))
        .catch((error) => {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        });
}
