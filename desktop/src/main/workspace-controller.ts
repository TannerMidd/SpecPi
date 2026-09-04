import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DesktopState, ProjectRecord } from "../shared/domain";
import type {
    ActiveSessionMetadata,
    RuntimeStartResult,
    SessionImportSelection,
    WorkspaceRequest,
} from "../shared/rpc";
import { canonicalPath, canonicalSessionPath } from "./path-identity";
import { RuntimeStartCancelledError } from "./pi-process";
import type { RuntimePool } from "./runtime-pool";
import type { ActiveSessionIdentity, StateStore } from "./state-store";

const IMPORT_TTL_MS = 5 * 60_000;

interface ImportCapability {
    ownerId: string;
    projectId: string;
    path: string;
    name: string;
    expiresAt: number;
    reservation?: string;
}

export interface WorkspaceContext {
    id: string;
    runtimes: RuntimePool;
    activeProjectId?: string;
    activeProjectPath?: string;
}

export type TrustChoice = "default" | "approve" | "deny";
export type ChooseTrust = (project: ProjectRecord) => Promise<TrustChoice | undefined>;
export type ConfirmCompatibility = (warning: string) => Promise<boolean>;

interface WorkspaceControllerDependencies {
    canonicalize(value: string): Promise<string>;
    canonicalizeSession(value: string): Promise<string>;
    now(): number;
    randomId(): string;
    stateChanged(state: DesktopState): void;
}

export class WorkspaceController {
    readonly #store: StateStore;
    readonly #dependencies: WorkspaceControllerDependencies;
    readonly #imports = new Map<string, ImportCapability>();
    readonly #activatingWindows = new Set<string>();

    constructor(store: StateStore, dependencies: Partial<WorkspaceControllerDependencies> = {}) {
        this.#store = store;
        this.#dependencies = {
            canonicalize: canonicalPath,
            canonicalizeSession: canonicalSessionPath,
            now: Date.now,
            randomId: randomUUID,
            stateChanged: () => undefined,
            ...dependencies,
        };
    }

    async registerProject(selectedPath: string): Promise<ProjectRecord> {
        const canonical = await this.#dependencies.canonicalize(selectedPath);
        const { project, state } = await this.#store.upsertProject(canonical, path.basename(canonical) || canonical);
        this.#dependencies.stateChanged(state);

        return project;
    }

    async setPiExecutable(selectedPath: string): Promise<DesktopState> {
        const canonical = await this.#dependencies.canonicalize(selectedPath);
        const state = await this.#store.setPiExecutable(canonical);
        this.#dependencies.stateChanged(state);

        return state;
    }

    async createSessionImport(context: WorkspaceContext, selectedPath: string): Promise<SessionImportSelection> {
        if (!context.activeProjectId) {
            throw new Error("Open the target project before importing a session");
        }

        const canonical = await this.#dependencies.canonicalize(selectedPath);
        if (path.extname(canonical).toLowerCase() !== ".jsonl") {
            throw new Error("Only Pi JSONL session files can be imported");
        }

        this.#pruneImports();
        const token = this.#dependencies.randomId();
        const name = path.basename(canonical);
        this.#imports.set(token, {
            ownerId: context.id,
            projectId: context.activeProjectId,
            path: canonical,
            name,
            expiresAt: this.#dependencies.now() + IMPORT_TTL_MS,
        });

        return { token, name };
    }

    transferSessionImport(token: string, sourceOwnerId: string, targetOwnerId: string): void {
        const capability = this.#requireImport(token, sourceOwnerId);
        if (capability.reservation) {
            throw new Error("The session import is already in use");
        }

        capability.ownerId = targetOwnerId;
    }

    async activate(
        context: WorkspaceContext,
        request: WorkspaceRequest,
        chooseTrust: ChooseTrust,
        confirmCompatibility?: ConfirmCompatibility,
    ): Promise<RuntimeStartResult> {
        if (this.#activatingWindows.has(context.id)) {
            throw new Error("A workspace transition is already in progress for this window");
        }

        this.#activatingWindows.add(context.id);
        try {
            return await this.#activate(context, request, chooseTrust, confirmCompatibility);
        } finally {
            this.#activatingWindows.delete(context.id);
        }
    }

    async #activate(
        context: WorkspaceContext,
        request: WorkspaceRequest,
        chooseTrust: ChooseTrust,
        confirmCompatibility?: ConfirmCompatibility,
    ): Promise<RuntimeStartResult> {
        this.#pruneImports();
        const storedProject = this.#store.getProject(request.projectId);
        if (!storedProject) {
            throw new Error("The selected project is no longer registered");
        }

        const canonicalProject = await this.#dependencies.canonicalize(storedProject.path);
        let project = storedProject;
        if (canonicalProject !== storedProject.path) {
            const updated = await this.#store.updateProjectPath(storedProject.id, canonicalProject);
            this.#dependencies.stateChanged(updated);
            project = updated.projects.find((item) => item.id === storedProject.id) ?? storedProject;
        }

        const session = request.sessionId ? this.#store.getSession(request.sessionId) : undefined;
        if (request.sessionId && (!session || session.projectId !== project.id)) {
            throw new Error("The selected session does not belong to this project");
        }

        const sessionPath = session ? await this.#dependencies.canonicalizeSession(session.sessionPath) : undefined;
        const importCapability = request.importToken ? this.#requireImport(request.importToken, context.id) : undefined;
        if (importCapability && importCapability.projectId !== project.id) {
            throw new Error("The session import belongs to a different target project");
        }

        const reservation = importCapability ? this.#dependencies.randomId() : undefined;
        if (importCapability && reservation) {
            if (importCapability.reservation) {
                throw new Error("The session import is already in use");
            }

            importCapability.reservation = reservation;
        }

        const reusable = context.runtimes.hasUsableRuntime(project.id, session?.id);
        let trust: TrustChoice = "default";
        try {
            if (!reusable) {
                const selected = await chooseTrust(project);
                if (!selected) {
                    this.#releaseImport(importCapability, reservation);

                    return { cancelled: true };
                }

                trust = selected;
            }

            const status = await context.runtimes.activate({
                projectId: project.id,
                cwd: canonicalProject,
                ...(this.#store.get().piPath ? { piPath: this.#store.get().piPath } : {}),
                trust,
                ...(session ? { sessionId: session.id, sessionPath } : {}),
                ...(importCapability ? { forkSessionPath: importCapability.path } : {}),
                ...(request.noSession ? { noSession: true } : {}),
                ...(request.offline ? { offline: true } : {}),
                ...(confirmCompatibility ? { confirmCompatibility } : {}),
            });
            context.activeProjectId = project.id;
            context.activeProjectPath = canonicalProject;
            if (request.importToken) {
                this.#imports.delete(request.importToken);
            }

            const state = await this.#store.setActiveWorkspace(project.id, session?.id);
            this.#dependencies.stateChanged(state);

            return { cancelled: false, status };
        } catch (error) {
            this.#releaseImport(importCapability, reservation);
            if (error instanceof RuntimeStartCancelledError) {
                return { cancelled: true };
            }

            throw error;
        }
    }

    async activeProjectRoot(context: WorkspaceContext, expectedProjectId: string): Promise<string> {
        if (!context.activeProjectId || !context.activeProjectPath) {
            throw new Error("No project is active in this window");
        }

        if (context.activeProjectId !== expectedProjectId) {
            throw new Error("The requested project is not active in this window");
        }

        const project = this.#store.getProject(context.activeProjectId);
        if (!project) {
            throw new Error("The active project is no longer registered");
        }

        const canonical = await this.#dependencies.canonicalize(project.path);
        if (context.activeProjectId !== expectedProjectId || canonical !== context.activeProjectPath) {
            throw new Error("The active project capability is no longer valid");
        }

        return canonical;
    }

    async saveActiveSession(context: WorkspaceContext, metadata: ActiveSessionMetadata): Promise<DesktopState> {
        const runtime = context.runtimes.activeIdentity();
        if (
            !runtime?.sessionId ||
            !runtime.sessionPath ||
            runtime.projectId !== context.activeProjectId ||
            runtime.projectPath !== context.activeProjectPath
        ) {
            throw new Error("Pi has not reported an active session identity");
        }

        const sessionPath = await this.#dependencies.canonicalizeSession(runtime.sessionPath);
        const current = context.runtimes.activeIdentity();
        if (
            current?.runtimeId !== runtime.runtimeId ||
            current.projectId !== runtime.projectId ||
            current.projectPath !== context.activeProjectPath ||
            current.sessionId !== runtime.sessionId ||
            current.sessionPath !== runtime.sessionPath
        ) {
            throw new Error("The active Pi runtime changed before its session was registered");
        }

        const identity: ActiveSessionIdentity = {
            projectId: runtime.projectId,
            sessionId: runtime.sessionId,
            sessionPath,
            ...(runtime.sessionName ? { name: runtime.sessionName } : {}),
        };
        const state = await this.#store.saveActiveSession(identity, metadata);
        this.#dependencies.stateChanged(state);

        return state;
    }

    async saveSessionDraft(context: WorkspaceContext, sessionId: string, draft: string): Promise<DesktopState> {
        this.#assertActiveSession(context, sessionId);
        const state = await this.#store.updateSessionDraft(sessionId, draft);
        this.#dependencies.stateChanged(state);

        return state;
    }

    async saveSessionTitle(context: WorkspaceContext, sessionId: string, title: string): Promise<DesktopState> {
        this.#assertActiveSession(context, sessionId);
        const state = await this.#store.updateSessionTitle(sessionId, title);
        this.#dependencies.stateChanged(state);

        return state;
    }

    #assertActiveSession(context: WorkspaceContext, sessionId: string): void {
        const runtime = context.runtimes.activeIdentity();
        if (
            !runtime ||
            runtime.sessionId !== sessionId ||
            runtime.projectId !== context.activeProjectId ||
            runtime.projectPath !== context.activeProjectPath
        ) {
            throw new Error("Session metadata may only be changed for this window's active runtime");
        }
    }

    #requireImport(token: string, ownerId: string): ImportCapability {
        this.#pruneImports();
        const capability = this.#imports.get(token);
        if (!capability || capability.ownerId !== ownerId) {
            throw new Error("The session import capability is invalid or expired");
        }

        return capability;
    }

    #releaseImport(capability: ImportCapability | undefined, reservation: string | undefined): void {
        if (capability && capability.reservation === reservation) {
            capability.reservation = undefined;
        }
    }

    #pruneImports(): void {
        const now = this.#dependencies.now();
        for (const [token, capability] of this.#imports) {
            if (capability.expiresAt <= now && !capability.reservation) {
                this.#imports.delete(token);
            }
        }
    }
}
