import assert from "node:assert/strict";

import fs from "node:fs";

import os from "node:os";

import path from "node:path";

import test from "node:test";

import {
    TASK_CONTRACT_ENTRY,
    createTaskContract,
    markdownPathLabel,
    readTaskContract,
    renderTaskContract,
    taskContractScopeViolations,
    validateTaskContract,
} from "../extensions/workflow-controls/task-contract.mjs";

function createRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-task-contract-test-"));
    fs.mkdirSync(path.join(root, "src", "components"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "inside.ts"), "inside\n");
    fs.writeFileSync(path.join(root, "src", "components", "button.ts"), "button\n");

    return root;
}

function card(overrides = {}) {
    return {
        objective: "Bound one task\u0000 objective",
        hypothesis: "A fixed card keeps review aligned",
        requirements: [
            { id: "R1", description: "Keep the task bounded", acceptance: "The card has a verified digest" },
            { description: "Keep scope explicit", acceptance: "Changed paths are compared to declared paths" },
        ],
        paths: ["src/"],
        rollback: "Clear the card and restore the prior branch state",
        nonGoals: ["No external writes"],
        ...overrides,
    };
}

test("task contracts canonicalize text and return immutable verified clones", () => {
    const root = createRoot();
    try {
        const contract = createTaskContract(card(), { root, origin: "human", id: "task-one" });
        assert.equal(contract.objective, "Bound one task objective");
        assert.equal(contract.requirements[1].id, "R2");
        assert.equal(contract.paths[0], "src/");
        assert.match(contract.digest, /^[a-f0-9]{64}$/u);

        const validated = validateTaskContract(contract);
        validated.requirements[0].description = "changed locally";
        assert.equal(contract.requirements[0].description, "Keep the task bounded");
        assert.equal(validateTaskContract(contract).digest, contract.digest);
        assert.throws(() => validateTaskContract({ ...contract, objective: "tampered" }), /digest mismatch/);

        const markdown = renderTaskContract(contract);
        assert.match(markdown, /Bound one task objective/);
        assert.match(markdown, /Requirements \(2\)/);
        assert.match(markdown, /R2/);

        const hostilePath = "evil\nline\u2028format\u202epercent%tick`name.ts";
        const safePathLabel = markdownPathLabel(hostilePath);
        assert.doesNotMatch(safePathLabel, /[\r\n\u2028\u202e`]/u);
        assert.equal(decodeURIComponent(safePathLabel), hostilePath);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("task contract branch reads only the latest valid set and distinguishes malformed entries", () => {
    const root = createRoot();
    const otherRoot = createRoot();
    try {
        const contract = createTaskContract(card(), { root, origin: "human", id: "task-two" });
        const entry = { type: "custom", customType: TASK_CONTRACT_ENTRY, data: { kind: "set", contract } };
        const branch = [entry];
        const restored = readTaskContract(branch, root);
        assert.deepEqual(restored, contract);
        restored.paths.push("src/components/");
        assert.equal(branch[0].data.contract.paths.length, 1);
        assert.equal(readTaskContract(branch, otherRoot), undefined);
        assert.equal(
            readTaskContract(
                [...branch, { type: "custom", customType: TASK_CONTRACT_ENTRY, data: { kind: "cleared" } }],
                root,
            ),
            undefined,
        );
        assert.throws(
            () => readTaskContract([{ type: "custom", customType: TASK_CONTRACT_ENTRY, data: undefined }], root),
            /Malformed task contract branch entry/,
        );
        assert.throws(
            () =>
                readTaskContract(
                    [...branch, { type: "custom", customType: TASK_CONTRACT_ENTRY, data: { kind: "set" } }],
                    root,
                ),
            /Task contract must be an object/,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(otherRoot, { recursive: true, force: true });
    }
});

test("task branch reads ignore unavailable foreign roots without adopting a moved card", () => {
    const root = createRoot();
    try {
        const recordedRoot = path.join(root, "src", "components");
        const contract = createTaskContract(card({ paths: [] }), { root: recordedRoot, origin: "human" });
        const branch = [{ type: "custom", customType: TASK_CONTRACT_ENTRY, data: { kind: "set", contract } }];
        const sourceDirectory = path.join(root, "src");
        const movedDirectory = path.join(root, "moved-src");
        fs.renameSync(sourceDirectory, movedDirectory);
        assert.equal(readTaskContract(branch, root), undefined);
        assert.equal(readTaskContract(branch, path.join(movedDirectory, "components")), undefined);
        assert.throws(() => readTaskContract(branch, recordedRoot), { code: "ENOENT" });

        fs.writeFileSync(sourceDirectory, "a file now occupies the old parent path\n");
        assert.equal(readTaskContract(branch, root), undefined);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("task branch reads preserve current-card validation and recorded-root access errors", (context) => {
    const root = createRoot();
    try {
        const contract = createTaskContract(card(), { root, origin: "human" });
        const branchWith = (value) => [
            { type: "custom", customType: TASK_CONTRACT_ENTRY, data: { kind: "set", contract: value } },
        ];
        assert.throws(() => readTaskContract(branchWith({ ...contract, schema: 2 }), root), /Unsupported/);
        assert.throws(
            () => readTaskContract(branchWith({ ...contract, objective: "tampered" }), root),
            /digest mismatch/,
        );
        assert.throws(() => readTaskContract(branchWith({ ...contract, root: "" }), root), /root is required/);

        const foreignRoot = path.join(root, "src");
        const foreignContract = createTaskContract(card({ paths: [] }), { root: foreignRoot, origin: "human" });
        const originalStat = fs.statSync;
        const accessError = Object.assign(new Error("recorded root cannot be accessed"), { code: "EACCES" });
        const statMock = context.mock.method(fs, "statSync", (candidate, ...args) => {
            if (candidate === foreignContract.root) {
                throw accessError;
            }

            return originalStat(candidate, ...args);
        });
        try {
            assert.throws(() => readTaskContract(branchWith(foreignContract), root), accessError);
        } finally {
            statMock.mock.restore();
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("improvement contracts require explicit bounded scope and provenance", () => {
    const root = createRoot();
    try {
        assert.throws(
            () =>
                createTaskContract(card({ paths: ["."] }), {
                    root,
                    origin: "improvement",
                    gapId: "gap",
                    selectionId: "selection",
                }),
            /project root/,
        );
        assert.throws(
            () =>
                createTaskContract(card({ paths: ["src/"] }), {
                    root,
                    origin: "improvement",
                    gapId: "gap",
                    selectionId: "selection",
                }),
            /specific files or subsystem directories/,
        );
        assert.throws(
            () =>
                createTaskContract(card({ hypothesis: "", rollback: "" }), {
                    root,
                    origin: "improvement",
                    gapId: "gap",
                    selectionId: "selection",
                }),
            /hypothesis must not be empty/,
        );
        const contract = createTaskContract(card({ paths: ["src/components/"] }), {
            root,
            origin: "improvement",
            gapId: "gap",
            selectionId: "selection",
        });
        assert.equal(contract.origin, "improvement");
        assert.equal(contract.gapId, "gap");
        assert.deepEqual(taskContractScopeViolations(contract, ["src/components/button.ts", "README.md"]), [
            "README.md",
        ]);
        const humanContract = createTaskContract(card({ paths: ["."] }), { root, origin: "human" });
        assert.deepEqual(taskContractScopeViolations(humanContract, ["../escape.txt", "src/inside.ts"]), [
            "../escape.txt",
        ]);
        assert.throws(
            () => createTaskContract(card({ paths: ["x".repeat(241)] }), { root, origin: "human" }),
            /path 1/,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
