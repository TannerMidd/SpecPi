import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RuntimeStartCancelledError } from "../../src/main/pi-process";
import { StateStore } from "../../src/main/state-store";
import { WorkspaceController, type WorkspaceContext } from "../../src/main/workspace-controller";
import type { RuntimeLaunchOptions, RuntimeStatus } from "../../src/shared/rpc";
import type { RuntimePool } from "../../src/main/runtime-pool";

class FakePool {
    launches: RuntimeLaunchOptions[] = [];
    reusable = false;
    identity?: {
        runtimeId: string;
        projectId: string;
        projectPath: string;
        sessionId?: string;
        sessionPath?: string;
        sessionName?: string;
    };

    hasUsableRuntime(): boolean {
        return this.reusable;
    }

    async activate(options: RuntimeLaunchOptions): Promise<RuntimeStatus> {
        this.launches.push(options);
        this.identity = {
            runtimeId: "runtime",
            projectId: options.projectId,
            projectPath: options.cwd,
            ...(options.sessionId ? { sessionId: options.sessionId } : {}),
            ...(options.sessionPath ? { sessionPath: options.sessionPath } : {}),
        };

        return { generation: 1, phase: "idle", cwd: options.cwd };
    }

    activeIdentity() {
        return this.identity;
    }
}

function context(id: string, pool: FakePool): WorkspaceContext {
    return { id, runtimes: pool as unknown as RuntimePool };
}

async function setup(now = 1_000): Promise<{
    store: StateStore;
    controller: WorkspaceController;
    projectId: string;
    pool: FakePool;
    window: WorkspaceContext;
    setNow(value: number): void;
}> {
    const directory = path.join(os.tmpdir(), `specpi-workspace-${crypto.randomUUID()}`);
    const store = new StateStore(directory, { randomId: () => crypto.randomUUID() });
    await store.load();
    let clock = now;
    const controller = new WorkspaceController(store, {
        canonicalize: async (value) => value,
        canonicalizeSession: async (value) => value,
        now: () => clock,
        randomId: () => crypto.randomUUID(),
    });
    const project = await controller.registerProject("/projects/one");
    const pool = new FakePool();
    const window = context("window-one", pool);

    return { store, controller, projectId: project.id, pool, window, setNow: (value) => (clock = value) };
}

describe("workspace capability controller", () => {
    it("[B1] keeps trust in the one launch and never persists it", async () => {
        const fixture = await setup();
        await fixture.controller.activate(fixture.window, { projectId: fixture.projectId }, async () => "approve");

        expect(fixture.pool.launches[0]).toMatchObject({
            projectId: fixture.projectId,
            cwd: "/projects/one",
            trust: "approve",
        });
        expect(JSON.stringify(fixture.store.get())).not.toContain("trust");
    });

    it("[B1] prompts once per new process and not when reactivating a usable runtime", async () => {
        const fixture = await setup();
        const chooseTrust = vi.fn(async () => "deny" as const);
        await fixture.controller.activate(fixture.window, { projectId: fixture.projectId }, chooseTrust);
        fixture.pool.reusable = true;
        await fixture.controller.activate(fixture.window, { projectId: fixture.projectId }, chooseTrust);

        expect(chooseTrust).toHaveBeenCalledTimes(1);
    });

    it("[B1] cancels before creating a process when native trust is dismissed", async () => {
        const fixture = await setup();
        await expect(
            fixture.controller.activate(fixture.window, { projectId: fixture.projectId }, async () => undefined),
        ).resolves.toEqual({ cancelled: true });
        expect(fixture.pool.launches).toEqual([]);
    });

    it("returns a cancelled start when main rejects compatibility mode", async () => {
        const fixture = await setup();
        fixture.pool.activate = async () => {
            throw new RuntimeStartCancelledError("Pi compatibility mode was cancelled");
        };

        await expect(
            fixture.controller.activate(
                fixture.window,
                { projectId: fixture.projectId },
                async () => "deny",
                async () => false,
            ),
        ).resolves.toEqual({ cancelled: true });
        expect(fixture.window.activeProjectId).toBeUndefined();
    });

    it("[B2/B3] resumes only a registered session owned by the requested project", async () => {
        const fixture = await setup();
        await fixture.store.saveActiveSession(
            { projectId: fixture.projectId, sessionId: "session", sessionPath: "/sessions/one.jsonl" },
            { draft: "" },
        );
        const other = await fixture.controller.registerProject("/projects/two");

        await expect(
            fixture.controller.activate(
                fixture.window,
                { projectId: other.id, sessionId: "session" },
                async () => "deny",
            ),
        ).rejects.toThrow("does not belong");
        expect(fixture.pool.launches).toEqual([]);
    });

    it("reopens and registers a Pi-reserved session before its JSONL leaf exists", async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "specpi-reserved-workspace-"));
        const projectPath = path.join(directory, "project");
        const sessionDirectory = path.join(directory, "sessions");
        await Promise.all([mkdir(projectPath), mkdir(sessionDirectory)]);
        const store = new StateStore(path.join(directory, "state"));
        await store.load();
        const controller = new WorkspaceController(store);
        const project = await controller.registerProject(projectPath);
        const reservedPath = path.join(sessionDirectory, "future.jsonl");
        await store.saveActiveSession(
            { projectId: project.id, sessionId: "future-session", sessionPath: reservedPath },
            { draft: "" },
        );
        const pool = new FakePool();
        const window = context("reserved-window", pool);

        try {
            await controller.activate(
                window,
                { projectId: project.id, sessionId: "future-session" },
                async () => "deny",
            );
            const canonicalReservedPath = path.join(await realpath(sessionDirectory), "future.jsonl");
            expect(pool.launches[0]).toMatchObject({
                projectId: project.id,
                sessionId: "future-session",
                sessionPath: canonicalReservedPath,
            });
            await expect(controller.saveActiveSession(window, { draft: "draft" })).resolves.toMatchObject({
                activeSessionId: "future-session",
            });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("[B2] hands an opaque selected session to Pi as a target-project fork", async () => {
        const fixture = await setup();
        fixture.window.activeProjectId = fixture.projectId;
        fixture.window.activeProjectPath = "/projects/one";
        const selection = await fixture.controller.createSessionImport(fixture.window, "/sessions/source.jsonl");
        const chooseTrust = vi.fn(async () => "deny" as const);
        await fixture.controller.activate(
            fixture.window,
            { projectId: fixture.projectId, importToken: selection.token },
            chooseTrust,
        );

        expect(fixture.pool.launches[0]).toMatchObject({
            projectId: fixture.projectId,
            cwd: "/projects/one",
            forkSessionPath: "/sessions/source.jsonl",
            trust: "deny",
        });
        expect(fixture.pool.launches[0]?.sessionPath).toBeUndefined();
        await expect(
            fixture.controller.activate(
                fixture.window,
                { projectId: fixture.projectId, importToken: selection.token },
                chooseTrust,
            ),
        ).rejects.toThrow("invalid or expired");
    });

    it("releases a failed import reservation and consumes it after successful startup", async () => {
        const fixture = await setup();
        fixture.window.activeProjectId = fixture.projectId;
        fixture.window.activeProjectPath = "/projects/one";
        const selection = await fixture.controller.createSessionImport(fixture.window, "/sessions/source.jsonl");
        fixture.pool.activate = async () => {
            throw new Error("Pi failed to start");
        };

        await expect(
            fixture.controller.activate(
                fixture.window,
                { projectId: fixture.projectId, importToken: selection.token },
                async () => "deny",
            ),
        ).rejects.toThrow("Pi failed");
        fixture.pool.activate = FakePool.prototype.activate.bind(fixture.pool);
        await fixture.controller.activate(
            fixture.window,
            { projectId: fixture.projectId, importToken: selection.token },
            async () => "deny",
        );
        await expect(
            fixture.controller.activate(
                fixture.window,
                { projectId: fixture.projectId, importToken: selection.token },
                async () => "deny",
            ),
        ).rejects.toThrow("invalid or expired");
    });

    it("rejects concurrent use while an import capability is reserved", async () => {
        const fixture = await setup();
        fixture.window.activeProjectId = fixture.projectId;
        fixture.window.activeProjectPath = "/projects/one";
        const selection = await fixture.controller.createSessionImport(fixture.window, "/sessions/source.jsonl");
        let releaseTrust: ((value: "deny") => void) | undefined;
        const first = fixture.controller.activate(
            fixture.window,
            { projectId: fixture.projectId, importToken: selection.token },
            () =>
                new Promise((resolve) => {
                    releaseTrust = resolve;
                }),
        );

        await expect(
            fixture.controller.activate(
                fixture.window,
                { projectId: fixture.projectId, importToken: selection.token },
                async () => "deny",
            ),
        ).rejects.toThrow("transition is already in progress");
        releaseTrust?.("deny");
        await first;
    });

    it("rejects wrong-window, wrong-project, and expired import capabilities", async () => {
        const fixture = await setup();
        fixture.window.activeProjectId = fixture.projectId;
        fixture.window.activeProjectPath = "/projects/one";
        const wrongWindow = await fixture.controller.createSessionImport(fixture.window, "/sessions/window.jsonl");
        await expect(
            fixture.controller.activate(
                context("window-two", fixture.pool),
                { projectId: fixture.projectId, importToken: wrongWindow.token },
                async () => "deny",
            ),
        ).rejects.toThrow("invalid or expired");

        const wrongProject = await fixture.controller.createSessionImport(fixture.window, "/sessions/project.jsonl");
        const other = await fixture.controller.registerProject("/projects/two");
        await expect(
            fixture.controller.activate(
                fixture.window,
                { projectId: other.id, importToken: wrongProject.token },
                async () => "deny",
            ),
        ).rejects.toThrow("different target project");

        const expired = await fixture.controller.createSessionImport(fixture.window, "/sessions/expired.jsonl");
        fixture.setNow(1_000 + 5 * 60_000);
        await expect(
            fixture.controller.activate(
                fixture.window,
                { projectId: fixture.projectId, importToken: expired.token },
                async () => "deny",
            ),
        ).rejects.toThrow("invalid or expired");
    });

    it("[B3] authorizes metadata and file roots only for the active runtime project", async () => {
        const fixture = await setup();
        await fixture.controller.activate(fixture.window, { projectId: fixture.projectId }, async () => "deny");
        fixture.pool.identity = {
            runtimeId: "runtime",
            projectId: fixture.projectId,
            projectPath: "/projects/one",
            sessionId: "session",
            sessionPath: "/sessions/one.jsonl",
            sessionName: "Pi name",
        };
        await fixture.controller.saveActiveSession(fixture.window, { draft: "draft" });

        expect(await fixture.controller.activeProjectRoot(fixture.window, fixture.projectId)).toBe("/projects/one");
        await expect(fixture.controller.activeProjectRoot(fixture.window, "another-project")).rejects.toThrow(
            "not active",
        );
        expect(fixture.store.get().sessions[0]).toMatchObject({
            id: "session",
            projectId: fixture.projectId,
            name: "Pi name",
            draft: "draft",
        });
        await expect(fixture.controller.saveSessionDraft(fixture.window, "other", "forged")).rejects.toThrow(
            "active runtime",
        );
    });
});
