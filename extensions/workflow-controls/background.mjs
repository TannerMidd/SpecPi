// Background jobs: start a long command, keep talking, hear back when it ends.
//
// A long eval or build run through `bash` holds the whole conversation until it returns; the person
// at the keyboard cannot say anything to the agent in the meantime. A background job returns at once
// and reports its exit code and last lines of output as a follow-up message when it finishes.
//
// It is deliberately small, and it never widens what may run:
//
// - One tool, and it only starts jobs. Its `command` is registered with the permission system as a
//   shell argument (`shellTools`), so every `bash` rule applies to it at full parity. A job may not
//   start unless that mapping is in effect.
// - The Jev command guard gates `bash` alone. While it is on, background jobs are off, so a guard
//   user never loses coverage. Only its saved state is visible to another extension; see
//   guardEnabled.
// - Interactive sessions only. A headless run has nobody to report back to.
// - Jobs belong to the session: they are stopped, and their logs deleted, when it ends.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const BACKGROUND_TOOL = "background";
export const BACKGROUND_MESSAGE = "specpi-background";
export const BACKGROUND_STATUS = "specpi-background";

/** The `shellTools` entry that makes the permission system gate `command` exactly like `bash`. */
export const SHELL_TOOL_MAPPING = Object.freeze({ commandArgument: "command" });

export const MAX_RUNNING_JOBS = 4;
export const MAX_LOG_BYTES = 8 * 1024 * 1024;
const TAIL_BUFFER_BYTES = 64 * 1024;
const TAIL_LINES = 40;
const TAIL_CHARS = 4000;
const COMMAND_PREVIEW_CHARS = 200;
const STALE_LOG_MS = 24 * 60 * 60 * 1000;

export function agentDirectory() {
    const configured = process.env.PI_CODING_AGENT_DIR;

    return path.resolve(configured && configured.length > 0 ? configured : path.join(os.homedir(), ".pi", "agent"));
}

export function logRoot(agentDir = agentDirectory()) {
    return path.join(agentDir, "specpi", "background");
}

/** A fresh log directory for one session's jobs. */
export function sessionLogDir(agentDir = agentDirectory()) {
    return path.join(logRoot(agentDir), `${process.pid}-${randomUUID().slice(0, 8)}`);
}

/**
 * Remove log directories a crashed session left behind. A session deletes its own on exit, so
 * anything older than a day belongs to a process that never got the chance.
 */
export function pruneStaleLogs({ root = logRoot(), maxAgeMs = STALE_LOG_MS, now = Date.now() } = {}) {
    let removed = 0;
    let entries = [];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return removed;
    }

    for (const entry of entries) {
        if (!entry.isDirectory() || !/^\d+-[0-9a-f]{8}$/u.test(entry.name)) {
            continue;
        }

        const dir = path.join(root, entry.name);
        try {
            if (now - fs.statSync(dir).mtimeMs > maxAgeMs) {
                fs.rmSync(dir, { recursive: true, force: true });
                removed += 1;
            }
        } catch {
            // Held open or already gone; the next session tries again.
        }
    }

    return removed;
}

// ---------------------------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------------------------

/**
 * Parse JSON that may carry `//` and `/* *\/` comments, as the permission system's config does.
 * Comments inside strings are left alone. Returns undefined for a missing file and throws for an
 * unreadable one, so a caller can tell "nothing configured" from "cannot verify".
 */
export function readJsonc(file) {
    if (!fs.existsSync(file)) {
        return undefined;
    }

    const text = fs.readFileSync(file, "utf8");
    let out = "";
    let inString = false;
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];
        if (inString) {
            out += char;
            if (char === "\\") {
                out += next ?? "";
                index += 1;
            } else if (char === '"') {
                inString = false;
            }
        } else if (char === '"') {
            inString = true;
            out += char;
        } else if (char === "/" && next === "/") {
            while (index < text.length && text[index] !== "\n") {
                index += 1;
            }

            out += "\n";
        } else if (char === "/" && next === "*") {
            const end = text.indexOf("*/", index + 2);
            index = end === -1 ? text.length : end + 1;
        } else {
            out += char;
        }
    }

    const value = JSON.parse(out);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${file} is not a JSON object`);
    }

    return value;
}

/**
 * The guard's saved state, resolved the way the guard resolves it: its own default is on, the
 * global file overrides that, and a trusted project's file overrides the global one.
 *
 * The guard also keeps a session-only switch in memory, and no other extension can read it. So a
 * guard switched on with `/jev-guard on` (without `--global`) is invisible here; that is disclosed
 * rather than guessed at. Saved state is what `/jev-guard on --global`, `setup` and SpecPi's own
 * installer write.
 */
export function guardEnabled({ home = os.homedir(), cwd, trusted = false } = {}) {
    let enabled = true;
    let source = "default";
    const files = [["global", path.join(home, ".pi", "jev-guard.json")]];
    if (trusted && cwd) {
        files.push(["project", path.join(cwd, ".pi", "jev-guard.json")]);
    }

    for (const [scope, file] of files) {
        let value;
        try {
            // Parsed exactly as the guard parses it: a byte-order mark stripped, then strict JSON. A
            // file it cannot parse is absent to it, so its default -- on -- applies; reading one with
            // comments more leniently here would see "off" where the guard sees "on".
            value = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, "")) : undefined;
        } catch {
            value = undefined;
        }

        if (typeof value?.enabled === "boolean") {
            enabled = value.enabled;
            source = scope;
        }
    }

    return { enabled, source };
}

export function permissionConfigPaths({ agentDir, cwd }) {
    return {
        global: path.join(agentDir, "extensions", "pi-permission-system", "config.json"),
        project: cwd ? path.join(cwd, ".pi", "extensions", "pi-permission-system", "config.json") : undefined,
    };
}

/**
 * The `shellTools` mapping the permission system will actually apply to this tool: global, then a
 * trusted project's entry, which replaces it wholesale on a key collision. A trusted repository could
 * point the mapping at another argument, which would leave `command` ungated, so the effective entry
 * is what gets checked, not the one SpecPi wrote.
 */
export function effectiveShellMapping({ agentDir, cwd, trusted = false }) {
    const paths = permissionConfigPaths({ agentDir, cwd });
    let mapping;
    for (const file of trusted ? [paths.global, paths.project] : [paths.global]) {
        const config = readJsonc(file);
        const entry = config?.shellTools?.[BACKGROUND_TOOL];
        if (entry !== undefined) {
            mapping = entry;
        }
    }

    return mapping;
}

export function mappingGatesCommand(mapping) {
    return (
        Boolean(mapping) &&
        typeof mapping === "object" &&
        mapping.commandArgument === SHELL_TOOL_MAPPING.commandArgument &&
        (mapping.workdirArgument === undefined || typeof mapping.workdirArgument === "string")
    );
}

/**
 * Whether a job may start, and if not, a sentence the model and the human can act on. Every
 * condition fails closed: an unreadable config or an unknown guard state refuses.
 */
export function admission({
    interactive,
    commandsKnown = true,
    guardInstalled,
    guard,
    permissionInstalled,
    mapping,
    mappingError,
    running,
}) {
    if (interactive !== true) {
        return {
            ok: false,
            reason: "Background jobs need an interactive session to report back to. Run the command with bash.",
        };
    }

    if (commandsKnown !== true) {
        return {
            ok: false,
            reason: "Background jobs are off because this Pi cannot list its commands, so SpecPi cannot tell whether the command guard or the permission system is installed. Run the command with bash.",
        };
    }

    if (guardInstalled && guard?.enabled !== false) {
        return {
            ok: false,
            reason: "The Jev command guard is on, and it only checks bash, so background jobs are off while it is. Run the command with bash, or switch the guard off with /jev-guard off --global.",
        };
    }

    if (permissionInstalled) {
        if (mappingError) {
            return {
                ok: false,
                reason: `Background jobs are off because the permission system's config could not be read to confirm bash rules apply: ${mappingError}`,
            };
        }

        if (!mappingGatesCommand(mapping)) {
            return {
                ok: false,
                reason: 'Background jobs are off because the permission system does not yet apply bash rules to them. Run `specpi update`, or add "shellTools": { "background": { "commandArgument": "command" } } to its global config.',
            };
        }
    }

    if (Number.isInteger(running) && running >= MAX_RUNNING_JOBS) {
        return {
            ok: false,
            reason: `${MAX_RUNNING_JOBS} background jobs are already running. Wait for one to finish, or ask the user to stop one with /jobs stop <id>.`,
        };
    }

    return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Steering long bash calls
// ---------------------------------------------------------------------------------------------

/** A bash call asking for a timeout above this is a long run; it belongs in a background job. */
export const LONG_BASH_TIMEOUT_SECONDS = 600;

const LOOP = /\b(?:for|while|until)\b[\s\S]*\bdo\b/u;
const SLEEPS = /\bsleep\s+(\d+(?:\.\d+)?)([smh]?)\b/gu;
const WATCHERS = /\bgh\s+run\s+watch\b|\bgh\s+pr\s+checks\b[^\n]*--watch\b|\btail\s+-[a-zA-Z]*f\b|\bwatch\s+-n\b/u;

function seconds(value, unit) {
    const number = Number(value);

    return unit === "h" ? number * 3600 : unit === "m" ? number * 60 : number;
}

/**
 * Whether a bash call would plainly hold the conversation while it waits, and if so why. Only the
 * unambiguous shapes: a polling loop that sleeps, a single long sleep, a watch command, or a timeout
 * the caller itself expects to be long. A long build that happens to take minutes is not guessable
 * from its text and is left to the guidance. Returns undefined when the call is fine.
 */
export function blockingShellCall(input) {
    const command = typeof input?.command === "string" ? input.command : "";
    const timeout = Number(input?.timeout);
    if (Number.isFinite(timeout) && timeout > LONG_BASH_TIMEOUT_SECONDS) {
        return `it asks for a ${Math.round(timeout)}-second timeout`;
    }

    const sleeps = [...command.matchAll(SLEEPS)].map((match) => seconds(match[1], match[2]));
    if (LOOP.test(command) && sleeps.some((value) => value >= 10)) {
        return "it polls in a loop that sleeps between checks";
    }

    if (sleeps.some((value) => value >= 60)) {
        return "it sleeps for a minute or more";
    }

    if (WATCHERS.test(command)) {
        return "it watches something until it finishes";
    }

    return undefined;
}

export function blockingShellReason(why) {
    return `Not run: this bash call would block the conversation because ${why}, and the user cannot talk to you until it returns. Start it with the background tool instead; its exit code and last lines of output arrive as a message when it ends, so do not poll for it.`;
}

// ---------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------

function sanitize(text) {
    // Keep tab, newline and carriage return; drop other control characters and bidi overrides.
    return String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, "");
}

export function tailOf(text, { lines = TAIL_LINES, chars = TAIL_CHARS } = {}) {
    const kept = sanitize(text).replace(/\r\n?/gu, "\n").replace(/\n+$/u, "").split("\n").slice(-lines).join("\n");

    return kept.length > chars ? kept.slice(-chars) : kept;
}

export function formatDuration(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }

    return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

function preview(command) {
    const single = sanitize(command).replace(/\s+/gu, " ").trim();

    return single.length > COMMAND_PREVIEW_CHARS ? `${single.slice(0, COMMAND_PREVIEW_CHARS - 1)}…` : single;
}

/**
 * Run and track a session's jobs.
 *
 * `run(command, cwd, { onData, signal })` resolves `{ exitCode }` when the process ends and rejects
 * when it is aborted; it is Pi's own local bash runner in production, so shell selection, process
 * trees and cleanup on Pi's exit match the `bash` tool. `report(job)` is called once per job with its
 * final state.
 */
export function createJobManager({ run, logDir, report, now = () => Date.now() }) {
    const jobs = new Map();
    let nextId = 1;
    let closed = false;

    const running = () => [...jobs.values()].filter((job) => job.state === "running");

    function start({ command, cwd, label }) {
        if (closed) {
            throw new Error("This session has ended");
        }

        fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
        const id = String(nextId);
        nextId += 1;
        const logPath = path.join(logDir, `job-${id}.log`);
        const log = fs.openSync(logPath, "w", 0o600);
        const controller = new AbortController();
        const job = {
            id,
            label: typeof label === "string" && label.trim() ? preview(label).slice(0, 80) : undefined,
            command: preview(command),
            cwd,
            logPath,
            startedAt: now(),
            state: "running",
            exitCode: undefined,
            endedAt: undefined,
            bytes: 0,
            truncated: false,
            tail: "",
            controller,
            stoppedBy: undefined,
        };
        jobs.set(id, job);

        const onData = (chunk) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            const text = buffer.toString("utf8");
            job.tail = (job.tail + text).slice(-TAIL_BUFFER_BYTES);
            if (job.bytes < MAX_LOG_BYTES) {
                const room = MAX_LOG_BYTES - job.bytes;
                const slice = buffer.length > room ? buffer.subarray(0, room) : buffer;
                try {
                    fs.writeSync(log, slice);
                } catch {
                    // A full disk must not take the job down with it; the tail is still kept.
                }

                job.bytes += slice.length;
                if (buffer.length > room && !job.truncated) {
                    job.truncated = true;
                    try {
                        fs.writeSync(log, `\n[SpecPi: log capped at ${MAX_LOG_BYTES} bytes; the job keeps running]\n`);
                    } catch {
                        // As above.
                    }
                }
            }
        };

        const finish = (state, exitCode) => {
            if (job.state !== "running") {
                return;
            }

            job.state = state;
            job.exitCode = exitCode;
            job.endedAt = now();
            try {
                fs.closeSync(log);
            } catch {
                // Already closed.
            }

            if (!closed) {
                report(job);
            }
        };

        Promise.resolve()
            .then(() => run(command, cwd, { onData, signal: controller.signal }))
            .then(
                (result) => finish("exited", Number.isInteger(result?.exitCode) ? result.exitCode : null),
                (error) => {
                    job.error = error?.message;
                    finish(controller.signal.aborted ? "stopped" : "failed", undefined);
                },
            );

        return job;
    }

    function stop(id, by = "user") {
        const job = jobs.get(String(id));
        if (!job || job.state !== "running") {
            return false;
        }

        job.stoppedBy = by;
        job.controller.abort();

        return true;
    }

    /** End every job and delete this session's logs. Nothing is reported after this. */
    function close() {
        closed = true;
        for (const job of running()) {
            job.stoppedBy = "session-end";
            job.controller.abort();
        }

        try {
            fs.rmSync(logDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {
            // A log still held open by a dying process is removed with the OS temp cleanup instead.
        }
    }

    return {
        start,
        stop,
        close,
        get: (id) => jobs.get(String(id)),
        list: () => [...jobs.values()],
        running: () => running().length,
    };
}

/** The follow-up the agent and the human both see when a job ends. */
export function completionText(job, now = Date.now()) {
    const name = job.label ? `${job.id} (${job.label})` : job.id;
    const took = formatDuration((job.endedAt ?? now) - job.startedAt);
    const outcome =
        job.state === "exited"
            ? `finished with exit code ${job.exitCode ?? "unknown"}`
            : job.state === "stopped"
              ? `was stopped${job.stoppedBy === "user" ? " by the user" : ""}`
              : `could not run${job.error ? `: ${sanitize(job.error).slice(0, 200)}` : ""}`;
    const tail = tailOf(job.tail);

    return [
        `Background job ${name} ${outcome} after ${took}.`,
        `Command: ${job.command}`,
        tail ? `Last lines of output:\n\`\`\`\n${tail.replace(/```/gu, "``\u200b`")}\n\`\`\`` : "It printed nothing.",
        `Full log (deleted when this session ends): ${job.logPath}${job.truncated ? " (capped)" : ""}`,
    ].join("\n");
}

export function startedText(job) {
    return [
        `Started background job ${job.id}${job.label ? ` (${job.label})` : ""}. It keeps running while you and the user carry on.`,
        "When it ends you will receive its exit code and last lines of output as a message, so do not wait for it or poll it.",
        `Its output is written to ${job.logPath} if you need to look before then. The user can list or stop jobs with /jobs.`,
    ].join(" ");
}

export function statusText(jobs) {
    const count = jobs.filter((job) => job.state === "running").length;

    return count > 0 ? `${count} background job${count === 1 ? "" : "s"} running` : undefined;
}

export function listText(jobs, now = Date.now()) {
    if (jobs.length === 0) {
        return "No background jobs in this session.";
    }

    return jobs
        .map((job) => {
            const took = formatDuration((job.endedAt ?? now) - job.startedAt);
            const state =
                job.state === "running"
                    ? `running ${took}`
                    : job.state === "exited"
                      ? `exit ${job.exitCode ?? "?"} after ${took}`
                      : `${job.state} after ${took}`;

            return `${job.id}  ${state}  ${job.label ?? job.command}`;
        })
        .join("\n");
}
