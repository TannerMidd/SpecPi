export interface ProjectRecord {
    id: string;
    path: string;
    label: string;
    lastOpenedAt: string;
    trust: "default" | "approve" | "deny";
    pinned: boolean;
    lastSessionPath?: string;
}

export interface SessionRecord {
    id: string;
    projectId: string;
    sessionId: string;
    sessionPath: string;
    /** Explicit name owned by Pi. */
    name?: string;
    /** Local display fallback derived from the first meaningful user prompt. */
    title?: string;
    model?: string;
    lastOpenedAt: string;
    draft: string;
    scrollTop?: number;
}

export interface DesktopState {
    schema: 1;
    piPath?: string;
    theme: "system" | "dark" | "light";
    projects: ProjectRecord[];
    sessions: SessionRecord[];
    activeProjectId?: string;
    activeSessionId?: string;
    layout: {
        filesOpen: boolean;
        filesWidth: number;
        inspectorOpen: boolean;
        sidebarOpen: boolean;
    };
}

export interface FileNode {
    name: string;
    relativePath: string;
    kind: "file" | "directory" | "symlink";
    size?: number;
}

export interface FilePreview {
    relativePath: string;
    kind: "text" | "image" | "binary";
    content?: string;
    dataUrl?: string;
    truncated: boolean;
    size: number;
    mimeType?: string;
}

export interface GitFileStatus {
    path: string;
    index: string;
    worktree: string;
}

export interface GitStatus {
    available: boolean;
    branch?: string;
    files: GitFileStatus[];
    error?: string;
}
