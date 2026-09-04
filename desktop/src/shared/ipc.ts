import type { DesktopState, FileNode, FilePreview, GitStatus, ProjectRecord } from "./domain";
import type {
    ActiveSessionMetadata,
    ExtensionUiResponse,
    RpcCommand,
    RuntimeDescriptor,
    RuntimeEvent,
    RuntimeSnapshot,
    RuntimeStartResult,
    RuntimeStatus,
    SessionImportSelection,
    WorkspaceRequest,
} from "./rpc";

export const IPC = {
    chooseProject: "desktop:choose-project",
    choosePi: "desktop:choose-pi",
    chooseSession: "desktop:choose-session",
    openWorkspace: "desktop:open-workspace",
    launchIntent: "desktop:launch-intent",
    getDesktopState: "desktop:get-state",
    updateDesktopState: "desktop:update-state",
    desktopStateChanged: "desktop:state-changed",
    saveSessionDraft: "desktop:save-session-draft",
    saveSessionTitle: "desktop:save-session-title",
    saveActiveSession: "desktop:save-active-session",
    runtimeSnapshot: "runtime:snapshot",
    runtimeRoster: "runtime:roster",
    runtimeDiagnostics: "runtime:diagnostics",
    saveDiagnostics: "runtime:save-diagnostics",
    runtimeStart: "runtime:start",
    runtimeStop: "runtime:stop",
    runtimeCommand: "runtime:command",
    runtimeUiResponse: "runtime:ui-response",
    runtimeEvent: "runtime:event",
    runtimeStatus: "runtime:status",
    listDirectory: "files:list-directory",
    readFile: "files:read-file",
    gitStatus: "git:status",
    gitDiff: "git:diff",
    saveExport: "desktop:save-export",
    copyText: "desktop:copy-text",
    openExternal: "desktop:open-external",
} as const;

export interface DesktopStatePatch {
    theme?: DesktopState["theme"];
    layout?: Partial<DesktopState["layout"]>;
}

export interface DesktopApi {
    chooseProject(): Promise<ProjectRecord | undefined>;
    choosePi(): Promise<DesktopState | undefined>;
    chooseSession(): Promise<SessionImportSelection | undefined>;
    openWorkspace(request: WorkspaceRequest): Promise<void>;
    getLaunchIntent(): Promise<WorkspaceRequest | undefined>;
    getDesktopState(): Promise<DesktopState>;
    updateDesktopState(patch: DesktopStatePatch): Promise<DesktopState>;
    saveSessionDraft(sessionId: string, draft: string): Promise<DesktopState>;
    saveSessionTitle(sessionId: string, title: string): Promise<DesktopState>;
    saveActiveSession(metadata: ActiveSessionMetadata): Promise<DesktopState>;
    getRuntimeSnapshot(): Promise<RuntimeSnapshot>;
    getRuntimeRoster(): Promise<RuntimeDescriptor[]>;
    getRuntimeDiagnostics(): Promise<readonly string[]>;
    saveRuntimeDiagnostics(): Promise<string | undefined>;
    startRuntime(request: WorkspaceRequest): Promise<RuntimeStartResult>;
    stopRuntime(): Promise<void>;
    sendRuntimeCommand(command: RpcCommand): Promise<unknown>;
    respondToExtension(request: ExtensionUiResponse): Promise<void>;
    listDirectory(projectId: string, relativePath: string): Promise<FileNode[]>;
    readFile(projectId: string, relativePath: string): Promise<FilePreview>;
    getGitStatus(projectId: string): Promise<GitStatus>;
    getGitDiff(projectId: string, relativePath?: string): Promise<string>;
    saveExport(sourcePath: string): Promise<string | undefined>;
    copyText(text: string): Promise<void>;
    openExternal(url: string): Promise<void>;
    onDesktopState(listener: (state: DesktopState) => void): () => void;
    onRuntimeEvent(listener: (event: RuntimeEvent) => void): () => void;
    onRuntimeStatus(listener: (status: RuntimeStatus) => void): () => void;
    onRuntimeRoster(listener: (runtimes: RuntimeDescriptor[]) => void): () => void;
}
