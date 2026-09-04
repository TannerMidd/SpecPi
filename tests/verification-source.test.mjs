import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
    MAX_SOURCE_DIRECTORY_DEPTH,
    MAX_SOURCE_DIRECTORIES,
    MAX_SOURCE_FILES,
    MAX_SOURCE_FILE_BYTES,
    MAX_SOURCE_TOTAL_BYTES,
    VERIFICATION_SCHEMA,
    captureSourceSnapshot,
    compareSourceSnapshots,
    createVerificationReceipt,
    saltedSourceRootIdentity,
    sourceSnapshotPaths,
    validateSourceSnapshot,
    validateVerificationReceipt,
} from "../extensions/tool-wishlist/verification.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createSourceRoot(label) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `specpi-verification-${label}-`));
    fs.mkdirSync(path.join(root, "extensions"));
    fs.mkdirSync(path.join(root, "scripts"));
    fs.writeFileSync(path.join(root, "extensions", "feature.mjs"), "export default 1;\n");
    fs.writeFileSync(path.join(root, "scripts", "check.mjs"), "export default 2;\n");
    fs.writeFileSync(path.join(root, "README.md"), "temporary source tree\n");

    return root;
}

function descriptor(size = 0) {
    return { type: "file", mode: 0o644, size, sha256: "0".repeat(64) };
}

function syntheticSnapshot(root, entries) {
    return {
        schema: VERIFICATION_SCHEMA,
        root: fs.realpathSync.native(root),
        files: Object.fromEntries(entries),
        digest: "0".repeat(64),
    };
}

test("source snapshots are stable and expose a deterministic inventory", () => {
    const root = createSourceRoot("stable");
    try {
        const first = captureSourceSnapshot(root, { head: "main" });
        const second = captureSourceSnapshot(root, { head: "main" });

        assert.deepEqual(second, first);
        assert.deepEqual(sourceSnapshotPaths(first), ["README.md", "extensions/feature.mjs", "scripts/check.mjs"]);
        assert.deepEqual(compareSourceSnapshots(first, second), {
            changed: [],
            digestChanged: false,
            headChanged: false,
            indeterminate: false,
        });
        assert.equal(saltedSourceRootIdentity(root, "verification-test-salt").length, 64);
        assert.equal(
            saltedSourceRootIdentity(root, "verification-test-salt"),
            saltedSourceRootIdentity(root, "verification-test-salt"),
        );
        assert.notEqual(
            saltedSourceRootIdentity(root, "another-verification-salt"),
            saltedSourceRootIdentity(root, "verification-test-salt"),
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("the real checkout inventory includes check inputs and excludes local/generated state", () => {
    const snapshot = captureSourceSnapshot(repoRoot);
    const paths = Object.keys(snapshot.files);

    assert.ok(paths.includes(".editorconfig"));
    assert.ok(paths.includes(".gitattributes"));
    assert.ok(paths.includes(".gitignore"));
    assert.ok(paths.includes(".prettierignore"));
    assert.ok(paths.some((value) => value.startsWith(".github/workflows/")));
    assert.ok(paths.includes("tests/fixtures/command-guard-session-approval-harness.ts"));
    assert.equal(
        paths.some((value) => value.startsWith("desktop/")),
        false,
    );
    assert.equal(
        paths.some((value) => value.startsWith("node_modules/")),
        false,
    );
    assert.equal(
        paths.some((value) => value.includes("/generated/")),
        false,
    );
});

test("source comparison detects content, path, and file-to-directory changes", () => {
    const root = createSourceRoot("changes");
    try {
        const before = captureSourceSnapshot(root);
        fs.writeFileSync(path.join(root, "extensions", "feature.mjs"), "export default 999;\n");
        const contentChanged = compareSourceSnapshots(before, captureSourceSnapshot(root));
        assert.deepEqual(contentChanged.changed, ["extensions/feature.mjs"]);
        assert.equal(contentChanged.digestChanged, true);

        fs.renameSync(path.join(root, "extensions", "feature.mjs"), path.join(root, "extensions", "renamed.mjs"));
        const pathChanged = compareSourceSnapshots(before, captureSourceSnapshot(root));
        assert.deepEqual(pathChanged.changed, ["extensions/feature.mjs", "extensions/renamed.mjs"]);

        fs.rmSync(path.join(root, "extensions", "renamed.mjs"));
        fs.mkdirSync(path.join(root, "extensions", "renamed.mjs"));
        fs.writeFileSync(path.join(root, "extensions", "renamed.mjs", "nested.mjs"), "export default 3;\n");
        const typeChanged = compareSourceSnapshots(before, captureSourceSnapshot(root));
        assert.deepEqual(typeChanged.changed, ["extensions/feature.mjs", "extensions/renamed.mjs/nested.mjs"]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("snapshot validation rejects digest tampering and unsafe inventory records", () => {
    const root = createSourceRoot("tamper");
    try {
        const snapshot = captureSourceSnapshot(root);
        const tampered = structuredClone(snapshot);
        tampered.files["extensions/feature.mjs"].sha256 = "f".repeat(64);
        assert.throws(() => validateSourceSnapshot(tampered, root), /digest does not match/);

        const traversal = structuredClone(snapshot);
        traversal.files["../outside.mjs"] = traversal.files["extensions/feature.mjs"];
        assert.throws(() => validateSourceSnapshot(traversal, root), /unsafe relative path|traversal/);

        const excluded = structuredClone(snapshot);
        excluded.files["node_modules/package/index.mjs"] = excluded.files["extensions/feature.mjs"];
        assert.throws(() => validateSourceSnapshot(excluded, root), /excluded or sensitive path/);

        const invalidDescriptor = structuredClone(snapshot);
        invalidDescriptor.files["extensions/feature.mjs"].size = MAX_SOURCE_FILE_BYTES + 1;
        assert.throws(() => validateSourceSnapshot(invalidDescriptor, root), /descriptor is invalid/);

        const hostilePath = "private%\u202E`source.mjs";
        const hostile = structuredClone(snapshot);
        hostile.files[hostilePath] = hostile.files["extensions/feature.mjs"];
        assert.throws(
            () => validateSourceSnapshot(hostile, root),
            (error) => {
                const message = String(error);
                assert.match(message, /%25/);
                assert.match(message, /%E2%80%AE/);
                assert.match(message, /%60/);
                assert.doesNotMatch(message, new RegExp(hostilePath));

                return true;
            },
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("source capture refuses ignored and sensitive inputs", () => {
    const ignoredRoot = createSourceRoot("ignored");
    try {
        fs.writeFileSync(path.join(ignoredRoot, "extensions", "ignored.mjs"), "ignored\n");
        assert.throws(
            () => captureSourceSnapshot(ignoredRoot, { ignoredPaths: ["extensions/ignored.mjs"] }),
            /contains ignored inputs/,
        );
        assert.throws(
            () => captureSourceSnapshot(ignoredRoot, { ignoredPaths: ["../outside.mjs"] }),
            /unsafe relative path|traversal/,
        );
    } finally {
        fs.rmSync(ignoredRoot, { recursive: true, force: true });
    }

    const sensitiveFileRoot = createSourceRoot("sensitive-file");
    try {
        fs.writeFileSync(path.join(sensitiveFileRoot, "extensions", "credentials.json"), "private\n");
        assert.throws(() => captureSourceSnapshot(sensitiveFileRoot), /sensitive source filename/);
    } finally {
        fs.rmSync(sensitiveFileRoot, { recursive: true, force: true });
    }

    const sensitiveDirectoryRoot = createSourceRoot("sensitive-directory");
    try {
        fs.mkdirSync(path.join(sensitiveDirectoryRoot, "extensions", "private"));
        assert.throws(() => captureSourceSnapshot(sensitiveDirectoryRoot), /sensitive source directory/);
    } finally {
        fs.rmSync(sensitiveDirectoryRoot, { recursive: true, force: true });
    }

    const npmrcRoot = createSourceRoot("npmrc");
    try {
        fs.writeFileSync(path.join(npmrcRoot, ".npmrc"), "script-shell=untrusted\n");
        assert.throws(() => captureSourceSnapshot(npmrcRoot), /root \.npmrc/);
    } finally {
        fs.rmSync(npmrcRoot, { recursive: true, force: true });
    }
});

test("source capture refuses symlinked source inputs when the host permits symlink creation", (t) => {
    const root = createSourceRoot("symlink");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-verification-outside-"));
    const link = path.join(root, "extensions", "linked.mjs");
    try {
        fs.writeFileSync(path.join(outside, "outside.mjs"), "outside\n");
        try {
            fs.symlinkSync(path.join(outside, "outside.mjs"), link, "file");
        } catch (error) {
            if (error?.code === "EPERM" || error?.code === "EACCES") {
                t.skip("the host does not permit creating test symlinks");

                return;
            }

            throw error;
        }

        assert.throws(() => captureSourceSnapshot(root), /symlinked source input/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test("snapshot validation enforces file-count, per-file, and total-byte limits", () => {
    const root = createSourceRoot("limits");
    try {
        const tooManyFiles = Array.from({ length: MAX_SOURCE_FILES + 1 }, (_, index) => [
            `extensions/file-${index}.mjs`,
            descriptor(),
        ]);
        assert.throws(
            () => validateSourceSnapshot(syntheticSnapshot(root, tooManyFiles), root),
            /file count is invalid/,
        );

        const tooLarge = syntheticSnapshot(root, [["extensions/large.mjs", descriptor(MAX_SOURCE_FILE_BYTES + 1)]]);
        assert.throws(() => validateSourceSnapshot(tooLarge, root), /descriptor is invalid/);

        const tooMuch = Array.from(
            { length: Math.ceil(MAX_SOURCE_TOTAL_BYTES / MAX_SOURCE_FILE_BYTES) + 1 },
            (_, index) => [`extensions/chunk-${index}.mjs`, descriptor(MAX_SOURCE_FILE_BYTES)],
        );
        assert.throws(() => validateSourceSnapshot(syntheticSnapshot(root, tooMuch), root), /byte count is invalid/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("source capture enforces directory depth and count limits", () => {
    const depthRoot = createSourceRoot("depth");
    try {
        let directory = path.join(depthRoot, "extensions");
        for (let index = 0; index < MAX_SOURCE_DIRECTORY_DEPTH; index += 1) {
            directory = path.join(directory, `level-${index}`);
            fs.mkdirSync(directory);
        }

        assert.throws(() => captureSourceSnapshot(depthRoot), /exceeds depth/);
    } finally {
        fs.rmSync(depthRoot, { recursive: true, force: true });
    }

    const countRoot = createSourceRoot("directories");
    try {
        const extensions = path.join(countRoot, "extensions");
        for (let index = 0; index < MAX_SOURCE_DIRECTORIES; index += 1) {
            fs.mkdirSync(path.join(extensions, `directory-${index}`));
        }

        assert.throws(() => captureSourceSnapshot(countRoot), /exceeds .* directories/);
    } finally {
        fs.rmSync(countRoot, { recursive: true, force: true });
    }
});

test("verification receipts validate stable source and reject changed source", () => {
    const root = createSourceRoot("receipt");
    try {
        const before = captureSourceSnapshot(root, { head: "main" });
        const after = captureSourceSnapshot(root, { head: "main" });
        const receipt = createVerificationReceipt({
            before,
            after,
            registryDigest: "a".repeat(64),
            validatorDigest: "b".repeat(64),
            gates: [{ id: "repository-check", exitCode: 0 }],
            contractDigest: "c".repeat(64),
            gapId: "gap-1",
            selectionId: "selection-1",
            sourceRootSalt: "verification-receipt-test-salt",
            runtimeAt: "2026-09-04T00:00:00.000Z",
        });
        assert.deepEqual(validateVerificationReceipt(receipt), receipt);

        fs.writeFileSync(path.join(root, "scripts", "check.mjs"), "export default 999;\n");
        const changed = captureSourceSnapshot(root, { head: "main" });
        assert.throws(
            () =>
                createVerificationReceipt({
                    before,
                    after: changed,
                    registryDigest: "a".repeat(64),
                    validatorDigest: "b".repeat(64),
                    gates: [{ id: "repository-check", exitCode: 0 }],
                    contractDigest: "c".repeat(64),
                    gapId: "gap-1",
                    selectionId: "selection-1",
                    sourceRootSalt: "verification-receipt-test-salt",
                }),
            /changed source snapshots/,
        );

        const changedHead = captureSourceSnapshot(root, { head: "other" });
        assert.throws(
            () =>
                createVerificationReceipt({
                    before,
                    after: changedHead,
                    registryDigest: "a".repeat(64),
                    validatorDigest: "b".repeat(64),
                    gates: [{ id: "repository-check", exitCode: 0 }],
                    contractDigest: "c".repeat(64),
                    gapId: "gap-1",
                    selectionId: "selection-1",
                    sourceRootSalt: "verification-receipt-test-salt",
                }),
            /changed source snapshots/,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
