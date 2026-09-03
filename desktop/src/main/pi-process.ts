import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rpcRecordSchema } from "../shared/schemas";
import type {
    ExtensionUiRequest,
    ExtensionUiResponse,
    RpcCommand,
    RpcRecord,
    RuntimeEvent,
    RuntimeSnapshot,
    RuntimeStatus,
    StartRuntimeOptions,
} from "../shared/rpc";
import { DiagnosticBuffer } from "./diagnostics";
import { JsonlDecoder } from "./jsonl";
import { assertSupportedPi, compatibilityWarning, probePi, resolvePiLaunch, type PiLaunch } from "./runtime-discovery";

const NONBLOCKING_UI = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);
const REQUEST_TIMEOUT = 120_000;
const MAX_PENDING_REQUESTS = 256;
const SESSION_REPLACEMENTS = new Set(["new_session", "switch_session", "fork", "clone"]);

interface PendingRequest {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
}

interface UiWaiter {
    resolve(): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
}

export class PiProcess extends EventEmitter {
    #child?: ChildProcessWithoutNullStreams;
    #launch?: PiLaunch;
    #generation = 0;
    #status: RuntimeStatus = { generation: 0, phase: "stopped" };
    readonly #pending = new Map<string, PendingRequest>();
    readonly #pendingUi = new Map<string, ExtensionUiRequest>();
    readonly #uiWaiters = new Set<UiWaiter>();
    readonly #diagnostics = new DiagnosticBuffer();
    #stopping = false;

    snapshot(): RuntimeSnapshot {
        return { status: { ...this.#status }, pendingUi: [...this.#pendingUi.values()].map((item) => ({ ...item })) };
    }

    diagnostics(): readonly string[] {
        return this.#diagnostics.entries();
    }

    async start(options: StartRuntimeOptions): Promise<RuntimeStatus> {
        await this.stop();
        this.#generation += 1;
        this.#setStatus({ generation: this.#generation, phase: "starting", cwd: options.cwd });

        try {
            this.#launch = await resolvePiLaunch(options.piPath);
            const version = await probePi(this.#launch);
            assertSupportedPi(version);
            const args = [...this.#launch.argsPrefix, "--mode", "rpc"];
            if (options.noSession) {
                args.push("--no-session");
            } else if (options.sessionPath) {
                args.push("--session", options.sessionPath);
            }

            if (options.trust === "approve") {
                args.push("--approve");
            } else if (options.trust === "deny") {
                args.push("--no-approve");
            }

            if (options.offline) {
                args.push("--offline");
            }

            const decoder = new JsonlDecoder();
            this.#stopping = false;
            const child = spawn(this.#launch.executable, args, {
                cwd: options.cwd,
                env: this.#launch.environment,
                shell: false,
                detached: process.platform !== "win32",
                windowsHide: true,
                stdio: ["pipe", "pipe", "pipe"],
            });
            this.#child = child;
            child.stdout.on("data", (chunk: Buffer) => {
                try {
                    for (const line of decoder.push(chunk)) {
                        this.#handleLine(line);
                    }
                } catch (error) {
                    this.#fail(error);
                }
            });
            child.stdout.on("end", () => {
                try {
                    for (const line of decoder.end()) {
                        this.#handleLine(line);
                    }
                } catch (error) {
                    this.#fail(error);
                }
            });
            child.stderr.on("data", (chunk: Buffer) => this.#diagnostics.append(chunk.toString("utf8")));
            child.once("error", (error) => this.#fail(error));
            child.once("exit", (code, signal) => this.#handleExit(code, signal));
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("Timed out starting Pi")), 10_000);
                child.once("spawn", () => {
                    clearTimeout(timer);
                    resolve();
                });
                child.once("error", (error) => {
                    clearTimeout(timer);
                    reject(error);
                });
            });
            await this.#startupBarrier();
            if (!this.#child) {
                throw new Error("Pi exited during startup");
            }

            this.#setStatus({
                generation: this.#generation,
                phase: this.#pendingUi.size > 0 ? "waiting-for-user" : "idle",
                piPath: this.#launch.displayPath,
                piVersion: version,
                cwd: options.cwd,
                compatibilityWarning: compatibilityWarning(version),
            });

            return { ...this.#status };
        } catch (error) {
            this.#fail(error);
            throw error;
        }
    }

    async stop(): Promise<void> {
        const child = this.#child;
        if (!child) {
            return;
        }

        this.#stopping = true;
        this.#child = undefined;
        this.#rejectPending(new Error("Pi runtime stopped"));
        this.#rejectUiWaiters(new Error("Pi runtime stopped"));
        this.#pendingUi.clear();
        await terminateProcessTree(child);
        this.#setStatus({ generation: this.#generation, phase: "stopped" });
    }

    async request(command: RpcCommand): Promise<unknown> {
        await this.#waitForUi();
        if (!this.#child || this.#child.killed) {
            throw new Error("Pi runtime is not running");
        }

        if (this.#pending.size >= MAX_PENDING_REQUESTS) {
            throw new Error("Pi RPC pending-request limit reached");
        }

        const id = command.id || randomUUID();
        const outgoing = { ...command, id };

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new Error(`Pi request timed out: ${command.type}`));
            }, REQUEST_TIMEOUT);
            this.#pending.set(id, { resolve, reject, timer });
            this.#write(outgoing).catch((error) => {
                const pending = this.#pending.get(id);
                if (pending) {
                    clearTimeout(pending.timer);
                    this.#pending.delete(id);
                    pending.reject(error);
                }
            });
        });
    }

    async respond(response: ExtensionUiResponse): Promise<void> {
        if (!this.#pendingUi.has(response.id)) {
            throw new Error("Extension UI request is no longer pending");
        }

        await this.#write(response);
        this.#pendingUi.delete(response.id);
        if (this.#pendingUi.size === 0 && this.#status.phase === "waiting-for-user") {
            this.#setStatus({ ...this.#status, phase: "idle" });
            setTimeout(() => this.#resolveUiWaitersIfClear(), 75);
        }
    }

    async #startupBarrier(): Promise<void> {
        if (this.#pendingUi.size > 0) {
            return;
        }

        await new Promise<void>((resolve) => {
            const done = () => {
                clearTimeout(timer);
                this.removeListener("blocking-ui", done);
                resolve();
            };

            const timer = setTimeout(done, 750);
            this.once("blocking-ui", done);
        });
    }

    async #waitForUi(): Promise<void> {
        if (this.#pendingUi.size === 0) {
            return;
        }

        await new Promise<void>((resolve, reject) => {
            const waiter: UiWaiter = {
                resolve,
                reject,
                timer: setTimeout(() => {
                    this.#uiWaiters.delete(waiter);
                    reject(new Error("Timed out waiting for extension input"));
                }, REQUEST_TIMEOUT),
            };
            this.#uiWaiters.add(waiter);
        });
    }

    #resolveUiWaitersIfClear(): void {
        if (this.#pendingUi.size > 0) {
            return;
        }

        for (const waiter of this.#uiWaiters) {
            clearTimeout(waiter.timer);
            waiter.resolve();
        }

        this.#uiWaiters.clear();
    }

    #rejectUiWaiters(error: Error): void {
        for (const waiter of this.#uiWaiters) {
            clearTimeout(waiter.timer);
            waiter.reject(error);
        }

        this.#uiWaiters.clear();
    }

    async #write(record: object): Promise<void> {
        const child = this.#child;
        if (!child || child.stdin.destroyed) {
            throw new Error("Pi RPC input is unavailable");
        }

        const line = `${JSON.stringify(record)}\n`;
        if (Buffer.byteLength(line) > 4 * 1024 * 1024) {
            throw new Error("Pi RPC command exceeded the size limit");
        }

        await new Promise<void>((resolve, reject) => {
            child.stdin.write(line, "utf8", (error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }

    #handleLine(line: string): void {
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            throw new Error("Pi emitted malformed JSON");
        }

        const result = rpcRecordSchema.safeParse(parsed);
        if (!result.success) {
            throw new Error("Pi emitted an invalid RPC record");
        }

        const record = result.data as RpcRecord;
        if (record.type === "response" && typeof record.id === "string") {
            const pending = this.#pending.get(record.id);
            if (pending) {
                clearTimeout(pending.timer);
                this.#pending.delete(record.id);
                if (record.success === false) {
                    pending.reject(new Error(typeof record.error === "string" ? record.error : "Pi command failed"));
                } else {
                    if (typeof record.command === "string" && SESSION_REPLACEMENTS.has(record.command)) {
                        this.#generation += 1;
                        this.#pendingUi.clear();
                        this.#setStatus({ ...this.#status, generation: this.#generation, phase: "idle" });
                    }

                    pending.resolve(record.data);
                }
            }
        }

        if (record.type === "extension_ui_request" && typeof record.id === "string") {
            const request = record as ExtensionUiRequest;
            if (!NONBLOCKING_UI.has(request.method)) {
                this.#pendingUi.set(request.id, request);
                this.#setStatus({ ...this.#status, phase: "waiting-for-user" });
                this.emit("blocking-ui");
            }
        }

        this.#applyPhase(record);
        const event: RuntimeEvent = { generation: this.#generation, record };
        this.emit("event", event);
    }

    #applyPhase(record: RpcRecord): void {
        const phases: Record<string, RuntimeStatus["phase"]> = {
            agent_start: "streaming",
            agent_settled: "idle",
            compaction_start: "compacting",
            compaction_end: "idle",
            auto_compaction_start: "compacting",
            auto_compaction_end: "idle",
            auto_retry_start: "retrying",
            auto_retry_end: "streaming",
        };
        const phase = phases[record.type];
        if (phase && !(this.#pendingUi.size > 0 && phase === "idle")) {
            this.#setStatus({ ...this.#status, phase });
        }
    }

    #handleExit(code: number | null, signal: NodeJS.Signals | null): void {
        if (this.#child?.pid) {
            this.#child = undefined;
        }

        this.#rejectPending(new Error(`Pi exited (${signal ?? code ?? "unknown"})`));
        this.#rejectUiWaiters(new Error(`Pi exited (${signal ?? code ?? "unknown"})`));
        this.#pendingUi.clear();
        if (!this.#stopping) {
            this.#setStatus({
                ...this.#status,
                phase: "failed",
                error: `Pi exited unexpectedly (${signal ?? code ?? "unknown"})`,
            });
        }
    }

    #fail(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        this.#diagnostics.append(message);
        this.#setStatus({ ...this.#status, phase: "failed", error: message });
        this.#rejectPending(new Error(message));
        this.#rejectUiWaiters(new Error(message));
        if (this.#child) {
            void terminateProcessTree(this.#child);
            this.#child = undefined;
        }
    }

    #rejectPending(error: Error): void {
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }

        this.#pending.clear();
    }

    #setStatus(status: RuntimeStatus): void {
        this.#status = status;
        this.emit("status", { ...status });
    }
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (!child.pid || child.exitCode !== null) {
        return;
    }

    if (process.platform === "win32") {
        await new Promise<void>((resolve) => {
            const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
                shell: false,
                windowsHide: true,
                stdio: "ignore",
            });
            killer.once("error", () => {
                child.kill("SIGKILL");
                resolve();
            });
            killer.once("exit", () => resolve());
        });

        return;
    }

    try {
        process.kill(-child.pid, "SIGTERM");
    } catch {
        child.kill("SIGTERM");
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    if (child.exitCode === null) {
        try {
            process.kill(-child.pid, "SIGKILL");
        } catch {
            child.kill("SIGKILL");
        }
    }
}
