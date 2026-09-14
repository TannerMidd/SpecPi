"use strict";

const { spawn: spawnProcess } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { StringDecoder } = require("node:string_decoder");

// A 20 MiB image batch becomes about 27 MiB of base64 before JSON framing.
// Keep transcript responses bounded while allowing image payloads in both directions.
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const MAX_WRITE_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 256;
const MAX_HISTORY_PREFIX_CHARS = 512;
const HISTORY_RESPONSE_PREFIX =
    /^\{"id":"(specpi-[1-9][0-9]{0,15})","type":"response","command":"(get_messages|get_entries)","success":true,"data":/u;

function abortError() {
    const error = new Error("The Pi request was cancelled.");
    error.name = "AbortError";

    return error;
}

/** A bounded JSONL transport. It never logs child output or uses a shell. */
class RpcClient extends EventEmitter {
    constructor({ command, args = [], cwd, env, spawn = spawnProcess, requestTimeout = 30_000 }) {
        super();
        this.options = { command, args: [...args], cwd, env, spawn, requestTimeout };
        this.state = "created";
        this.child = null;
        this.pending = new Map();
        this.nextId = 0;
        this.decoder = new StringDecoder("utf8");
        this.line = "";
        this.lineBytes = 0;
        this.linePrefix = "";
        this.discardHistoryId = null;
        this.diagnostics = new Set();
        this.exitEmitted = false;
        this.failure = null;
    }

    start({ signal } = {}) {
        if (this.state === "stopping" || this.state === "stopped") {
            return Promise.reject(new Error("This Pi connection has already been closed."));
        }

        if (this.startPromise) {
            return this.startPromise;
        }

        if (signal?.aborted) {
            return Promise.reject(abortError());
        }

        this.state = "starting";
        this.startPromise = new Promise((resolve, reject) => {
            this.finishStart = (error) => {
                clearTimeout(this.startTimer);
                signal?.removeEventListener("abort", onAbort);
                this.finishStart = null;
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            };

            const onAbort = () => {
                this.finishStart?.(abortError());
                void this.stop();
            };

            signal?.addEventListener("abort", onAbort, { once: true });
            this.startTimer = setTimeout(() => {
                this.fail(new Error("Pi did not start in time. Check the Pi executable setting."));
            }, 30_000);
            try {
                this.child = this.options.spawn(this.options.command, this.options.args, {
                    cwd: this.options.cwd,
                    env: this.options.env ?? process.env,
                    shell: false,
                    windowsHide: true,
                    stdio: ["pipe", "pipe", "pipe"],
                });
                this.attachChild(this.child);
            } catch {
                this.fail(new Error("Pi could not be started. Check the Pi executable and Node.js settings."));
            }
        });

        return this.startPromise;
    }

    attachChild(child) {
        child.once("spawn", () => {
            if (this.state === "starting") {
                this.state = "running";
                this.finishStart?.();
            }
        });
        child.on("error", () => {
            this.fail(new Error("The Pi process could not run. Check the Pi executable and workspace access."));
        });
        child.once("exit", (code, signal) => this.handleExit(code, signal));
        child.once("close", (code, signal) => this.handleExit(code, signal));
        child.stdin?.on("error", () => {
            this.fail(new Error("The connection to Pi closed while sending a request."));
        });
        child.stdout?.on("error", () => {
            this.fail(new Error("The connection to Pi closed while reading a response."));
        });
        child.stderr?.on("error", () => {
            this.diagnostic("Pi's diagnostic stream is unavailable.");
        });
        child.stderr?.on("data", () => {
            this.diagnostic("Pi wrote diagnostic output. Raw output is withheld to protect private information.");
        });
        child.stdout?.on("data", (chunk) => this.consume(chunk));
        child.stdout?.on("end", () => {
            if (this.state === "running" || this.state === "starting") {
                this.fail(new Error("Pi closed its response stream. Reconnect to continue."));
            }
        });
        if (!child.stdin || !child.stdout || !child.stderr) {
            this.fail(new Error("Pi could not open its communication streams."));
        }
    }

    /** OS spawn does not mean Pi has finished loading extensions or started reading RPC. */
    async waitUntilReady({ timeoutMs = 90_000, signal } = {}) {
        try {
            return await this.request("get_state", {}, { timeoutMs, signal });
        } catch (error) {
            if (error.code !== "PI_RPC_TIMEOUT") {
                throw error;
            }

            const startupError = new Error(
                "Pi did not finish starting its chat connection. A Pi extension may be waiting for a startup dialog. " +
                    "Update the SpecPi harness, check extension startup in a terminal, then reconnect. " +
                    "Installing the Chat VSIX alone does not update the harness.",
            );
            startupError.code = "PI_STARTUP_TIMEOUT";
            throw startupError;
        }
    }

    async request(type, params = {}, { timeoutMs = this.options.requestTimeout, signal } = {}) {
        if (signal?.aborted) {
            throw abortError();
        }

        if (this.state === "starting") {
            await new Promise((resolve, reject) => {
                const onAbort = () => reject(abortError());
                signal?.addEventListener("abort", onAbort, { once: true });
                this.startPromise.then(
                    () => {
                        signal?.removeEventListener("abort", onAbort);
                        resolve();
                    },
                    (error) => {
                        signal?.removeEventListener("abort", onAbort);
                        reject(error);
                    },
                );
            });
        }

        if (signal?.aborted) {
            throw abortError();
        }

        if (this.state !== "running") {
            throw this.failure ?? new Error("Pi is not connected. Connect before sending a request.");
        }

        if (
            typeof type !== "string" ||
            !type ||
            typeof params !== "object" ||
            params === null ||
            Array.isArray(params)
        ) {
            throw new Error("Invalid Pi request.");
        }

        if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
            throw new Error("Invalid Pi request timeout.");
        }

        if (this.pending.size >= MAX_PENDING_REQUESTS) {
            throw new Error("Pi has too many pending requests. Wait for the current operation to finish.");
        }

        const id = `specpi-${++this.nextId}`;

        return new Promise((resolve, reject) => {
            const entry = { type, resolve, reject, signal };
            entry.onAbort = () => this.settle(id, abortError());
            signal?.addEventListener("abort", entry.onAbort, { once: true });
            if (timeoutMs > 0) {
                entry.timer = setTimeout(() => {
                    const error = new Error(`Pi did not respond to ${type} in time.`);
                    error.code = "PI_RPC_TIMEOUT";
                    this.settle(id, error);
                }, timeoutMs);
            }

            this.pending.set(id, entry);
            this.write({ ...params, id, type }, (error) => {
                if (error) {
                    this.settle(id, error);
                }
            });
        });
    }

    /** UI dialog responses have no matching RPC response; do not await one. */
    send(response) {
        if (
            this.state !== "running" ||
            !response ||
            response.type !== "extension_ui_response" ||
            typeof response.id !== "string"
        ) {
            return false;
        }

        return this.write(response);
    }

    write(message, onError = () => {}) {
        let encoded;
        try {
            encoded = `${JSON.stringify(message)}\n`;
            if (Buffer.byteLength(encoded, "utf8") > MAX_LINE_BYTES) {
                throw new Error("oversized");
            }
        } catch {
            onError(new Error("The Pi request cannot be encoded or is too large."));

            return false;
        }

        const failWrite = () => {
            const error = new Error("The connection to Pi closed while sending a request.");
            onError(error);
            this.fail(error);
        };

        try {
            if (!this.child?.stdin?.writable || this.child.stdin.destroyed) {
                failWrite();

                return false;
            }

            if (this.child.stdin.writableLength + Buffer.byteLength(encoded, "utf8") > MAX_WRITE_BUFFER_BYTES) {
                onError(new Error("Pi's request buffer is full. Wait before sending more requests."));

                return false;
            }

            this.child.stdin.write(encoded, "utf8", (error) => {
                if (error) {
                    failWrite();
                }
            });

            return true;
        } catch {
            failWrite();

            return false;
        }
    }

    consume(chunk) {
        if (this.state !== "running" && this.state !== "starting") {
            return;
        }

        const text = this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        let offset = 0;
        while (offset < text.length) {
            const newline = text.indexOf("\n", offset);
            if (this.discardHistoryId) {
                if (newline < 0) {
                    return;
                }

                const id = this.discardHistoryId;
                this.discardHistoryId = null;
                const error = new Error(
                    "This chat's saved history exceeds the display limit. Pi remains connected; continue with the currently displayed messages or start a new chat.",
                );
                error.code = "PI_RPC_HISTORY_TOO_LARGE";
                this.settle(id, error);
                offset = newline + 1;

                continue;
            }

            const part = text.slice(offset, newline < 0 ? text.length : newline);
            if (this.linePrefix.length < MAX_HISTORY_PREFIX_CHARS) {
                this.linePrefix += part.slice(0, MAX_HISTORY_PREFIX_CHARS - this.linePrefix.length);
            }

            const partBytes = Buffer.byteLength(part, "utf8");
            if (partBytes > MAX_LINE_BYTES - this.lineBytes) {
                const match = HISTORY_RESPONSE_PREFIX.exec(this.linePrefix);
                const entry = match && this.pending.get(match[1]);
                if (!entry || entry.type !== match[2]) {
                    this.fail(new Error("Pi sent a response larger than the connection limit."));

                    return;
                }

                // Pi 0.84.4 writes this exact header order. Only a correlated,
                // successful history response can be discarded without parsing
                // its oversized body. Other oversized records remain fatal.
                this.discardHistoryId = match[1];
                this.line = "";
                this.lineBytes = 0;
                this.linePrefix = "";

                continue;
            }

            this.lineBytes += partBytes;
            this.line += part;
            if (newline < 0) {
                return;
            }

            const line = this.line.endsWith("\r") ? this.line.slice(0, -1) : this.line;
            this.line = "";
            this.lineBytes = 0;
            this.linePrefix = "";
            this.handleLine(line);
            offset = newline + 1;
        }
    }

    handleLine(line) {
        if (!line.trim()) {
            return;
        }

        let message;
        try {
            message = JSON.parse(line);
        } catch {
            this.diagnostic("Pi sent non-protocol output. Its contents were withheld.");

            return;
        }

        if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string") {
            this.diagnostic("Pi sent an invalid protocol message. Its contents were withheld.");

            return;
        }

        if (message.type !== "response") {
            this.emit("event", message);

            return;
        }

        const entry = this.pending.get(message.id);
        if (!entry) {
            return;
        }

        if (message.command !== entry.type || typeof message.success !== "boolean") {
            this.settle(message.id, new Error("Pi returned an invalid response to the request."));
        } else if (!message.success) {
            this.settle(
                message.id,
                new Error(
                    typeof message.error === "string" ? message.error.slice(0, 4096) : "Pi rejected the request.",
                ),
            );
        } else {
            this.settle(message.id, null, message.data);
        }
    }

    settle(id, error, data) {
        const entry = this.pending.get(id);
        if (!entry) {
            return;
        }

        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.signal?.removeEventListener("abort", entry.onAbort);
        if (error) {
            entry.reject(error);
        } else {
            entry.resolve(data);
        }
    }

    rejectPending(error) {
        for (const id of this.pending.keys()) {
            this.settle(id, error);
        }
    }

    diagnostic(message) {
        if (!this.diagnostics.has(message) && this.state !== "stopped") {
            this.diagnostics.add(message);
            this.emit("diagnostic", message);
        }
    }

    fail(error) {
        if (this.state === "stopping" || this.state === "stopped") {
            return;
        }

        this.failure = error;
        this.finishStart?.(error);
        this.rejectPending(error);
        this.diagnostic(error.message);
        void this.stop();
    }

    handleExit(code, signal) {
        const expected = this.state === "stopping" || this.state === "stopped";
        this.state = "stopped";
        const error = this.failure ?? new Error(expected ? "Pi disconnected." : "Pi exited. Reconnect to continue.");
        this.finishStart?.(error);
        this.rejectPending(error);
        // RPC is persistent: process exit ends the connection and invalidates pending requests.
        // Release owned pipes even if a descendant keeps an inherited handle open.
        this.releaseStreams();
        this.line = "";
        this.lineBytes = 0;
        this.linePrefix = "";
        this.discardHistoryId = null;
        this.finishStop?.();
        if (!this.exitEmitted) {
            this.exitEmitted = true;
            this.emit("exit", { code, signal });
        }
    }

    releaseStreams() {
        this.child?.stdin?.destroy();
        this.child?.stdout?.destroy();
        this.child?.stderr?.destroy();
        this.child?.unref?.();
    }

    stop() {
        if (this.stopPromise) {
            return this.stopPromise;
        }

        if (this.state === "stopped" || this.state === "created") {
            this.state = "stopped";

            return Promise.resolve();
        }

        this.state = "stopping";
        const error = this.failure ?? new Error("Pi disconnected.");
        this.finishStart?.(error);
        this.rejectPending(error);
        this.stopPromise = new Promise((resolve) => {
            let terminateTimer;
            let killTimer;
            let finishTimer;
            this.finishStop = () => {
                clearTimeout(terminateTimer);
                clearTimeout(killTimer);
                clearTimeout(finishTimer);
                this.finishStop = null;
                this.state = "stopped";
                this.releaseStreams();
                this.line = "";
                this.lineBytes = 0;
                this.linePrefix = "";
                this.discardHistoryId = null;
                resolve();
            };

            if (!this.child || this.child.exitCode != null || this.child.signalCode != null) {
                this.finishStop();

                return;
            }

            const kill = (signal) => {
                try {
                    this.child.kill(signal);
                } catch {
                    this.diagnostic("Pi could not be terminated automatically.");
                }
            };

            // EOF lets Pi dispose its runtime and running tools before forced termination.
            terminateTimer = setTimeout(() => kill("SIGTERM"), 1500);
            killTimer = setTimeout(() => kill("SIGKILL"), 2000);
            finishTimer = setTimeout(() => {
                this.finishStop?.();
            }, 2500);
            try {
                this.child.stdin?.end();
            } catch {
                kill("SIGTERM");
            }
        });

        return this.stopPromise;
    }
}

module.exports = { RpcClient };
