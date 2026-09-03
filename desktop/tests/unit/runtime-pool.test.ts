import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { RuntimePool } from "../../src/main/runtime-pool";
import type {
    ExtensionUiResponse,
    RpcCommand,
    RuntimeEvent,
    RuntimeSnapshot,
    RuntimeStatus,
    StartRuntimeOptions,
} from "../../src/shared/rpc";

class FakeRuntime extends EventEmitter {
    status: RuntimeStatus = { generation: 0, phase: "stopped" };
    pendingUi: RuntimeSnapshot["pendingUi"] = [];
    options?: StartRuntimeOptions;
    starts = 0;
    stops = 0;

    snapshot(): RuntimeSnapshot {
        return { status: { ...this.status }, pendingUi: [...this.pendingUi] };
    }

    diagnostics(): readonly string[] {
        return [];
    }

    async start(options: StartRuntimeOptions): Promise<RuntimeStatus> {
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
            return { sessionFile: this.options?.sessionPath };
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

describe("desktop runtime pool", () => {
    it("keeps inactive sessions running and reactivates them without another process", async () => {
        const processes: FakeRuntime[] = [];
        const pool = new RuntimePool(() => {
            const runtime = new FakeRuntime();
            processes.push(runtime);

            return runtime;
        });
        const visibleEvents: RuntimeEvent[] = [];
        pool.on("event", (event: RuntimeEvent) => visibleEvents.push(event));

        await pool.activate({ cwd: "C:/project", trust: "deny", sessionPath: "C:/sessions/one.jsonl" });
        pool.authorizeExport("C:/exports/one.html");
        processes[0]!.setPhase("streaming");
        await pool.activate({ cwd: "C:/project", trust: "deny", sessionPath: "C:/sessions/two.jsonl" });

        expect(processes).toHaveLength(2);
        expect(pool.isExportAuthorized("C:/exports/one.html")).toBe(false);
        expect(processes[0]!.stops).toBe(0);
        expect(pool.roster()).toMatchObject([
            { sessionPath: "C:/sessions/one.jsonl", active: false, status: { phase: "streaming" } },
            { sessionPath: "C:/sessions/two.jsonl", active: true, status: { phase: "idle" } },
        ]);

        processes[0]!.send({ type: "message_end", message: { role: "assistant", content: "background" } });
        expect(visibleEvents).toEqual([]);

        await pool.activate({ cwd: "C:/project", trust: "deny", sessionPath: "c:\\sessions\\one.jsonl" });
        expect(processes).toHaveLength(2);
        expect(processes[0]!.starts).toBe(1);
        expect(processes[1]!.stops).toBe(0);
        expect(pool.snapshot().status.phase).toBe("streaming");
        expect(pool.isExportAuthorized("C:/exports/one.html")).toBe(true);
        processes[0]!.send({ type: "message_end", message: { role: "assistant", content: "visible again" } });
        expect(visibleEvents.at(-1)?.generation).toBe(pool.snapshot().status.generation);

        await pool.stopAll();
        expect(processes.map((runtime) => runtime.stops)).toEqual([1, 1]);
        expect(pool.roster()).toEqual([]);
    });

    it("replays pending UI when its background session becomes visible", async () => {
        const processes: FakeRuntime[] = [];
        const pool = new RuntimePool(() => {
            const runtime = new FakeRuntime();
            processes.push(runtime);

            return runtime;
        });
        await pool.activate({ cwd: "C:/project", trust: "deny", sessionPath: "C:/sessions/one.jsonl" });
        await pool.activate({ cwd: "C:/project", trust: "deny", sessionPath: "C:/sessions/two.jsonl" });
        processes[0]!.pendingUi = [
            { type: "extension_ui_request", id: "approval", method: "confirm", title: "Review" },
        ];
        processes[0]!.send({
            type: "extension_ui_request",
            id: "guard-status",
            method: "setStatus",
            statusKey: "guard",
            statusText: "Guard Off",
        });
        processes[0]!.setPhase("waiting-for-user");
        const visibleEvents: RuntimeEvent[] = [];
        pool.on("event", (event: RuntimeEvent) => visibleEvents.push(event));

        await pool.activate({ cwd: "C:/project", trust: "deny", sessionPath: "C:/sessions/one.jsonl" });

        expect(visibleEvents.map((event) => event.record.id)).toEqual(["guard-status", "approval"]);
    });
});
