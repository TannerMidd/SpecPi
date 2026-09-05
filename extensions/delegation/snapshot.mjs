import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DelegationError } from "./errors.mjs";

const MAX_FILES = 200;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const TEXT_EXTENSIONS = new Set([
    ".astro",
    ".bash",
    ".bat",
    ".c",
    ".cc",
    ".cjs",
    ".cmake",
    ".cmd",
    ".cpp",
    ".cs",
    ".css",
    ".cts",
    ".go",
    ".gql",
    ".graphql",
    ".h",
    ".hpp",
    ".htm",
    ".html",
    ".ini",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".kt",
    ".kts",
    ".less",
    ".lock",
    ".lua",
    ".md",
    ".mdx",
    ".mjs",
    ".mts",
    ".php",
    ".properties",
    ".proto",
    ".ps1",
    ".py",
    ".r",
    ".rb",
    ".rs",
    ".rst",
    ".sass",
    ".scss",
    ".sh",
    ".sql",
    ".svelte",
    ".svg",
    ".swift",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".vue",
    ".xml",
    ".yaml",
    ".yml",
]);
const TEXT_NAMES = new Set([
    "dockerfile",
    "makefile",
    "cmakelists.txt",
    "license",
    "notice",
    ".editorconfig",
    ".gitignore",
    ".gitattributes",
    ".prettierrc",
    ".eslintrc",
]);
const PRIVATE_SEGMENT =
    /(?:^|[._-])(?:auth|authentication|secret|secrets|credential|credentials|session|sessions|history|mission|missions|trust)(?:$|[._-])/i;
const PRIVATE_DIRECTORY = /^(?:\.git|\.pi|\.codex|\.ssh|\.aws|\.azure|\.gnupg)$/i;
const DEVICE_NAME = /^(?:con|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

function fail(label) {
    throw new DelegationError(`Snapshot ${label}.`);
}

function isPrivate(segment) {
    return PRIVATE_DIRECTORY.test(segment) || PRIVATE_SEGMENT.test(segment) || /^\.env(?:\.|$)/i.test(segment);
}

function samePath(left, right) {
    return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function boundedInteger(value, maximum) {
    return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function validateRelative(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
        fail("path rejected");
    }

    if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /[\x00-\x1f\x7f:*?]/.test(value)) {
        fail("path rejected");
    }

    const parts = value.replaceAll("\\", "/").split("/");
    if (
        parts.length > 128 ||
        parts.some(
            (part) =>
                !part ||
                part === "." ||
                part === ".." ||
                /[. ]$/.test(part) ||
                isPrivate(part) ||
                DEVICE_NAME.test(part),
        )
    ) {
        fail("path rejected");
    }

    const name = parts.at(-1).toLowerCase();
    if (!TEXT_EXTENSIONS.has(path.posix.extname(name)) && !TEXT_NAMES.has(name)) {
        fail("file type rejected");
    }

    return parts.join("/");
}

function identityEqual(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}

function fileEqual(left, right) {
    return (
        identityEqual(left, right) &&
        left.size === right.size &&
        left.nlink === right.nlink &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs &&
        left.birthtimeNs === right.birthtimeNs
    );
}

function checkedStat(filename, directory) {
    const stat = fs.lstatSync(filename, { bigint: true });
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) {
        fail("path rejected");
    }

    if (!samePath(fs.realpathSync.native(filename), filename)) {
        fail("path binding changed");
    }

    return stat;
}

function binding(root, relative) {
    let filename = root;
    const chain = [checkedStat(root, true)];
    const parts = relative.split("/");
    for (const [index, part] of parts.entries()) {
        filename = path.join(filename, part);
        chain.push(checkedStat(filename, index < parts.length - 1));
    }

    return { filename, chain, stat: chain.at(-1) };
}

function bindingEqual(left, right) {
    return (
        left.chain.length === right.chain.length &&
        left.chain.every((stat, index) =>
            index === left.chain.length - 1
                ? fileEqual(stat, right.chain[index])
                : identityEqual(stat, right.chain[index]),
        )
    );
}

function hash(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function readBoundFile(root, relative, expected, maximum) {
    if (!bindingEqual(expected, binding(root, relative)) || expected.stat.size > BigInt(maximum)) {
        fail("source changed");
    }

    // NOFOLLOW protects the final component where supported. Node does not expose
    // portable openat/Windows reparse controls for every ancestor. Identity and
    // canonical-path checks narrow races; this is not a hostile-OS sandbox or an
    // atomic filesystem snapshot. The local filesystem is a trusted boundary.
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    let descriptor;
    let bytes;
    try {
        descriptor = fs.openSync(expected.filename, flags);
        const before = fs.fstatSync(descriptor, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n || !fileEqual(before, expected.stat)) {
            fail("source changed");
        }

        bytes = Buffer.alloc(Number(before.size) + 1);
        let count = 0;
        while (count < bytes.length) {
            const received = fs.readSync(descriptor, bytes, count, bytes.length - count, null);
            if (received === 0) {
                break;
            }

            count += received;
        }

        if (
            count !== Number(before.size) ||
            !fileEqual(before, fs.fstatSync(descriptor, { bigint: true })) ||
            !bindingEqual(expected, binding(root, relative))
        ) {
            fail("source changed");
        }

        return bytes.subarray(0, count);
    } catch {
        bytes?.fill(0);
        fail("source unavailable or changed");
    } finally {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
    }
}

function textLines(bytes) {
    if (bytes.some((byte) => (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127)) {
        fail("non-text source rejected");
    }

    let text;
    try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
        fail("non-text source rejected");
    }

    if (text.length === 0) {
        return [];
    }

    const lines = text.split(/\r\n|\n|\r/);
    if (lines.at(-1) === "") {
        lines.pop();
    }

    return lines;
}

function responseBytes(value) {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Capture only parent-selected relative text files; never discover or walk files.
 * Limits may be lowered, never raised. Line results normalize newlines to LF;
 * digests always cover the original bytes. Private-path denial is a conservative
 * filename boundary, not a claim to detect secrets embedded in ordinary sources.
 * Nothing is persisted. Byte buffers are cleared after use; destroy drops string
 * references. JS strings and returned data cannot be securely erased from memory.
 */
export function createSnapshot(root, paths, options = {}) {
    const records = [];
    let closed = false;
    let canonicalRoot;
    try {
        if (
            !options ||
            typeof options !== "object" ||
            !boundedInteger(options.maxFiles ?? MAX_FILES, MAX_FILES) ||
            !boundedInteger(options.maxBytes ?? MAX_BYTES, MAX_BYTES)
        ) {
            fail("limits rejected");
        }

        const maxFiles = options.maxFiles ?? MAX_FILES;
        const maxBytes = options.maxBytes ?? MAX_BYTES;
        if (!Array.isArray(paths) || paths.length > maxFiles) {
            fail("file quota exceeded");
        }

        // Validate the entire selection before inspecting any selected file.
        const selected = paths.map(validateRelative);
        const keys = selected.map((value) => (process.platform === "win32" ? value.toLowerCase() : value));
        if (new Set(keys).size !== selected.length) {
            fail("duplicate source rejected");
        }

        if (
            typeof root !== "string" ||
            root.length === 0 ||
            root.length > 4096 ||
            /[\x00-\x1f\x7f]/.test(root) ||
            root.replaceAll("\\", "/").split("/").some(isPrivate)
        ) {
            fail("root rejected");
        }

        canonicalRoot = path.resolve(root);
        if (canonicalRoot.replaceAll("\\", "/").split("/").some(isPrivate)) {
            fail("root rejected");
        }

        checkedStat(canonicalRoot, true);
        let totalBytes = 0;
        for (const relative of selected) {
            const original = binding(canonicalRoot, relative);
            if (original.stat.size > BigInt(maxBytes - totalBytes)) {
                fail("byte quota exceeded");
            }

            totalBytes += Number(original.stat.size);
            records.push({ relative, original, digest: undefined, lines: undefined });
        }

        for (const record of records) {
            const bytes = readBoundFile(canonicalRoot, record.relative, record.original, maxBytes);
            try {
                record.digest = hash(bytes);
                record.lines = textLines(bytes);
            } finally {
                bytes.fill(0);
            }
        }

        // Recheck every digest after all captures, then all path/stat bindings.
        // This detects observed drift, without claiming an atomic OS snapshot.
        for (const record of records) {
            const bytes = readBoundFile(canonicalRoot, record.relative, record.original, maxBytes);
            try {
                if (hash(bytes) !== record.digest) {
                    fail("source changed");
                }
            } finally {
                bytes.fill(0);
            }
        }

        for (const record of records) {
            if (!bindingEqual(record.original, binding(canonicalRoot, record.relative))) {
                fail("source changed");
            }
        }
    } catch {
        records.length = 0;
        fail("creation rejected");
    }

    const sources = Object.freeze(
        records.map((record, index) =>
            Object.freeze({
                id: `s${index + 1}`,
                path: record.relative,
                digest: record.digest,
                bytes: Number(record.original.stat.size),
                lineCount: record.lines.length,
            }),
        ),
    );
    const byId = new Map(sources.map((source, index) => [source.id, records[index]]));

    function ensureOpen() {
        if (closed) {
            fail("closed");
        }
    }

    return Object.freeze({
        sources,
        read(id, startLine = 1, maxLines = 200) {
            ensureOpen();
            const record = byId.get(id);
            if (
                !record ||
                !boundedInteger(startLine, Number.MAX_SAFE_INTEGER) ||
                !boundedInteger(maxLines, 200) ||
                startLine > Math.max(1, record.lines.length)
            ) {
                fail("read request rejected");
            }

            const requestedEnd = Math.min(record.lines.length, startLine - 1 + maxLines);
            const result = {
                sourceId: id,
                digest: record.digest,
                startLine,
                endLine: startLine - 1,
                text: "",
                truncated: false,
            };
            const lines = [];
            const overhead = responseBytes(result) - String(result.endLine).length;
            let textBytes = 0;
            for (let index = startLine - 1; index < requestedEnd; index += 1) {
                // JSON encodes a separator newline as two bytes. Encode each line once,
                // including escapes and UTF-8, instead of repeatedly encoding its prefix.
                const nextBytes = textBytes + responseBytes(record.lines[index]) - 2 + (lines.length ? 2 : 0);
                if (overhead + String(index + 1).length + nextBytes > MAX_RESPONSE_BYTES) {
                    if (index === startLine - 1) {
                        fail("line exceeds response quota");
                    }

                    result.truncated = true;
                    break;
                }

                lines.push(record.lines[index]);
                textBytes = nextBytes;
                result.endLine = index + 1;
            }

            result.text = lines.join("\n");

            return result;
        },
        search(query, limit = 20, allowedIds) {
            ensureOpen();
            if (
                typeof query !== "string" ||
                query.length < 1 ||
                query.length > 200 ||
                /[\x00-\x1f\x7f]/.test(query) ||
                !boundedInteger(limit, 20)
            ) {
                fail("search request rejected");
            }

            let selectedIds;
            if (allowedIds !== undefined) {
                if (!(allowedIds instanceof Set) || allowedIds.size > byId.size) {
                    fail("search scope rejected");
                }

                selectedIds = new Set(allowedIds);
                for (const id of selectedIds) {
                    if (!byId.has(id)) {
                        fail("search scope rejected");
                    }
                }
            }

            const results = [];
            let resultBytes = 2;
            for (const [id, record] of byId) {
                if (selectedIds && !selectedIds.has(id)) {
                    continue;
                }

                for (const [index, line] of record.lines.entries()) {
                    if (!line.includes(query)) {
                        continue;
                    }

                    const match = { sourceId: id, line: index + 1, text: line };
                    const nextBytes = resultBytes + responseBytes(match) + (results.length ? 1 : 0);
                    if (nextBytes > MAX_RESPONSE_BYTES) {
                        if (results.length === 0) {
                            fail("line exceeds response quota");
                        }

                        return results;
                    }

                    results.push(match);
                    resultBytes = nextBytes;
                    if (results.length === limit) {
                        return results;
                    }
                }
            }

            return results;
        },
        assertBindings() {
            try {
                for (const record of records) {
                    if (!bindingEqual(record.original, binding(canonicalRoot, record.relative))) {
                        fail("source changed");
                    }
                }
            } catch {
                fail("source unavailable or changed");
            }
        },
        assertFresh() {
            try {
                for (const record of records) {
                    const bytes = readBoundFile(canonicalRoot, record.relative, record.original, MAX_BYTES);
                    try {
                        if (hash(bytes) !== record.digest) {
                            fail("source changed");
                        }
                    } finally {
                        bytes.fill(0);
                    }
                }

                for (const record of records) {
                    if (!bindingEqual(record.original, binding(canonicalRoot, record.relative))) {
                        fail("source changed");
                    }
                }
            } catch {
                fail("source unavailable or changed");
            }
        },
        destroy() {
            if (!closed) {
                for (const record of records) {
                    record.lines.length = 0;
                }

                byId.clear();
                // Retain only identity, path and digest metadata for later receipt checks.
                // Captured text is no longer available after the worker deadline.
                closed = true;
            }
        },
    });
}
