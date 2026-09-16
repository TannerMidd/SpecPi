// Spawns Pi in RPC mode and correlates commands with responses.
//
// Adapted from SpecPi Chat's vscode/src/rpc-client.js. The differences that
// matter here: this bridge has no editor host to fall back on, so a dead child
// process must reject every pending request rather than hang, and extension UI
// requests are surfaced as events for the approval registry rather than being
// answered inline.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { RecordDecoder, encodeRecord } from "./framing.js";

// Dialog methods block the agent until the client answers. Fire-and-forget
// methods must never be answered: replying to one desynchronises the
// sub-protocol. Both lists come from docs/rpc.md.
export const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
export const FIRE_AND_FORGET_METHODS = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);

// The commands the phone UI can reach. Anything absent is refused before it
// reaches Pi. `bash` and `abort_bash` are deliberately excluded: a remote shell
// is a far larger surface than remote approvals and the mobile UI needs none.
export const ALLOWED_COMMANDS = new Set([
    "prompt",
    "steer",
    "follow_up",
    "abort",
    "clear_queue",
    "new_session",
    "switch_session",
    "get_state",
    "get_messages",
    "get_entries",
    "set_model",
    "get_available_models",
    "set_thinking_level",
    "get_session_stats",
]);

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

export class RpcBridge extends EventEmitter {
    constructor({
        command = process.env.SPECPI_REMOTE_PI_BIN || "pi",
        args = ["--mode", "rpc"],
        cwd = process.cwd(),
        env = process.env,
        requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    } = {}) {
        super();
        this.command = command;
        this.args = args;
        this.cwd = cwd;
        this.env = env;
        this.requestTimeoutMs = requestTimeoutMs;
        this.pending = new Map();
        this.decoder = new RecordDecoder();
        this.child = null;
        this.exitReason = null;
    }

    start() {
        if (this.child) {
            return;
        }

        this.exitReason = null;
        this.child = spawn(this.command, this.args, {
            cwd: this.cwd,
            env: this.env,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        this.child.stdout.setEncoding("utf8");
        this.child.stderr.setEncoding("utf8");
        this.child.stdout.on("data", (chunk) => this.consume(chunk));
        this.child.stderr.on("data", (chunk) => this.emit("stderr", chunk));
        this.child.on("error", (error) => this.fail(`Pi failed to start: ${error.message}`));
        this.child.on("exit", (code, signal) => {
            const detail = signal ? `signal ${signal}` : `code ${code}`;
            this.fail(`Pi exited (${detail})`);
        });
    }

    consume(chunk) {
        const { records, errors } = this.decoder.push(chunk);
        for (const error of errors) {
            this.emit("protocolError", error);
        }

        for (const record of records) {
            this.dispatch(record);
        }
    }

    dispatch(record) {
        if (!record || typeof record !== "object") {
            return;
        }

        if (record.type === "response") {
            this.settle(record);

            return;
        }

        if (record.type === "extension_ui_request") {
            this.emit("uiRequest", record);

            return;
        }

        this.emit("event", record);
    }

    settle(record) {
        const entry = this.pending.get(record.id);
        if (!entry) {
            // A response with no pending request means the command timed out
            // locally. Surfacing it keeps the mismatch visible rather than
            // silently dropping agent output.
            this.emit("orphanResponse", record);

            return;
        }

        this.pending.delete(record.id);
        clearTimeout(entry.timer);
        entry.resolve(record);
    }

    fail(message) {
        this.exitReason = message;
        this.child = null;
        const { records, errors } = this.decoder.flush();
        for (const record of records) {
            this.dispatch(record);
        }

        for (const error of errors) {
            this.emit("protocolError", error);
        }

        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error(message));
        }

        this.pending.clear();
        this.emit("closed", message);
    }

    // Raw write. Used for extension_ui_response, which carries an id chosen by
    // the agent and expects no response of its own.
    write(record) {
        if (!this.child || !this.child.stdin.writable) {
            throw new Error(this.exitReason || "Pi is not running");
        }

        this.child.stdin.write(encodeRecord(record));
    }

    send(command) {
        if (!ALLOWED_COMMANDS.has(command.type)) {
            return Promise.reject(new Error(`Command not permitted over Remote: ${command.type}`));
        }

        if (!this.child) {
            return Promise.reject(new Error(this.exitReason || "Pi is not running"));
        }

        const id = command.id || randomUUID();
        const record = { ...command, id };

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Timed out waiting for ${command.type}`));
            }, this.requestTimeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.write(record);
            } catch (error) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(error);
            }
        });
    }

    async stop() {
        const child = this.child;
        if (!child) {
            return;
        }

        this.child = null;
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error("Remote daemon is shutting down"));
        }

        this.pending.clear();
        child.stdin.end();
        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                child.kill("SIGKILL");
                resolve();
            }, 2000);
            child.once("exit", () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
}
