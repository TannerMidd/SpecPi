import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { markdownPathLabel } from "../workflow-controls/task-contract.mjs";

export const VERIFICATION_SCHEMA = 1;
export const MAX_SOURCE_FILES = 2048;
export const MAX_SOURCE_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_SOURCE_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_SOURCE_DIRECTORY_DEPTH = 12;
export const MAX_SOURCE_DIRECTORIES = 512;
export const MAX_RECEIPT_GATES = 8;

// These are the source and verification inputs that can affect a SpecPi
// checkout.  Keep the inventory explicit so a user's neighbouring files are
// never pulled into a proof merely because they happen to live in the root.
export const SOURCE_DIRECTORIES = Object.freeze([
    ".github",
    "browser-runtime",
    "extensions",
    "scripts",
    "shell",
    "site",
    "skills",
    "templates",
    "tests",
    "themes",
]);

export const SOURCE_ROOT_FILES = Object.freeze([
    "AGENTS.md",
    "CHANGELOG.md",
    ".editorconfig",
    ".gitattributes",
    ".gitignore",
    ".prettierignore",
    "LICENSE",
    "NPM_RELEASE.md",
    "PLAN.md",
    "README.md",
    "SECURITY.md",
    "SECURITY_MODEL.md",
    "THIRD_PARTY.md",
    "eslint.config.js",
    "package.json",
    "prettier.config.mjs",
    "specpi",
    "specpi.cmd",
]);

const EXCLUDED_DIRECTORY_NAMES = new Set([
    ".git",
    ".next",
    "build",
    "coverage",
    "desktop",
    "dist",
    "generated",
    "node_modules",
    "out",
]);

const SENSITIVE_DIRECTORY_NAMES = new Set([
    "auth",
    "credentials",
    "history",
    "missions",
    "private",
    "secrets",
    "sessions",
    "tokens",
    "trust",
]);

const SENSITIVE_FILENAME =
    /(?:^|[._-])(?:\.env(?:\..*)?|auth(?:entication)?|credential(?:s)?|secret(?:s)?|token(?:s)?|password(?:s)?|passwd|trust|history|mission(?:s)?)(?:[._-]|$)|(?:^|[._-])session(?:s)?\.(?:json|jsonl|db|sqlite|log)$|\.(?:crt|der|key|pem|pfx|p12)$/iu;
const SAFE_HEAD = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,160}$/u;
const SAFE_GATE_ID = /^(?=.*[A-Za-z0-9])[A-Za-z0-9 ._:-]{1,100}$/u;

function portableRelative(value) {
    return value.split(path.sep).join("/");
}

function assertDirectory(root) {
    if (typeof root !== "string" || !root.trim()) {
        throw new Error("Verification source root must be a non-empty path");
    }

    const resolved = path.resolve(root);
    let stat;
    try {
        stat = fs.lstatSync(resolved);
    } catch (error) {
        throw new Error(
            `Verification source root is unavailable: ${markdownPathLabel(error instanceof Error ? error.message : String(error))}`,
        );
    }

    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("Verification source root must be a real directory");
    }

    return fs.realpathSync.native(resolved);
}

export function canonicalSourceRoot(root) {
    return assertDirectory(root);
}

function assertRelativePath(relativePath) {
    if (
        typeof relativePath !== "string" ||
        !relativePath ||
        relativePath.startsWith("/") ||
        /^[A-Za-z]:[\\/]/u.test(relativePath) ||
        /[\u0000-\u001f\u007f]/u.test(relativePath)
    ) {
        throw new Error("Verification inventory contains an unsafe relative path");
    }

    const normalized = relativePath.replaceAll("\\", "/");
    if (normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
        throw new Error("Verification inventory contains traversal or empty path segments");
    }

    return normalized;
}

function isExcludedDirectory(name) {
    return EXCLUDED_DIRECTORY_NAMES.has(name.toLowerCase());
}

function isSensitiveFilename(name) {
    return SENSITIVE_FILENAME.test(name);
}

function ensureInside(root, candidate) {
    const resolvedRoot = path.resolve(root);
    const resolvedCandidate = path.resolve(candidate);
    const lowerRoot = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
    const lowerCandidate = process.platform === "win32" ? resolvedCandidate.toLowerCase() : resolvedCandidate;
    if (lowerCandidate !== lowerRoot && !lowerCandidate.startsWith(`${lowerRoot}${path.sep}`)) {
        throw new Error("Verification inventory path escapes the source root");
    }
}

function assertRealDirectory(root, candidate, relativeDirectory) {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(
            `Verification source directory is not a real directory: ${markdownPathLabel(relativeDirectory)}`,
        );
    }

    const real = fs.realpathSync.native(candidate);
    ensureInside(root, real);
}

function lstatIfPresent(candidate) {
    try {
        return fs.lstatSync(candidate);
    } catch (error) {
        if (error?.code === "ENOENT") {
            return undefined;
        }

        throw error;
    }
}

function assertRealAncestors(root, relativePath) {
    const parts = relativePath.split("/");
    let current = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
        const part = parts[index];
        current = path.join(current, part);
        ensureInside(root, current);
        assertRealDirectory(root, current, parts.slice(0, index + 1).join("/"));
    }
}

function listDirectory(root, relativeDirectory, files, context) {
    context.directories += 1;
    if (context.directories > MAX_SOURCE_DIRECTORIES) {
        throw new Error(`Verification source inventory exceeds ${MAX_SOURCE_DIRECTORIES} directories`);
    }

    const depth = relativeDirectory.split("/").length;
    if (depth > MAX_SOURCE_DIRECTORY_DEPTH) {
        throw new Error(`Verification source inventory exceeds depth ${MAX_SOURCE_DIRECTORY_DEPTH}`);
    }

    const directory = path.join(root, ...relativeDirectory.split("/"));
    ensureInside(root, directory);
    assertRealDirectory(root, directory, relativeDirectory);
    let entries;
    try {
        entries = fs
            .readdirSync(directory, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
        throw new Error(
            `Verification inventory could not enumerate ${markdownPathLabel(relativeDirectory)}: ${markdownPathLabel(error instanceof Error ? error.message : String(error))}`,
        );
    }

    for (const entry of entries) {
        if (!entry.name || entry.name === "." || entry.name === ".." || /[\u0000-\u001f\u007f]/u.test(entry.name)) {
            throw new Error("Verification inventory contains an unsafe filename");
        }

        const relativePath = assertRelativePath(`${relativeDirectory}/${entry.name}`);
        if (entry.isDirectory()) {
            if (!isExcludedDirectory(entry.name)) {
                if (SENSITIVE_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
                    throw new Error(
                        `Verification inventory refuses sensitive source directory: ${markdownPathLabel(relativePath)}`,
                    );
                }

                listDirectory(root, relativePath, files, context);
            }

            continue;
        }

        if (entry.isSymbolicLink()) {
            throw new Error(
                `Verification inventory refuses symlinked source input: ${markdownPathLabel(relativePath)}`,
            );
        }

        if (!entry.isFile()) {
            throw new Error(`Verification inventory refuses non-file source input: ${markdownPathLabel(relativePath)}`);
        }

        if (isSensitiveFilename(entry.name)) {
            throw new Error(
                `Verification inventory refuses sensitive source filename: ${markdownPathLabel(relativePath)}`,
            );
        }

        if (files.length >= MAX_SOURCE_FILES) {
            throw new Error(`Verification source inventory exceeds ${MAX_SOURCE_FILES} files`);
        }

        files.push(relativePath);
    }
}

function enumerateSourceFiles(root) {
    assertNoRootNpmrc(root);

    const files = [];
    const context = { directories: 0 };
    for (const relativeDirectory of SOURCE_DIRECTORIES) {
        const directory = path.join(root, relativeDirectory);
        ensureInside(root, directory);
        const directoryStat = lstatIfPresent(directory);
        if (!directoryStat) {
            continue;
        }

        if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
            throw new Error(
                `Verification source directory is not a real directory: ${markdownPathLabel(relativeDirectory)}`,
            );
        }

        assertRealDirectory(root, directory, relativeDirectory);

        if (!isExcludedDirectory(relativeDirectory)) {
            if (SENSITIVE_DIRECTORY_NAMES.has(relativeDirectory.toLowerCase())) {
                throw new Error(
                    `Verification inventory refuses sensitive source directory: ${markdownPathLabel(relativeDirectory)}`,
                );
            }

            listDirectory(root, relativeDirectory, files, context);
        }
    }

    for (const name of SOURCE_ROOT_FILES) {
        if (isSensitiveFilename(name)) {
            throw new Error(`Verification inventory refuses sensitive source filename: ${markdownPathLabel(name)}`);
        }

        const candidate = path.join(root, name);
        ensureInside(root, candidate);
        const stat = lstatIfPresent(candidate);
        if (!stat) {
            continue;
        }

        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error(`Verification root source input is not a regular file: ${markdownPathLabel(name)}`);
        }

        if (files.length >= MAX_SOURCE_FILES) {
            throw new Error(`Verification source inventory exceeds ${MAX_SOURCE_FILES} files`);
        }

        files.push(name);
    }

    const unique = [...new Set(files)].sort();
    if (unique.length === 0) {
        throw new Error("Verification source inventory is empty");
    }

    if (unique.length > MAX_SOURCE_FILES) {
        throw new Error(`Verification source inventory exceeds ${MAX_SOURCE_FILES} files`);
    }

    return unique;
}

function isKnownInventoryPath(relativePath) {
    if (SOURCE_ROOT_FILES.includes(relativePath)) {
        return true;
    }

    const topLevel = relativePath.split("/")[0];

    return SOURCE_DIRECTORIES.includes(topLevel);
}

export function assertNoRootNpmrc(root) {
    const resolvedRoot = canonicalSourceRoot(root);
    const npmrc = path.join(resolvedRoot, ".npmrc");
    if (lstatIfPresent(npmrc)) {
        throw new Error("Verification refuses a root .npmrc because it can alter npm script execution");
    }
}

export function assertSafeSourceInput(root, relativePath) {
    const resolvedRoot = canonicalSourceRoot(root);
    const safePath = assertRelativePath(relativePath);
    const basename = safePath.split("/").at(-1);
    if (
        !isKnownInventoryPath(safePath) ||
        isSensitiveFilename(basename) ||
        safePath.split("/").some((part) => isExcludedDirectory(part))
    ) {
        throw new Error(
            `Verification source input is outside the closed safe inventory: ${markdownPathLabel(safePath)}`,
        );
    }

    assertRealAncestors(resolvedRoot, safePath);
    const candidate = path.join(resolvedRoot, ...safePath.split("/"));
    ensureInside(resolvedRoot, candidate);
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Verification source input is not a regular file: ${markdownPathLabel(safePath)}`);
    }

    if (stat.size > MAX_SOURCE_FILE_BYTES) {
        throw new Error(
            `Verification source input exceeds ${MAX_SOURCE_FILE_BYTES} bytes: ${markdownPathLabel(safePath)}`,
        );
    }

    return safePath;
}

function normalizeIgnoredPaths(root, ignoredPaths) {
    if (ignoredPaths === undefined) {
        return new Set();
    }

    if (!Array.isArray(ignoredPaths) && !(ignoredPaths instanceof Set)) {
        throw new Error("Verification ignored paths must be an array or set");
    }

    const normalized = new Set();
    for (const value of ignoredPaths) {
        const candidate = String(value).replace(/[\\/]+$/u, "");
        if (!candidate) {
            continue;
        }

        const relativePath = assertRelativePath(candidate);
        ensureInside(root, path.join(root, ...relativePath.split("/")));
        normalized.add(relativePath);
    }

    return normalized;
}

function hashBuffer(value) {
    return createHash("sha256").update(value).digest("hex");
}

export function saltedSourceRootIdentity(root, salt) {
    const resolvedRoot = canonicalSourceRoot(root);
    if (typeof salt !== "string" || salt.length < 16 || salt.length > 256) {
        throw new Error("Verification source-root salt is invalid");
    }

    return hashBuffer(Buffer.from(`${salt}\0${resolvedRoot}`, "utf8"));
}

function readRegularFile(root, relativePath, { includeContent = false } = {}) {
    const candidate = path.join(root, ...relativePath.split("/"));
    ensureInside(root, candidate);
    assertRealAncestors(root, relativePath);
    const before = fs.lstatSync(candidate);
    if (before.isSymbolicLink() || !before.isFile()) {
        throw new Error(`Verification source input changed type before read: ${markdownPathLabel(relativePath)}`);
    }

    if (before.size > MAX_SOURCE_FILE_BYTES) {
        throw new Error(
            `Verification source input exceeds ${MAX_SOURCE_FILE_BYTES} bytes: ${markdownPathLabel(relativePath)}`,
        );
    }

    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    const descriptor = fs.openSync(candidate, flags);
    let content;
    try {
        const opened = fs.fstatSync(descriptor);
        if (
            opened.isSymbolicLink() ||
            !opened.isFile() ||
            opened.size !== before.size ||
            opened.mode !== before.mode ||
            (opened.dev !== undefined && before.dev !== undefined && opened.dev !== before.dev) ||
            (opened.ino !== undefined && before.ino !== undefined && opened.ino !== before.ino)
        ) {
            throw new Error(`Verification source input changed before read: ${markdownPathLabel(relativePath)}`);
        }

        content = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < content.length) {
            const read = fs.readSync(descriptor, content, offset, content.length - offset, offset);
            if (read <= 0) {
                throw new Error(`Verification source input shrank during read: ${markdownPathLabel(relativePath)}`);
            }

            offset += read;
        }

        const extra = Buffer.alloc(1);
        if (fs.readSync(descriptor, extra, 0, 1, before.size) > 0) {
            throw new Error(`Verification source input grew during read: ${markdownPathLabel(relativePath)}`);
        }

        const after = fs.fstatSync(descriptor);
        if (
            after.size !== before.size ||
            after.mtimeMs !== opened.mtimeMs ||
            after.mode !== opened.mode ||
            (after.dev !== undefined && opened.dev !== undefined && after.dev !== opened.dev) ||
            (after.ino !== undefined && opened.ino !== undefined && after.ino !== opened.ino)
        ) {
            throw new Error(`Verification source input changed during read: ${markdownPathLabel(relativePath)}`);
        }
    } finally {
        fs.closeSync(descriptor);
    }

    assertRealAncestors(root, relativePath);
    const afterPath = fs.lstatSync(candidate);
    if (
        afterPath.isSymbolicLink() ||
        !afterPath.isFile() ||
        afterPath.size !== before.size ||
        afterPath.mode !== before.mode ||
        afterPath.mtimeMs !== before.mtimeMs ||
        (afterPath.dev !== undefined && before.dev !== undefined && afterPath.dev !== before.dev) ||
        (afterPath.ino !== undefined && before.ino !== undefined && afterPath.ino !== before.ino)
    ) {
        throw new Error(`Verification source input changed after read: ${markdownPathLabel(relativePath)}`);
    }

    return {
        type: "file",
        mode: before.mode & 0o7777,
        size: before.size,
        sha256: hashBuffer(content),
        ...(includeContent ? { content } : {}),
    };
}

export function readSafeSourceText(root, relativePath) {
    const safePath = assertSafeSourceInput(root, relativePath);
    const result = readRegularFile(root, safePath, { includeContent: true });

    return result.content.toString("utf8");
}

function snapshotDigest(files) {
    const stable = Object.entries(files)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([relativePath, value]) => [relativePath, value]);

    return hashBuffer(Buffer.from(JSON.stringify(stable), "utf8"));
}

function validateHead(head) {
    if (head === undefined) {
        return undefined;
    }

    if (typeof head !== "string" || !SAFE_HEAD.test(head)) {
        throw new Error("Verification HEAD identity is invalid");
    }

    return head;
}

export function captureSourceSnapshot(root, options = {}) {
    const resolvedRoot = canonicalSourceRoot(root);
    const filesToRead = enumerateSourceFiles(resolvedRoot);
    const ignored = normalizeIgnoredPaths(resolvedRoot, options.ignoredPaths);
    const isIgnored = (relativePath) =>
        [...ignored].some((ignoredPath) => relativePath === ignoredPath || relativePath.startsWith(`${ignoredPath}/`));
    const ignoredCandidates = filesToRead.filter(isIgnored);
    if (ignoredCandidates.length > 0) {
        throw new Error(
            `Verification source inventory contains ignored inputs: ${ignoredCandidates.map(markdownPathLabel).join(", ")}`,
        );
    }

    const files = {};
    let totalBytes = 0;
    for (const relativePath of filesToRead) {
        const descriptor = readRegularFile(resolvedRoot, relativePath);
        totalBytes += descriptor.size;
        if (totalBytes > MAX_SOURCE_TOTAL_BYTES) {
            throw new Error(`Verification source inventory exceeds ${MAX_SOURCE_TOTAL_BYTES} bytes`);
        }

        files[relativePath] = descriptor;
    }

    const repeatedFiles = enumerateSourceFiles(resolvedRoot);
    const repeatedIgnored = repeatedFiles.filter(isIgnored);
    if (
        repeatedFiles.length !== filesToRead.length ||
        repeatedFiles.some((relativePath, index) => relativePath !== filesToRead[index]) ||
        repeatedIgnored.length > 0
    ) {
        throw new Error("Verification source inventory changed during fingerprint");
    }

    return {
        schema: VERIFICATION_SCHEMA,
        root: resolvedRoot,
        ...(validateHead(options.head) === undefined ? {} : { head: options.head }),
        files,
        digest: snapshotDigest(files),
    };
}

function descriptorEqual(left, right) {
    return (
        left?.type === right?.type &&
        left?.mode === right?.mode &&
        left?.size === right?.size &&
        left?.sha256 === right?.sha256
    );
}

export function validateSourceSnapshot(snapshot, root) {
    if (
        !snapshot ||
        snapshot.schema !== VERIFICATION_SCHEMA ||
        typeof snapshot.root !== "string" ||
        !snapshot.files ||
        typeof snapshot.files !== "object" ||
        Array.isArray(snapshot.files) ||
        typeof snapshot.digest !== "string"
    ) {
        throw new Error("Verification source snapshot is malformed");
    }

    const expectedRoot = canonicalSourceRoot(root ?? snapshot.root);
    if (snapshot.root !== expectedRoot) {
        throw new Error("Verification source snapshot root changed");
    }

    const entries = Object.entries(snapshot.files);
    if (entries.length === 0 || entries.length > MAX_SOURCE_FILES) {
        throw new Error("Verification source snapshot file count is invalid");
    }

    const files = {};
    let totalBytes = 0;
    for (const [relativePath, descriptor] of entries) {
        const safePath = assertRelativePath(relativePath);
        const basename = safePath.split("/").at(-1);
        if (isSensitiveFilename(basename) || safePath.split("/").some((part) => isExcludedDirectory(part))) {
            throw new Error(
                `Verification source snapshot contains an excluded or sensitive path: ${markdownPathLabel(safePath)}`,
            );
        }

        if (
            descriptor?.type !== "file" ||
            !Number.isInteger(descriptor.mode) ||
            descriptor.mode < 0 ||
            descriptor.mode > 0o7777 ||
            !Number.isInteger(descriptor.size) ||
            descriptor.size < 0 ||
            descriptor.size > MAX_SOURCE_FILE_BYTES ||
            typeof descriptor.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/u.test(descriptor.sha256)
        ) {
            throw new Error(`Verification source snapshot descriptor is invalid: ${markdownPathLabel(safePath)}`);
        }

        totalBytes += descriptor.size;
        if (totalBytes > MAX_SOURCE_TOTAL_BYTES) {
            throw new Error("Verification source snapshot byte count is invalid");
        }

        files[safePath] = { ...descriptor };
    }

    for (const safePath of Object.keys(files)) {
        if (!isKnownInventoryPath(safePath)) {
            throw new Error(
                `Verification source snapshot path is outside the closed source inventory: ${markdownPathLabel(safePath)}`,
            );
        }
    }

    if (snapshot.digest !== snapshotDigest(files)) {
        throw new Error("Verification source snapshot digest does not match its files");
    }

    validateHead(snapshot.head);

    return {
        schema: VERIFICATION_SCHEMA,
        root: expectedRoot,
        ...(snapshot.head === undefined ? {} : { head: snapshot.head }),
        files,
        digest: snapshot.digest,
    };
}

export function compareSourceSnapshots(before, after) {
    const left = validateSourceSnapshot(before);
    const right = validateSourceSnapshot(after, left.root);
    const candidates = new Set([...Object.keys(left.files), ...Object.keys(right.files)]);
    const changed = [...candidates]
        .filter((relativePath) => !descriptorEqual(left.files[relativePath], right.files[relativePath]))
        .sort();

    return {
        changed,
        digestChanged: left.digest !== right.digest,
        headChanged: left.head !== right.head,
        indeterminate: false,
    };
}

export function sourceSnapshotPaths(snapshot) {
    return Object.keys(validateSourceSnapshot(snapshot).files).sort();
}

export function createVerificationReceipt({
    before,
    after,
    registryDigest,
    validatorDigest,
    gates,
    contractDigest,
    gapId,
    selectionId,
    sourceRootSalt,
    runtimeAt = new Date().toISOString(),
}) {
    const comparison = compareSourceSnapshots(before, after);
    if (comparison.digestChanged || comparison.headChanged || comparison.changed.length > 0) {
        throw new Error("Cannot create verification receipt from changed source snapshots");
    }

    const validated = validateSourceSnapshot(after);
    if (typeof registryDigest !== "string" || !/^[a-f0-9]{64}$/u.test(registryDigest)) {
        throw new Error("Verification registry digest is invalid");
    }

    if (typeof validatorDigest !== "string" || !/^[a-f0-9]{64}$/u.test(validatorDigest)) {
        throw new Error("Verification validator digest is invalid");
    }

    if (!Array.isArray(gates) || gates.length < 1 || gates.length > MAX_RECEIPT_GATES) {
        throw new Error(`Verification receipt requires 1-${MAX_RECEIPT_GATES} gates`);
    }

    const normalizedGates = gates.map((gate) => {
        if (
            !gate ||
            typeof gate.id !== "string" ||
            !SAFE_GATE_ID.test(gate.id) ||
            !Number.isInteger(gate.exitCode) ||
            gate.exitCode < 0 ||
            gate.exitCode > 255
        ) {
            throw new Error("Verification receipt gate is invalid");
        }

        return { id: gate.id, exitCode: gate.exitCode };
    });

    if (typeof contractDigest !== "string" || !/^[a-f0-9]{64}$/u.test(contractDigest)) {
        throw new Error("Verification contract digest is invalid");
    }

    const safeIdentity = (value, label) => {
        if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(value)) {
            throw new Error(`Verification ${label} is invalid`);
        }

        return value;
    };

    const normalizedGapId = safeIdentity(gapId, "gap ID");
    const normalizedSelectionId = safeIdentity(selectionId, "selection ID");
    if (typeof sourceRootSalt !== "string" || sourceRootSalt.length < 16 || sourceRootSalt.length > 256) {
        throw new Error("Verification source-root salt is invalid");
    }

    if (typeof runtimeAt !== "string" || !Number.isFinite(Date.parse(runtimeAt))) {
        throw new Error("Verification runtime timestamp is invalid");
    }

    return {
        schema: VERIFICATION_SCHEMA,
        sourceDigest: validated.digest,
        registryDigest,
        validatorDigest,
        gates: normalizedGates,
        runtimeAt,
        contractDigest,
        gapId: normalizedGapId,
        selectionId: normalizedSelectionId,
        sourceRootIdentity: saltedSourceRootIdentity(validated.root, sourceRootSalt),
        runtime: {
            node: process.version,
            platform: process.platform,
        },
    };
}

export function validateVerificationReceipt(receipt) {
    if (
        !receipt ||
        receipt.schema !== VERIFICATION_SCHEMA ||
        typeof receipt.sourceDigest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(receipt.sourceDigest) ||
        typeof receipt.registryDigest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(receipt.registryDigest) ||
        typeof receipt.validatorDigest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(receipt.validatorDigest) ||
        !Array.isArray(receipt.gates) ||
        receipt.gates.length < 1 ||
        receipt.gates.length > MAX_RECEIPT_GATES ||
        !receipt.gates.every(
            (gate) =>
                gate &&
                typeof gate.id === "string" &&
                SAFE_GATE_ID.test(gate.id) &&
                Number.isInteger(gate.exitCode) &&
                gate.exitCode >= 0 &&
                gate.exitCode <= 255,
        ) ||
        typeof receipt.runtimeAt !== "string" ||
        !Number.isFinite(Date.parse(receipt.runtimeAt)) ||
        typeof receipt.contractDigest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(receipt.contractDigest) ||
        typeof receipt.gapId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(receipt.gapId) ||
        typeof receipt.selectionId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(receipt.selectionId) ||
        typeof receipt.sourceRootIdentity !== "string" ||
        !/^[a-f0-9]{64}$/u.test(receipt.sourceRootIdentity) ||
        typeof receipt.runtime !== "object" ||
        receipt.runtime === null ||
        typeof receipt.runtime.node !== "string" ||
        !/^v\d+\.\d+\.\d+/.test(receipt.runtime.node) ||
        typeof receipt.runtime.platform !== "string" ||
        !/^[A-Za-z0-9._-]{1,40}$/u.test(receipt.runtime.platform)
    ) {
        throw new Error("Verification receipt is malformed");
    }

    return {
        schema: VERIFICATION_SCHEMA,
        sourceDigest: receipt.sourceDigest,
        registryDigest: receipt.registryDigest,
        validatorDigest: receipt.validatorDigest,
        gates: receipt.gates.map((gate) => ({ id: gate.id, exitCode: gate.exitCode })),
        runtimeAt: receipt.runtimeAt,
        contractDigest: receipt.contractDigest,
        gapId: receipt.gapId,
        selectionId: receipt.selectionId,
        sourceRootIdentity: receipt.sourceRootIdentity,
        runtime: {
            node: receipt.runtime.node,
            platform: receipt.runtime.platform,
        },
    };
}
