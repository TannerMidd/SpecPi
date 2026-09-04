import type { DesktopState } from "../../shared/domain";
import type { DesktopApi, DesktopStatePatch } from "../../shared/ipc";
import type { RuntimeDescriptor, RuntimeEvent, RuntimeStatus } from "../../shared/rpc";
import { mergeSessionRecord } from "../../shared/session-registry";

const projectPath = "F:/Development/SpecPi";
const preview = new URLSearchParams(window.location.search).get("preview");
const now = Date.now();
let state: DesktopState = {
    schema: 2,
    revision: 0,
    theme: preview === "light" ? "light" : "dark",
    projects: [
        {
            id: "specpi-project",
            path: projectPath,
            label: "SpecPi",
            lastOpenedAt: new Date(now).toISOString(),
            pinned: true,
            lastSessionId: "demo-session",
        },
    ],
    sessions: [
        {
            id: "demo-session",
            projectId: "specpi-project",
            sessionId: "demo-session",
            sessionPath: "C:/demo/session.jsonl",
            name: "Desktop production pass",
            model: "openai-codex/gpt-5.6",
            lastOpenedAt: new Date(now).toISOString(),
            draft: "",
        },
        {
            id: "review",
            projectId: "specpi-project",
            sessionId: "review",
            sessionPath: "C:/demo/review.jsonl",
            name: "Security review",
            model: "openai-codex/gpt-5.6",
            lastOpenedAt: new Date(now - 18 * 60_000).toISOString(),
            draft: "",
        },
        {
            id: "commands",
            projectId: "specpi-project",
            sessionId: "commands",
            sessionPath: "C:/demo/commands.jsonl",
            name: "Composer commands",
            model: "anthropic/claude-sonnet",
            lastOpenedAt: new Date(now - 2 * 3_600_000).toISOString(),
            draft: "",
        },
        {
            id: "guard",
            projectId: "specpi-project",
            sessionId: "guard",
            sessionPath: "C:/demo/guard.jsonl",
            model: "openai-codex/gpt-5.6",
            lastOpenedAt: new Date(now - 26 * 3_600_000).toISOString(),
            draft: "",
        },
        {
            id: "audit",
            projectId: "specpi-project",
            sessionId: "audit",
            sessionPath: "C:/demo/audit.jsonl",
            title: "Implementation audit",
            model: "openai-codex/gpt-5.6",
            lastOpenedAt: new Date(now - 4 * 86_400_000).toISOString(),
            draft: "",
        },
    ],
    activeProjectId: preview === "empty" ? undefined : "specpi-project",
    activeSessionId: preview === "empty" ? undefined : "demo-session",
    layout: { filesOpen: false, filesWidth: 420, inspectorOpen: true, sidebarOpen: true },
};
let status: RuntimeStatus = { generation: 0, phase: "stopped" };
let runtimes: RuntimeDescriptor[] = [];
const stateListeners = new Set<(next: DesktopState) => void>();
const eventListeners = new Set<(event: RuntimeEvent) => void>();
const statusListeners = new Set<(next: RuntimeStatus) => void>();
const rosterListeners = new Set<(next: RuntimeDescriptor[]) => void>();
const runtimeNames = new Map<string, string>();
const commitState = (next: Omit<DesktopState, "revision"> & { revision?: number }): DesktopState => {
    state = { ...next, revision: state.revision + 1 };
    const snapshot = structuredClone(state);
    stateListeners.forEach((listener) => listener(snapshot));

    return snapshot;
};

const emitEvent = (record: RuntimeEvent["record"]) =>
    eventListeners.forEach((listener) => listener({ generation: status.generation, record }));
const emitRuntimeEvent = (runtimeId: string | undefined, record: RuntimeEvent["record"]) => {
    if (runtimeId && runtimes.some((runtime) => runtime.runtimeId === runtimeId && runtime.active)) {
        emitEvent(record);
    }
};

const emitRoster = () => {
    const snapshot = structuredClone(runtimes);
    rosterListeners.forEach((listener) => listener(snapshot));
};

const emitStatus = (next: RuntimeStatus) => {
    status = next;
    runtimes = runtimes.map((runtime) => (runtime.active ? { ...runtime, status: next } : runtime));
    statusListeners.forEach((listener) => listener(next));
    emitRoster();
};

const emitRuntimeStatus = (runtimeId: string | undefined, phase: RuntimeStatus["phase"]) => {
    if (!runtimeId) {
        return;
    }

    const runtime = runtimes.find((item) => item.runtimeId === runtimeId);
    if (!runtime) {
        return;
    }

    const next = { ...runtime.status, phase };
    runtimes = runtimes.map((item) => (item.runtimeId === runtimeId ? { ...item, status: next } : item));
    emitRoster();
    if (runtime.active) {
        status = next;
        statusListeners.forEach((listener) => listener(next));
    }
};

export function installMockApi(): void {
    const api: DesktopApi = {
        chooseProject: async () => structuredClone(state.projects[0]),
        choosePi: async () => commitState({ ...state, piPath: "C:/Users/example/AppData/Roaming/npm/pi.cmd" }),
        chooseSession: async () => ({ token: crypto.randomUUID(), name: "session.jsonl" }),
        openWorkspace: async () => undefined,
        getLaunchIntent: async () =>
            preview === "empty" ? undefined : { projectId: "specpi-project", sessionId: "demo-session" },
        getDesktopState: async () => structuredClone(state),
        updateDesktopState: async (patch: DesktopStatePatch) =>
            commitState({ ...state, ...patch, layout: { ...state.layout, ...patch.layout } }),
        saveSessionDraft: async (sessionId, draft) =>
            commitState({
                ...state,
                sessions: state.sessions.map((session) => (session.id === sessionId ? { ...session, draft } : session)),
            }),
        saveSessionTitle: async (sessionId, title) =>
            commitState({
                ...state,
                sessions: state.sessions.map((session) =>
                    session.id === sessionId && !session.name?.trim() && !session.title?.trim()
                        ? { ...session, title }
                        : session,
                ),
            }),
        saveActiveSession: async (metadata) => {
            const activeRuntime = runtimes.find((runtime) => runtime.active);
            const sessionId = activeRuntime?.sessionId ?? "demo-session";
            const existing = state.sessions.find((session) => session.id === sessionId);
            const session = {
                id: sessionId,
                projectId: activeRuntime?.projectId ?? "specpi-project",
                sessionId,
                sessionPath: activeRuntime?.sessionPath ?? existing?.sessionPath ?? "C:/demo/session.jsonl",
                ...(existing?.name ? { name: existing.name } : {}),
                ...(metadata.title ? { title: metadata.title } : existing?.title ? { title: existing.title } : {}),
                ...(metadata.model ? { model: metadata.model } : existing?.model ? { model: existing.model } : {}),
                lastOpenedAt: new Date().toISOString(),
                draft: metadata.draft ?? existing?.draft ?? "",
            };

            return commitState({
                ...state,
                sessions: mergeSessionRecord(state.sessions, session, "win32"),
                activeProjectId: session.projectId,
                activeSessionId: session.id,
            });
        },
        getRuntimeSnapshot: async () => ({ status, pendingUi: [] }),
        getRuntimeRoster: async () => structuredClone(runtimes),
        getRuntimeDiagnostics: async () => ["Pi RPC ready · no credential data collected"],
        saveRuntimeDiagnostics: async () => "C:/demo/specpi-desktop-diagnostics.txt",
        startRuntime: async (request) => {
            const project = state.projects.find((item) => item.id === request.projectId);
            if (!project) {
                throw new Error("Mock project is missing");
            }

            const requestedSession = request.sessionId
                ? state.sessions.find((session) => session.id === request.sessionId)
                : undefined;
            const existing = request.sessionId
                ? runtimes.find(
                      (runtime) => runtime.projectId === request.projectId && runtime.sessionId === request.sessionId,
                  )
                : undefined;
            if (existing) {
                runtimes = runtimes.map((runtime) => ({
                    ...runtime,
                    active: runtime.runtimeId === existing.runtimeId,
                }));
                status = existing.status;
                statusListeners.forEach((listener) => listener(status));
                emitRoster();

                return { cancelled: false, status };
            }

            const generatedId = request.importToken ? `import-${crypto.randomUUID()}` : crypto.randomUUID();
            const sessionId = requestedSession?.id ?? generatedId;
            const sessionPath = requestedSession?.sessionPath ?? `C:/demo/${sessionId}.jsonl`;
            runtimes = [
                ...runtimes.map((runtime) => ({ ...runtime, active: false })),
                {
                    runtimeId: crypto.randomUUID(),
                    projectId: project.id,
                    projectPath: project.path,
                    sessionId,
                    sessionPath,
                    active: true,
                    status: { generation: status.generation + 1, phase: "starting", cwd: project.path },
                },
            ];
            emitStatus({ generation: status.generation + 1, phase: "starting", cwd: project.path });
            await new Promise((resolve) => setTimeout(resolve, preview === "startup" ? 60_000 : 2_000));
            emitStatus({
                generation: status.generation,
                phase: "idle",
                cwd: project.path,
                piPath: state.piPath ?? "pi",
                piVersion: "0.84.4",
            });
            emitEvent({
                type: "extension_ui_request",
                id: "mock-guard-status",
                method: "setStatus",
                statusKey: "specpi-command-guard",
                statusText: "Guard Off",
            });

            return { cancelled: false, status };
        },
        stopRuntime: async () => {
            emitStatus({ generation: status.generation, phase: "stopped" });
            runtimes = runtimes.filter((runtime) => !runtime.active);
            emitRoster();
        },
        sendRuntimeCommand: async (command) => {
            if (command.type === "get_state") {
                const activeRuntime = runtimes.find((runtime) => runtime.active);
                const activePath = activeRuntime?.sessionPath ?? "C:/demo/session.jsonl";
                const session = state.sessions.find(
                    (item) =>
                        item.sessionPath.replaceAll("\\", "/").toLowerCase() ===
                        activePath.replaceAll("\\", "/").toLowerCase(),
                );

                return {
                    model: { id: "gpt-5.6", provider: "openai-codex" },
                    thinkingLevel: "high",
                    sessionId: session?.sessionId ?? activeRuntime?.sessionId ?? "demo-session",
                    sessionFile: session?.sessionPath ?? activePath,
                    sessionName: runtimeNames.get(activeRuntime?.runtimeId ?? "") ?? session?.name,
                };
            }

            if (command.type === "get_messages") {
                const activePath = runtimes.find((runtime) => runtime.active)?.sessionPath;
                if (activePath?.replaceAll("\\", "/").toLowerCase() === "c:/demo/guard.jsonl") {
                    return { messages: [] };
                }

                return {
                    messages: [
                        { role: "user", content: "Implement the desktop interface", timestamp: 1 },
                        {
                            role: "assistant",
                            content: [
                                { type: "text", text: "I’ll inspect the project and build the smallest secure host." },
                            ],
                            timestamp: 2,
                        },
                    ],
                };
            }

            if (command.type === "get_commands") {
                return {
                    commands: [
                        { name: "guard", description: "Show or change the session command guard", source: "extension" },
                        { name: "scope", description: "Declare expected project paths", source: "extension" },
                        { name: "spec", description: "Toggle focused execution", source: "extension" },
                        { name: "files", description: "Browse project files", source: "extension" },
                        { name: "approval-demo", description: "Preview an inline approval", source: "extension" },
                    ],
                };
            }

            if (command.type === "get_available_models") {
                return {
                    models: [
                        { id: "gpt-5.6", provider: "openai-codex", name: "GPT-5.6" },
                        { id: "claude-sonnet", provider: "anthropic", name: "Claude Sonnet" },
                    ],
                };
            }

            if (command.type === "get_available_thinking_levels") {
                return { levels: ["off", "low", "medium", "high", "xhigh"] };
            }

            if (command.type === "get_entries") {
                return { entries: [] };
            }

            if (command.type === "get_session_stats") {
                return {
                    userMessages: 8,
                    assistantMessages: 7,
                    toolCalls: 12,
                    totalMessages: 27,
                    tokens: { input: 18400, output: 6200, cacheRead: 11400, cacheWrite: 0, total: 36000 },
                    cost: 0.1842,
                    contextUsage: { percent: 18, tokens: 36000, contextWindow: 200000 },
                };
            }

            if (["new_session", "clone", "fork"].includes(command.type)) {
                const active = runtimes.find((runtime) => runtime.active);
                if (!active) {
                    throw new Error("Mock Pi runtime is not active");
                }

                const sessionId = crypto.randomUUID();
                const nextStatus: RuntimeStatus = {
                    ...active.status,
                    generation: status.generation + 1,
                    phase: "idle",
                };
                runtimes = runtimes.map((runtime) =>
                    runtime.runtimeId === active.runtimeId
                        ? {
                              ...runtime,
                              sessionId,
                              sessionPath: `C:/demo/${sessionId}.jsonl`,
                              status: nextStatus,
                          }
                        : runtime,
                );
                emitStatus(nextStatus);

                return command.type === "fork" ? { text: "Selected branch text" } : {};
            }

            if (command.type === "set_session_name" && typeof command.name === "string") {
                const runtimeId = runtimes.find((runtime) => runtime.active)?.runtimeId;
                if (runtimeId) {
                    runtimeNames.set(runtimeId, command.name);
                }

                return {};
            }

            if (command.type === "prompt" || command.type === "steer" || command.type === "follow_up") {
                if (typeof command.message === "string" && /^\/guard (?:off|guard|strict)$/u.test(command.message)) {
                    const mode = command.message.slice("/guard ".length);
                    emitEvent({
                        type: "extension_ui_request",
                        id: `mock-guard-mode-${Date.now()}`,
                        method: "setStatus",
                        statusKey: "specpi-command-guard",
                        statusText: mode === "off" ? "Guard Off" : `🛡 ${mode[0]!.toUpperCase()}${mode.slice(1)}`,
                    });

                    return {};
                }

                if (command.message === "/approval-demo") {
                    emitEvent({
                        type: "extension_ui_request",
                        id: "mock-approval",
                        method: "select",
                        title: "Command guard approval — Severity: high; category: repository; cwd: F:/Development/SpecPi; affected: desktop/src/renderer; reason: This operation modifies application code; safer: review the exact change before allowing it",
                        options: ["Deny (Recommended)", "Allow once", "Allow exact call for session", "Lock session"],
                    });

                    return {};
                }

                if (typeof command.message === "string" && command.message.startsWith("/")) {
                    emitEvent({
                        type: "extension_ui_request",
                        id: `mock-command-${Date.now()}`,
                        method: "notify",
                        message: `${command.message} executed by Pi`,
                        notifyType: "info",
                    });

                    return {};
                }

                const runtimeId = runtimes.find((runtime) => runtime.active)?.runtimeId;
                emitRuntimeEvent(runtimeId, {
                    type: "message_end",
                    message: { role: "user", content: command.message, timestamp: Date.now() },
                });
                emitRuntimeStatus(runtimeId, "streaming");
                if (preview === "tools") {
                    setTimeout(() => {
                        emitRuntimeEvent(runtimeId, {
                            type: "tool_execution_start",
                            toolCallId: "mock-read",
                            toolName: "read",
                            args: { path: "desktop/src/renderer/src/App.tsx" },
                        });
                    }, 350);
                    setTimeout(() => {
                        emitRuntimeEvent(runtimeId, {
                            type: "tool_execution_end",
                            toolCallId: "mock-read",
                            result: { content: "export function App() {\n    return <SpecPiDesktop />;\n}" },
                            isError: false,
                        });
                    }, 900);
                }

                setTimeout(() => {
                    emitRuntimeEvent(runtimeId, {
                        type: "message_update",
                        assistantMessageEvent: {
                            type: "thinking_delta",
                            contentIndex: 0,
                            delta: "**Checking incremental Markdown rendering**",
                        },
                    });
                    emitRuntimeEvent(runtimeId, {
                        type: "message_update",
                        assistantMessageEvent: {
                            type: "text_delta",
                            contentIndex: 1,
                            delta: "## Working through Pi RPC\n\n- Streaming Markdown stays formatted.",
                        },
                    });
                }, 120);
                setTimeout(() => {
                    emitRuntimeEvent(runtimeId, {
                        type: "message_end",
                        message: {
                            role: "assistant",
                            content: [
                                {
                                    type: "text",
                                    text: "## Working through Pi RPC\n\n- Streaming Markdown stayed formatted.",
                                },
                            ],
                            timestamp: Date.now(),
                        },
                    });
                    emitRuntimeEvent(runtimeId, { type: "agent_settled" });
                    emitRuntimeStatus(runtimeId, "idle");
                }, 2_500);
            }

            return {};
        },
        respondToExtension: async (response) =>
            emitEvent({
                type: "extension_ui_request",
                id: `notice-${response.id}`,
                method: "notify",
                message: "Command guard active in guard mode.",
                notifyType: "info",
            }),
        listDirectory: async (_projectId, relative) =>
            relative
                ? []
                : [
                      { name: "extensions", relativePath: "extensions", kind: "directory" },
                      { name: "README.md", relativePath: "README.md", kind: "file", size: 8000 },
                      { name: "PLAN.md", relativePath: "PLAN.md", kind: "file", size: 42000 },
                  ],
        readFile: async (_projectId, relative) => ({
            relativePath: relative,
            kind: "text",
            content: `# ${relative}\n\nPreviewed securely inside the selected project.`,
            truncated: false,
            size: 80,
        }),
        getGitStatus: async (_projectId) => ({
            available: true,
            branch: "main",
            files: [{ path: "PLAN.md", index: " ", worktree: "M" }],
        }),
        getGitDiff: async (_projectId, _relativePath) =>
            [
                "diff --git a/PLAN.md b/PLAN.md",
                "--- a/PLAN.md",
                "+++ b/PLAN.md",
                "@@ -18,3 +18,4 @@ Desktop implementation",
                " - Preserve local Pi ownership",
                "-- Match the current shell",
                "+- Match the refined desktop workbench",
                "+- Validate responsive states",
            ].join("\n"),
        saveExport: async () => undefined,
        copyText: async () => undefined,
        openExternal: async () => undefined,
        onDesktopState: (listener) => {
            stateListeners.add(listener);

            return () => stateListeners.delete(listener);
        },
        onRuntimeEvent: (listener) => {
            eventListeners.add(listener);

            return () => eventListeners.delete(listener);
        },
        onRuntimeStatus: (listener) => {
            statusListeners.add(listener);

            return () => statusListeners.delete(listener);
        },
        onRuntimeRoster: (listener) => {
            rosterListeners.add(listener);

            return () => rosterListeners.delete(listener);
        },
    };
    window.specpi = api;
}
