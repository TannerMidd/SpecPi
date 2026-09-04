import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../../src/main/state-store";

function temporaryStateDirectory(): string {
    return path.join(os.tmpdir(), `specpi-state-${crypto.randomUUID()}`);
}

describe("desktop state store", () => {
    it("serializes concurrent atomic preference updates without losing fields", async () => {
        const directory = temporaryStateDirectory();
        const store = new StateStore(directory);
        await store.load();
        await Promise.all([
            store.updatePreferences({ theme: "light" }),
            store.updatePreferences({ layout: { filesOpen: true } }),
            store.updatePreferences({ layout: { sidebarOpen: false } }),
        ]);
        const parsed = JSON.parse(await readFile(path.join(directory, "desktop-state.json"), "utf8"));
        expect(parsed).toMatchObject({
            schema: 2,
            revision: 3,
            theme: "light",
            layout: { filesOpen: true, sidebarOpen: false },
        });
    });

    it("saves active-session metadata without accepting renderer-owned identity", async () => {
        const directory = temporaryStateDirectory();
        const store = new StateStore(directory, { platform: "win32" });
        await store.load();
        const { project } = await store.upsertProject("C:/project", "project");
        await store.saveActiveSession(
            {
                projectId: project.id,
                sessionId: "session-a",
                sessionPath: "C:/sessions/a.jsonl",
                name: "Pi name",
            },
            { draft: "old", model: "provider/model" },
        );
        await Promise.all([
            store.updateSessionDraft("session-a", "new"),
            store.updateSessionTitle("session-a", "First prompt title"),
            store.updatePreferences({ theme: "light" }),
        ]);
        await store.updateSessionTitle("session-a", "A later prompt");
        const state = store.get();
        expect(state.sessions[0]).toMatchObject({
            id: "session-a",
            projectId: project.id,
            name: "Pi name",
            draft: "new",
        });
        expect(state.sessions[0]?.title).toBeUndefined();
        expect(state.projects[0]?.lastSessionId).toBe("session-a");
        expect(state.activeSessionId).toBe("session-a");
    });

    it("keeps an existing session in place when Pi reports it again", async () => {
        const directory = temporaryStateDirectory();
        const store = new StateStore(directory);
        await store.load();
        const { project } = await store.upsertProject(directory, "project");
        for (const id of ["one", "two", "three"]) {
            await store.saveActiveSession(
                { projectId: project.id, sessionId: id, sessionPath: path.join(directory, `${id}.jsonl`) },
                { draft: "" },
            );
        }

        const before = store.get().sessions.map((session) => session.id);
        await store.saveActiveSession(
            { projectId: project.id, sessionId: "two", sessionPath: path.join(directory, "two.jsonl") },
            { title: "Updated session", draft: "" },
        );

        expect(store.get().sessions.map((session) => session.id)).toEqual(before);
        expect(store.get().sessions.find((session) => session.id === "two")?.title).toBe("Updated session");
    });

    it("removes a session and its active/recent references atomically", async () => {
        const directory = temporaryStateDirectory();
        const store = new StateStore(directory);
        await store.load();
        const { project } = await store.upsertProject(directory, "project");
        await store.saveActiveSession(
            { projectId: project.id, sessionId: "session", sessionPath: path.join(directory, "session.jsonl") },
            { draft: "draft" },
        );

        const removed = await store.removeSession("session");

        expect(removed.sessions).toEqual([]);
        expect(removed.activeSessionId).toBeUndefined();
        expect(removed.projects[0]?.lastSessionId).toBeUndefined();
    });

    it("[C4] atomically retains projects added from independent windows", async () => {
        const directory = temporaryStateDirectory();
        const store = new StateStore(directory);
        await store.load();
        await Promise.all([
            store.upsertProject(path.join(directory, "one"), "one"),
            store.upsertProject(path.join(directory, "two"), "two"),
        ]);

        expect(
            store
                .get()
                .projects.map((project) => project.label)
                .sort(),
        ).toEqual(["one", "two"]);
    });

    it("[B1/B2] migrates schema 1 without persisting trust or unverified session associations", async () => {
        const directory = temporaryStateDirectory();
        await mkdir(directory, { recursive: true });
        await writeFile(
            path.join(directory, "desktop-state.json"),
            JSON.stringify({
                schema: 1,
                piPath: "C:/bin/pi.cmd",
                theme: "dark",
                projects: [
                    {
                        id: "project",
                        path: "C:/project",
                        label: "project",
                        lastOpenedAt: "2026-01-01T00:00:00.000Z",
                        trust: "approve",
                        pinned: false,
                        lastSessionPath: "C:/sessions/one.jsonl",
                    },
                ],
                sessions: [
                    {
                        id: "one",
                        projectId: "project",
                        sessionId: "one",
                        sessionPath: "C:/sessions/one.jsonl",
                        lastOpenedAt: "2026-01-01T00:00:00.000Z",
                        draft: "draft",
                    },
                ],
                activeProjectId: "project",
                activeSessionId: "one",
                layout: { filesOpen: false, filesWidth: 420 },
            }),
        );
        const store = new StateStore(directory);
        const state = await store.load();
        const persisted = await readFile(path.join(directory, "desktop-state.json"), "utf8");

        expect(state).toMatchObject({
            schema: 2,
            revision: 0,
            piPath: "C:/bin/pi.cmd",
            activeProjectId: "project",
            sessions: [],
            layout: { inspectorOpen: true, sidebarOpen: true },
        });
        expect(state.activeSessionId).toBeUndefined();
        expect(state.projects[0]?.lastSessionId).toBeUndefined();
        expect(persisted).not.toContain("trust");
        expect(persisted).not.toContain("lastSessionPath");
    });

    it("[C6] quarantines malformed nested state and recovers validated defaults", async () => {
        const directory = temporaryStateDirectory();
        await mkdir(directory, { recursive: true });
        await writeFile(
            path.join(directory, "desktop-state.json"),
            JSON.stringify({
                schema: 2,
                revision: 1,
                theme: "dark",
                projects: [{ id: "project", path: 42 }],
                sessions: [],
                layout: { filesOpen: false, filesWidth: 420, inspectorOpen: true, sidebarOpen: true },
            }),
        );
        const store = new StateStore(directory);
        expect(await store.load()).toMatchObject({ schema: 2, revision: 0, projects: [], sessions: [] });
        expect((await readdir(directory)).some((name) => name.startsWith("desktop-state.json.corrupt-"))).toBe(true);
    });

    it("[C5] preserves case-distinct paths on Linux and folds them on Windows", async () => {
        const linuxStore = new StateStore(temporaryStateDirectory(), { platform: "linux" });
        await linuxStore.load();
        await linuxStore.upsertProject("/tmp/SpecPi-A", "upper");
        await linuxStore.upsertProject("/tmp/specpi-a", "lower");
        expect(linuxStore.get().projects).toHaveLength(2);

        const windowsStore = new StateStore(temporaryStateDirectory(), { platform: "win32" });
        await windowsStore.load();
        await windowsStore.upsertProject("C:\\SpecPi", "upper");
        await windowsStore.upsertProject("c:/specpi", "lower");
        expect(windowsStore.get().projects).toHaveLength(1);
    });
});
