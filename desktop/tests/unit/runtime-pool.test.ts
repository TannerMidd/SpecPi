import { EventEmitter } from "node:events";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RuntimeStartCancelledError } from "../../src/main/pi-process";
import { RuntimePool } from "../../src/main/runtime-pool";
import type {
    ExtensionUiResponse,
    RpcCommand,
    RuntimeEvent,
    RuntimeLaunchOptions,
    RuntimeSnapshot,
    RuntimeStatus,
} from "../../src/shared/rpc";

class FakeRuntime extends EventEmitter {
    status: RuntimeStatus = { generation: 0, phase: "stopped" };
    pendingUi: RuntimeSnapshot["pendingUi"] = [];
    options?: RuntimeLaunchOptions;
    starts = 0;
    stops = 0;

    snapshot(): RuntimeSnapshot {
        return { status: { ...this.status }, pendingUi: [...this.pendingUi] };
    }

    diagnostics(): readonly string[] {
        return [];
    }

    async start(options: RuntimeLaunchOptions): Promise<RuntimeStatus> {
        this.options = options;
        this.starts += 1;
        this.setPhase("starting");
        this.setPhase("idle");

        return { ...this.status };
    }

    async stop(): Promise<void> {
        this.stops += 1;
        this.setPhase("stopped");
    }

    async request(command: RpcCommand): Promise<unknown> {
        if (command.type === "get_state") {
            return { sessionId: this.options?.sessionId, sessionFile: this.options?.sessionPath };
        }

        return {};
    }

    async respond(_response: ExtensionUiResponse): Promise<void> {
        this.pendingUi = [];
    }

    setPhase(phase: RuntimeStatus["phase"]): void {
        this.status = { ...this.status, generation: this.status.generation + 1, phase };
        this.emit("status", { ...this.status });
    }

    send(record: RuntimeEvent["record"]): void {
        this.emit("event", { generation: this.status.generation, record } satisfies RuntimeEvent);
    }
}

function launch(sessionId: string): RuntimeLaunchOptions {
    return {
        projectId: "project",
        cwd: "/project",
        trust: "deny",
        sessionId,
        sessionPath: `/sessions/${sessionId}.jsonl`,
    };
}

describe("desktop runtime pool", () => {
    it("keeps inactive sessions running and reactivates them by main-owned IDs", async () => {
        const processes: FakeRuntime[] = [];
        const pool = new RuntimePool(() => {
            const runtime = new FakeRuntime();
            processes.push(runtime);

            return runtime;
        });
        const visibleEvents: RuntimeEvent[] = [];
        pool.on("event", (event: RuntimeEvent) => visibleEvents.push(event));

        await pool.activate(launch("one"));
        pool.authorizeExport("/exports/one.html");
        processes[0]!.setPhase("streaming");
        await pool.activate(launch("two"));

        expect(processes).toHaveLength(2);
        expect(pool.isExportAuthorized("/exports/one.html")).toBe(false);
        expect(processes[0]!.stops).toBe(0);
        expect(pool.roster()).toMatchObject([
            { projectId: "project", sessionId: "one", active: false, status: { phase: "streaming" } },
            { projectId: "project", sessionId: "two", active: true, status: { phase: "idle" } },
        ]);

        processes[0]!.send({ type: "message_end", message: { role: "assistant", content: "background" } });
        expect(visibleEvents).toEqual([]);

        await pool.activate({ ...launch("one"), sessionPath: "/different/display/path.jsonl" });
        expect(processes).toHaveLength(2);
        expect(processes[0]!.starts).toBe(1);
        expect(processes[1]!.stops).toBe(0);
        expect(pool.snapshot().status.phase).toBe("streaming");
        expect(pool.isExportAuthorized("/exports/one.html")).toBe(true);
        processes[0]!.send({ type: "message_end", message: { role: "assistant", content: "visible again" } });
        expect(visibleEvents.at(-1)?.generation).toBe(pool.snapshot().status.generation);

        await pool.stopAll();
        expect(processes.map((runtime) => runtime.stops)).toEqual([1, 1]);
        expect(pool.roster()).toEqual([]);
    });

    it("restores the prior active runtime after compatibility cancellation", async () => {
        const processes: FakeRuntime[] = [];
        const pool = new RuntimePool(() => {
            const runtime = new FakeRuntime();
            if (processes.length === 1) {
                runtime.start = async () => {
                    runtime.setPhase("stopped");
                    throw new RuntimeStartCancelledError("Pi compatibility mode was cancelled");
                };
            }

            processes.push(runtime);

            return runtime;
        });
        await pool.activate(launch("one"));
        const priorRuntimeId = pool.activeIdentity()?.runtimeId;

        await expect(pool.activate(launch("two"))).rejects.toThrow("Pi compatibility mode was cancelled");
        expect(pool.activeIdentity()?.runtimeId).toBe(priorRuntimeId);
        expect(pool.activeIdentity()?.sessionId).toBe("one");
        expect(pool.snapshot().status.phase).toBe("idle");
        expect(pool.roster()).toHaveLength(1);
    });

    it("replays pending UI and authoritative status when a background session becomes visible", async () => {
        const processes: FakeRuntime[] = [];
        const pool = new RuntimePool(() => {
            const runtime = new FakeRuntime();
            processes.push(runtime);

            return runtime;
        });
        await pool.activate(launch("one"));
        await pool.activate(launch("two"));
        processes[0]!.pendingUi = [
            { type: "extension_ui_request", id: "approval", method: "confirm", title: "Review" },
        ];
        processes[0]!.send({
            type: "extension_ui_request",
            id: "guard-status",
            method: "setStatus",
            statusKey: "specpi-command-guard",
            statusText: "Guard Off",
        });
        processes[0]!.setPhase("waiting-for-user");
        const visibleEvents: RuntimeEvent[] = [];
        pool.on("event", (event: RuntimeEvent) => visibleEvents.push(event));

        await pool.activate(launch("one"));

        expect(visibleEvents.map((event) => event.record.id)).toEqual(["guard-status", "approval"]);
    });

    it("[B4] keeps a rapid stop-start replacement tracked", async () => {
        const processes: FakeRuntime[] = [];
        let rejectFirst: ((error: Error) => void) | undefined;
        let releaseStop: (() => void) | undefined;
        const pool = new RuntimePool(() => {
            const runtime = new FakeRuntime();
            runtime.start = async (options) => {
                runtime.options = options;
                runtime.starts += 1;
                if (runtime.starts === 1) {
                    runtime.setPhase("starting");

                    return new Promise((_resolve, reject) => {
                        rejectFirst = reject;
                    });
                }

                runtime.setPhase("idle");

                return { ...runtime.status };
            };

            runtime.stop = async () => {
                runtime.stops += 1;
                runtime.setPhase("stopped");
                rejectFirst?.(new Error("start cancelled"));

                return new Promise((resolve) => {
                    releaseStop = resolve;
                });
            };

            processes.push(runtime);

            return runtime;
        });
        const first = pool.activate(launch("one")).catch((error: unknown) => error);
        await vi.waitFor(() => expect(processes).toHaveLength(1));
        const stopping = pool.stopActive();
        const replacement = pool.activate(launch("one"));
        releaseStop?.();

        expect(await first).toBeInstanceOf(Error);
        await stopping;
        await expect(replacement).resolves.toMatchObject({ phase: "idle" });
        expect(processes).toHaveLength(1);
        expect(pool.roster()).toMatchObject([{ sessionId: "one", active: true, status: { phase: "idle" } }]);
    });

    it("[C8] rejects a response when another runtime becomes active before it completes", async () => {
        const processes: FakeRuntime[] = [];
        let resolveRequest: ((value: unknown) => void) | undefined;
        const pool = new RuntimePool(() => {
            const runtime = new FakeRuntime();
            processes.push(runtime);

            return runtime;
        });
        await pool.activate(launch("one"));
        processes[0]!.request = () =>
            new Promise((resolve) => {
                resolveRequest = resolve;
            });
        const pending = pool.request({ type: "get_messages" });

        await pool.activate(launch("two"));
        resolveRequest?.([]);

        await expect(pending).rejects.toThrow("active Pi runtime changed");
    });

    it("[C5] does not alias case-distinct POSIX session paths", async () => {
        const processes: FakeRuntime[] = [];
        const pool = new RuntimePool(() => {
            const runtime = new FakeRuntime();
            processes.push(runtime);

            return runtime;
        }, "linux");
        await pool.activate({ projectId: "project", cwd: "/project", trust: "deny", sessionPath: "/tmp/A.jsonl" });
        await pool.activate({ projectId: "project", cwd: "/project", trust: "deny", sessionPath: "/tmp/a.jsonl" });

        expect(processes).toHaveLength(2);
    });

    it("[B5] advances the visible generation only for a completed replacement", async () => {
        const pool = new RuntimePool(() => new FakeRuntime());
        await pool.activate(launch("one"));
        const before = pool.snapshot().status.generation;

        await pool.request({ type: "new_session" });

        expect(pool.snapshot().status.generation).toBe(before + 1);
        expect(pool.activeIdentity()?.sessionId).toBeUndefined();
    });

    it("[B5] accepts Pi's reserved session path before the JSONL leaf is materialized", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "specpi-reserved-session-"));
        const reportedPath = `${directory}${path.sep}${path.sep}future.jsonl`;
        const expectedPath = path.join(await realpath(directory), "future.jsonl");
        const runtime = new FakeRuntime();
        let replaced = false;
        runtime.request = async (command) => {
            if (command.type === "new_session") {
                replaced = true;

                return { cancelled: false };
            }

            if (command.type === "get_state" && replaced) {
                return { sessionId: "fresh-session", sessionFile: reportedPath };
            }

            return {};
        };

        const pool = new RuntimePool(() => runtime);

        try {
            await pool.activate({ projectId: "project", cwd: directory, trust: "deny" });
            await pool.request({ type: "new_session" });

            await expect(pool.request({ type: "get_state" })).resolves.toMatchObject({
                sessionId: "fresh-session",
                sessionFile: reportedPath,
            });
            expect(pool.activeIdentity()).toMatchObject({
                projectId: "project",
                sessionId: "fresh-session",
                sessionPath: expectedPath,
            });
            await expect(access(expectedPath)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            await pool.stopAll();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("commits a get_state session identity only after its path is canonicalized", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "specpi-session-identity-"));
        const oldPath = path.join(directory, "old.jsonl");
        await writeFile(oldPath, "synthetic\n", "utf8");
        const canonicalOldPath = await realpath(oldPath);
        const runtime = new FakeRuntime();
        let response = { sessionId: "old-session", sessionFile: oldPath, sessionName: "Old session" };
        runtime.request = async (command) => (command.type === "get_state" ? response : {});
        const pool = new RuntimePool(() => runtime);

        try {
            await pool.activate({ projectId: "project", cwd: directory, trust: "deny" });
            await pool.request({ type: "get_state" });
            response = {
                sessionId: "new-session",
                sessionFile: path.join(directory, "missing-parent", "future.jsonl"),
                sessionName: "New session",
            };

            await expect(pool.request({ type: "get_state" })).rejects.toMatchObject({ code: "ENOENT" });
            expect(pool.activeIdentity()).toMatchObject({
                sessionId: "old-session",
                sessionPath: canonicalOldPath,
                sessionName: "Old session",
            });
        } finally {
            await pool.stopAll();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("[B5] treats cancelled replacements as no-ops", async () => {
        const processes: FakeRuntime[] = [];
        const pool = new RuntimePool(() => {
            const runtime = new FakeRuntime();
            runtime.request = async (command) => (command.type === "new_session" ? { cancelled: true } : {});
            processes.push(runtime);

            return runtime;
        });
        await pool.activate(launch("one"));
        const generation = pool.snapshot().status.generation;
        await pool.request({ type: "new_session" });

        expect(pool.snapshot().status.generation).toBe(generation);
        expect(pool.activeIdentity()).toMatchObject({ projectId: "project", sessionId: "one" });
    });
});
