import type { DesktopState } from "../../shared/domain";
import type { DesktopApi, DesktopStatePatch } from "../../shared/ipc";
import type { RuntimeEvent, RuntimeStatus } from "../../shared/rpc";

const projectPath = "F:/Development/SpecPi";
let state: DesktopState = {
    schema: 1,
    theme: "dark",
    projects: [],
    sessions: [],
    layout: { filesOpen: false, filesWidth: 420 },
};
let status: RuntimeStatus = { generation: 0, phase: "stopped" };
const eventListeners = new Set<(event: RuntimeEvent) => void>();
const statusListeners = new Set<(next: RuntimeStatus) => void>();
const emitEvent = (record: RuntimeEvent["record"]) =>
    eventListeners.forEach((listener) => listener({ generation: status.generation, record }));
const emitStatus = (next: RuntimeStatus) => {
    status = next;
    statusListeners.forEach((listener) => listener(next));
};

export function installMockApi(): void {
    const api: DesktopApi = {
        chooseProject: async () => projectPath,
        choosePi: async () => "C:/Users/example/AppData/Roaming/npm/pi.cmd",
        chooseSession: async () => "C:/demo/session.jsonl",
        getDesktopState: async () => structuredClone(state),
        updateDesktopState: async (patch: DesktopStatePatch) => {
            state = { ...state, ...patch, layout: { ...state.layout, ...patch.layout } };

            return structuredClone(state);
        },
        saveSessionDraft: async (sessionId, draft) => {
            state = {
                ...state,
                sessions: state.sessions.map((session) => (session.id === sessionId ? { ...session, draft } : session)),
            };

            return structuredClone(state);
        },
        getRuntimeSnapshot: async () => ({ status, pendingUi: [] }),
        getRuntimeDiagnostics: async () => ["Pi RPC ready · no credential data collected"],
        saveRuntimeDiagnostics: async () => "C:/demo/specpi-desktop-diagnostics.txt",
        startRuntime: async (options) => {
            emitStatus({ generation: status.generation + 1, phase: "starting", cwd: options.cwd });
            setTimeout(
                () =>
                    emitEvent({
                        type: "extension_ui_request",
                        id: "mock-guard",
                        method: "select",
                        title: "SpecPi command guard",
                        options: ["Guard (Recommended)", "Strict", "Off for this session"],
                    }),
                100,
            );
            emitStatus({
                generation: status.generation,
                phase: "idle",
                cwd: options.cwd,
                piPath: options.piPath ?? "pi",
                piVersion: "0.84.4",
            });

            return status;
        },
        stopRuntime: async () => emitStatus({ generation: status.generation, phase: "stopped" }),
        sendRuntimeCommand: async (command) => {
            if (command.type === "get_state") {
                return {
                    model: { id: "gpt-5.6", provider: "openai-codex" },
                    thinkingLevel: "high",
                    sessionId: "demo-session",
                    sessionFile: "C:/demo/session.jsonl",
                    sessionName: "Desktop implementation",
                };
            }

            if (command.type === "get_messages") {
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
                return { contextUsage: { percent: 18, tokens: 36000, contextWindow: 200000 } };
            }

            if (command.type === "prompt" || command.type === "steer" || command.type === "follow_up") {
                emitEvent({
                    type: "message_end",
                    message: { role: "user", content: command.message, timestamp: Date.now() },
                });
                emitStatus({ ...status, phase: "streaming" });
                setTimeout(
                    () =>
                        emitEvent({
                            type: "message_update",
                            assistantMessageEvent: {
                                type: "text_delta",
                                contentIndex: 0,
                                delta: "Working through Pi RPC…",
                            },
                        }),
                    120,
                );
                setTimeout(() => {
                    emitEvent({
                        type: "message_end",
                        message: {
                            role: "assistant",
                            content: [{ type: "text", text: "Working through Pi RPC…" }],
                            timestamp: Date.now(),
                        },
                    });
                    emitEvent({ type: "agent_settled" });
                    emitStatus({ ...status, phase: "idle" });
                }, 450);
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
        listDirectory: async (_root, relative) =>
            relative
                ? []
                : [
                      { name: "extensions", relativePath: "extensions", kind: "directory" },
                      { name: "README.md", relativePath: "README.md", kind: "file", size: 8000 },
                      { name: "PLAN.md", relativePath: "PLAN.md", kind: "file", size: 42000 },
                  ],
        readFile: async (_root, relative) => ({
            relativePath: relative,
            kind: "text",
            content: `# ${relative}\n\nPreviewed securely inside the selected project.`,
            truncated: false,
            size: 80,
        }),
        getGitStatus: async () => ({
            available: true,
            branch: "main",
            files: [{ path: "PLAN.md", index: " ", worktree: "M" }],
        }),
        getGitDiff: async () => "diff --git a/PLAN.md b/PLAN.md\n+SpecPi Desktop implementation plan",
        saveExport: async () => undefined,
        copyText: async () => undefined,
        openExternal: async () => undefined,
        onRuntimeEvent: (listener) => {
            eventListeners.add(listener);

            return () => eventListeners.delete(listener);
        },
        onRuntimeStatus: (listener) => {
            statusListeners.add(listener);

            return () => statusListeners.delete(listener);
        },
    };
    window.specpi = api;
}
