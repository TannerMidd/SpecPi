import type { DesktopState, FileNode, FilePreview, GitStatus } from "./domain";
import type {
    ExtensionUiResponse,
    RpcCommand,
    RuntimeEvent,
    RuntimeSnapshot,
    RuntimeStatus,
    StartRuntimeOptions,
} from "./rpc";

export const IPC = {
    chooseProject: "desktop:choose-project",
    choosePi: "desktop:choose-pi",
    chooseSession: "desktop:choose-session",
    getDesktopState: "desktop:get-state",
    updateDesktopState: "desktop:update-state",
    saveSessionDraft: "desktop:save-session-draft",
    runtimeSnapshot: "runtime:snapshot",
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

export type DesktopStatePatch = Partial<
    Pick<DesktopState, "piPath" | "theme" | "activeProjectId" | "activeSessionId">
> & {
    projects?: DesktopState["projects"];
    sessions?: DesktopState["sessions"];
    layout?: Partial<DesktopState["layout"]>;
};

export interface DesktopApi {
    chooseProject(): Promise<string | undefined>;
    choosePi(): Promise<string | undefined>;
    chooseSession(): Promise<string | undefined>;
    getDesktopState(): Promise<DesktopState>;
    updateDesktopState(patch: DesktopStatePatch): Promise<DesktopState>;
    saveSessionDraft(sessionId: string, draft: string): Promise<DesktopState>;
    getRuntimeSnapshot(): Promise<RuntimeSnapshot>;
    getRuntimeDiagnostics(): Promise<readonly string[]>;
    saveRuntimeDiagnostics(): Promise<string | undefined>;
    startRuntime(options: StartRuntimeOptions): Promise<RuntimeStatus>;
    stopRuntime(): Promise<void>;
    sendRuntimeCommand(command: RpcCommand): Promise<unknown>;
    respondToExtension(request: ExtensionUiResponse): Promise<void>;
    listDirectory(projectRoot: string, relativePath: string): Promise<FileNode[]>;
    readFile(projectRoot: string, relativePath: string): Promise<FilePreview>;
    getGitStatus(projectRoot: string): Promise<GitStatus>;
    getGitDiff(projectRoot: string, relativePath?: string): Promise<string>;
    saveExport(sourcePath: string): Promise<string | undefined>;
    copyText(text: string): Promise<void>;
    openExternal(url: string): Promise<void>;
    onRuntimeEvent(listener: (event: RuntimeEvent) => void): () => void;
    onRuntimeStatus(listener: (status: RuntimeStatus) => void): () => void;
}
