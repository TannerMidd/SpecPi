// Session discovery.
//
// Pi's RPC surface has no "list sessions" command: `switch_session` takes a
// path you are expected to already have. So the catalogue is built by reading
// the agent's own sessions directory.
//
// This deliberately reads conversation content -- the first user message of
// each session, to give the list something recognisable to show, since session
// headers carry no title. That is a wider boundary than the rest of the daemon
// takes, and it is documented in SECURITY.md rather than left implicit.
//
// Reads are bounded: a preview stops at the first user message, and the record
// scan gives up after a byte budget rather than pulling a large transcript into
// memory to count its lines.

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RecordDecoder } from "./framing.js";

const PREVIEW_CHARS = 140;
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_SESSIONS = 300;

export function agentDirectory(env = process.env) {
    return env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export function sessionsRoot(env = process.env) {
    return path.join(agentDirectory(env), "sessions");
}

// Confines a client-supplied path to the sessions tree. switch_session would
// otherwise take any path the daemon can read, and "the client is already
// authenticated" is not a reason to widen what it can point the agent at.
export function isInsideSessions(candidate, env = process.env) {
    if (typeof candidate !== "string" || candidate.length === 0) {
        return false;
    }

    const root = path.resolve(sessionsRoot(env));
    const resolved = path.resolve(candidate);
    const relative = path.relative(root, resolved);

    return (
        relative.length > 0 &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative) &&
        resolved.toLowerCase().endsWith(".jsonl")
    );
}

export async function listSessions({ env = process.env, limit = MAX_SESSIONS } = {}) {
    const root = sessionsRoot(env);
    let projects = [];
    try {
        projects = await readdir(root, { withFileTypes: true });
    } catch {
        // No sessions directory yet is an empty list, not an error.
        return [];
    }

    const files = [];
    for (const entry of projects) {
        if (!entry.isDirectory()) {
            continue;
        }

        const directory = path.join(root, entry.name);
        let names = [];
        try {
            names = await readdir(directory);
        } catch {
            continue;
        }

        for (const name of names) {
            if (!name.endsWith(".jsonl")) {
                continue;
            }

            files.push({ file: path.join(directory, name), project: entry.name });
        }
    }

    const dated = [];
    for (const item of files) {
        try {
            const info = await stat(item.file);
            dated.push({ ...item, modified: info.mtimeMs, size: info.size });
        } catch {
            continue;
        }
    }

    // Newest first, then bound the work: a machine with hundreds of sessions
    // should not pay to summarise all of them.
    dated.sort((left, right) => right.modified - left.modified);
    const selected = dated.slice(0, limit);

    const sessions = [];
    for (const item of selected) {
        const summary = await summarise(item.file);
        if (!summary) {
            continue;
        }

        sessions.push({
            ...summary,
            path: item.file,
            project: summary.cwd || decodeProject(item.project),
            modified: new Date(item.modified).toISOString(),
            size: item.size,
        });
    }

    return sessions;
}

// Reads one session far enough to describe it: the header for identity, the
// first user message for a preview, and a message count that stops at the byte
// budget rather than scanning an unbounded transcript.
export async function summarise(file) {
    const decoder = new RecordDecoder();
    const result = { id: null, cwd: null, created: null, preview: "", messages: 0, partial: false };
    let scanned = 0;

    const stream = createReadStream(file, { encoding: "utf8" });
    try {
        for await (const chunk of stream) {
            scanned += Buffer.byteLength(chunk, "utf8");
            const { records } = decoder.push(chunk);
            for (const record of records) {
                apply(result, record);
            }

            if (scanned >= MAX_SCAN_BYTES) {
                result.partial = true;
                break;
            }
        }
    } catch {
        return null;
    } finally {
        stream.destroy();
    }

    if (!result.partial) {
        for (const record of decoder.flush().records) {
            apply(result, record);
        }
    }

    if (!result.id) {
        return null;
    }

    return result;
}

function apply(result, record) {
    if (!record || typeof record !== "object") {
        return;
    }

    if (record.type === "session") {
        result.id = record.id ?? result.id;
        result.cwd = record.cwd ?? result.cwd;
        result.created = record.timestamp ?? result.created;

        return;
    }

    if (record.type !== "message") {
        return;
    }

    result.messages += 1;
    if (result.preview.length === 0 && record.message?.role === "user") {
        result.preview = firstText(record.message.content).slice(0, PREVIEW_CHARS);
    }
}

function firstText(content) {
    if (typeof content === "string") {
        return content.trim();
    }

    if (!Array.isArray(content)) {
        return "";
    }

    for (const part of content) {
        if (part && part.type === "text" && typeof part.text === "string" && part.text.trim()) {
            return part.text.trim();
        }
    }

    return "";
}

// Pi slugifies the working directory into the session folder name. Recovering a
// readable path is best-effort and only used when the header has no cwd.
function decodeProject(slug) {
    if (!slug.startsWith("--")) {
        return slug;
    }

    return slug.replace(/^--/u, "").replace(/--$/u, "").replace(/-/gu, "/");
}

export { PREVIEW_CHARS, MAX_SCAN_BYTES };
