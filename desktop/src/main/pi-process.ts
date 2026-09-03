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
const MAX_RPC_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_BULK_RESPONSE_BYTES = 64 * 1024 * 1024;
const BULK_RESPONSE_COMMANDS = new Set([
    "get_entries",
    "get_fork_messages",
    "get_last_assistant_text",
    "get_messages",
    "get_tree",
]);
const SESSION_REPLACEMENTS = new Set(["new_session", "switch_session", "fork", "clone"]);

interface PendingRequest {
    command: string;
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
}

interface UiWaiter {
    resolve(): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
}

interface RecentGuardResponse {
    fingerprint: string;
    response: ExtensionUiResponse;
    generation: number;
    answeredAt: number;
}

function desktopGuardStartupResponse(request: ExtensionUiRequest): ExtensionUiResponse | undefined {
    const title = String(request.title ?? "");
    if (request.method === "select" && title === "SpecPi command guard") {
        const options = Array.isArray(request.options)
            ? request.options.filter((option): option is string => typeof option === "string")
            : [];
        if (options.includes("Off for this session")) {
            return { type: "extension_ui_response", id: request.id, value: "Off for this session" };
        }
    }

    if (request.method === "confirm" && title === "Turn command guard off for this session?") {
        return { type: "extension_ui_response", id: request.id, confirmed: true };
    }

    return undefined;
}

function isLegacyGuardStartupNotice(request: ExtensionUiRequest): boolean {
    return (
        request.method === "notify" &&
        String(request.message ?? "") === "Command guard is off for this session; this is not a sandbox."
    );
}

function guardPromptFingerprint(request: ExtensionUiRequest): string | undefined {
    if (request.method !== "select" || !/command guard/iu.test(String(request.title ?? ""))) {
        return undefined;
    }

    const options = Array.isArray(request.options)
        ? request.options.filter((option): option is string => typeof option === "string")
        : [];

    return JSON.stringify([request.method, request.title, options]);
}

export class PiProcess extends EventEmitter {
    #child?: ChildProcessWithoutNullStreams;
    #launch?: PiLaunch;
    #generation = 0;
    #status: RuntimeStatus = { generation: 0, phase: "stopped" };
    readonly #pending = new Map<string, PendingRequest>();
    readonly #pendingUi = new Map<string, ExtensionUiRequest>();
    readonly #uiAliases = new Map<string, Set<string>>();
    readonly #uiWaiters = new Set<UiWaiter>();
    readonly #diagnostics = new DiagnosticBuffer();
    #recentGuardResponse?: RecentGuardResponse;
    #stopping = false;

    snapshot(): RuntimeSnapshot {
        return { status: { ...this.#status }, pendingUi: [...this.#pendingUi.values()].map((item) => ({ ...item })) };
    }

    diagnostics(): readonly string[] {
        return this.#diagnostics.entries();
    }

    async start(options: StartRuntimeOptions): Promise<RuntimeStatus> {
        await this.stop();
        this.#pendingUi.clear();
        this.#uiAliases.clear();
        this.#recentGuardResponse = undefined;
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

            const decoder = new JsonlDecoder(MAX_BULK_RESPONSE_BYTES);
            this.#stopping = false;
            const child = spawn(this.#launch.executable, args, {
                cwd: options.cwd,
                env: { ...this.#launch.environment, SPECPI_DESKTOP: "1" },
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
            await this.#waitUntilReadyOrBlocked();
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
        this.#uiAliases.clear();
        this.#recentGuardResponse = undefined;
        await terminateProcessTree(child);
        this.#setStatus({ generation: this.#generation, phase: "stopped" });
    }

    async request(command: RpcCommand): Promise<unknown> {
        if (SESSION_REPLACEMENTS.has(command.type)) {
            // A replacement is a real session boundary. Never carry a prior startup answer into it.
            this.#recentGuardResponse = undefined;
        }

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
            this.#pending.set(id, { command: command.type, resolve, reject, timer });
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
        const request = this.#pendingUi.get(response.id);
        if (!request) {
            throw new Error("Extension UI request is no longer pending");
        }

        const aliases = [...(this.#uiAliases.get(response.id) ?? [])];
        await this.#write(response);
        for (const id of aliases) {
            await this.#write({ ...response, id });
        }

        const fingerprint = guardPromptFingerprint(request);
        if (fingerprint) {
            this.#recentGuardResponse = {
                fingerprint,
                response: { ...response },
                generation: this.#generation,
                answeredAt: Date.now(),
            };
        }

        this.#pendingUi.delete(response.id);
        this.#uiAliases.delete(response.id);
        if (this.#pendingUi.size === 0 && this.#status.phase === "waiting-for-user") {
            this.#setStatus({ ...this.#status, phase: "idle" });
            setTimeout(() => this.#resolveUiWaitersIfClear(), 75);
        }
    }

    async #waitUntilReadyOrBlocked(): Promise<void> {
        if (this.#pendingUi.size > 0) {
            return;
        }

        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const finish = (error?: unknown) => {
                if (settled) {
                    return;
                }

                settled = true;
                this.removeListener("blocking-ui", blocked);
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            };

            const blocked = () => finish();
            this.once("blocking-ui", blocked);
            void this.request({ type: "get_state" }).then(
                () => finish(),
                (error) => finish(error),
            );
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
        if (Buffer.byteLength(line) > MAX_RPC_RECORD_BYTES) {
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
        const pending =
            record.type === "response" && typeof record.id === "string" ? this.#pending.get(record.id) : undefined;
        const isExpectedBulkResponse =
            pending !== undefined && BULK_RESPONSE_COMMANDS.has(pending.command) && record.command === pending.command;
        if (Buffer.byteLength(line) > MAX_RPC_RECORD_BYTES && !isExpectedBulkResponse) {
            throw new Error(`RPC record exceeded ${MAX_RPC_RECORD_BYTES} bytes`);
        }

        if (record.type === "response" && typeof record.id === "string") {
            if (pending) {
                clearTimeout(pending.timer);
                this.#pending.delete(record.id);
                if (record.success === false) {
                    pending.reject(new Error(typeof record.error === "string" ? record.error : "Pi command failed"));
                } else {
                    if (typeof record.command === "string" && SESSION_REPLACEMENTS.has(record.command)) {
                        this.#generation += 1;
                        this.#pendingUi.clear();
                        this.#uiAliases.clear();
                        this.#recentGuardResponse = undefined;
                        this.#setStatus({ ...this.#status, generation: this.#generation, phase: "idle" });
                    }

                    pending.resolve(record.data);
                }
            }
        }

        if (record.type === "extension_ui_request" && typeof record.id === "string") {
            const request = record as ExtensionUiRequest;
            const startupResponse = desktopGuardStartupResponse(request);
            if (startupResponse) {
                // Older installed SpecPi versions predate Desktop's non-interstitial startup contract.
                // Consume only the exact startup choice and its exact follow-up confirmation; protected
                // operation approvals and every other extension request still reach the renderer.
                void this.#write(startupResponse).catch((error) => this.#fail(error));

                return;
            }

            if (isLegacyGuardStartupNotice(request)) {
                return;
            }

            if (!NONBLOCKING_UI.has(request.method)) {
                const fingerprint = guardPromptFingerprint(request);
                if (fingerprint) {
                    const active = [...this.#pendingUi.entries()].find(
                        ([, pending]) => guardPromptFingerprint(pending) === fingerprint,
                    );
                    if (active) {
                        const aliases = this.#uiAliases.get(active[0]) ?? new Set<string>();
                        aliases.add(request.id);
                        this.#uiAliases.set(active[0], aliases);

                        return;
                    }

                    const recent = this.#recentGuardResponse;
                    if (
                        recent?.fingerprint === fingerprint &&
                        recent.generation === this.#generation &&
                        Date.now() - recent.answeredAt < 5_000
                    ) {
                        void this.#write({ ...recent.response, id: request.id }).catch((error) => this.#fail(error));

                        return;
                    }
                }

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
        this.#uiAliases.clear();
        this.#recentGuardResponse = undefined;
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
