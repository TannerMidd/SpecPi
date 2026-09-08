import type { ChildProcess, spawn } from "node:child_process";

export type StartSpec = Readonly<{
    command: string;
    cwd: string;
    label: string;
    timeoutSeconds: number;
    shell: string;
    dialect: "bash" | "cmd";
}>;
export type TaskSummary = {
    id: string;
    label: string;
    command: string;
    status: "starting" | "running" | "stopping" | "cleanup-unconfirmed" | "failed" | "exited" | "killed";
    elapsedMs: number;
    exitCode: number | null;
    exitSignal: string | null;
    reason: string | null;
    cleanup: "pending" | "confirmed" | "unconfirmed";
    generation: number;
};
export type OwnedRoot = {
    child?: Pick<ChildProcess, "pid">;
    rootExited: boolean;
    exitCode?: number | null;
};
export type Task = OwnedRoot & {
    id: string;
    spec: StartSpec;
    generation: number;
    startedAt: number;
    endedAt?: number;
    status: TaskSummary["status"];
    cleanup: TaskSummary["cleanup"];
    ring: OutputRing;
    child?: ChildProcess;
    exitSignal?: string | null;
    reason?: string;
    failed?: boolean;
    stopping?: Promise<TaskSummary>;
    timer?: ReturnType<typeof setTimeout>;
};
export declare const LIMITS: Readonly<
    Record<"command" | "cwd" | "label" | "active" | "completed" | "approvals" | "buffer" | "read" | "timeout", number>
>;
export declare function safeText(value: unknown): string;
export declare function preview(value: unknown, limit?: number): string;
export declare function record(value: unknown, keys: string[]): void;
export declare function shellSpec(platform?: NodeJS.Platform): Pick<StartSpec, "shell" | "dialect">;
export declare function normalizeStart(input: unknown, cwd: string): StartSpec;
export declare class OutputRing {
    constructor(capacity?: number);
    capacity: number;
    bytes: Buffer;
    end: number;
    append(stream: "stdout" | "stderr", chunk: Buffer, final?: boolean): void;
    append(stream: "stdout" | "stderr", chunk: undefined, final: true): void;
    read(offset?: number): {
        output: string;
        offset: number;
        nextOffset: number;
        endOffset: number;
        lostBytes: number;
        truncated: boolean;
    };
}
export declare function terminateOwned(
    task: OwnedRoot,
    options?: { graceMs?: number; observeMs?: number },
): Promise<boolean>;
export declare class TaskRunner {
    constructor(options?: {
        spawnProcess?: typeof spawn;
        terminate?: (task: Task) => Promise<boolean>;
        startupMs?: number;
    });
    tasks: Map<string, Task>;
    closed: boolean;
    spawnProcess: typeof spawn;
    terminate: (task: Task) => Promise<boolean>;
    startupMs: number;
    get(id: string): Task;
    summary(task: Task): TaskSummary;
    list(): TaskSummary[];
    evict(): void;
    start(spec: StartSpec, generation: number, signal?: AbortSignal): Promise<TaskSummary>;
    stop(id: string, reason?: string): Promise<TaskSummary>;
    shutdown(): Promise<TaskSummary[]>;
}
