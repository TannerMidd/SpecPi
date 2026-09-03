import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../../src/main/state-store";

describe("desktop state store", () => {
    it("serializes concurrent atomic updates without losing fields", async () => {
        const directory = path.join(os.tmpdir(), `specpi-state-${crypto.randomUUID()}`);
        const store = new StateStore(directory);
        await store.load();
        await Promise.all([
            store.update({ theme: "dark" }),
            store.update({ activeProjectId: "project" }),
            store.update({ layout: { filesOpen: true } }),
        ]);
        const parsed = JSON.parse(await readFile(path.join(directory, "desktop-state.json"), "utf8"));
        expect(parsed).toMatchObject({ theme: "dark", activeProjectId: "project", layout: { filesOpen: true } });
    });

    it("saves a session draft without replacing newer registry state", async () => {
        const directory = path.join(os.tmpdir(), `specpi-state-${crypto.randomUUID()}`);
        const store = new StateStore(directory);
        await store.load();
        await store.update({
            sessions: [
                {
                    id: "session-a",
                    projectId: "project-a",
                    sessionId: "session-a",
                    sessionPath: "C:/sessions/a.jsonl",
                    lastOpenedAt: new Date().toISOString(),
                    draft: "old",
                },
            ],
        });
        await Promise.all([
            store.updateSessionDraft("session-a", "new"),
            store.update({ activeProjectId: "project-a", activeSessionId: "session-a" }),
        ]);
        const state = store.get();
        expect(state.sessions[0]?.draft).toBe("new");
        expect(state.activeSessionId).toBe("session-a");
    });

    it("keeps an existing session in place when it becomes active", async () => {
        const directory = path.join(os.tmpdir(), `specpi-state-${crypto.randomUUID()}`);
        const store = new StateStore(directory);
        await store.load();
        const existing = [
            {
                id: "one",
                projectId: "project",
                sessionId: "one",
                sessionPath: "C:/sessions/one.jsonl",
                lastOpenedAt: "2026-01-01T00:00:00.000Z",
                draft: "",
            },
            {
                id: "two",
                projectId: "project",
                sessionId: "two",
                sessionPath: "C:/sessions/two.jsonl",
                lastOpenedAt: "2026-01-02T00:00:00.000Z",
                draft: "",
            },
            {
                id: "three",
                projectId: "project",
                sessionId: "three",
                sessionPath: "C:/sessions/three.jsonl",
                lastOpenedAt: "2026-01-03T00:00:00.000Z",
                draft: "",
            },
        ];
        await store.update({ sessions: existing });
        await store.saveSession({
            ...existing[1]!,
            name: "Updated session",
            lastOpenedAt: "2026-02-01T00:00:00.000Z",
        });

        const sessions = store.get().sessions;
        expect(sessions.map((session) => session.id)).toEqual(["one", "two", "three"]);
        expect(sessions[1]).toMatchObject({ name: "Updated session", lastOpenedAt: "2026-02-01T00:00:00.000Z" });
    });

    it("merges sessions atomically for independent windows", async () => {
        const directory = path.join(os.tmpdir(), `specpi-state-${crypto.randomUUID()}`);
        const store = new StateStore(directory);
        await store.load();
        await store.update({
            projects: [
                {
                    id: "project",
                    path: "C:/project",
                    label: "project",
                    lastOpenedAt: new Date().toISOString(),
                    trust: "deny",
                    pinned: false,
                },
            ],
        });
        await Promise.all([
            store.saveSession({
                id: "one",
                projectId: "project",
                sessionId: "one",
                sessionPath: "C:/sessions/one.jsonl",
                lastOpenedAt: new Date().toISOString(),
                draft: "",
            }),
            store.saveSession({
                id: "two",
                projectId: "project",
                sessionId: "two",
                sessionPath: "C:/sessions/two.jsonl",
                lastOpenedAt: new Date().toISOString(),
                draft: "",
            }),
        ]);
        expect(
            store
                .get()
                .sessions.map((session) => session.id)
                .sort(),
        ).toEqual(["one", "two"]);
    });

    it("fills new layout preferences when loading an older valid state", async () => {
        const directory = path.join(os.tmpdir(), `specpi-state-${crypto.randomUUID()}`);
        await mkdir(directory, { recursive: true });
        await writeFile(
            path.join(directory, "desktop-state.json"),
            JSON.stringify({
                schema: 1,
                theme: "dark",
                projects: [],
                sessions: [],
                layout: { filesOpen: false, filesWidth: 420 },
            }),
        );
        const store = new StateStore(directory);
        expect((await store.load()).layout).toMatchObject({ inspectorOpen: true, sidebarOpen: true });
    });

    it("quarantines corrupt state and recovers defaults", async () => {
        const directory = path.join(os.tmpdir(), `specpi-state-${crypto.randomUUID()}`);
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, "desktop-state.json"), "not-json");
        const store = new StateStore(directory);
        expect(await store.load()).toMatchObject({ schema: 1, projects: [], sessions: [] });
    });
});
