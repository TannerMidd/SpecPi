import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
    ExtensionUiResponse,
    RpcCommand,
    RpcRecord,
    RuntimeDescriptor,
    RuntimeEvent,
    RuntimeIdentity,
    RuntimeLaunchOptions,
    RuntimeSnapshot,
    RuntimeStatus,
} from "../shared/rpc";
import { canonicalPath, canonicalSessionPath, pathIdentity } from "./path-identity";
import { PiProcess, RuntimeStartCancelledError } from "./pi-process";

const MAX_RUNTIMES = 32;
const SESSION_REPLACEMENTS = new Set(["new_session", "fork", "clone"]);
const stoppedSnapshot = (): RuntimeSnapshot => ({ status: { generation: 0, phase: "stopped" }, pendingUi: [] });

interface RuntimeProcess extends EventEmitter {
    snapshot(): RuntimeSnapshot;
    diagnostics(): readonly string[];
    start(options: RuntimeLaunchOptions): Promise<RuntimeStatus>;
    stop(): Promise<void>;
    request(command: RpcCommand): Promise<unknown>;
    respond(response: ExtensionUiResponse): Promise<void>;
}

interface ManagedRuntime {
    runtimeId: string;
    projectId: string;
    projectPath: string;
    sessionId?: string;
    sessionPath?: string;
    sessionName?: string;
    process: RuntimeProcess;
    exportPaths: Set<string>;
    projection: Map<string, RpcRecord>;
    lifecycleEpoch: number;
    starting?: Promise<RuntimeStatus>;
    stopping?: Promise<void>;
}

function cancelledTransition(result: unknown): boolean {
    return Boolean(result && typeof result === "object" && (result as { cancelled?: unknown }).cancelled === true);
}

export class RuntimePool extends EventEmitter {
    readonly #createProcess: () => RuntimeProcess;
    readonly #platform: NodeJS.Platform;
    readonly #runtimes = new Set<ManagedRuntime>();
    #active?: ManagedRuntime;
    #viewGeneration = 0;
    #closed = false;

    constructor(createProcess: () => RuntimeProcess = () => new PiProcess(), platform = process.platform) {
        super();
        this.#createProcess = createProcess;
        this.#platform = platform;
    }

    snapshot(): RuntimeSnapshot {
        if (!this.#active) {
            return { ...stoppedSnapshot(), status: { ...stoppedSnapshot().status, generation: this.#viewGeneration } };
        }

        const snapshot = this.#active.process.snapshot();

        return { ...snapshot, status: this.#viewStatus(snapshot.status) };
    }

    roster(): RuntimeDescriptor[] {
        return [...this.#runtimes].map((runtime) => ({
            runtimeId: runtime.runtimeId,
            projectId: runtime.projectId,
            projectPath: runtime.projectPath,
            ...(runtime.sessionId ? { sessionId: runtime.sessionId } : {}),
            ...(runtime.sessionPath ? { sessionPath: runtime.sessionPath } : {}),
            active: runtime === this.#active,
            status: runtime.process.snapshot().status,
        }));
    }

    activeIdentity(): (RuntimeIdentity & { sessionName?: string }) | undefined {
        const runtime = this.#active;
        if (!runtime) {
            return undefined;
        }

        return {
            runtimeId: runtime.runtimeId,
            projectId: runtime.projectId,
            projectPath: runtime.projectPath,
            ...(runtime.sessionId ? { sessionId: runtime.sessionId } : {}),
            ...(runtime.sessionPath ? { sessionPath: runtime.sessionPath } : {}),
            ...(runtime.sessionName ? { sessionName: runtime.sessionName } : {}),
        };
    }

    diagnostics(): readonly string[] {
        return this.#active?.process.diagnostics() ?? [];
    }

    hasUsableRuntime(projectId: string, sessionId?: string): boolean {
        if (!sessionId) {
            return false;
        }

        return [...this.#runtimes].some((runtime) => {
            const phase = runtime.process.snapshot().status.phase;

            return (
                runtime.projectId === projectId &&
                runtime.sessionId === sessionId &&
                phase !== "stopped" &&
                phase !== "failed"
            );
        });
    }

    async activate(options: RuntimeLaunchOptions): Promise<RuntimeStatus> {
        if (this.#closed) {
            throw new Error("The Pi runtime pool is closed");
        }

        const existing = options.sessionId
            ? [...this.#runtimes].find(
                  (runtime) => runtime.projectId === options.projectId && runtime.sessionId === options.sessionId,
              )
            : options.sessionPath
              ? [...this.#runtimes].find(
                    (runtime) =>
                        runtime.projectId === options.projectId &&
                        runtime.sessionPath !== undefined &&
                        pathIdentity(runtime.sessionPath, this.#platform) ===
                            pathIdentity(options.sessionPath!, this.#platform),
                )
              : undefined;
        const runtime = existing ?? this.#createManagedRuntime(options);
        const activationEpoch = ++runtime.lifecycleEpoch;
        await runtime.stopping;
        if (runtime.lifecycleEpoch !== activationEpoch) {
            throw new Error("The Pi runtime activation was superseded");
        }

        let phase = runtime.process.snapshot().status.phase;
        const previousActive = this.#active;
        const changed = runtime !== previousActive;
        if (changed || phase === "stopped" || phase === "failed") {
            this.#viewGeneration += 1;
        }

        this.#active = runtime;
        runtime.projectId = options.projectId;
        runtime.projectPath = options.cwd;
        if (options.sessionId) {
            runtime.sessionId = options.sessionId;
        }

        if (options.sessionPath) {
            runtime.sessionPath = options.sessionPath;
        }

        if (changed) {
            this.#publishActiveSnapshot(runtime);
        }

        this.#publishRoster();

        if (runtime.starting) {
            const inFlight = runtime.starting;
            try {
                return this.#viewStatus(await inFlight);
            } catch (error) {
                if (
                    runtime.lifecycleEpoch !== activationEpoch ||
                    !["stopped", "failed"].includes(runtime.process.snapshot().status.phase)
                ) {
                    throw error;
                }

                if (runtime.starting === inFlight) {
                    runtime.starting = undefined;
                }

                phase = runtime.process.snapshot().status.phase;
            }
        }

        if (phase !== "stopped" && phase !== "failed") {
            return this.#viewStatus(runtime.process.snapshot().status);
        }

        runtime.exportPaths.clear();
        const starting = runtime.process.start(options);
        runtime.starting = starting;
        try {
            return this.#viewStatus(await starting);
        } catch (error) {
            if (error instanceof RuntimeStartCancelledError && this.#active === runtime) {
                if (!existing) {
                    this.#runtimes.delete(runtime);
                }

                this.#active = previousActive;
                if (changed) {
                    this.#viewGeneration += 1;
                    if (previousActive) {
                        this.#publishActiveSnapshot(previousActive);
                    } else {
                        this.emit("status", {
                            generation: this.#viewGeneration,
                            phase: "stopped",
                        } satisfies RuntimeStatus);
                    }
                }
            }

            throw error;
        } finally {
            if (runtime.starting === starting) {
                runtime.starting = undefined;
            }

            this.#publishRoster();
        }
    }

    async stopActive(): Promise<void> {
        const runtime = this.#active;
        if (!runtime) {
            return;
        }

        const stopEpoch = ++runtime.lifecycleEpoch;
        const starting = runtime.starting;
        const stopping = (async () => {
            await runtime.process.stop();
            await starting?.catch(() => undefined);
        })();
        runtime.stopping = stopping;
        await stopping;
        if (runtime.stopping === stopping) {
            runtime.stopping = undefined;
        }

        if (runtime.lifecycleEpoch !== stopEpoch) {
            return;
        }

        runtime.exportPaths.clear();
        this.#runtimes.delete(runtime);
        if (this.#active === runtime) {
            this.#active = undefined;
            this.#viewGeneration += 1;
            this.emit("status", { ...stoppedSnapshot().status, generation: this.#viewGeneration });
        }

        this.#publishRoster();
    }

    async stopAll(): Promise<void> {
        this.#closed = true;
        const runtimes = [...this.#runtimes];
        for (const runtime of runtimes) {
            runtime.lifecycleEpoch += 1;
        }

        await Promise.all(runtimes.map((runtime) => runtime.process.stop()));
        await Promise.all(runtimes.map((runtime) => runtime.starting?.catch(() => undefined)));
        await Promise.all(runtimes.map((runtime) => runtime.stopping?.catch(() => undefined)));
        this.#runtimes.clear();
        this.#active = undefined;
        this.#publishRoster();
    }

    async request(command: RpcCommand): Promise<unknown> {
        const runtime = this.#requireActive();
        const priorProjection = SESSION_REPLACEMENTS.has(command.type) ? new Map(runtime.projection) : undefined;
        const result = await runtime.process.request(command);
        if (SESSION_REPLACEMENTS.has(command.type) && !cancelledTransition(result)) {
            if (runtime === this.#active) {
                this.#viewGeneration += 1;
            }

            runtime.sessionId = undefined;
            runtime.sessionPath = undefined;
            runtime.sessionName = undefined;
            runtime.exportPaths.clear();
            for (const [key, record] of priorProjection ?? []) {
                if (runtime.projection.get(key) === record) {
                    runtime.projection.delete(key);
                }
            }

            if (runtime === this.#active) {
                this.#publishActiveSnapshot(runtime);
            }

            this.#publishRoster();
        }

        if (command.type === "get_state" && result && typeof result === "object") {
            const data = result as { sessionId?: unknown; sessionFile?: unknown; sessionName?: unknown };
            const sessionId =
                typeof data.sessionId === "string" && data.sessionId.length > 0 ? data.sessionId : runtime.sessionId;
            const sessionPath =
                typeof data.sessionFile === "string" && data.sessionFile.length > 0
                    ? await canonicalSessionPath(data.sessionFile)
                    : runtime.sessionPath;
            const sessionName =
                typeof data.sessionName === "string" && data.sessionName.trim() ? data.sessionName.trim() : undefined;
            runtime.sessionId = sessionId;
            runtime.sessionPath = sessionPath;
            runtime.sessionName = sessionName;
            this.#publishRoster();
        }

        if (runtime !== this.#active) {
            throw new Error("The active Pi runtime changed before the command completed");
        }

        if (command.type === "export_html" && result && typeof result === "object") {
            const sourcePath = (result as { path?: unknown }).path;
            if (typeof sourcePath === "string") {
                const canonicalSource = await canonicalPath(sourcePath);
                if (runtime !== this.#active) {
                    throw new Error("The active Pi runtime changed before export authorization completed");
                }

                runtime.exportPaths.add(canonicalSource);
            }
        }

        return result;
    }

    respond(response: ExtensionUiResponse): Promise<void> {
        return this.#requireActive().process.respond(response);
    }

    authorizeExport(sourcePath: string): void {
        this.#requireActive().exportPaths.add(sourcePath);
    }

    isExportAuthorized(sourcePath: string): boolean {
        return this.#active?.exportPaths.has(sourcePath) === true;
    }

    hasRunningProcesses(): boolean {
        return [...this.#runtimes].some((runtime) => runtime.process.snapshot().status.phase !== "stopped");
    }

    #createManagedRuntime(options: RuntimeLaunchOptions): ManagedRuntime {
        if (this.#runtimes.size >= MAX_RUNTIMES) {
            throw new Error(`A desktop window can run at most ${MAX_RUNTIMES} Pi sessions at once`);
        }

        const runtime: ManagedRuntime = {
            runtimeId: randomUUID(),
            projectId: options.projectId,
            projectPath: options.cwd,
            ...(options.sessionId ? { sessionId: options.sessionId } : {}),
            ...(options.sessionPath ? { sessionPath: options.sessionPath } : {}),
            process: this.#createProcess(),
            exportPaths: new Set(),
            lifecycleEpoch: 0,
            projection: new Map(),
        };
        this.#runtimes.add(runtime);
        runtime.process.on("event", (event: RuntimeEvent) => {
            this.#recordProjection(runtime, event.record);
            if (runtime === this.#active) {
                this.emit("event", { ...event, generation: this.#viewGeneration });
            }
        });
        runtime.process.on("status", (status: RuntimeStatus) => {
            if (runtime === this.#active) {
                this.emit("status", this.#viewStatus(status));
            }

            this.#publishRoster();
        });

        return runtime;
    }

    #publishActiveSnapshot(runtime: ManagedRuntime): void {
        const snapshot = runtime.process.snapshot();
        this.emit("status", this.#viewStatus(snapshot.status));
        for (const record of runtime.projection.values()) {
            this.emit("event", { generation: this.#viewGeneration, record } satisfies RuntimeEvent);
        }

        for (const request of snapshot.pendingUi) {
            this.emit("event", { generation: this.#viewGeneration, record: request } satisfies RuntimeEvent);
        }
    }

    #recordProjection(runtime: ManagedRuntime, record: RpcRecord): void {
        if (record.type !== "extension_ui_request") {
            return;
        }

        const method = record.method;
        if (method === "setStatus" && typeof record.statusKey === "string") {
            const key = `status:${record.statusKey}`;
            if (typeof record.statusText === "string") {
                this.#storeProjection(runtime, key, record);
            } else {
                runtime.projection.delete(key);
            }
        } else if (method === "setWidget" && typeof record.widgetKey === "string") {
            const key = `widget:${record.widgetKey}`;
            if (Array.isArray(record.widgetLines)) {
                this.#storeProjection(runtime, key, record);
            } else {
                runtime.projection.delete(key);
            }
        } else if (method === "setTitle") {
            this.#storeProjection(runtime, "title", record);
        }
    }

    #storeProjection(runtime: ManagedRuntime, key: string, record: RpcRecord): void {
        if (!runtime.projection.has(key) && runtime.projection.size >= 256) {
            const oldest = runtime.projection.keys().next().value;
            if (oldest !== undefined) {
                runtime.projection.delete(oldest);
            }
        }

        runtime.projection.set(key, record);
    }

    #publishRoster(): void {
        this.emit("roster", this.roster());
    }

    #viewStatus(status: RuntimeStatus): RuntimeStatus {
        return { ...status, generation: this.#viewGeneration };
    }

    #requireActive(): ManagedRuntime {
        if (!this.#active) {
            throw new Error("Pi runtime is not running");
        }

        return this.#active;
    }
}
