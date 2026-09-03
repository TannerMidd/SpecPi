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

    it("quarantines corrupt state and recovers defaults", async () => {
        const directory = path.join(os.tmpdir(), `specpi-state-${crypto.randomUUID()}`);
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, "desktop-state.json"), "not-json");
        const store = new StateStore(directory);
        expect(await store.load()).toMatchObject({ schema: 1, projects: [], sessions: [] });
    });
});
