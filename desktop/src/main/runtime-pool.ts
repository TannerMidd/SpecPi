import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
    ExtensionUiResponse,
    RpcCommand,
    RpcRecord,
    RuntimeDescriptor,
    RuntimeEvent,
    RuntimeSnapshot,
    RuntimeStatus,
    StartRuntimeOptions,
} from "../shared/rpc";
import { PiProcess } from "./pi-process";

const MAX_RUNTIMES = 32;
const stoppedSnapshot = (): RuntimeSnapshot => ({ status: { generation: 0, phase: "stopped" }, pendingUi: [] });

interface RuntimeProcess extends EventEmitter {
    snapshot(): RuntimeSnapshot;
    diagnostics(): readonly string[];
    start(options: StartRuntimeOptions): Promise<RuntimeStatus>;
    stop(): Promise<void>;
    request(command: RpcCommand): Promise<unknown>;
    respond(response: ExtensionUiResponse): Promise<void>;
}

interface ManagedRuntime {
    runtimeId: string;
    projectPath: string;
    sessionPath?: string;
    process: RuntimeProcess;
    exportPaths: Set<string>;
    projection: Map<string, RpcRecord>;
    starting?: Promise<RuntimeStatus>;
}

function normalizedPath(value: string): string {
    return value.replaceAll("\\", "/").toLowerCase();
}

export class RuntimePool extends EventEmitter {
    readonly #createProcess: () => RuntimeProcess;
    readonly #runtimes = new Set<ManagedRuntime>();
    #active?: ManagedRuntime;
    #viewGeneration = 0;

    constructor(createProcess: () => RuntimeProcess = () => new PiProcess()) {
        super();
        this.#createProcess = createProcess;
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
            projectPath: runtime.projectPath,
            ...(runtime.sessionPath ? { sessionPath: runtime.sessionPath } : {}),
            active: runtime === this.#active,
            status: runtime.process.snapshot().status,
        }));
    }

    diagnostics(): readonly string[] {
        return this.#active?.process.diagnostics() ?? [];
    }

    async activate(options: StartRuntimeOptions): Promise<RuntimeStatus> {
        const sessionPath = options.sessionPath;
        const existing = sessionPath
            ? [...this.#runtimes].find(
                  (runtime) =>
                      runtime.sessionPath !== undefined &&
                      normalizedPath(runtime.sessionPath) === normalizedPath(sessionPath),
              )
            : undefined;
        const runtime = existing ?? this.#createManagedRuntime(options);
        const phase = runtime.process.snapshot().status.phase;
        const changed = runtime !== this.#active;
        if (changed || phase === "stopped" || phase === "failed") {
            this.#viewGeneration += 1;
        }

        this.#active = runtime;
        runtime.projectPath = options.cwd;
        if (options.sessionPath) {
            runtime.sessionPath = options.sessionPath;
        }

        if (changed) {
            this.#publishActiveSnapshot(runtime);
        }

        this.#publishRoster();

        if (runtime.starting) {
            return this.#viewStatus(await runtime.starting);
        }

        if (phase !== "stopped" && phase !== "failed") {
            return this.#viewStatus(runtime.process.snapshot().status);
        }

        runtime.exportPaths.clear();
        const starting = runtime.process.start(options);
        runtime.starting = starting;
        try {
            return this.#viewStatus(await starting);
        } finally {
            runtime.starting = undefined;
            this.#publishRoster();
        }
    }

    async stopActive(): Promise<void> {
        const runtime = this.#active;
        if (!runtime) {
            return;
        }

        await runtime.process.stop();
        runtime.exportPaths.clear();
        this.#runtimes.delete(runtime);
        this.#active = undefined;
        this.#viewGeneration += 1;
        this.emit("status", { ...stoppedSnapshot().status, generation: this.#viewGeneration });
        this.#publishRoster();
    }

    async stopAll(): Promise<void> {
        const runtimes = [...this.#runtimes];
        await Promise.all(runtimes.map((runtime) => runtime.process.stop()));
        this.#runtimes.clear();
        this.#active = undefined;
        this.#publishRoster();
    }

    async request(command: RpcCommand): Promise<unknown> {
        const runtime = this.#requireActive();
        const result = await runtime.process.request(command);
        if (command.type === "get_state" && result && typeof result === "object") {
            const sessionFile = (result as { sessionFile?: unknown }).sessionFile;
            if (typeof sessionFile === "string" && sessionFile.length > 0) {
                runtime.sessionPath = sessionFile;
                this.#publishRoster();
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

    #createManagedRuntime(options: StartRuntimeOptions): ManagedRuntime {
        if (this.#runtimes.size >= MAX_RUNTIMES) {
            throw new Error(`A desktop window can run at most ${MAX_RUNTIMES} Pi sessions at once`);
        }

        const runtime: ManagedRuntime = {
            runtimeId: randomUUID(),
            projectPath: options.cwd,
            ...(options.sessionPath ? { sessionPath: options.sessionPath } : {}),
            process: this.#createProcess(),
            exportPaths: new Set(),
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
