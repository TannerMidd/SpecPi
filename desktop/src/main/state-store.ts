import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DesktopState, ProjectRecord, SessionRecord } from "../shared/domain";
import type { ActiveSessionMetadata } from "../shared/rpc";
import { desktopStateSchema, legacyDesktopStateSchema } from "../shared/schemas";
import { pathIdentity } from "./path-identity";

const defaultState = (): DesktopState => ({
    schema: 2,
    revision: 0,
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

export interface ActiveSessionIdentity {
    projectId: string;
    sessionId: string;
    sessionPath: string;
    name?: string;
}

interface StateStoreOptions {
    platform?: NodeJS.Platform;
    now?: () => Date;
    randomId?: () => string;
}

function migrateLegacy(value: unknown): DesktopState {
    const legacy = legacyDesktopStateSchema.parse(value);

    return {
        schema: 2,
        revision: 0,
        ...(legacy.piPath ? { piPath: legacy.piPath } : {}),
        theme: legacy.theme,
        projects: legacy.projects.map(({ trust: _trust, lastSessionPath: _lastSessionPath, ...project }) => project),
        sessions: [],
        ...(legacy.activeProjectId && legacy.projects.some((project) => project.id === legacy.activeProjectId)
            ? { activeProjectId: legacy.activeProjectId }
            : {}),
        layout: {
            filesOpen: legacy.layout.filesOpen,
            filesWidth: legacy.layout.filesWidth,
            inspectorOpen: legacy.layout.inspectorOpen ?? true,
            sidebarOpen: legacy.layout.sidebarOpen ?? true,
        },
    };
}

export class StateStore {
    readonly #file: string;
    readonly #platform: NodeJS.Platform;
    readonly #now: () => Date;
    readonly #randomId: () => string;
    #state: DesktopState = defaultState();
    #operationQueue: Promise<void> = Promise.resolve();

    constructor(directory: string, options: StateStoreOptions = {}) {
        this.#file = path.join(directory, "desktop-state.json");
        this.#platform = options.platform ?? process.platform;
        this.#now = options.now ?? (() => new Date());
        this.#randomId = options.randomId ?? randomUUID;
    }

    async load(): Promise<DesktopState> {
        await mkdir(path.dirname(this.#file), { recursive: true });
        try {
            const source = await readFile(this.#file, "utf8");
            const raw: unknown = JSON.parse(source);
            const isLegacy = typeof raw === "object" && raw !== null && "schema" in raw && raw.schema === 1;
            const parsed = isLegacy ? migrateLegacy(raw) : desktopStateSchema.parse(raw);
            this.#state = this.#validate(parsed);
            const sanitized = `${JSON.stringify(this.#state, null, 2)}\n`;
            if (isLegacy || sanitized !== source) {
                await this.#write(this.#state);
            }
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

        return this.get();
    }

    get(): DesktopState {
        return structuredClone(this.#state);
    }

    getProject(projectId: string): ProjectRecord | undefined {
        const project = this.#state.projects.find((item) => item.id === projectId);

        return project ? structuredClone(project) : undefined;
    }

    getSession(sessionId: string): SessionRecord | undefined {
        const session = this.#state.sessions.find((item) => item.id === sessionId);

        return session ? structuredClone(session) : undefined;
    }

    async updatePreferences(patch: {
        theme?: DesktopState["theme"];
        layout?: Partial<DesktopState["layout"]>;
    }): Promise<DesktopState> {
        return this.#commit((state) => {
            if (patch.theme !== undefined) {
                state.theme = patch.theme;
            }

            if (patch.layout) {
                state.layout = { ...state.layout, ...patch.layout };
            }
        });
    }

    async upsertProject(
        projectPath: string,
        label = path.basename(projectPath) || projectPath,
    ): Promise<{
        project: ProjectRecord;
        state: DesktopState;
    }> {
        let projectId = "";
        const state = await this.#commit((draft) => {
            const key = pathIdentity(projectPath, this.#platform);
            const existing = draft.projects.find((project) => pathIdentity(project.path, this.#platform) === key);
            const now = this.#now().toISOString();
            if (existing) {
                existing.path = projectPath;
                existing.label = label;
                existing.lastOpenedAt = now;
                projectId = existing.id;

                return;
            }

            projectId = this.#randomId();
            draft.projects.unshift({
                id: projectId,
                path: projectPath,
                label,
                lastOpenedAt: now,
                pinned: false,
            });
        });
        const project = state.projects.find((item) => item.id === projectId);
        if (!project) {
            throw new Error("Project registration failed");
        }

        return { project, state };
    }

    async updateProjectPath(projectId: string, projectPath: string): Promise<DesktopState> {
        return this.#commit((state) => {
            const project = state.projects.find((item) => item.id === projectId);
            if (!project) {
                throw new Error("The selected project is no longer registered");
            }

            const key = pathIdentity(projectPath, this.#platform);
            if (
                state.projects.some((item) => item.id !== projectId && pathIdentity(item.path, this.#platform) === key)
            ) {
                throw new Error("The canonical project path is already registered");
            }

            project.path = projectPath;
        });
    }

    async setPiExecutable(piPath?: string): Promise<DesktopState> {
        return this.#commit((state) => {
            if (piPath) {
                state.piPath = piPath;
            } else {
                delete state.piPath;
            }
        });
    }

    async setActiveWorkspace(projectId: string, sessionId?: string): Promise<DesktopState> {
        return this.#commit((state) => {
            if (!state.projects.some((project) => project.id === projectId)) {
                throw new Error("The selected project is no longer registered");
            }

            if (sessionId) {
                const session = state.sessions.find((item) => item.id === sessionId);
                if (!session || session.projectId !== projectId) {
                    throw new Error("The selected session does not belong to this project");
                }

                state.activeSessionId = sessionId;
            } else {
                delete state.activeSessionId;
            }

            state.activeProjectId = projectId;
        });
    }

    async removeSession(sessionId: string): Promise<DesktopState> {
        return this.#commit((state) => {
            const session = state.sessions.find((item) => item.id === sessionId);
            if (!session) {
                throw new Error("The selected session is no longer registered");
            }

            state.sessions = state.sessions.filter((item) => item.id !== sessionId);
            const project = state.projects.find((item) => item.id === session.projectId);
            if (project?.lastSessionId === sessionId) {
                project.lastSessionId = undefined;
            }

            if (state.activeSessionId === sessionId) {
                state.activeSessionId = undefined;
            }
        });
    }

    async updateSessionDraft(sessionId: string, draft: string): Promise<DesktopState> {
        return this.#commit((state) => {
            const session = state.sessions.find((item) => item.id === sessionId);
            if (!session) {
                throw new Error("The active session is no longer registered");
            }

            session.draft = draft;
        });
    }

    async updateSessionTitle(sessionId: string, title: string): Promise<DesktopState> {
        return this.#commit((state) => {
            const session = state.sessions.find((item) => item.id === sessionId);
            if (!session) {
                throw new Error("The active session is no longer registered");
            }

            if (!session.name?.trim() && !session.title?.trim()) {
                session.title = title;
            }
        });
    }

    async saveActiveSession(identity: ActiveSessionIdentity, metadata: ActiveSessionMetadata): Promise<DesktopState> {
        return this.#commit((state) => {
            const project = state.projects.find((item) => item.id === identity.projectId);
            if (!project) {
                throw new Error("The active runtime project is no longer registered");
            }

            const sessionPathKey = pathIdentity(identity.sessionPath, this.#platform);
            const existing = state.sessions.find(
                (item) =>
                    item.id === identity.sessionId || pathIdentity(item.sessionPath, this.#platform) === sessionPathKey,
            );
            const record: SessionRecord = {
                id: identity.sessionId,
                projectId: identity.projectId,
                sessionId: identity.sessionId,
                sessionPath: identity.sessionPath,
                ...(identity.name?.trim() ? { name: identity.name.trim().slice(0, 200) } : {}),
                ...(metadata.title?.trim()
                    ? { title: metadata.title }
                    : existing?.title
                      ? { title: existing.title }
                      : {}),
                ...(metadata.model ? { model: metadata.model } : existing?.model ? { model: existing.model } : {}),
                lastOpenedAt: this.#now().toISOString(),
                draft: metadata.draft ?? existing?.draft ?? "",
                ...(existing?.scrollTop !== undefined ? { scrollTop: existing.scrollTop } : {}),
            };
            const matches = (item: SessionRecord) =>
                item.id === record.id || pathIdentity(item.sessionPath, this.#platform) === sessionPathKey;
            const index = state.sessions.findIndex(matches);
            state.sessions = state.sessions.filter((item, itemIndex) => itemIndex === index || !matches(item));
            if (index >= 0) {
                state.sessions[index] = record;
            } else {
                state.sessions.unshift(record);
            }

            state.sessions = state.sessions.slice(0, 2_000);
            project.lastSessionId = record.id;
            project.lastOpenedAt = record.lastOpenedAt;
            state.activeProjectId = project.id;
            state.activeSessionId = record.id;
        });
    }

    async #commit(mutator: (state: DesktopState) => void): Promise<DesktopState> {
        let result: DesktopState | undefined;
        const operation = this.#operationQueue.then(async () => {
            const draft = structuredClone(this.#state);
            mutator(draft);
            draft.revision = this.#state.revision + 1;
            const next = this.#validate(draft);
            await this.#write(next);
            this.#state = next;
            result = this.get();
        });
        this.#operationQueue = operation.catch(() => undefined);
        await operation;

        return result ?? this.get();
    }

    #validate(candidate: DesktopState): DesktopState {
        const state = desktopStateSchema.parse(candidate);
        const projectIds = new Set<string>();
        const projectPaths = new Set<string>();
        for (const project of state.projects) {
            const key = pathIdentity(project.path, this.#platform);
            if (projectIds.has(project.id) || projectPaths.has(key)) {
                throw new Error("Desktop state contains a duplicate project");
            }

            projectIds.add(project.id);
            projectPaths.add(key);
        }

        const sessionIds = new Set<string>();
        const sessionPaths = new Set<string>();
        for (const session of state.sessions) {
            const key = pathIdentity(session.sessionPath, this.#platform);
            if (sessionIds.has(session.id) || sessionPaths.has(key)) {
                throw new Error("Desktop state contains a duplicate session");
            }

            if (!projectIds.has(session.projectId)) {
                throw new Error("Desktop state contains a session without its project");
            }

            sessionIds.add(session.id);
            sessionPaths.add(key);
        }

        if (state.activeProjectId && !projectIds.has(state.activeProjectId)) {
            throw new Error("Desktop state contains an invalid active project");
        }

        if (state.activeSessionId) {
            const active = state.sessions.find((session) => session.id === state.activeSessionId);
            if (!active || active.projectId !== state.activeProjectId) {
                throw new Error("Desktop state contains an invalid active session");
            }
        }

        for (const project of state.projects) {
            if (
                project.lastSessionId &&
                !state.sessions.some(
                    (session) => session.id === project.lastSessionId && session.projectId === project.id,
                )
            ) {
                throw new Error("Desktop state contains an invalid recent session");
            }
        }

        return state;
    }

    async #write(state: DesktopState): Promise<void> {
        const temporary = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
            await rename(temporary, this.#file);
        } finally {
            await rm(temporary, { force: true }).catch(() => undefined);
        }
    }
}
