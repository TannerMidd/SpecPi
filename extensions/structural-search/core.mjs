import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createSnapshot } from "../delegation/snapshot.mjs";

export const VERSION = "0.45.3";
export const LANGUAGES = Object.freeze({
    javascript: { parser: "javascript", extensions: [".js", ".mjs", ".cjs"] },
    jsx: { parser: "jsx", extensions: [".jsx"] },
    typescript: { parser: "typescript", extensions: [".ts", ".mts", ".cts"] },
    tsx: { parser: "tsx", extensions: [".tsx"] },
    python: { parser: "python", extensions: [".py"] },
});
export const MAX_RESULT_BYTES = 24 * 1024;
export class SearchError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
function reject(message) {
    throw new SearchError("denied", message);
}

export function normalizeSearch(input) {
    if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => !["language", "pattern", "paths", "maxResults", "timeoutMs"].includes(key))
    ) {
        reject("Invalid structural search input.");
    }

    if (!Object.hasOwn(LANGUAGES, input.language)) {
        throw new SearchError("unsupported_language", "Choose a supported structural search language.");
    }

    if (
        typeof input.pattern !== "string" ||
        !input.pattern.trim() ||
        Buffer.byteLength(input.pattern) > 4096 ||
        input.pattern.includes("\0")
    ) {
        throw new SearchError("invalid_pattern", "Provide a nonempty pattern up to 4096 bytes.");
    }

    if (
        !Array.isArray(input.paths) ||
        !input.paths.length ||
        input.paths.length > 200 ||
        input.paths.some(
            (p) =>
                typeof p !== "string" || !LANGUAGES[input.language].extensions.includes(path.extname(p).toLowerCase()),
        ) ||
        Buffer.byteLength(JSON.stringify(input.paths)) > 6000
    ) {
        reject("Select 1–200 explicit relative files matching the language, with at most 6000 bytes of paths.");
    }

    const maxResults = input.maxResults ?? 50;
    const timeoutMs = input.timeoutMs ?? 10000;
    if (
        !Number.isInteger(maxResults) ||
        maxResults < 1 ||
        maxResults > 100 ||
        !Number.isInteger(timeoutMs) ||
        timeoutMs < 1000 ||
        timeoutMs > 30000
    ) {
        reject("Structural search limits are invalid.");
    }

    return { language: input.language, pattern: input.pattern, paths: [...input.paths], maxResults, timeoutMs };
}

export function resolveBinary(runtimeDir) {
    const platforms = {
        "win32-x64": "win32-x64-msvc",
        "darwin-arm64": "darwin-arm64",
        "darwin-x64": "darwin-x64",
        "linux-x64": "linux-x64-gnu",
    };
    const platform = platforms[`${process.platform}-${process.arch}`];
    if (!platform || (process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime)) {
        throw new SearchError("unavailable", "Structural search is unavailable on this platform.");
    }

    const directory = path.join(runtimeDir, "node_modules", "@ast-grep", `cli-${platform}`);
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
        const executable = path.join(directory, process.platform === "win32" ? "ast-grep.exe" : "ast-grep");
        if (manifest.version !== VERSION || !fs.statSync(executable).isFile()) {
            throw new Error("Wrong binary");
        }

        return executable;
    } catch {
        throw new SearchError(
            "unavailable",
            "Structural search runtime unavailable. Run specpi update --structural-search=on without acquisition skip flags.",
        );
    }
}

export function minimalEnvironment() {
    const env = {};
    // Native parser only: no loader overrides, HOME/config discovery, provider keys or shell.
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL"]) {
        if (process.env[key]) {
            env[key] = process.env[key];
        }
    }

    return env;
}

export function parseSource(executable, directory, input, bytes, signal, quota = { remaining: 2 * 1024 * 1024 }) {
    return new Promise((resolve, rejectPromise) => {
        if (signal?.aborted) {
            rejectPromise(new SearchError("cancelled", "Structural search cancelled."));

            return;
        }

        const args = [
            "run",
            "--config",
            path.join(directory, "sgconfig.yml"),
            "--lang",
            LANGUAGES[input.language].parser,
            `--pattern=${input.pattern}`,
            "--stdin",
            "--json=compact",
            "--threads",
            "1",
            "--color",
            "never",
        ];
        const child = spawn(executable, args, {
            cwd: directory,
            env: minimalEnvironment(),
            shell: false,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const output = [];
        quota.stderrRemaining ??= 8192;
        let failure;
        let killTimer;
        let finished = false;
        const fail = (error) => {
            failure ??= error;
            try {
                child.kill("SIGKILL");
            } catch {
                // The close deadline below reports unconfirmed cleanup and prevents reuse.
            }

            killTimer ??= setTimeout(() => {
                if (!finished) {
                    finished = true;
                    rejectPromise(
                        new SearchError(
                            "cleanup_failed",
                            "Parser cleanup could not be confirmed; reload after terminating the owned parser.",
                        ),
                    );
                }
            }, 1000);
        };

        const abort = () => fail(new SearchError("cancelled", "Structural search cancelled."));
        signal?.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", (chunk) => {
            quota.remaining -= chunk.length;
            if (quota.remaining < 0) {
                fail(new SearchError("partial", "Parser output limit reached; narrow the selection or pattern."));
            } else {
                output.push(chunk);
            }
        });
        child.stderr.on("data", (chunk) => {
            quota.stderrRemaining -= chunk.length;
            if (quota.stderrRemaining < 0) {
                fail(new SearchError("partial", "Parser diagnostic limit reached."));
            }
        });
        child.stdin.on("error", () => {});
        child.on("error", () => {
            failure ??= new SearchError("unavailable", "Structural parser could not start.");
        });
        child.on("close", (code) => {
            clearTimeout(killTimer);
            signal?.removeEventListener("abort", abort);
            if (finished) {
                return;
            }

            finished = true;
            if (failure) {
                rejectPromise(failure);

                return;
            }

            if (code !== 0 && code !== 1) {
                rejectPromise(new SearchError("invalid_pattern", "Parser rejected this pattern or input."));

                return;
            }

            try {
                const raw = Buffer.concat(output).toString("utf8").trim();
                const matches = raw ? JSON.parse(raw) : [];
                if (!Array.isArray(matches)) {
                    throw new Error("Malformed output");
                }

                resolve(matches);
            } catch {
                rejectPromise(new SearchError("unavailable", "Parser returned invalid structured output."));
            }
        });
        child.stdin.end(bytes);
        if (signal?.aborted) {
            abort();
        }
    });
}

function clip(text, maximum) {
    let value = String(text)
        .slice(0, maximum)
        .toWellFormed()
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ");
    while (Buffer.byteLength(value) > maximum) {
        value = value.slice(0, -1).toWellFormed();
    }

    return value;
}

export async function structuralSearch(
    input,
    { cwd, runtimeDir, signal, admit = async () => {}, parser = parseSource } = {},
) {
    const spec = normalizeSearch(input);
    await admit();
    if (signal?.aborted) {
        throw new SearchError("cancelled", "Structural search cancelled.");
    }

    const executable = resolveBinary(runtimeDir);
    const snapshot = createSnapshot(cwd, spec.paths);
    let directory;
    let preserveDirectory = false;
    const result = {
        status: "complete",
        engineVersion: VERSION,
        language: spec.language,
        captureId: crypto.randomUUID(),
        searchedFiles: 0,
        requestedFiles: spec.paths.length,
        sources: snapshot.sources.map(({ id, path: file, digest }) => ({ id, path: file, digest })),
        matches: [],
        truncated: false,
        columnEncoding: "one-based UTF-8 byte columns; end exclusive",
    };
    try {
        if (
            snapshot.sources.some((source) => source.bytes > 1024 * 1024) ||
            Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES / 2
        ) {
            reject("Source or selection metadata exceeds the search quota; narrow the selection.");
        }

        directory = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-structural-"));
        fs.writeFileSync(path.join(directory, "sgconfig.yml"), "ruleDirs: []\n", { mode: 0o600 });
        const quota = { remaining: 2 * 1024 * 1024 };
        for (const source of snapshot.sources) {
            await admit();
            const matches = await snapshot.withSourceBytes(source.id, async (bytes) => {
                const raw = await parser(executable, directory, spec, bytes, signal, quota);
                const lines = [0];
                for (let offset = 0; offset < bytes.length; offset += 1) {
                    if (bytes[offset] === 10) {
                        lines.push(offset + 1);
                    }
                }

                const position = (offset) => {
                    let low = 0;
                    let high = lines.length;
                    while (low + 1 < high) {
                        const middle = Math.floor((low + high) / 2);
                        if (lines[middle] <= offset) {
                            low = middle;
                        } else {
                            high = middle;
                        }
                    }

                    return { line: low, column: offset - lines[low] };
                };

                // CLI display columns count characters. Use original byte offsets instead.
                return raw.slice(0, spec.maxResults + 1).map((match) => {
                    const start = match.range?.byteOffset?.start;
                    const end = match.range?.byteOffset?.end;
                    if (
                        !Number.isSafeInteger(start) ||
                        !Number.isSafeInteger(end) ||
                        start < 0 ||
                        end < start ||
                        end > bytes.length ||
                        bytes.subarray(start, end).toString("utf8") !== match.text
                    ) {
                        throw new SearchError("unavailable", "Parser returned an invalid source range.");
                    }

                    return { text: match.text, range: { start: position(start), end: position(end) } };
                });
            });
            result.searchedFiles += 1;
            for (const match of matches) {
                const start = match.range?.start;
                const end = match.range?.end;
                if (
                    ![start?.line, start?.column, end?.line, end?.column].every(
                        (v) => Number.isSafeInteger(v) && v >= 0,
                    ) ||
                    typeof match.text !== "string"
                ) {
                    throw new SearchError("unavailable", "Parser returned an invalid source range.");
                }

                const entry = {
                    sourceId: source.id,
                    path: source.path,
                    start: { line: start.line + 1, byteColumn: start.column + 1 },
                    end: { line: end.line + 1, byteColumn: end.column + 1 },
                    snippet: clip(match.text, 512),
                    snippetTruncated: Buffer.byteLength(match.text) > 512,
                };
                result.matches.push(entry);
                if (
                    result.matches.length > spec.maxResults ||
                    Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES - 512
                ) {
                    result.matches.pop();
                    result.truncated = true;
                    result.status = "partial";

                    return result;
                }
            }
        }

        return result;
    } catch (error) {
        preserveDirectory = error instanceof SearchError && error.status === "cleanup_failed";
        if (error instanceof SearchError && error.status === "partial") {
            return { ...result, status: "partial", truncated: true, reason: error.message };
        }

        throw error;
    } finally {
        snapshot.destroy();
        if (directory && !preserveDirectory) {
            try {
                fs.rmSync(directory, { recursive: true, force: true });
            } catch {
                throw new SearchError(
                    "cleanup_failed",
                    "Structural scratch cleanup failed; resolve it before reloading.",
                );
            }
        }
    }
}
