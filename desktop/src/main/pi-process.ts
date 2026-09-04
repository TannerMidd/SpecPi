import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { MAX_RPC_COMMAND_BYTES, serializedRpcBytes } from "../shared/limits";
import { extensionUiRequestSchema, rpcRecordSchema } from "../shared/schemas";
import type {
    ExtensionUiRequest,
    ExtensionUiResponse,
    RpcCommand,
    RpcRecord,
    RuntimeEvent,
    RuntimeLaunchOptions,
    RuntimeSnapshot,
    RuntimeStatus,
} from "../shared/rpc";
import { DiagnosticBuffer } from "./diagnostics";
import { JsonlDecoder } from "./jsonl";
import { terminateProcessTree } from "./process-tree";
import { assertSupportedPi, compatibilityWarning, probePi, resolvePiLaunch, type PiLaunch } from "./runtime-discovery";

const NONBLOCKING_UI = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);
const REQUEST_TIMEOUT = 120_000;
const MAX_PENDING_REQUESTS = 256;
const MAX_BULK_RESPONSE_BYTES = 64 * 1024 * 1024;
export class RuntimeStartCancelledError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RuntimeStartCancelledError";
    }
}

const BULK_RESPONSE_COMMANDS = new Set([
    "get_entries",
    "get_fork_messages",
    "get_last_assistant_text",
    "get_messages",
    "get_tree",
]);
const SESSION_REPLACEMENTS = new Set(["new_session", "fork", "clone"]);

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

export interface PiProcessDependencies {
    resolveLaunch(requested: string | undefined, signal: AbortSignal): Promise<PiLaunch>;
    probe(launch: PiLaunch, signal: AbortSignal): Promise<string>;
    spawnRuntime(
        executable: string,
        args: readonly string[],
        options: SpawnOptionsWithoutStdio,
    ): ChildProcessWithoutNullStreams;
    terminate(child: ChildProcessWithoutNullStreams): Promise<void>;
}

const productionDependencies: PiProcessDependencies = {
    resolveLaunch: resolvePiLaunch,
    probe: (launch, signal) => probePi(launch, 10_000, signal),
    spawnRuntime: (executable, args, options) =>
        spawn(executable, [...args], { ...options, stdio: ["pipe", "pipe", "pipe"] }),
    terminate: terminateProcessTree,
};

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

function validateExtensionUiResponse(request: ExtensionUiRequest, response: ExtensionUiResponse): void {
    if (response.cancelled === true) {
        if (response.value !== undefined || response.confirmed !== undefined) {
            throw new Error("Extension UI cancellation response is ambiguous");
        }

        return;
    }

    if (request.method === "select") {
        const options = Array.isArray(request.options) ? request.options : [];
        if (
            typeof response.value !== "string" ||
            response.confirmed !== undefined ||
            !options.includes(response.value)
        ) {
            throw new Error("Extension UI response did not select an offered option");
        }

        return;
    }

    if (request.method === "confirm") {
        if (typeof response.confirmed !== "boolean" || response.value !== undefined) {
            throw new Error("Extension UI confirmation response is invalid");
        }

        return;
    }

    if (["input", "editor"].includes(request.method)) {
        if (typeof response.value !== "string" || response.confirmed !== undefined) {
            throw new Error("Extension UI text response is invalid");
        }

        return;
    }

    throw new Error("This extension UI request does not accept a response");
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

function replacementCancelled(record: RpcRecord): boolean {
    return Boolean(
        record.data && typeof record.data === "object" && (record.data as { cancelled?: unknown }).cancelled === true,
    );
}

function cancelledStartError(): Error {
    return new Error("Pi runtime start was cancelled");
}

export class PiProcess extends EventEmitter {
    readonly #dependencies: PiProcessDependencies;
    #child?: ChildProcessWithoutNullStreams;
    #launch?: PiLaunch;
    #attempt = 0;
    #startAbort?: AbortController;
    #generation = 0;
    #status: RuntimeStatus = { generation: 0, phase: "stopped" };
    readonly #pending = new Map<string, PendingRequest>();
    readonly #pendingUi = new Map<string, ExtensionUiRequest>();
    readonly #uiAliases = new Map<string, Set<string>>();
    readonly #uiWaiters = new Set<UiWaiter>();
    readonly #terminations = new Set<Promise<void>>();
    readonly #diagnostics = new DiagnosticBuffer();
    #recentGuardResponse?: RecentGuardResponse;

    constructor(dependencies: Partial<PiProcessDependencies> = {}) {
        super();
        this.#dependencies = { ...productionDependencies, ...dependencies };
    }

    snapshot(): RuntimeSnapshot {
        return { status: { ...this.#status }, pendingUi: [...this.#pendingUi.values()].map((item) => ({ ...item })) };
    }

    diagnostics(): readonly string[] {
        return this.#diagnostics.entries();
    }

    async start(options: RuntimeLaunchOptions): Promise<RuntimeStatus> {
        await this.stop();
        const attempt = ++this.#attempt;
        const abort = new AbortController();
        this.#startAbort = abort;
        this.#pendingUi.clear();
        this.#uiAliases.clear();
        this.#recentGuardResponse = undefined;
        this.#generation += 1;
        this.#setStatus({ generation: this.#generation, phase: "starting", cwd: options.cwd });
        let child: ChildProcessWithoutNullStreams | undefined;

        try {
            const launch = await this.#dependencies.resolveLaunch(options.piPath, abort.signal);
            this.#assertAttempt(attempt, abort.signal);
            const version = await this.#dependencies.probe(launch, abort.signal);
            this.#assertAttempt(attempt, abort.signal);
            assertSupportedPi(version);
            const warning = compatibilityWarning(version);
            if (warning) {
                const confirmed = await options.confirmCompatibility?.(warning);
                this.#assertAttempt(attempt, abort.signal);
                if (!confirmed) {
                    throw new RuntimeStartCancelledError("Pi compatibility mode was cancelled");
                }
            }

            const args = [...launch.argsPrefix, "--mode", "rpc"];
            if (options.noSession) {
                args.push("--no-session");
            } else if (options.forkSessionPath) {
                args.push("--fork", options.forkSessionPath);
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

            this.#assertAttempt(attempt, abort.signal);
            const decoder = new JsonlDecoder(MAX_BULK_RESPONSE_BYTES);
            child = this.#dependencies.spawnRuntime(launch.executable, args, {
                cwd: options.cwd,
                env: { ...launch.environment, SPECPI_DESKTOP: "1" },
                shell: false,
                detached: process.platform !== "win32",
                windowsHide: true,
            });
            this.#assertAttempt(attempt, abort.signal);
            this.#launch = launch;
            this.#child = child;
            child.stdout.on("data", (chunk: Buffer) => {
                if (!this.#isCurrentChild(child!, attempt)) {
                    return;
                }

                try {
                    for (const line of decoder.push(chunk)) {
                        this.#handleLine(line, child!, attempt);
                    }
                } catch (error) {
                    this.#fail(error, child!, attempt);
                }
            });
            child.stdout.on("end", () => {
                if (!this.#isCurrentChild(child!, attempt)) {
                    return;
                }

                try {
                    for (const line of decoder.end()) {
                        this.#handleLine(line, child!, attempt);
                    }
                } catch (error) {
                    this.#fail(error, child!, attempt);
                }
            });
            child.stderr.on("data", (chunk: Buffer) => {
                if (this.#isCurrentChild(child!, attempt)) {
                    this.#diagnostics.append(chunk.toString("utf8"));
                }
            });
            child.once("exit", (code, signal) => this.#handleExit(child!, attempt, code, signal));
            await this.#waitForSpawn(child, attempt, abort.signal);
            child.once("error", (error) => this.#fail(error, child!, attempt));
            this.#assertCurrentChild(child, attempt, abort.signal);
            await this.#waitUntilReadyOrBlocked();
            this.#assertCurrentChild(child, attempt, abort.signal);
            this.#setStatus({
                generation: this.#generation,
                phase: this.#pendingUi.size > 0 ? "waiting-for-user" : "idle",
                piPath: launch.displayPath,
                piVersion: version,
                cwd: options.cwd,
                compatibilityWarning: compatibilityWarning(version),
            });

            return { ...this.#status };
        } catch (error) {
            if (child && !this.#isCurrentChild(child, attempt)) {
                await this.#dependencies.terminate(child);
            }

            if (abort.signal.aborted || attempt !== this.#attempt) {
                throw cancelledStartError();
            }

            if (error instanceof RuntimeStartCancelledError && !child) {
                this.#setStatus({ generation: this.#generation, phase: "stopped" });
                throw error;
            }

            this.#fail(error, child, attempt);
            throw error;
        } finally {
            if (this.#startAbort === abort) {
                this.#startAbort = undefined;
            }
        }
    }

    async stop(): Promise<void> {
        const stopAttempt = ++this.#attempt;
        this.#startAbort?.abort();
        this.#startAbort = undefined;
        const child = this.#child;
        this.#child = undefined;
        this.#launch = undefined;
        this.#rejectPending(new Error("Pi runtime stopped"));
        this.#rejectUiWaiters(new Error("Pi runtime stopped"));
        this.#pendingUi.clear();
        this.#uiAliases.clear();
        this.#recentGuardResponse = undefined;
        if (child) {
            await this.#trackTermination(child);
        }

        await Promise.all([...this.#terminations]);
        if (this.#attempt === stopAttempt) {
            this.#setStatus({ generation: this.#generation, phase: "stopped" });
        }
    }

    async request(command: RpcCommand): Promise<unknown> {
        await this.#waitForUi();
        if (!this.#child || this.#child.killed) {
            throw new Error("Pi runtime is not running");
        }

        if (this.#pending.size >= MAX_PENDING_REQUESTS) {
            throw new Error("Pi RPC pending-request limit reached");
        }

        const id = randomUUID();
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

        validateExtensionUiResponse(request, response);
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

    async #waitForSpawn(child: ChildProcessWithoutNullStreams, attempt: number, signal: AbortSignal): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const finish = (error?: Error) => {
                clearTimeout(timer);
                signal.removeEventListener("abort", cancelled);
                child.removeListener("spawn", spawned);
                child.removeListener("error", failed);
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            };

            const spawned = () => finish();
            const failed = (error: Error) => finish(error);
            const cancelled = () => finish(cancelledStartError());
            const timer = setTimeout(() => finish(new Error("Timed out starting Pi")), 10_000);
            child.once("spawn", spawned);
            child.once("error", failed);
            signal.addEventListener("abort", cancelled, { once: true });
            if (!this.#isCurrentChild(child, attempt) || signal.aborted) {
                cancelled();
            }
        });
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

        if (serializedRpcBytes(record) > MAX_RPC_COMMAND_BYTES) {
            throw new Error("Pi RPC command exceeded the size limit");
        }

        const line = `${JSON.stringify(record)}\n`;
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

    #handleLine(line: string, child: ChildProcessWithoutNullStreams, attempt: number): void {
        if (!this.#isCurrentChild(child, attempt)) {
            return;
        }

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

        let record = result.data as RpcRecord;
        const pending =
            record.type === "response" && typeof record.id === "string" ? this.#pending.get(record.id) : undefined;
        const isExpectedBulkResponse =
            pending !== undefined && BULK_RESPONSE_COMMANDS.has(pending.command) && record.command === pending.command;
        if (Buffer.byteLength(line) > MAX_RPC_COMMAND_BYTES && !isExpectedBulkResponse) {
            throw new Error(`RPC record exceeded ${MAX_RPC_COMMAND_BYTES} bytes`);
        }

        if (record.type === "response") {
            if (pending && record.command !== pending.command) {
                throw new Error(`Pi response command mismatch: expected ${pending.command}`);
            }

            if (typeof record.id === "string" && pending) {
                clearTimeout(pending.timer);
                this.#pending.delete(record.id);
                if (record.success === false) {
                    pending.reject(new Error(typeof record.error === "string" ? record.error : "Pi command failed"));
                } else {
                    if (
                        typeof record.command === "string" &&
                        SESSION_REPLACEMENTS.has(record.command) &&
                        !replacementCancelled(record)
                    ) {
                        this.#generation += 1;
                        this.#pendingUi.clear();
                        this.#uiAliases.clear();
                        this.#recentGuardResponse = undefined;
                        this.#setStatus({ ...this.#status, generation: this.#generation, phase: "idle" });
                    }

                    pending.resolve(record.data);
                }
            }

            return;
        }

        if (record.type === "extension_ui_request") {
            const extensionResult = extensionUiRequestSchema.safeParse(record);
            if (!extensionResult.success) {
                throw new Error("Pi emitted an invalid extension UI request");
            }

            const request = extensionResult.data as ExtensionUiRequest;
            record = request;
            const startupResponse = desktopGuardStartupResponse(request);
            if (startupResponse) {
                void this.#write(startupResponse).catch((error) => this.#fail(error, child, attempt));

                return;
            }

            if (isLegacyGuardStartupNotice(request)) {
                return;
            }

            if (!NONBLOCKING_UI.has(request.method)) {
                const fingerprint = guardPromptFingerprint(request);
                if (fingerprint) {
                    const active = [...this.#pendingUi.entries()].find(
                        ([, waiting]) => guardPromptFingerprint(waiting) === fingerprint,
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
                        void this.#write({ ...recent.response, id: request.id }).catch((error) =>
                            this.#fail(error, child, attempt),
                        );

                        return;
                    }
                }

                if (!this.#pendingUi.has(request.id) && this.#pendingUi.size >= MAX_PENDING_REQUESTS) {
                    throw new Error("Pi extension UI pending-request limit reached");
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

    #handleExit(
        child: ChildProcessWithoutNullStreams,
        attempt: number,
        code: number | null,
        signal: NodeJS.Signals | null,
    ): void {
        if (!this.#isCurrentChild(child, attempt)) {
            return;
        }

        this.#child = undefined;
        void this.#trackTermination(child);
        const error = new Error(`Pi exited (${signal ?? code ?? "unknown"})`);
        this.#rejectPending(error);
        this.#rejectUiWaiters(error);
        this.#pendingUi.clear();
        this.#uiAliases.clear();
        this.#recentGuardResponse = undefined;
        this.#setStatus({
            ...this.#status,
            phase: "failed",
            error: `Pi exited unexpectedly (${signal ?? code ?? "unknown"})`,
        });
    }

    #fail(error: unknown, child?: ChildProcessWithoutNullStreams, attempt?: number): void {
        if (child && attempt !== undefined && !this.#isCurrentChild(child, attempt)) {
            return;
        }

        const message = error instanceof Error ? error.message : String(error);
        this.#diagnostics.append(message);
        this.#setStatus({ ...this.#status, phase: "failed", error: message });
        this.#rejectPending(new Error(message));
        this.#rejectUiWaiters(new Error(message));
        const failedChild = child ?? this.#child;
        if (failedChild && this.#child === failedChild) {
            this.#child = undefined;
            void this.#trackTermination(failedChild);
        }
    }

    #trackTermination(child: ChildProcessWithoutNullStreams): Promise<void> {
        const termination = this.#dependencies.terminate(child).catch((error) => {
            this.#diagnostics.append(error instanceof Error ? error.message : String(error));
        });
        this.#terminations.add(termination);
        void termination.finally(() => this.#terminations.delete(termination));

        return termination;
    }

    #rejectPending(error: Error): void {
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }

        this.#pending.clear();
    }

    #assertAttempt(attempt: number, signal: AbortSignal): void {
        if (attempt !== this.#attempt || signal.aborted) {
            throw cancelledStartError();
        }
    }

    #assertCurrentChild(child: ChildProcessWithoutNullStreams, attempt: number, signal: AbortSignal): void {
        this.#assertAttempt(attempt, signal);
        if (this.#child !== child || child.killed) {
            throw cancelledStartError();
        }
    }

    #isCurrentChild(child: ChildProcessWithoutNullStreams, attempt: number): boolean {
        return attempt === this.#attempt && this.#child === child;
    }

    #setStatus(status: RuntimeStatus): void {
        this.#status = status;
        this.emit("status", { ...status });
    }
}
