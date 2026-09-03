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

export interface StartRuntimeOptions {
    cwd: string;
    piPath?: string;
    trust: "default" | "approve" | "deny";
    sessionPath?: string;
    noSession?: boolean;
    offline?: boolean;
}

export interface RuntimeSnapshot {
    status: RuntimeStatus;
    pendingUi: ExtensionUiRequest[];
}

export interface RuntimeDescriptor {
    runtimeId: string;
    projectPath: string;
    sessionPath?: string;
    active: boolean;
    status: RuntimeStatus;
}

export interface ExtensionUiResponse {
    type: "extension_ui_response";
    id: string;
    value?: string;
    confirmed?: boolean;
    cancelled?: true;
}
