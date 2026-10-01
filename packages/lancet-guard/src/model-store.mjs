// Where the LANCET model lives on disk, and the one-time download that puts it there.
//
// The model is not in the npm package. `/lancet-guard setup` fetches the pinned release ZIP from
// GitHub, and nothing else ever downloads it: not install, not session start, not switching the
// guard on. The ZIP is streamed to a private staging directory, capped at its expected size, and
// refused unless its SHA-256 matches model-manifest.mjs. Only then are the pinned model files
// extracted, each refused unless its own digest matches. The ZIP is deleted, and only a complete,
// verified set is renamed into place, so an interrupted or tampered download leaves the previous
// state, never a partial model.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MODEL_ARCHIVE, MODEL_FILES, MODEL_ID } from "./model-manifest.mjs";
import { extractEntries } from "./zip.mjs";

// About 109 MB; generous enough for a slow connection, bounded so a stalled one ends.
const DOWNLOAD_TIMEOUT_MS = 900_000;

export function agentDirectory(env = process.env) {
    return path.resolve(env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
}

export function modelDirectory(agentDir = agentDirectory()) {
    return path.join(agentDir, "lancet-guard", MODEL_ID);
}

/**
 * A cheap presence check for status lines: every file there, a regular file, the pinned size.
 * Loading still verifies every digest; this only answers "has setup been run".
 */
export function modelState(directory = modelDirectory()) {
    try {
        const root = fs.lstatSync(directory);
        if (!root.isDirectory()) {
            return { installed: false, problem: "model path is not a directory" };
        }
    } catch {
        return { installed: false, problem: "not downloaded" };
    }

    for (const [name, expected] of Object.entries(MODEL_FILES)) {
        try {
            const stat = fs.lstatSync(path.join(directory, name));
            if (!stat.isFile() || stat.size !== expected.bytes) {
                return { installed: false, problem: `${name} is damaged` };
            }
        } catch {
            return { installed: false, problem: `${name} is missing` };
        }
    }

    return { installed: true };
}

function verifyFile(file, expected) {
    const bytes = fs.readFileSync(file);

    return (
        bytes.length === expected.bytes && crypto.createHash("sha256").update(bytes).digest("hex") === expected.sha256
    );
}

/** True when every file is present and matches its digest. */
export function modelVerified(directory = modelDirectory()) {
    if (!modelState(directory).installed) {
        return false;
    }

    try {
        return Object.entries(MODEL_FILES).every(([name, expected]) =>
            verifyFile(path.join(directory, name), expected),
        );
    } catch {
        return false;
    }
}

async function fetchArchive(fetchImpl, target, signal) {
    const expected = MODEL_ARCHIVE;
    const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    const response = await fetchImpl(expected.url, {
        redirect: "follow",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok || !response.body) {
        throw new Error(`model download failed: HTTP ${response.status}`);
    }

    if (response.url && !response.url.startsWith("https://")) {
        throw new Error("model download was redirected off HTTPS");
    }

    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > 0 && declared !== expected.bytes) {
        throw new Error("model download is the wrong size");
    }

    const hash = crypto.createHash("sha256");
    const handle = fs.openSync(target, "wx", 0o600);
    let received = 0;
    try {
        for await (const chunk of response.body) {
            received += chunk.length;
            if (received > expected.bytes) {
                throw new Error("model download is larger than the pinned archive");
            }

            hash.update(chunk);
            fs.writeSync(handle, chunk);
        }

        fs.fsyncSync(handle);
    } finally {
        fs.closeSync(handle);
    }

    if (received !== expected.bytes || hash.digest("hex") !== expected.sha256) {
        throw new Error("model download failed its checksum; nothing was installed");
    }
}

/** Take the pinned files out of a verified archive into `directory`, checking each digest. */
function unpack(archive, directory) {
    const limits = Object.fromEntries(
        Object.entries(MODEL_FILES).map(([name, expected]) => [MODEL_ARCHIVE.prefix + name, expected.bytes]),
    );
    const entries = extractEntries(archive, limits);
    fs.mkdirSync(directory, { mode: 0o700 });
    for (const [name, expected] of Object.entries(MODEL_FILES)) {
        const bytes = entries.get(MODEL_ARCHIVE.prefix + name);
        if (crypto.createHash("sha256").update(bytes).digest("hex") !== expected.sha256) {
            throw new Error(`${name} in the model archive failed its checksum; nothing was installed`);
        }

        fs.writeFileSync(path.join(directory, name), bytes, { flag: "wx", mode: 0o600 });
    }
}

/**
 * Download, verify and install the pinned model. Idempotent: a verified model already in place is
 * left alone and reported as such.
 *
 * @param {{ agentDir?: string, fetchImpl?: typeof fetch, signal?: AbortSignal,
 *           onProgress?: (name: string) => void }} [options]
 */
export async function installModel({ agentDir = agentDirectory(), fetchImpl = fetch, signal, onProgress } = {}) {
    const directory = modelDirectory(agentDir);
    if (modelVerified(directory)) {
        return { installed: false, reason: "already-current", directory };
    }

    const parent = path.dirname(directory);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(parent).isSymbolicLink()) {
        throw new Error("The LANCET model directory's parent is a symbolic link; refusing to write through it");
    }

    const staging = fs.mkdtempSync(path.join(parent, `.${MODEL_ID}-download-`));
    const unpacked = path.join(staging, "model");
    let retired;
    try {
        onProgress?.("download");
        const archive = path.join(staging, "model.zip");
        await fetchArchive(fetchImpl, archive, signal);
        onProgress?.("verify");
        unpack(archive, unpacked);
        fs.rmSync(archive, { force: true });

        // A damaged earlier copy is moved aside rather than overwritten in place, so the rename
        // below is the only moment the model directory changes.
        if (fs.existsSync(directory)) {
            retired = `${directory}.replaced-${process.pid}-${Date.now()}`;
            fs.renameSync(directory, retired);
        }

        fs.renameSync(unpacked, directory);
    } catch (error) {
        fs.rmSync(staging, { recursive: true, force: true });
        if (retired && !fs.existsSync(directory)) {
            fs.renameSync(retired, directory);
        }

        throw error;
    }

    // Clean-up after the model is in place is best effort: a leftover staging or replaced
    // directory is harmless, and failing here would report a working install as failed.
    for (const leftover of [staging, retired]) {
        try {
            if (leftover) {
                fs.rmSync(leftover, { recursive: true, force: true });
            }
        } catch {
            // Ignored; see above.
        }
    }

    return { installed: true, reason: "downloaded", directory };
}
