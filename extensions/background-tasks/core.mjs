import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { redactCommand } from "../command-guard/redact.mjs";

export const LIMITS = Object.freeze({
    command: 16384,
    cwd: 4096,
    label: 128,
    active: 4,
    completed: 32,
    approvals: 128,
    buffer: 262144,
    read: 65536,
    timeout: 28800,
});
const supervisor = fileURLToPath(new URL("./supervisor.mjs", import.meta.url));
const terminal = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;
export function safeText(value) {
    return String(value).replace(
        terminal,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
}

export function preview(value, limit = 320) {
    return safeText(redactCommand(value, limit));
}

export function record(value, keys) {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => !keys.includes(key))
    ) {
        throw new Error("Invalid background task input.");
    }
}

function text(value, limit, name) {
    if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value) > limit) {
        throw new Error(`Invalid or oversized ${name}.`);
    }

    return value;
}

export function shellSpec(platform = process.platform) {
    if (platform === "win32") {
        return { shell: path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"), dialect: "cmd" };
    }

    return { shell: "/bin/sh", dialect: "bash" };
}

export function normalizeStart(input, cwd) {
    record(input, ["command", "cwd", "label", "timeoutSeconds"]);
    const command = text(input.command, LIMITS.command, "command");
    const requestedCwd = text(input.cwd ?? cwd, LIMITS.cwd, "cwd");
    let resolved;
    try {
        resolved = fs.realpathSync(path.resolve(cwd, requestedCwd));
        if (!fs.statSync(resolved).isDirectory()) {
            throw new Error();
        }
    } catch {
        throw new Error("Background cwd must be an existing directory.");
    }

    text(resolved, LIMITS.cwd, "resolved cwd");
    const label = input.label === undefined ? "" : text(input.label, LIMITS.label, "label");
    const timeoutSeconds = input.timeoutSeconds ?? 1800;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > LIMITS.timeout) {
        throw new Error("timeoutSeconds must be an integer from 1 to 28800.");
    }

    return Object.freeze({ command, cwd: resolved, label, timeoutSeconds, ...shellSpec() });
}

export class OutputRing {
    constructor(capacity = LIMITS.buffer) {
        this.capacity = capacity;
        this.bytes = Buffer.alloc(0);
        this.end = 0;
        this.decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    }
    append(stream, chunk, final = false) {
        const decoded = final ? this.decoders[stream].end() : this.decoders[stream].write(chunk);
        if (!decoded) {
            return;
        }

        const next = Buffer.from(`[${stream}] ${decoded}`);
        this.end += next.length;
        if (next.length >= this.capacity) {
            this.bytes = Buffer.from(next.subarray(next.length - this.capacity));
        } else {
            this.bytes = Buffer.concat([
                this.bytes.subarray(Math.max(0, this.bytes.length + next.length - this.capacity)),
                next,
            ]);
        }

        let skip = 0;
        while (skip < this.bytes.length && (this.bytes[skip] & 0xc0) === 0x80) {
            skip += 1;
        }

        this.bytes = this.bytes.subarray(skip);
    }
    read(offset = 0) {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.end) {
            throw new Error("Invalid or future output cursor.");
        }

        const oldest = this.end - this.bytes.length;
        let start = Math.max(offset, oldest) - oldest;
        while (start < this.bytes.length && (this.bytes[start] & 0xc0) === 0x80) {
            start += 1;
        }

        let end = Math.min(this.bytes.length, start + LIMITS.read);
        while (end < this.bytes.length && end > start && (this.bytes[end] & 0xc0) === 0x80) {
            end -= 1;
        }

        return {
            output: safeText(this.bytes.subarray(start, end).toString("utf8")),
            offset: oldest + start,
            nextOffset: oldest + end,
            endOffset: this.end,
            lostBytes: oldest + start - offset,
            truncated: oldest + start > offset || end < this.bytes.length,
        };
    }
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function groupAlive(pid) {
    try {
        process.kill(-pid, 0);

        return true;
    } catch (error) {
        return error.code !== "ESRCH";
    }
}

export async function terminateOwned(task, { graceMs = 5000, observeMs = 1000 } = {}) {
    if (!task.child?.pid) {
        return true;
    }

    const pid = task.child.pid;
    if (process.platform === "win32") {
        // Never taskkill a PID after observing that the owned supervisor exited.
        if (task.rootExited) {
            return false;
        }

        const helper = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
        const ok = await new Promise((resolve) => {
            execFile(
                helper,
                ["/PID", String(pid), "/T", "/F"],
                { windowsHide: true, timeout: 5000, maxBuffer: 16384 },
                (error) => resolve(!error),
            );
        });
        const end = Date.now() + observeMs;
        while (!task.rootExited && Date.now() < end) {
            await delay(20);
        }

        return ok && task.rootExited;
    }

    // Preserve grace for a running command/tree. An observed command exit (including
    // a null exit code for a signal/failure) needs only the remaining group cleanup.
    // Keep the supervisor alive until escalation; never signal an observed-dead root.
    const commandExited = task.exitCode !== undefined;
    if (!task.rootExited) {
        try {
            process.kill(-pid, "SIGTERM");
        } catch (error) {
            if (error.code !== "ESRCH") {
                return false;
            }
        }

        if (!commandExited) {
            await delay(graceMs);
        }

        if (!task.rootExited) {
            try {
                process.kill(-pid, "SIGKILL");
            } catch (error) {
                if (error.code !== "ESRCH") {
                    return false;
                }
            }
        }
    }

    const end = Date.now() + observeMs;
    while ((!task.rootExited || groupAlive(pid)) && Date.now() < end) {
        await delay(20);
    }

    return task.rootExited && !groupAlive(pid);
}

export class TaskRunner {
    constructor({ spawnProcess = spawn, terminate = terminateOwned, startupMs = 10000 } = {}) {
        this.tasks = new Map();
        this.spawnProcess = spawnProcess;
        this.terminate = terminate;
        this.startupMs = startupMs;
        this.closed = false;
    }
    get(id) {
        if (typeof id !== "string" || !this.tasks.has(id)) {
            throw new Error("Unknown background task ID.");
        }

        return this.tasks.get(id);
    }
    summary(task) {
        return {
            id: task.id,
            label: preview(task.spec.label, LIMITS.label),
            command: preview(task.spec.command),
            status: task.status,
            elapsedMs: (task.endedAt ?? Date.now()) - task.startedAt,
            exitCode: task.exitCode ?? null,
            exitSignal: task.exitSignal ?? null,
            reason: task.reason ?? null,
            cleanup: task.cleanup,
            generation: task.generation,
        };
    }
    list() {
        return [...this.tasks.values()].map((task) => this.summary(task));
    }
    evict() {
        const completed = [...this.tasks.values()].filter((task) => task.cleanup === "confirmed");
        while (completed.length > LIMITS.completed) {
            this.tasks.delete(completed.shift().id);
        }
    }
    async start(spec, generation, signal) {
        signal?.throwIfAborted();
        if (
            this.closed ||
            [...this.tasks.values()].filter((task) => task.cleanup !== "confirmed").length >= LIMITS.active
        ) {
            throw new Error("Background admission closed or four active/unconfirmed tasks already exist.");
        }

        const task = {
            id: randomUUID(),
            spec,
            generation,
            startedAt: Date.now(),
            status: "starting",
            cleanup: "pending",
            ring: new OutputRing(),
            rootExited: false,
        };
        // Reserve synchronously before any await, including supervisor startup.
        this.tasks.set(task.id, task);
        let settle;
        const started = new Promise((resolve) => {
            settle = resolve;
        });
        const abort = () => {
            void this.stop(task.id, "start cancelled");
            settle(false);
        };

        signal?.addEventListener("abort", abort, { once: true });
        try {
            task.child = this.spawnProcess(process.execPath, [supervisor], {
                cwd: spec.cwd,
                env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
                stdio: ["ignore", "pipe", "pipe", "ipc"],
                detached: process.platform !== "win32",
                windowsHide: true,
            });
            for (const stream of ["stdout", "stderr"]) {
                task.child[stream].on("data", (chunk) => task.ring.append(stream, chunk));
                task.child[stream].once("end", () => task.ring.append(stream, undefined, true));
                task.child[stream].on("error", () => {});
            }

            task.child.once("error", () => {
                task.failed = true;
                task.rootExited = true;
                settle(false);
                void this.stop(task.id, "spawn failed");
            });
            task.child.once("exit", () => {
                task.rootExited = true;
                settle(false);
                if (!task.stopping) {
                    void this.stop(task.id, "supervisor exited unexpectedly");
                }
            });
            task.child.on("message", (message) => {
                if (message?.event === "ready" && task.status === "starting") {
                    const args =
                        process.platform === "win32" ? ["/d", "/s", "/c", `"${spec.command}"`] : ["-c", spec.command];
                    task.child.send({ operation: "start", shell: spec.shell, args, cwd: spec.cwd }, (error) => {
                        if (error) {
                            settle(false);
                            void this.stop(task.id, "startup failed");
                        }
                    });
                } else if (message?.event === "started") {
                    if (task.status === "starting") {
                        task.status = "running";
                    }

                    settle(true);
                } else if (message?.event === "exited" || message?.event === "failed") {
                    task.exitCode = Number.isInteger(message.code) ? message.code : null;
                    task.exitSignal = typeof message.signal === "string" ? message.signal.slice(0, 32) : null;
                    task.failed = message.event === "failed";
                    settle(!task.failed);
                    void this.stop(task.id, task.failed ? "command spawn failed" : "command exited");
                }
            });
            task.timer = setTimeout(() => {
                void this.stop(task.id, "timeout");
            }, spec.timeoutSeconds * 1000);
            const startupTimer = setTimeout(() => settle(false), this.startupMs);
            const success = await started;
            clearTimeout(startupTimer);
            if (!success || signal?.aborted || this.closed) {
                await this.stop(task.id, signal?.aborted ? "start cancelled" : "startup failed");
            }

            return this.summary(task);
        } catch {
            task.failed = true;
            await this.stop(task.id, "spawn failed");

            return this.summary(task);
        } finally {
            signal?.removeEventListener("abort", abort);
        }
    }
    async stop(id, reason = "stop requested") {
        const task = this.get(id);
        if (task.cleanup === "confirmed") {
            return this.summary(task);
        }

        if (task.stopping) {
            return task.stopping;
        }

        task.status = "stopping";
        task.reason ??= reason;
        clearTimeout(task.timer);
        task.stopping = (async () => {
            let confirmed = false;
            try {
                confirmed = await this.terminate(task);
            } catch {
                // Failure is evidence of uncertainty, never evidence of death.
            }

            task.cleanup = confirmed ? "confirmed" : "unconfirmed";
            task.status = !confirmed
                ? "cleanup-unconfirmed"
                : task.failed
                  ? "failed"
                  : task.reason === "command exited"
                    ? "exited"
                    : "killed";
            if (confirmed) {
                task.endedAt = Date.now();
                task.child?.stdout?.destroy();
                task.child?.stderr?.destroy();
                if (task.child?.connected) {
                    task.child.disconnect();
                }
            }

            this.evict();

            return this.summary(task);
        })();
        const result = await task.stopping;
        task.stopping = undefined;

        return result;
    }
    async shutdown() {
        this.closed = true;

        return Promise.all([...this.tasks.keys()].map((id) => this.stop(id, "session cleanup")));
    }
}
