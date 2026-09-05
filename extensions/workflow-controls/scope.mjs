import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const MAX_SCOPE_ENTRIES = 40;
export const MAX_SNAPSHOT_PATHS = 256;
export const MAX_FINGERPRINT_BYTES = 8 * 1024 * 1024;

function portableRelative(value) {
    return value.split(path.sep).join("/");
}

function comparable(value, platform = process.platform) {
    const normalized = path.resolve(value);

    return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInside(root, candidate, platform = process.platform) {
    const base = comparable(root, platform);
    const target = comparable(candidate, platform);

    return target === base || target.startsWith(`${base}${path.sep}`);
}

function nearestExistingParent(candidate) {
    let current = candidate;
    while (!fs.existsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) {
            return undefined;
        }

        current = parent;
    }

    return current;
}

export function canonicalRoot(root) {
    const resolved = path.resolve(root);
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
        throw new Error("Scope root must be a directory");
    }

    return fs.realpathSync.native(resolved);
}

export function resolveScopedPath(root, input, options = {}) {
    if (typeof input !== "string" || !input.trim() || /[\u0000-\u001f\u007f]/u.test(input)) {
        throw new Error("Scope paths must be non-empty text without control characters");
    }

    const trimmed = input.trim();
    if (path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/u.test(trimmed)) {
        throw new Error("Scope paths must be project-relative");
    }

    const resolvedRoot = canonicalRoot(root);
    const candidate = path.resolve(resolvedRoot, trimmed);
    if (!isInside(resolvedRoot, candidate, options.platform)) {
        throw new Error("Scope path escapes the project root");
    }

    const existing = nearestExistingParent(candidate);
    if (!existing) {
        throw new Error("Scope path has no verifiable parent");
    }

    const canonicalParent = fs.realpathSync.native(existing);
    if (!isInside(resolvedRoot, canonicalParent, options.platform)) {
        throw new Error("Scope path escapes the project root through a symlink");
    }

    const relative = portableRelative(path.relative(resolvedRoot, candidate)) || ".";
    const explicitDirectory = /[\\/]$/u.test(trimmed);
    const directory = explicitDirectory || (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory());

    return { path: relative, directory };
}

export function normalizeScopeEntries(root, inputs, options = {}) {
    if (!Array.isArray(inputs) || inputs.length === 0) {
        throw new Error("Scope requires at least one path");
    }

    if (inputs.length > MAX_SCOPE_ENTRIES) {
        throw new Error(`Scope supports at most ${MAX_SCOPE_ENTRIES} paths`);
    }

    const seen = new Set();
    const entries = [];
    for (const input of inputs) {
        const entry = resolveScopedPath(root, input, options);
        const key = `${options.platform === "win32" ? entry.path.toLowerCase() : entry.path}:${entry.directory}`;
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        entries.push(entry);
    }

    if (entries.length === 0) {
        throw new Error("Scope requires at least one distinct path");
    }

    return entries;
}

export function scopeMatches(entries, relativePath, platform = process.platform) {
    if (!Array.isArray(entries) || typeof relativePath !== "string") {
        return false;
    }

    const normalize = (value) => {
        const result = value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "") || ".";

        return platform === "win32" ? result.toLowerCase() : result;
    };

    const candidate = normalize(relativePath);

    return entries.some((entry) => {
        const expected = normalize(entry.path);
        if (entry.directory) {
            return expected === "." || candidate === expected || candidate.startsWith(`${expected}/`);
        }

        return candidate === expected;
    });
}

// Git reports NUL-delimited paths verbatim, so a filename may legally contain a newline. Those paths are reported back
// through the system prompt, tool results, and the UI, where a raw newline would let a hostile filename forge a line of
// guidance. Escaping keeps the path identifiable without letting it break out of the line it belongs on.
export function sanitizePathLabel(value) {
    return String(value).replace(/[%\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => encodeURIComponent(character));
}

export function parsePorcelainEntries(output) {
    if (typeof output !== "string") {
        throw new Error("Git status output is unavailable");
    }

    const fields = output.split("\0");
    const entries = [];
    for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index];
        if (!field) {
            continue;
        }

        if (field.length < 4 || field[2] !== " ") {
            throw new Error("Malformed NUL-delimited Git status output");
        }

        const status = field.slice(0, 2);
        const candidate = field.slice(3);
        if (!candidate || candidate.includes("\0")) {
            throw new Error("Malformed Git status path");
        }

        entries.push({ status, path: candidate.replaceAll("\\", "/") });
        if (status.includes("R") || status.includes("C")) {
            index += 1;
            if (index >= fields.length || !fields[index]) {
                throw new Error("Malformed Git rename status");
            }

            if (status.includes("R")) {
                entries.push({ status, path: fields[index].replaceAll("\\", "/") });
            }
        }
    }

    return entries;
}

export function parsePorcelainZ(output) {
    return [...new Set(parsePorcelainEntries(output).map((entry) => entry.path))].sort();
}

function fingerprintPath(root, relativePath) {
    const candidate = path.resolve(root, relativePath);
    if (!isInside(root, candidate)) {
        throw new Error("Git reported a path outside the project root");
    }

    let stat;
    try {
        stat = fs.lstatSync(candidate);
    } catch (error) {
        if (error?.code === "ENOENT") {
            return "missing";
        }

        throw error;
    }

    if (stat.isSymbolicLink()) {
        return `symlink:${fs.readlinkSync(candidate)}`;
    }

    if (!stat.isFile()) {
        return `${stat.mode}:${stat.size}:${stat.mtimeMs}`;
    }

    if (stat.size > MAX_FINGERPRINT_BYTES) {
        return `large:${stat.size}:${stat.mtimeMs}`;
    }

    return createHash("sha256").update(fs.readFileSync(candidate)).digest("hex");
}

export function createWorktreeSnapshot(root, porcelainOutput) {
    const resolvedRoot = canonicalRoot(root);
    const paths = parsePorcelainZ(porcelainOutput);
    if (paths.length > MAX_SNAPSHOT_PATHS) {
        return {
            root: resolvedRoot,
            paths: paths.slice(0, MAX_SNAPSHOT_PATHS),
            fingerprints: {},
            indeterminate: true,
            reason: `More than ${MAX_SNAPSHOT_PATHS} changed paths`,
        };
    }

    const fingerprints = {};
    for (const relativePath of paths) {
        fingerprints[relativePath] = fingerprintPath(resolvedRoot, relativePath);
    }

    return { root: resolvedRoot, paths, fingerprints, indeterminate: false };
}

export function compareWorktreeSnapshots(before, after, entries) {
    if (!before || !after || before.indeterminate || after.indeterminate || before.root !== after.root) {
        return { changed: [], outside: [], indeterminate: true };
    }

    const candidates = new Set([...before.paths, ...after.paths]);
    const changed = [...candidates]
        .filter((candidate) => before.fingerprints[candidate] !== after.fingerprints[candidate])
        .sort();
    const outside = changed.filter((candidate) => !scopeMatches(entries, candidate));

    return { changed, outside, indeterminate: false };
}

export function relativeMutationPath(root, input, options = {}) {
    if (typeof input !== "string" || !input.trim() || /[\u0000-\u001f\u007f]/u.test(input)) {
        throw new Error("Mutation path must be non-empty text without control characters");
    }

    const relative = !path.isAbsolute(input) && !/^[A-Za-z]:[\\/]/u.test(input);
    const requested = relative ? input.trim() : input;
    const resolvedRoot = canonicalRoot(root);
    const cwd = typeof options.cwd === "string" && options.cwd ? options.cwd : resolvedRoot;
    // Pi resolves relative paths lexically before the filesystem follows symlinks. Canonicalizing cwd first would
    // change the target of ../ beneath an aliased directory.
    const candidate = relative ? path.resolve(cwd, requested) : path.resolve(requested);
    const existing = nearestExistingParent(candidate);
    if (!existing) {
        throw new Error("Mutation path has no verifiable parent");
    }

    const canonicalParent = fs.realpathSync.native(existing);
    if (!isInside(resolvedRoot, canonicalParent, options.platform)) {
        throw new Error("Mutation path escapes the project root through a symlink");
    }

    // Rebase only an aliased project-root prefix, preserving internal symlink labels and nonexistent descendants.
    // The outermost matching ancestor keeps an internal link back to the root from erasing its own scope label.
    let scopedCandidate = candidate;
    if (!isInside(resolvedRoot, candidate, options.platform)) {
        let lexicalRoot;
        let ancestor = existing;
        while (true) {
            if (
                comparable(fs.realpathSync.native(ancestor), options.platform) ===
                comparable(resolvedRoot, options.platform)
            ) {
                lexicalRoot = ancestor;
            }

            const parent = path.dirname(ancestor);
            if (parent === ancestor) {
                break;
            }

            ancestor = parent;
        }

        if (!lexicalRoot) {
            throw new Error("Mutation path escapes the project root");
        }

        scopedCandidate = path.resolve(resolvedRoot, path.relative(lexicalRoot, candidate));
    }

    if (!isInside(resolvedRoot, scopedCandidate, options.platform)) {
        throw new Error("Mutation path escapes the project root");
    }

    return portableRelative(path.relative(resolvedRoot, scopedCandidate)) || ".";
}
