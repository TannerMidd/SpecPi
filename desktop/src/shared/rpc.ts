export type RuntimePhase =
    "stopped" | "starting" | "idle" | "streaming" | "waiting-for-user" | "compacting" | "retrying" | "failed";

export interface RpcRecord {
    type: string;
    id?: string;
    [key: string]: unknown;
}

export interface RpcCommand extends RpcRecord {
    type: string;
}

export interface RuntimeEvent {
    generation: number;
    record: RpcRecord;
}

export interface RuntimeStatus {
    generation: number;
    phase: RuntimePhase;
    piPath?: string;
    piVersion?: string;
    cwd?: string;
    error?: string;
    compatibilityWarning?: string;
}

export interface ExtensionUiRequest extends RpcRecord {
    type: "extension_ui_request";
    id: string;
    method:
        | "select"
        | "confirm"
        | "input"
        | "editor"
        | "notify"
        | "setStatus"
        | "setWidget"
        | "setTitle"
        | "set_editor_text";
}

/** Main-process-only launch authority. Never expose this shape through preload. */
export interface RuntimeLaunchOptions {
    projectId: string;
    cwd: string;
    piPath?: string;
    trust: "default" | "approve" | "deny";
    sessionId?: string;
    sessionPath?: string;
    forkSessionPath?: string;
    noSession?: boolean;
    offline?: boolean;
    confirmCompatibility?(warning: string): Promise<boolean>;
}

/** Renderer request containing only main-owned capability identifiers. */
export interface WorkspaceRequest {
    projectId: string;
    sessionId?: string;
    importToken?: string;
    noSession?: boolean;
    offline?: boolean;
}

export interface RuntimeStartResult {
    cancelled: boolean;
    status?: RuntimeStatus;
}

export interface SessionImportSelection {
    token: string;
    name: string;
}

export interface ActiveSessionMetadata {
    title?: string;
    model?: string;
    draft?: string;
}

export interface RuntimeSnapshot {
    status: RuntimeStatus;
    pendingUi: ExtensionUiRequest[];
}

export interface RuntimeDescriptor {
    runtimeId: string;
    projectId: string;
    projectPath: string;
    sessionId?: string;
    sessionPath?: string;
    active: boolean;
    status: RuntimeStatus;
}

export interface RuntimeIdentity {
    runtimeId: string;
    projectId: string;
    projectPath: string;
    sessionId?: string;
    sessionPath?: string;
}

export interface ExtensionUiResponse {
    type: "extension_ui_response";
    id: string;
    value?: string;
    confirmed?: boolean;
    cancelled?: true;
}
