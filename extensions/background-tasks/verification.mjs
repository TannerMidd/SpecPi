import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { normalizeStart, record, safeText } from "./core.mjs";

export const VERIFY_LIMITS = Object.freeze({
    declarations: 40,
    files: 256,
    bytes: 8 * 1024 * 1024,
    entries: 512,
    depth: 12,
    receipts: 32,
    output: 16384,
});
const deniedDirectories =
    /^(?:\.git|\.pi|\.codex|\.ssh|\.gnupg|\.aws|\.azure|\.kube|node_modules|credentials|secrets|sessions|missions|history|trust)$/iu;
const deniedFile =
    /^(?:\.env(?:[.-].*)?|\.npmrc|\.pypirc|\.netrc|auth\.json(?:[.-].*)?|credentials?(?:[.-].*)?|secrets?(?:[.-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|private[-_]?key(?:[.-].*)?|settings\.local\.json|.*\.(?:pem|key|p12|pfx|keystore|sqlite|db|jsonl))$/iu;
const hash = (value) => createHash("sha256").update(value).digest("hex");
export const verificationDigest = (value) => hash(JSON.stringify(value));

function inside(root, candidate) {
    const relative = path.relative(root, candidate);

    return (
        relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    );
}

function privateRoots() {
    return [path.join(os.homedir(), ".pi"), process.env.PI_CODING_AGENT_DIR].filter(Boolean).flatMap((entry) => {
        const resolved = path.resolve(entry);
        try {
            return [resolved, fs.realpathSync.native(resolved)];
        } catch {
            return [resolved];
        }
    });
}

function rejectPrivateRoot(candidate, roots = privateRoots()) {
    for (const privateRoot of roots) {
        if (inside(privateRoot, candidate)) {
            throw new Error("Verification inputs cannot include Pi private state.");
        }
    }

    if (candidate.split(/[\\/]/u).some((part) => deniedDirectories.test(part))) {
        throw new Error("Verification root is a private or excluded directory.");
    }
}

export function verificationRoot(value) {
    const absolute = path.resolve(value);
    // Reject known private state before inspecting the requested directory.
    rejectPrivateRoot(absolute);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("Verification root must be a real directory.");
    }

    // Ancestor links can lead into private state, so screen the resolved path too
    // rather than rejecting every root whose spelling is not already canonical:
    // /var/folders on macOS and a lowercase Windows drive letter are both
    // ordinary workspaces. Callers compare against this canonical return value.
    const canonical = fs.realpathSync.native(absolute);
    rejectPrivateRoot(canonical);

    return canonical;
}

// The same rules normalizeManifest applies to a declared path segment, asked of a
// name discovered by the directory walk. Declared paths still fail loudly; only
// entries found inside a declared directory are skipped.
function excludedEntry(name) {
    return (
        typeof name !== "string" ||
        !name ||
        name.length > 240 ||
        /[\u0000-\u001f\u007f:*?<>|/\\]/u.test(name) ||
        name === "." ||
        name === ".." ||
        name !== name.trim() ||
        name.endsWith(".") ||
        deniedDirectories.test(name) ||
        deniedFile.test(name)
    );
}

export function normalizeManifest(values) {
    if (!Array.isArray(values) || values.length === 0 || values.length > VERIFY_LIMITS.declarations) {
        throw new Error("Verification requires 1-40 explicit relative files or directories ending in /.");
    }

    const result = values
        .map((value) => {
            if (typeof value !== "string" || value.length > 240 || /[\u0000-\u001f\u007f:*?<>|]/u.test(value)) {
                throw new Error("Invalid verification input path.");
            }

            const normalized = value.replaceAll("\\", "/");
            const directory = normalized.endsWith("/");
            const parts = (directory ? normalized.slice(0, -1) : normalized).split("/");
            if (
                parts.some(
                    (part) =>
                        !part ||
                        part === "." ||
                        part === ".." ||
                        part !== part.trim() ||
                        part.endsWith(".") ||
                        deniedDirectories.test(part),
                ) ||
                deniedFile.test(parts.at(-1))
            ) {
                throw new Error("Verification inputs contain a private, excluded or unsafe path.");
            }

            return normalized;
        })
        .sort();
    if (
        new Set(result.map((value) => (process.platform === "win32" ? value.toLowerCase() : value))).size !==
        result.length
    ) {
        throw new Error("Verification inputs must be unique.");
    }

    return result;
}

export function normalizeVerification(input, cwd, workspaceRoot = cwd) {
    record(input, ["command", "cwd", "label", "timeoutSeconds", "inputs"]);
    const { inputs, ...execution } = input;
    const root = verificationRoot(workspaceRoot);
    // Compare canonical against canonical: verificationRoot resolves links, and
    // normalizeStart resolves spec.cwd with a different realpath API, so the two
    // spellings only agree once both have been put through the same resolution.
    if (!inside(root, verificationRoot(cwd))) {
        throw new Error("Verification workspace must contain the active cwd.");
    }

    verificationRoot(path.resolve(cwd, execution.cwd ?? cwd));
    const spec = normalizeStart(execution, cwd);
    const specRoot = verificationRoot(spec.cwd);
    if (!inside(root, specRoot)) {
        throw new Error("Verification command cwd must be within the active workspace.");
    }

    return Object.freeze({
        root,
        spec: Object.freeze({ ...spec, cwd: specRoot }),
        inputs: Object.freeze(normalizeManifest(inputs)),
    });
}

export function executionSpecDigest(spec) {
    return verificationDigest({
        command: spec.command,
        cwd: spec.cwd,
        shell: spec.shell,
        dialect: spec.dialect,
        timeoutSeconds: spec.timeoutSeconds,
    });
}

export function captureInputs(root, declarations) {
    const canonical = verificationRoot(root);
    const blockedRoots = privateRoots();
    const inputs = normalizeManifest(declarations);
    const files = new Map();
    let total = 0;
    let visited = 0;
    let skipped = 0;
    const directories = new Map();
    const countEntry = () => {
        visited += 1;
        if (visited > VERIFY_LIMITS.entries) {
            throw new Error("Verification directory inventory exceeds its bound.");
        }
    };

    const inspectPath = (relative) => {
        let candidate = canonical;
        let stat;
        for (const part of ["", ...relative.split("/")]) {
            candidate = part ? path.join(candidate, part) : candidate;
            rejectPrivateRoot(candidate, blockedRoots);
            stat = fs.lstatSync(candidate);
            if (stat.isSymbolicLink() || !inside(canonical, fs.realpathSync.native(candidate))) {
                throw new Error("Verification inputs cannot traverse links.");
            }

            if (stat.isDirectory()) {
                const identity = `${stat.dev}:${stat.ino}`;
                if (directories.has(candidate) && directories.get(candidate) !== identity) {
                    throw new Error("Verification input directory changed during capture.");
                }

                directories.set(candidate, identity);
            }
        }

        return stat;
    };

    const visit = (relative, candidate, directory, depth) => {
        if (depth > VERIFY_LIMITS.depth) {
            throw new Error("Verification directory inventory exceeds its bound.");
        }

        normalizeManifest([`${relative}${directory ? "/" : ""}`]);
        // Recheck the full chain: an open directory handle does not pin the path
        // used to open its children when another process replaces an ancestor.
        const stat = inspectPath(relative);
        if (directory) {
            if (!stat.isDirectory()) {
                throw new Error("Declared verification directory is not a directory.");
            }

            const handle = fs.opendirSync(candidate);
            try {
                let entry;
                while ((entry = handle.readSync())) {
                    countEntry();
                    // A declared directory that happens to contain a secret, a build
                    // cache or an unusable name skips that entry. Aborting the whole
                    // capture would make an already-recorded receipt go stale the
                    // moment a build drops a .sqlite beside the sources it declared.
                    if (excludedEntry(entry.name)) {
                        skipped += 1;
                        continue;
                    }

                    visit(
                        `${relative}/${entry.name}`,
                        path.join(candidate, entry.name),
                        entry.isDirectory(),
                        depth + 1,
                    );
                }
            } finally {
                handle.closeSync();
            }

            inspectPath(relative);

            return;
        }

        if (files.has(relative)) {
            return;
        }

        if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            files.size >= VERIFY_LIMITS.files ||
            total + stat.size > VERIFY_LIMITS.bytes
        ) {
            throw new Error("Verification requires ordinary unlinked files within 256 files and 8 MiB total.");
        }

        const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        try {
            const opened = fs.fstatSync(descriptor);
            inspectPath(relative);
            if (
                !opened.isFile() ||
                opened.nlink !== 1 ||
                opened.dev !== stat.dev ||
                opened.ino !== stat.ino ||
                opened.size !== stat.size
            ) {
                throw new Error("Verification input changed while opening.");
            }

            const bytes = Buffer.alloc(opened.size + 1);
            let count = 0;
            while (count < bytes.length) {
                const read = fs.readSync(descriptor, bytes, count, bytes.length - count, count);
                if (read === 0) {
                    break;
                }

                count += read;
            }

            const after = fs.fstatSync(descriptor);
            if (
                count !== opened.size ||
                after.mtimeMs !== opened.mtimeMs ||
                after.ctimeMs !== opened.ctimeMs ||
                after.size !== opened.size
            ) {
                throw new Error("Verification input changed while hashing.");
            }

            total += count;
            files.set(relative, { path: relative, bytes: count, sha256: hash(bytes.subarray(0, count)) });
        } finally {
            fs.closeSync(descriptor);
        }
    };

    for (const declaration of inputs) {
        const relative = declaration.replace(/\/$/u, "");
        countEntry();
        visit(relative, path.join(canonical, relative), declaration.endsWith("/"), 0);
    }

    if (files.size === 0) {
        throw new Error("Verification input manifest contains no files.");
    }

    const entries = [...files.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));

    return {
        root: canonical,
        inputs,
        files: entries,
        bytes: total,
        skipped,
        digest: verificationDigest({ root: canonical, inputs, files: entries }),
    };
}

export function verificationOutput(ring) {
    let start = Math.max(0, ring.bytes.length - VERIFY_LIMITS.output);
    while (start < ring.bytes.length && (ring.bytes[start] & 0xc0) === 0x80) {
        start += 1;
    }

    // Escape per character and keep whole units from the end. Cutting the escaped
    // buffer at a byte offset can split a \uXXXX expansion, and the leftover
    // fragment would be presented as output the command never produced.
    const units = [...ring.bytes.subarray(start).toString("utf8")].map((character) => {
        const escaped = safeText(character);

        return { escaped, bytes: Buffer.byteLength(escaped) };
    });
    let budget = VERIFY_LIMITS.output;
    let kept = units.length;
    while (kept > 0 && units[kept - 1].bytes <= budget) {
        kept -= 1;
        budget -= units[kept].bytes;
    }

    return {
        text: units
            .slice(kept)
            .map((unit) => unit.escaped)
            .join(""),
        truncated: start > 0 || ring.end > ring.bytes.length || kept > 0,
        observedStreams: ring.digests(),
        scope: "Digest covers observed raw stream bytes; output is an untrusted bounded tail, not complete command output.",
    };
}

export class VerificationRegistry {
    constructor() {
        this.generation = randomUUID();
        this.receipts = new Map();
    }
    invalidate() {
        this.generation = randomUUID();
        this.receipts.clear();
    }
    add(binding, before, after, outcome, output) {
        const receipt = {
            schema: 1,
            id: randomUUID(),
            generation: this.generation,
            root: binding.root,
            spec: { ...binding.spec },
            specDigest: executionSpecDigest(binding.spec),
            inputs: [...binding.inputs],
            before,
            after,
            outcome: { ...outcome },
            output,
            recordedAt: new Date().toISOString(),
        };
        while (this.receipts.size >= VERIFY_LIMITS.receipts) {
            this.receipts.delete(this.receipts.keys().next().value);
        }

        this.receipts.set(receipt.id, structuredClone(receipt));

        return structuredClone(receipt);
    }
    resolve(id, root, captures = new Map()) {
        const canonical = verificationRoot(root);
        const receipt = this.receipts.get(id);
        if (!receipt || receipt.generation !== this.generation || receipt.root !== canonical) {
            return { id, status: "unknown", reason: "No current receipt for this workspace and session generation." };
        }

        // Receipts commonly declare the same inputs, and re-reading and hashing an
        // inventory per receipt is what makes resolving a full list expensive.
        const key = verificationDigest(receipt.inputs);
        let current = captures.get(key);
        if (current === undefined) {
            try {
                current = captureInputs(canonical, receipt.inputs);
            } catch {
                current = null;
            }

            captures.set(key, current);
        }

        if (current === null) {
            return {
                ...structuredClone(receipt),
                status: "stale",
                reason: "Declared input inventory is unavailable or exceeds its bounds.",
            };
        }

        const fresh = receipt.before?.digest === receipt.after?.digest && current.digest === receipt.after?.digest;
        const passed =
            receipt.outcome.status === "exited" &&
            receipt.outcome.exitCode === 0 &&
            receipt.outcome.cleanup === "confirmed" &&
            receipt.outcome.reason === "command exited";

        return {
            ...structuredClone(receipt),
            status: !fresh ? "stale" : passed ? "passed" : "failed",
            reason: !fresh
                ? "Declared inputs changed during or after the check."
                : passed
                  ? "Observed exit zero with confirmed cleanup and unchanged declared inputs."
                  : "The command did not finish successfully with confirmed cleanup.",
        };
    }
    list(root) {
        // Stored roots are canonical, so the caller's spelling has to be resolved
        // the same way resolve() does or every receipt silently filters out.
        const canonical = verificationRoot(root);
        const captures = new Map();

        return [...this.receipts.values()]
            .filter((receipt) => receipt.root === canonical)
            .map((receipt) => this.resolve(receipt.id, canonical, captures));
    }
}
