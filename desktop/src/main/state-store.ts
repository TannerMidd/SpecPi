import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DesktopState, SessionRecord } from "../shared/domain";
import type { DesktopStatePatch } from "../shared/ipc";
import { mergeSessionRecord } from "../shared/session-registry";

const defaultState = (): DesktopState => ({
    schema: 1,
    theme: "dark",
    projects: [],
    sessions: [],
    layout: {
        filesOpen: false,
        filesWidth: 420,
        inspectorOpen: true,
        sidebarOpen: true,
    },
});

export class StateStore {
    readonly #file: string;
    #state: DesktopState = defaultState();
    #writeQueue: Promise<void> = Promise.resolve();

    constructor(directory: string) {
        this.#file = path.join(directory, "desktop-state.json");
    }

    async load(): Promise<DesktopState> {
        await mkdir(path.dirname(this.#file), { recursive: true });
        try {
            const parsed = JSON.parse(await readFile(this.#file, "utf8")) as Partial<DesktopState>;
            if (parsed.schema !== 1 || !Array.isArray(parsed.projects) || !Array.isArray(parsed.sessions)) {
                throw new Error("Unsupported desktop state schema");
            }

            this.#state = {
                ...defaultState(),
                ...parsed,
                layout: { ...defaultState().layout, ...parsed.layout },
            } as DesktopState;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                const quarantine = `${this.#file}.corrupt-${Date.now()}`;
                try {
                    await rename(this.#file, quarantine);
                } catch {
                    // A failed quarantine still must not affect Pi state.
                }
            }

            this.#state = defaultState();
        }

        return structuredClone(this.#state);
    }

    get(): DesktopState {
        return structuredClone(this.#state);
    }

    async updateSessionDraft(sessionId: string, draft: string): Promise<DesktopState> {
        return this.update({
            sessions: this.#state.sessions.map((session) =>
                session.id === sessionId ? { ...session, draft } : session,
            ),
        });
    }

    async updateSessionTitle(sessionId: string, title: string): Promise<DesktopState> {
        return this.update({
            sessions: this.#state.sessions.map((session) =>
                session.id === sessionId && !session.name?.trim() && !session.title?.trim()
                    ? { ...session, title }
                    : session,
            ),
        });
    }

    async saveSession(session: SessionRecord): Promise<DesktopState> {
        const sessions = mergeSessionRecord(this.#state.sessions, session);
        const projects = this.#state.projects.map((project) =>
            project.id === session.projectId
                ? { ...project, lastSessionPath: session.sessionPath, lastOpenedAt: session.lastOpenedAt }
                : project,
        );

        return this.update({
            sessions,
            projects,
            activeSessionId: session.id,
            activeProjectId: session.projectId,
        });
    }

    async update(patch: DesktopStatePatch): Promise<DesktopState> {
        this.#state = {
            ...this.#state,
            ...patch,
            layout: { ...this.#state.layout, ...patch.layout },
        };
        const snapshot = JSON.stringify(this.#state, null, 2);
        this.#writeQueue = this.#writeQueue.then(async () => {
            const temporary = `${this.#file}.${process.pid}.tmp`;
            await writeFile(temporary, `${snapshot}\n`, { encoding: "utf8", mode: 0o600 });
            await rename(temporary, this.#file);
        });
        await this.#writeQueue;

        return this.get();
    }
}
