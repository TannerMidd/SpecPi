import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { DesktopState, ProjectRecord, SessionRecord } from "../../shared/domain";
import type {
    ExtensionUiRequest,
    RpcCommand,
    RuntimeDescriptor,
    RuntimeEvent,
    RuntimeStatus,
    StartRuntimeOptions,
} from "../../shared/rpc";
import { sessionDisplayTitle, sessionTitleFromMessages, sessionTitleFromPrompt } from "../../shared/session-title";
import { CommandPalette, type CommandInfo } from "./components/CommandPalette";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { FilesPanel } from "./components/FilesPanel";
import { Icon } from "./components/Icons";
import { ModelSelector, type ModelOption } from "./components/ModelSelector";
import { SessionNameDialog } from "./components/SessionNameDialog";
import { Transcript } from "./components/Transcript";
import { commandSuggestions, composerStreamingBehavior, parseSlashCommand } from "./lib/commands";
import { sessionOpenAction, spinupDetail } from "./lib/spinup";
import { stripAnsi } from "./lib/text";
import { emptyConversation, messagesToItems, reduceRuntimeEvent } from "./state/conversation";

interface Toast {
    id: string;
    message: string;
    level: "info" | "warning" | "error";
}

interface BranchChoice {
    entryId: string;
    text: string;
}

interface SpinupStatus {
    startedAt: number;
    projectLabel: string;
    sessionLabel?: string;
}

const DESKTOP_COMMANDS: CommandInfo[] = [
    {
        name: "new",
        label: "New session",
        description: "Start a fresh independent session",
        source: "desktop",
        invocation: "@new-session",
    },
    {
        name: "open-session",
        label: "Open session",
        description: "Open a Pi JSONL session",
        source: "desktop",
        invocation: "@open-session",
    },
    {
        name: "open-project",
        label: "Open project",
        description: "Choose another project workspace",
        source: "desktop",
        invocation: "@open-project",
    },
    { name: "files", label: "Files", description: "Browse project files", source: "desktop", invocation: "@files" },
    {
        name: "changes",
        label: "Changes",
        description: "Review the current git diff",
        source: "desktop",
        invocation: "@changes",
    },
    {
        name: "compact",
        label: "Compact context",
        description: "Compact context with optional instructions",
        source: "desktop",
        invocation: "@compact",
    },
    {
        name: "branch",
        label: "Branch session",
        description: "Fork from a selected user message",
        source: "desktop",
        invocation: "@branch",
    },
    {
        name: "clone",
        label: "Clone session",
        description: "Clone the current Pi session",
        source: "desktop",
        invocation: "@clone",
    },
    {
        name: "tree",
        label: "Session tree",
        description: "Inspect the Pi session tree",
        source: "desktop",
        invocation: "@tree",
    },
    {
        name: "rename",
        label: "Rename session",
        description: "Set the session name",
        source: "desktop",
        invocation: "@rename",
    },
    {
        name: "label",
        label: "Label entry",
        description: "Label the current session-tree entry",
        source: "desktop",
        invocation: "@label",
    },
    {
        name: "export",
        label: "Export transcript",
        description: "Save the transcript as HTML",
        source: "desktop",
        invocation: "@export",
    },
    {
        name: "abort",
        label: "Abort turn",
        description: "Stop the active agent turn",
        source: "desktop",
        invocation: "@abort",
    },
    {
        name: "runtime",
        label: "Runtime",
        description: "Inspect Pi runtime and diagnostics",
        source: "desktop",
        invocation: "@runtime",
    },
    {
        name: "commands",
        label: "Commands",
        description: "Browse every Pi and desktop command",
        source: "desktop",
        invocation: "@commands",
    },
];

function object(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function latestSpecMode(entries: unknown[]): boolean {
    let enabled = false;
    for (const candidate of entries) {
        const entry = object(candidate);
        if (entry.type === "custom" && entry.customType === "spec-mode") {
            enabled = object(entry.data).enabled === true;
        }
    }

    return enabled;
}

function projectLabel(projectPath: string): string {
    return (
        projectPath
            .replace(/[\\/]+$/u, "")
            .split(/[\\/]/u)
            .at(-1) || projectPath
    );
}

function compactPath(projectPath: string): string {
    const home = projectPath.match(/^(.*?[\\/](?:Users|home)[\\/][^\\/]+)([\\/].*)$/iu);

    return home?.[2] ? `~${home[2].replaceAll("\\", "/")}` : projectPath.replaceAll("\\", "/");
}

function normalizedSessionPath(sessionPath: string): string {
    return sessionPath.replaceAll("\\", "/").toLowerCase();
}

function sessionRuntimeLabel(status?: RuntimeStatus): string | undefined {
    if (!status || status.phase === "stopped") {
        return undefined;
    }

    const labels: Partial<Record<RuntimeStatus["phase"], string>> = {
        starting: "starting",
        idle: "idle",
        streaming: "working",
        "waiting-for-user": "waiting",
        compacting: "compacting",
        retrying: "retrying",
        failed: "failed",
    };

    return labels[status.phase];
}

function relativeTime(timestamp: string): string {
    const elapsed = Date.now() - new Date(timestamp).getTime();
    if (!Number.isFinite(elapsed) || elapsed < 0) {
        return "recently";
    }

    const minutes = Math.floor(elapsed / 60_000);
    if (minutes < 1) {
        return "just now";
    }

    if (minutes < 60) {
        return `${minutes} min ago`;
    }

    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours} hr ago`;
    }

    const days = Math.floor(hours / 24);

    return days === 1 ? "yesterday" : `${days} days ago`;
}

function formatCount(value: unknown): string {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return "—";
    }

    return value >= 1_000_000
        ? `${(value / 1_000_000).toFixed(1)}m`
        : value >= 1_000
          ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`
          : value.toLocaleString();
}

function formatElapsed(milliseconds: number): string {
    const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
    const minutes = Math.floor(seconds / 60);

    return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function statusValue(statuses: Map<string, string>, fragment: string, fallback: string): string {
    const match = [...statuses.entries()].find(([key]) => key.toLowerCase().includes(fragment));
    if (!match) {
        return fallback;
    }

    return stripAnsi(match[1])
        .replace(/[🛡π]/gu, "")
        .replace(new RegExp(`^${fragment}\\s*[:·-]?\\s*`, "iu"), "")
        .trim()
        .toLowerCase();
}

export function App() {
    const [desktop, setDesktop] = useState<DesktopState>();
    const [runtime, setRuntime] = useState<RuntimeStatus>({ generation: 0, phase: "stopped" });
    const [runtimeRoster, setRuntimeRoster] = useState<RuntimeDescriptor[]>([]);
    const runtimeRef = useRef(runtime);
    runtimeRef.current = runtime;
    const [conversation, dispatch] = useReducer(reduceRuntimeEvent, undefined, emptyConversation);
    const [commands, setCommands] = useState<CommandInfo[]>([]);
    const [models, setModels] = useState<ModelOption[]>([]);
    const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
    const [sessionState, setSessionState] = useState<Record<string, unknown>>({});
    const [sessionStats, setSessionStats] = useState<Record<string, unknown>>({});
    const [dialogs, setDialogs] = useState<ExtensionUiRequest[]>([]);
    const [toasts, setToasts] = useState<Toast[]>([]);
    const [statuses, setStatuses] = useState(new Map<string, string>());
    const [widgets, setWidgets] = useState(new Map<string, string[]>());
    const [palette, setPalette] = useState(false);
    const [draft, setDraft] = useState("");
    const composerRef = useRef<HTMLTextAreaElement>(null);
    const promptHistory = useRef<string[]>([]);
    const historyIndex = useRef(-1);
    const historyDraft = useRef("");
    const [autocompleteOpen, setAutocompleteOpen] = useState(false);
    const [autocompleteIndex, setAutocompleteIndex] = useState(0);
    const [commandFeedback, setCommandFeedback] = useState("");
    const commandFeedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const [requestedGuardMode, setRequestedGuardMode] = useState<"off" | "guard" | "strict">();
    const [sessionSearch, setSessionSearch] = useState("");
    const [delivery, setDelivery] = useState<"steer" | "followUp">("steer");
    const [attachments, setAttachments] = useState<
        Array<{
            type: "image";
            data: string;
            mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
            name: string;
        }>
    >([]);
    const [specMode, setSpecMode] = useState(false);
    const [pendingSpecMode, setPendingSpecMode] = useState<boolean>();
    const [selectedProject, setSelectedProject] = useState<ProjectRecord>();
    const [activeSessionId, setActiveSessionId] = useState<string>();
    const [launchIntent, setLaunchIntent] = useState<StartRuntimeOptions>();
    const launchHandled = useRef(false);
    const runStartedAt = useRef<number | undefined>(undefined);
    const [runElapsed, setRunElapsed] = useState(0);
    const [lastRunElapsed, setLastRunElapsed] = useState(0);
    const [pendingProject, setPendingProject] = useState<string>();
    const [branchChoices, setBranchChoices] = useState<BranchChoice[]>();
    const [renameSessionOpen, setRenameSessionOpen] = useState(false);
    const [filesTab, setFilesTab] = useState<"files" | "changes">("files");
    const [changedFiles, setChangedFiles] = useState(0);
    const [gitBranch, setGitBranch] = useState("");
    const [filesRefreshToken, setFilesRefreshToken] = useState(0);
    const [filesMounted, setFilesMounted] = useState(false);
    const [projectMenuOpen, setProjectMenuOpen] = useState(false);
    const [runtimePanel, setRuntimePanel] = useState(false);
    const [treeView, setTreeView] = useState<unknown>();
    const [diagnostics, setDiagnostics] = useState<readonly string[]>([]);
    const [spinup, setSpinup] = useState<SpinupStatus>();
    const [spinupElapsed, setSpinupElapsed] = useState(0);
    const startGeneration = useRef(0);
    const startInFlight = useRef(false);
    const [sessionChanging, setSessionChanging] = useState(false);
    const [error, setError] = useState("");

    const toast = useCallback((message: string, level: Toast["level"] = "info") => {
        const id = crypto.randomUUID();
        setToasts((current) => [...current.slice(-4), { id, message: stripAnsi(message).slice(0, 2_000), level }]);
        setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 6_000);
    }, []);

    const showCommandFeedback = useCallback((message: string) => {
        if (commandFeedbackTimer.current) {
            clearTimeout(commandFeedbackTimer.current);
        }

        setCommandFeedback(message);
        commandFeedbackTimer.current = setTimeout(() => setCommandFeedback(""), 4_000);
    }, []);

    const persist = useCallback(async (patch: Parameters<typeof window.specpi.updateDesktopState>[0]) => {
        const next = await window.specpi.updateDesktopState(patch);
        setDesktop(next);

        return next;
    }, []);

    const hydrate = useCallback(
        async (project?: ProjectRecord, desktopOverride?: DesktopState, draftOverride?: string) => {
            const [stateValue, messagesValue, commandsValue, modelsValue, thinkingValue, entriesValue, statsValue] =
                await Promise.all([
                    window.specpi.sendRuntimeCommand({ type: "get_state" }),
                    window.specpi.sendRuntimeCommand({ type: "get_messages" }),
                    window.specpi.sendRuntimeCommand({ type: "get_commands" }),
                    window.specpi.sendRuntimeCommand({ type: "get_available_models" }),
                    window.specpi.sendRuntimeCommand({ type: "get_available_thinking_levels" }),
                    window.specpi.sendRuntimeCommand({ type: "get_entries" }),
                    window.specpi.sendRuntimeCommand({ type: "get_session_stats" }),
                ]);
            const stateData = object(stateValue);
            const messages = object(messagesValue).messages;
            const commandList = object(commandsValue).commands;
            const modelList = object(modelsValue).models;
            const levels = object(thinkingValue).levels;
            const entries = object(entriesValue).entries;
            setSessionState(stateData);
            setSessionStats(object(statsValue));
            dispatch({ generation: runtimeRef.current.generation, record: { type: "desktop_hydrate", messages } });
            if (Array.isArray(messages)) {
                const items = messagesToItems(messages);
                dispatch({ generation: runtimeRef.current.generation, record: { type: "desktop_replace", items } });
            }

            setCommands(
                Array.isArray(commandList)
                    ? commandList
                          .map((item) => object(item) as unknown as CommandInfo)
                          .filter((command) => typeof command.name === "string")
                    : [],
            );
            setModels(Array.isArray(modelList) ? modelList.map((item) => object(item) as unknown as ModelOption) : []);
            setThinkingLevels(
                Array.isArray(levels) ? levels.filter((item): item is string => typeof item === "string") : [],
            );
            setSpecMode(Array.isArray(entries) ? latestSpecMode(entries) : false);

            const sessionFile = typeof stateData.sessionFile === "string" ? stateData.sessionFile : undefined;
            const sessionId = typeof stateData.sessionId === "string" ? stateData.sessionId : undefined;
            const desktopState = desktopOverride ?? desktop;
            if (project && desktopState && sessionFile && sessionId) {
                const normalizedSessionPath = sessionFile.replaceAll("\\", "/").toLowerCase();
                const existing = desktopState.sessions.find(
                    (item) =>
                        item.id === sessionId ||
                        item.sessionPath.replaceAll("\\", "/").toLowerCase() === normalizedSessionPath,
                );
                const record: SessionRecord = {
                    id: sessionId,
                    projectId: project.id,
                    sessionId,
                    sessionPath: sessionFile,
                    name:
                        typeof stateData.sessionName === "string" && stateData.sessionName.trim()
                            ? stateData.sessionName
                            : undefined,
                    title: sessionTitleFromMessages(messages) ?? existing?.title,
                    model: object(stateData.model).id
                        ? `${String(object(stateData.model).provider)}/${String(object(stateData.model).id)}`
                        : existing?.model,
                    lastOpenedAt: new Date().toISOString(),
                    draft: existing?.draft ?? draftOverride ?? "",
                };
                setActiveSessionId(record.id);
                const saved = await window.specpi.saveSession(record);
                setDesktop(saved);

                return saved;
            }

            return desktopState;
        },
        [desktop],
    );

    useEffect(() => {
        let active = true;
        void Promise.all([
            window.specpi.getDesktopState(),
            window.specpi.getRuntimeSnapshot(),
            window.specpi.getRuntimeRoster(),
            window.specpi.getLaunchIntent(),
        ]).then(([state, snapshot, runtimes, intent]) => {
            if (!active) {
                return;
            }

            setDesktop(state);
            runtimeRef.current = snapshot.status;
            setRuntime(snapshot.status);
            setRuntimeRoster(runtimes);
            setDialogs(snapshot.pendingUi);
            const project = intent
                ? state.projects.find((item) => item.path.toLowerCase() === intent.cwd.toLowerCase())
                : state.projects.find((item) => item.id === state.activeProjectId);
            setSelectedProject(project);
            setActiveSessionId(intent ? undefined : state.activeSessionId);
            setLaunchIntent(intent);
        });
        const offStatus = window.specpi.onRuntimeStatus((status) => {
            runtimeRef.current = status;
            setRuntime(status);
            if (status.phase === "stopped" || status.phase === "failed") {
                setDialogs([]);
            }
        });
        const offRoster = window.specpi.onRuntimeRoster(setRuntimeRoster);
        let streamFrame: number | undefined;
        let streamEvents: RuntimeEvent[] = [];
        const flushStream = () => {
            streamFrame = undefined;
            const queued = streamEvents;
            streamEvents = [];
            for (const event of queued) {
                dispatch(event);
            }
        };

        const offEvent = window.specpi.onRuntimeEvent((event) => {
            if (event.generation < runtimeRef.current.generation) {
                return;
            }

            const record = event.record;
            if (record.type === "message_update") {
                streamEvents.push(event);
                streamFrame ??= requestAnimationFrame(flushStream);

                return;
            }

            if (streamFrame !== undefined) {
                cancelAnimationFrame(streamFrame);
                flushStream();
            }

            dispatch(event);
            if (record.type === "agent_start") {
                runStartedAt.current = Date.now();
                setRunElapsed(0);
            } else if (record.type === "agent_settled") {
                if (runStartedAt.current) {
                    const elapsed = Date.now() - runStartedAt.current;
                    setRunElapsed(elapsed);
                    setLastRunElapsed(elapsed);
                    runStartedAt.current = undefined;
                }

                void window.specpi
                    .sendRuntimeCommand({ type: "get_session_stats" })
                    .then((value) => setSessionStats(object(value)))
                    .catch(() => undefined);
            }

            if (record.type === "extension_ui_request") {
                const request = record as ExtensionUiRequest;
                if (["select", "confirm", "input", "editor"].includes(request.method)) {
                    setDialogs((current) =>
                        current.some((item) => item.id === request.id) ? current : [...current, request],
                    );
                } else if (request.method === "notify") {
                    toast(
                        String(request.message ?? ""),
                        request.notifyType === "warning" || request.notifyType === "error"
                            ? request.notifyType
                            : "info",
                    );
                } else if (request.method === "setStatus") {
                    if (String(request.statusKey).includes("command-guard")) {
                        setRequestedGuardMode(undefined);
                    }

                    setStatuses((current) => {
                        const next = new Map(current);
                        if (typeof request.statusText === "string") {
                            next.set(String(request.statusKey), stripAnsi(request.statusText));
                        } else {
                            next.delete(String(request.statusKey));
                        }

                        return next;
                    });
                } else if (request.method === "setWidget") {
                    setWidgets((current) => {
                        const next = new Map(current);
                        if (Array.isArray(request.widgetLines)) {
                            next.set(
                                String(request.widgetKey),
                                request.widgetLines.map((line) => stripAnsi(String(line))),
                            );
                        } else {
                            next.delete(String(request.widgetKey));
                        }

                        return next;
                    });
                } else if (request.method === "setTitle") {
                    document.title = stripAnsi(String(request.title ?? "SpecPi Desktop"));
                } else if (request.method === "set_editor_text") {
                    setDraft(String(request.text ?? ""));
                } else {
                    setDialogs((current) =>
                        current.some((item) => item.id === request.id) ? current : [...current, request],
                    );
                }
            }

            if (record.type === "entry_appended") {
                const entry = object(record.entry);
                if (entry.customType === "spec-mode") {
                    setSpecMode(object(entry.data).enabled === true);
                }
            }
        });

        return () => {
            active = false;
            if (streamFrame !== undefined) {
                cancelAnimationFrame(streamFrame);
            }

            offStatus();
            offRoster();
            offEvent();
        };
    }, [toast]);

    useEffect(() => {
        if (!desktop) {
            return;
        }

        document.documentElement.dataset.theme = desktop.theme;
    }, [desktop?.theme]);

    useEffect(() => {
        if (desktop?.layout.filesOpen) {
            setFilesMounted(true);
        }
    }, [desktop?.layout.filesOpen]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const modifier = event.ctrlKey || event.metaKey;
            const key = event.key.toLowerCase();
            if (modifier && (key === "k" || (event.shiftKey && key === "p")) && dialogs.length === 0) {
                event.preventDefault();
                if (runtime.phase !== "stopped") {
                    setPalette(true);
                }
            } else if (modifier && key === "b" && desktop) {
                event.preventDefault();
                void persist({ layout: { sidebarOpen: !desktop.layout.sidebarOpen } });
            } else if (modifier && key === "l" && runtime.phase !== "stopped") {
                event.preventDefault();
                composerRef.current?.focus();
            } else if (event.key === "Escape" && palette) {
                setPalette(false);
            } else if (event.key === "Escape" && pendingProject) {
                setPendingProject(undefined);
            }
        };

        window.addEventListener("keydown", onKeyDown);

        return () => window.removeEventListener("keydown", onKeyDown);
    }, [desktop, dialogs.length, palette, pendingProject, persist, runtime.phase]);

    useEffect(() => {
        if (!selectedProject) {
            setChangedFiles(0);
            setGitBranch("");

            return;
        }

        let active = true;
        void window.specpi
            .getGitStatus(selectedProject.path)
            .then((git) => {
                if (active) {
                    setChangedFiles(git.files.length);
                    setGitBranch(git.branch ?? "");
                }
            })
            .catch(() => {
                if (active) {
                    setChangedFiles(0);
                    setGitBranch("");
                }
            });

        return () => {
            active = false;
        };
    }, [selectedProject?.path, conversation.toolCount]);

    useEffect(() => {
        if (!activeSessionId) {
            return;
        }

        const sessionId = activeSessionId;
        const timer = setTimeout(() => {
            void window.specpi
                .saveSessionDraft(sessionId, draft)
                .then(setDesktop)
                .catch(() => undefined);
        }, 350);

        return () => clearTimeout(timer);
    }, [draft, activeSessionId]);

    useEffect(() => {
        if (!["streaming", "compacting", "retrying"].includes(runtime.phase)) {
            return;
        }

        const update = () => setRunElapsed(runStartedAt.current ? Date.now() - runStartedAt.current : 0);
        update();
        const timer = setInterval(update, 1_000);

        return () => clearInterval(timer);
    }, [runtime.phase]);

    useEffect(() => {
        if (!spinup) {
            return;
        }

        const update = () => setSpinupElapsed(Date.now() - spinup.startedAt);
        update();
        const timer = setInterval(update, 1_000);

        return () => clearInterval(timer);
    }, [spinup]);

    const startProject = async (
        project: ProjectRecord,
        sessionPath?: string,
        desktopOverride?: DesktopState,
        noSession = false,
    ) => {
        const desktopState = desktopOverride ?? desktop;
        if (!desktopState) {
            return;
        }

        if (startInFlight.current) {
            toast("Pi is still finishing the previous runtime transition.", "warning");

            return;
        }

        startInFlight.current = true;
        const startToken = ++startGeneration.current;
        const normalizedPath = sessionPath ? normalizedSessionPath(sessionPath) : undefined;
        const openingSession = normalizedPath
            ? desktopState.sessions.find((session) => normalizedSessionPath(session.sessionPath) === normalizedPath)
            : undefined;
        const running = normalizedPath
            ? runtimeRoster.some(
                  (item) =>
                      item.sessionPath !== undefined &&
                      normalizedSessionPath(item.sessionPath) === normalizedPath &&
                      item.status.phase !== "stopped" &&
                      item.status.phase !== "failed",
              )
            : false;
        setSpinup(
            running
                ? undefined
                : {
                      startedAt: Date.now(),
                      projectLabel: project.label,
                      sessionLabel: openingSession?.name ?? (sessionPath ? "Selected session" : undefined),
                  },
        );
        setSpinupElapsed(0);
        setError("");
        setSelectedProject(project);
        setDialogs([]);
        setStatuses(new Map());
        setWidgets(new Map());
        setSessionState({});
        setSessionStats({});
        setSpecMode(false);
        setPendingSpecMode(undefined);
        setRequestedGuardMode(undefined);
        setAttachments([]);
        setBranchChoices(undefined);
        runStartedAt.current = undefined;
        setRunElapsed(0);
        setLastRunElapsed(0);
        document.title = "SpecPi Desktop";
        dispatch({ generation: runtimeRef.current.generation + 1, record: { type: "desktop_clear" } });
        try {
            const started = await window.specpi.startRuntime({
                cwd: project.path,
                piPath: desktopState.piPath,
                trust: project.trust,
                sessionPath,
                noSession,
            });
            if (startToken !== startGeneration.current) {
                await window.specpi.stopRuntime();

                return;
            }

            runtimeRef.current = started;
            setRuntime(started);
            if (["streaming", "compacting", "retrying"].includes(started.phase)) {
                runStartedAt.current = Date.now();
            }

            if (started.compatibilityWarning) {
                setSpinup(undefined);
                if (!window.confirm(`${started.compatibilityWarning}\n\nContinue?`)) {
                    await window.specpi.stopRuntime();

                    return;
                }
            }

            const next = await persist({ activeProjectId: project.id });
            const hydrated = await hydrate(project, next);
            const activeSession = hydrated?.sessions.find((session) => session.id === hydrated.activeSessionId);
            setDraft(activeSession?.draft ?? "");
        } catch (caught) {
            if (startToken === startGeneration.current) {
                setError(caught instanceof Error ? caught.message : String(caught));
            }
        } finally {
            startInFlight.current = false;
            if (startToken === startGeneration.current) {
                setSpinup(undefined);
            }
        }
    };

    useEffect(() => {
        if (!desktop || !launchIntent || launchHandled.current) {
            return;
        }

        const project = desktop.projects.find((item) => item.path.toLowerCase() === launchIntent.cwd.toLowerCase());
        if (!project) {
            setError("The project for this workspace is no longer available.");

            return;
        }

        launchHandled.current = true;
        void startProject(project, launchIntent.sessionPath, desktop, launchIntent.noSession === true);
    }, [desktop, launchIntent]);

    const addProject = async () => {
        const selected = await window.specpi.chooseProject();
        if (selected) {
            setPendingProject(selected);
        }
    };

    const confirmProject = async (trust: ProjectRecord["trust"]) => {
        if (!pendingProject || !desktop) {
            return;
        }

        const existing = desktop.projects.find((item) => item.path.toLowerCase() === pendingProject.toLowerCase());
        const project: ProjectRecord = existing
            ? { ...existing, trust }
            : {
                  id: crypto.randomUUID(),
                  path: pendingProject,
                  label: projectLabel(pendingProject),
                  lastOpenedAt: new Date().toISOString(),
                  trust,
                  pinned: false,
              };
        const projects = [project, ...desktop.projects.filter((item) => item.id !== project.id)];
        const next = await persist({ projects, activeProjectId: project.id });
        setPendingProject(undefined);
        await startProject(project, project.lastSessionPath, next);
    };

    const addImages = async (files: File[]) => {
        const selected = files.slice(0, Math.max(0, 8 - attachments.length));
        const loaded = await Promise.all(
            selected.map(async (file) => {
                if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)) {
                    throw new Error(`${file.name} is not a supported image type`);
                }

                if (file.size > 10 * 1024 * 1024) {
                    throw new Error(`${file.name} exceeds 10 MB`);
                }

                const bitmap = await createImageBitmap(file);
                const width = bitmap.width;
                const height = bitmap.height;
                const pixels = width * height;
                bitmap.close();
                if (pixels > 32_000_000 || width > 8_192 || height > 8_192) {
                    throw new Error(`${file.name} exceeds the image dimension limit`);
                }

                const dataUrl = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
                    reader.onload = () => resolve(String(reader.result));
                    reader.readAsDataURL(file);
                });

                return {
                    type: "image" as const,
                    data: dataUrl.slice(dataUrl.indexOf(",") + 1),
                    mimeType: file.type as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
                    name: file.name,
                };
            }),
        );
        setAttachments((current) => [...current, ...loaded].slice(0, 8));
    };

    const runPrompt = async (text = draft) => {
        const message = text.trim();
        if (!message) {
            return;
        }

        setError("");
        setAutocompleteOpen(false);
        const images = attachments.map(({ name: _name, ...image }) => image);
        const slash = parseSlashCommand(message);
        const discovered = slash ? commands.find((command) => command.name.toLowerCase() === slash.name) : undefined;
        const currentSession = desktop?.sessions.find((session) => session.id === activeSessionId);
        const automaticTitle =
            currentSession && !currentSession.name?.trim() && !currentSession.title?.trim()
                ? sessionTitleFromPrompt(message)
                : undefined;
        try {
            let command: RpcCommand = { type: "prompt", message, images };
            const streamingBehavior = composerStreamingBehavior(agentBusy, discovered?.source, delivery);
            if (streamingBehavior) {
                command = { ...command, streamingBehavior };
            }

            if (slash) {
                showCommandFeedback(`Running /${slash.name}…`);
            }

            setDraft("");
            setAttachments([]);
            await window.specpi.sendRuntimeCommand(command);
            if (automaticTitle && currentSession) {
                try {
                    const saved = await window.specpi.saveSessionTitle(currentSession.id, automaticTitle);
                    setDesktop(saved);
                } catch (caught) {
                    setError(
                        `Prompt accepted, but the session title could not be saved: ${
                            caught instanceof Error ? caught.message : String(caught)
                        }`,
                    );
                }
            }

            promptHistory.current = [message, ...promptHistory.current.filter((item) => item !== message)].slice(
                0,
                100,
            );
            historyIndex.current = -1;
            if (slash) {
                showCommandFeedback(`/${slash.name} accepted by Pi`);
            }
        } catch (caught) {
            setDraft(message);
            setError(caught instanceof Error ? caught.message : String(caught));
            if (slash) {
                showCommandFeedback(`/${slash.name} failed`);
            }
        }
    };

    const changeGuardMode = async (mode: "off" | "guard" | "strict") => {
        setRequestedGuardMode(mode);
        setError("");
        showCommandFeedback(`Setting protection to ${mode}…`);
        try {
            await window.specpi.sendRuntimeCommand({ type: "prompt", message: `/guard ${mode}` });
            showCommandFeedback(`Protection set to ${mode}`);
        } catch (caught) {
            setRequestedGuardMode(undefined);
            setError(caught instanceof Error ? caught.message : String(caught));
            showCommandFeedback("Protection change failed");
        }
    };

    const respond = async (response: Parameters<typeof window.specpi.respondToExtension>[0]) => {
        await window.specpi.respondToExtension(response);
        setDialogs((current) => current.filter((item) => item.id !== response.id));
    };

    const saveCurrentDraft = async (): Promise<DesktopState | undefined> => {
        if (!activeSessionId) {
            return desktop;
        }

        const next = await window.specpi.saveSessionDraft(activeSessionId, draft);
        setDesktop(next);

        return next;
    };

    const openIndependentWorkspace = async (sessionPath?: string, newSession = false) => {
        if (!selectedProject || !desktop) {
            return;
        }

        if (
            sessionPath &&
            activeSession?.sessionPath.replaceAll("\\", "/").toLowerCase() ===
                sessionPath.replaceAll("\\", "/").toLowerCase()
        ) {
            toast("That session is already active in this window.", "warning");

            return;
        }

        const options: StartRuntimeOptions = {
            cwd: selectedProject.path,
            piPath: desktop.piPath,
            trust: selectedProject.trust,
            sessionPath,
        };
        if (runtime.phase === "stopped" || runtime.phase === "failed") {
            await startProject(selectedProject, sessionPath, desktop);

            return;
        }

        await window.specpi.openWorkspace(options);
        toast(newSession ? "New session opened in an independent window." : "Session opened in an independent window.");
    };

    const runDesktopCommand = async (command: string, args = "") => {
        const changesSession = ["@new-session", "@clone", "@open-session"].includes(command);
        if (changesSession && sessionChanging) {
            return false;
        }

        if (changesSession) {
            setSessionChanging(true);
        }

        try {
            if (command === "@files") {
                setFilesTab("files");
                await persist({ layout: { filesOpen: true } });
            } else if (command === "@changes") {
                setFilesTab("changes");
                await persist({ layout: { filesOpen: true } });
            } else if (command === "@open-project") {
                await addProject();
            } else if (command === "@abort") {
                await window.specpi.sendRuntimeCommand({ type: "abort" });
            } else if (command === "@new-session") {
                await openIndependentWorkspace(undefined, true);
            } else if (command === "@compact") {
                await window.specpi.sendRuntimeCommand({
                    type: "compact",
                    ...(args ? { customInstructions: args } : {}),
                });
            } else if (command === "@clone") {
                const saved = await saveCurrentDraft();
                await window.specpi.sendRuntimeCommand({ type: "clone" });
                dispatch({ generation: runtimeRef.current.generation, record: { type: "desktop_clear" } });
                await hydrate(selectedProject, saved, "");
                setDraft("");
            } else if (command === "@open-session") {
                const sessionPath = await window.specpi.chooseSession();
                if (sessionPath) {
                    await openIndependentWorkspace(sessionPath);
                }
            } else if (command === "@tree") {
                setTreeView(await window.specpi.sendRuntimeCommand({ type: "get_tree" }));
            } else if (command === "@branch") {
                const result = object(await window.specpi.sendRuntimeCommand({ type: "get_fork_messages" }));
                setBranchChoices(
                    Array.isArray(result.messages)
                        ? (result.messages
                              .map((item) => object(item))
                              .filter(
                                  (item) => typeof item.entryId === "string" && typeof item.text === "string",
                              ) as unknown as BranchChoice[])
                        : [],
                );
            } else if (command === "@rename") {
                if (args) {
                    await window.specpi.sendRuntimeCommand({ type: "set_session_name", name: args.slice(0, 200) });
                    await hydrate(selectedProject);
                } else {
                    setRenameSessionOpen(true);
                }
            } else if (command === "@label") {
                const result = object(await window.specpi.sendRuntimeCommand({ type: "get_entries" }));
                const label = args || window.prompt("Label for the current entry");
                if (typeof result.leafId === "string" && label !== null) {
                    await window.specpi.sendRuntimeCommand({
                        type: "set_label",
                        entryId: result.leafId,
                        label: label.trim().slice(0, 200) || undefined,
                    });
                }
            } else if (command === "@runtime") {
                await openRuntimePanel();
            } else if (command === "@commands") {
                setPalette(true);
            } else if (command === "@export") {
                const result = object(await window.specpi.sendRuntimeCommand({ type: "export_html" }));
                if (typeof result.path === "string") {
                    await window.specpi.saveExport(result.path);
                }
            }

            return true;
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));

            return false;
        } finally {
            if (changesSession) {
                setSessionChanging(false);
            }
        }
    };

    const runComposerInput = async (text = draft) => {
        const message = text.trim();
        if (!message) {
            return;
        }

        const slash = parseSlashCommand(message);
        const local = slash ? DESKTOP_COMMANDS.find((command) => command.name.toLowerCase() === slash.name) : undefined;
        if (slash && /^spec$/u.test(slash.name) && /^(?:on|off)$/u.test(slash.args)) {
            setDraft("");
            setAutocompleteOpen(false);
            promptHistory.current = [message, ...promptHistory.current.filter((item) => item !== message)].slice(
                0,
                100,
            );
            const succeeded = await requestSpecMode(slash.args === "on");
            showCommandFeedback(succeeded ? `/spec ${slash.args} accepted by Pi` : `/spec ${slash.args} failed`);

            return;
        }

        if (slash && local?.invocation) {
            setDraft("");
            setAutocompleteOpen(false);
            setAttachments([]);
            promptHistory.current = [message, ...promptHistory.current.filter((item) => item !== message)].slice(
                0,
                100,
            );
            historyIndex.current = -1;
            showCommandFeedback(`Running /${slash.name}…`);
            const succeeded = await runDesktopCommand(local.invocation, slash.args);
            showCommandFeedback(succeeded ? `/${slash.name} complete` : `/${slash.name} failed`);

            return;
        }

        await runPrompt(message);
    };

    const forkSession = async (entryId: string) => {
        if (sessionChanging) {
            return;
        }

        setBranchChoices(undefined);
        setSessionChanging(true);
        try {
            const saved = await saveCurrentDraft();
            await window.specpi.sendRuntimeCommand({ type: "fork", entryId });
            dispatch({ generation: runtimeRef.current.generation, record: { type: "desktop_clear" } });
            await hydrate(selectedProject, saved, "");
            setDraft("");
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setSessionChanging(false);
        }
    };

    const openRuntimePanel = async () => {
        setDiagnostics(await window.specpi.getRuntimeDiagnostics());
        setRuntimePanel(true);
    };

    const chooseRuntime = async () => {
        const piPath = await window.specpi.choosePi();
        if (piPath) {
            await persist({ piPath });
        }
    };

    const switchSession = async (session: SessionRecord) => {
        const action = sessionOpenAction(runtime.phase, session.id === activeSessionId);
        if (sessionChanging || action === "none") {
            return;
        }

        setSessionChanging(true);
        setError("");
        try {
            const project = desktop?.projects.find((item) => item.id === session.projectId) ?? selectedProject;
            if (!project || !desktop) {
                throw new Error("The project for this session is no longer available.");
            }

            const saved = await saveCurrentDraft();
            setActiveSessionId(session.id);
            await startProject(project, session.sessionPath, saved);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setSessionChanging(false);
        }
    };

    const requestSpecMode = async (next = !specMode) => {
        setSpecMode(next);
        const isBusy = ["streaming", "compacting", "retrying"].includes(runtime.phase);
        if (isBusy) {
            setPendingSpecMode(next);
            toast(`Spec view ${next ? "enabled" : "disabled"} now; session state will sync after this turn.`);

            return true;
        }

        try {
            await window.specpi.sendRuntimeCommand({ type: "prompt", message: `/spec ${next ? "on" : "off"}` });
        } catch (caught) {
            setSpecMode(!next);
            setError(caught instanceof Error ? caught.message : String(caught));

            return false;
        }

        return true;
    };

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (!(event.ctrlKey || event.metaKey) || dialogs.length > 0 || pendingProject) {
                return;
            }

            if (event.key.toLowerCase() === "n" && selectedProject) {
                event.preventDefault();
                void runDesktopCommand("@new-session");
            } else if (event.key.toLowerCase() === "o") {
                event.preventDefault();
                void addProject();
            }
        };

        window.addEventListener("keydown", onKeyDown);

        return () => window.removeEventListener("keydown", onKeyDown);
    }, [dialogs.length, pendingProject, selectedProject, sessionChanging]);

    const switchModel = async (value: string) => {
        const model = models.find((item) => `${item.provider}/${item.id}` === value);
        if (!model) {
            return;
        }

        try {
            await window.specpi.sendRuntimeCommand({ type: "set_model", provider: model.provider, modelId: model.id });
            await hydrate(selectedProject);
        } catch (caught) {
            setError(
                `Model unavailable or provider authentication is incomplete. ${caught instanceof Error ? caught.message : String(caught)}`,
            );
        }
    };

    useEffect(() => {
        if (pendingSpecMode === undefined || runtime.phase !== "idle") {
            return;
        }

        const next = pendingSpecMode;
        setPendingSpecMode(undefined);
        void window.specpi
            .sendRuntimeCommand({ type: "prompt", message: `/spec ${next ? "on" : "off"}` })
            .catch((caught) => {
                setSpecMode(!next);
                setError(caught instanceof Error ? caught.message : String(caught));
            });
    }, [pendingSpecMode, runtime.phase]);

    const activeModel = object(sessionState.model);
    const currentSessions = desktop?.sessions.filter((item) => item.projectId === selectedProject?.id) ?? [];
    const visibleSessions = currentSessions.filter((session) =>
        `${sessionDisplayTitle(session.name, session.title)} ${session.model ?? ""} ${session.sessionPath}`
            .toLowerCase()
            .includes(sessionSearch.trim().toLowerCase()),
    );
    const runtimeBySessionPath = useMemo(
        () =>
            new Map(
                runtimeRoster.flatMap((item) =>
                    item.sessionPath ? [[normalizedSessionPath(item.sessionPath), item] as const] : [],
                ),
            ),
        [runtimeRoster],
    );
    const activeSession = currentSessions.find((item) => item.id === activeSessionId);
    const activeSessionTitle = activeSession ? sessionDisplayTitle(activeSession.name, activeSession.title) : undefined;
    const paletteCommands = useMemo(() => {
        const localNames = new Set(DESKTOP_COMMANDS.map((command) => command.name.toLowerCase()));

        return [...DESKTOP_COMMANDS, ...commands.filter((command) => !localNames.has(command.name.toLowerCase()))];
    }, [commands]);
    const slashSuggestions = useMemo(
        () => (autocompleteOpen ? commandSuggestions(draft, paletteCommands) : []),
        [autocompleteOpen, draft, paletteCommands],
    );
    const agentBusy = runtime.phase === "streaming" || runtime.phase === "compacting" || runtime.phase === "retrying";
    const contextUsage = object(sessionStats.contextUsage);
    const tokenStats = object(sessionStats.tokens);
    const usageText = [
        typeof tokenStats.total === "number" ? `${tokenStats.total.toLocaleString()} tokens` : undefined,
        typeof sessionStats.cost === "number" ? `$${sessionStats.cost.toFixed(4)}` : undefined,
        contextUsage.percent != null ? `CTX ${Number(contextUsage.percent).toFixed(0)}%` : "CTX —",
    ]
        .filter(Boolean)
        .join(" · ");
    const statusText = runtime.phase === "waiting-for-user" ? "Waiting for you" : runtime.phase;
    const guardState = statusValue(statuses, "guard", "off");
    const guardMode =
        requestedGuardMode ?? (/strict/iu.test(guardState) ? "strict" : /off/iu.test(guardState) ? "off" : "guard");
    const scopeState = statusValue(statuses, "scope", "inactive");
    const wishlistState = statusValue(statuses, "wishlist", "inactive");
    const experimentState = statusValue(statuses, "experiment", "none");
    const totalTurns =
        typeof sessionStats.assistantMessages === "number" ? sessionStats.assistantMessages : conversation.turnCount;
    const totalTools = typeof sessionStats.toolCalls === "number" ? sessionStats.toolCalls : conversation.toolCount;
    const messageTotal = typeof sessionStats.totalMessages === "number" ? sessionStats.totalMessages : 0;
    const queueTotal = conversation.queue.steering.length + conversation.queue.followUp.length;
    const displayElapsed = runStartedAt.current ? runElapsed : lastRunElapsed;
    const modelLabel = String(activeModel.name ?? activeModel.id ?? "Not selected");
    const scopeReady = /clean|inactive|unset/iu.test(scopeState);
    const guardReady = guardState !== "not set" && !/off/iu.test(guardState);
    const specPhase =
        runtime.phase === "streaming"
            ? "REASONING"
            : runtime.phase === "waiting-for-user"
              ? "REVIEW"
              : runtime.phase.toUpperCase();
    const sidebarHidden = !desktop?.layout.sidebarOpen || specMode;
    const inspectorHidden = !desktop?.layout.inspectorOpen || specMode || Boolean(desktop?.layout.filesOpen);

    if (!desktop) {
        return <main className="loading">Loading SpecPi Desktop…</main>;
    }

    return (
        <main
            className={`${specMode ? "app spec-active" : "app"}${desktop.layout.sidebarOpen ? "" : " sidebar-collapsed"}`}
        >
            <header className={`window-titlebar${/Macintosh/iu.test(navigator.userAgent) ? " mac" : ""}`}>
                <button
                    className="sidebar-toggle"
                    aria-label={desktop.layout.sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
                    title={`${desktop.layout.sidebarOpen ? "Collapse" : "Expand"} sidebar (Ctrl+B)`}
                    onClick={() => void persist({ layout: { sidebarOpen: !desktop.layout.sidebarOpen } })}
                >
                    <Icon name="panel-left" size={17} />
                </button>
                <i className="window-divider" aria-hidden="true" />
                <span className="window-mark" aria-hidden="true">
                    π
                </span>
                <strong className="window-project">{selectedProject?.label ?? "SpecPi Desktop"}</strong>
                {activeSessionTitle ? (
                    <>
                        <span className="window-slash" aria-hidden="true">
                            /
                        </span>
                        <strong className="window-session">{activeSessionTitle}</strong>
                    </>
                ) : null}
                {specMode ? (
                    <span className="window-spec-badge">
                        <i aria-hidden="true" /> Spec
                    </span>
                ) : null}
            </header>
            <aside className="sidebar" aria-hidden={sidebarHidden} inert={sidebarHidden ? true : undefined}>
                {selectedProject ? (
                    <>
                        <div className="project-switcher-wrap">
                            <button
                                className="project-switcher"
                                aria-expanded={projectMenuOpen}
                                onClick={() => setProjectMenuOpen((open) => !open)}
                            >
                                <span>{selectedProject.label.slice(0, 1).toUpperCase()}</span>
                                <div>
                                    <strong>{selectedProject.label}</strong>
                                    <small>{compactPath(selectedProject.path)}</small>
                                </div>
                                <Icon name="chevron-down" size={15} />
                            </button>
                            {projectMenuOpen ? (
                                <div className="project-menu">
                                    {desktop.projects.map((project) => (
                                        <button
                                            key={project.id}
                                            className={project.id === selectedProject.id ? "active" : ""}
                                            onClick={() => {
                                                setProjectMenuOpen(false);
                                                void startProject(project, project.lastSessionPath);
                                            }}
                                        >
                                            <span>{project.label.slice(0, 1).toUpperCase()}</span>
                                            <div>
                                                <strong>{project.label}</strong>
                                                <small>{compactPath(project.path)}</small>
                                            </div>
                                        </button>
                                    ))}
                                    <button
                                        className="project-menu-open"
                                        onClick={() => {
                                            setProjectMenuOpen(false);
                                            void addProject();
                                        }}
                                    >
                                        <Icon name="plus" size={14} /> Open project…
                                    </button>
                                </div>
                            ) : null}
                        </div>
                        <label className="session-search">
                            <Icon name="search" size={14} />
                            <input
                                value={sessionSearch}
                                placeholder="Find sessions"
                                aria-label="Find sessions"
                                onChange={(event) => setSessionSearch(event.target.value)}
                            />
                            {sessionSearch ? (
                                <button aria-label="Clear session search" onClick={() => setSessionSearch("")}>
                                    <Icon name="close" size={11} />
                                </button>
                            ) : null}
                        </label>
                        <section className="sessions">
                            <div className="section-heading">
                                <span>Sessions</span>
                                <div>
                                    <button
                                        title="Open a session in an independent window"
                                        aria-label="Open a session in an independent window"
                                        disabled={sessionChanging}
                                        onClick={() => void runDesktopCommand("@open-session")}
                                    >
                                        <Icon name="document" size={15} />
                                    </button>
                                    <button
                                        title="New session in an independent window (Ctrl+N)"
                                        aria-label="New session in an independent window"
                                        disabled={sessionChanging}
                                        onClick={() => void runDesktopCommand("@new-session")}
                                    >
                                        <Icon name="plus" size={15} />
                                    </button>
                                </div>
                            </div>
                            <nav className="session-list" aria-label="Sessions">
                                {visibleSessions.map((session) => {
                                    const active = session.id === activeSessionId;
                                    const sessionTitle = sessionDisplayTitle(session.name, session.title);
                                    const sessionRuntime = runtimeBySessionPath.get(
                                        normalizedSessionPath(session.sessionPath),
                                    );
                                    const sessionStatus = active ? runtime : sessionRuntime?.status;
                                    const runningLabel = active
                                        ? (sessionRuntimeLabel(sessionStatus) ?? "stopped")
                                        : sessionRuntimeLabel(sessionStatus);
                                    const runtimeClass =
                                        sessionStatus && sessionStatus.phase !== "stopped"
                                            ? `session-state ${sessionStatus.phase}`
                                            : "";

                                    return (
                                        <div className={`session-row ${active ? "active" : ""}`} key={session.id}>
                                            <button
                                                className="session-main"
                                                disabled={sessionChanging}
                                                onClick={() => void switchSession(session)}
                                            >
                                                <strong>{sessionTitle}</strong>
                                                <small className={runtimeClass}>
                                                    {runningLabel
                                                        ? `${runningLabel} · `
                                                        : session.model
                                                          ? `${session.model.split("/").at(-1)} · `
                                                          : ""}
                                                    {relativeTime(session.lastOpenedAt)}
                                                </small>
                                            </button>
                                            <button
                                                className="session-popout"
                                                title={
                                                    active
                                                        ? "Already active in this window"
                                                        : "Open in an independent window"
                                                }
                                                aria-label={`Open ${sessionTitle} in an independent window`}
                                                disabled={active}
                                                onClick={() => void openIndependentWorkspace(session.sessionPath)}
                                            >
                                                ↗
                                            </button>
                                        </div>
                                    );
                                })}
                                {currentSessions.length > 0 && visibleSessions.length === 0 ? (
                                    <p className="session-empty">No matching sessions</p>
                                ) : null}
                            </nav>
                        </section>
                    </>
                ) : (
                    <>
                        <button className="open-project-row" onClick={() => void addProject()}>
                            <span>
                                <Icon name="plus" size={15} />
                            </span>
                            <strong>Open a project…</strong>
                            <kbd>{/Macintosh/iu.test(navigator.userAgent) ? "⌘O" : "Ctrl O"}</kbd>
                        </button>
                        <div className="section-heading project-heading">Projects</div>
                        <nav className="projects" aria-label="Projects">
                            {desktop.projects.map((project) => (
                                <button
                                    key={project.id}
                                    onClick={() => void startProject(project, project.lastSessionPath)}
                                >
                                    <span>{project.label.slice(0, 1).toUpperCase()}</span>
                                    <div>
                                        <strong>{project.label}</strong>
                                        <small>{compactPath(project.path)}</small>
                                    </div>
                                </button>
                            ))}
                        </nav>
                        <div className="sidebar-spacer" />
                    </>
                )}
                <footer>
                    <span className={`runtime-connection ${runtime.phase}`}>
                        <i /> {runtime.piVersion ? `Pi ${runtime.piVersion}` : "Pi not connected"}
                    </span>
                    <button title="Runtime" aria-label="Runtime" onClick={() => void openRuntimePanel()}>
                        <Icon name="sliders" size={16} />
                    </button>
                </footer>
            </aside>

            <section className="workspace">
                {selectedProject ? (
                    <header className="topbar">
                        <nav className="workspace-tabs" aria-label="Workspace views">
                            <button
                                className={!desktop.layout.filesOpen ? "active" : ""}
                                onClick={() => void persist({ layout: { filesOpen: false } })}
                            >
                                Chat
                                <i />
                            </button>
                            <button
                                className={desktop.layout.filesOpen && filesTab === "files" ? "active" : ""}
                                onClick={() => {
                                    setFilesTab("files");
                                    void persist({ layout: { filesOpen: true } });
                                }}
                            >
                                Files
                                <i />
                            </button>
                            <button
                                className={desktop.layout.filesOpen && filesTab === "changes" ? "active" : ""}
                                onClick={() => {
                                    setFilesTab("changes");
                                    void persist({ layout: { filesOpen: true } });
                                }}
                            >
                                Changes
                                {changedFiles ? <span className="change-count">{changedFiles}</span> : null}
                                <i />
                            </button>
                        </nav>
                        {specMode ? (
                            <div className="top-actions spec-actions">
                                <div className="spec-status" aria-label="Spec execution status">
                                    <span>{pendingSpecMode !== undefined ? "Sync pending" : specPhase}</span>
                                    <span>T{String(totalTurns).padStart(2, "0")}</span>
                                    <span>X{String(totalTools).padStart(2, "0")}</span>
                                    <span className={scopeReady ? "good" : ""}>
                                        scope{" "}
                                        {Array.from(statuses.keys()).some((key) => key.includes("scope"))
                                            ? "active"
                                            : "unset"}
                                    </span>
                                </div>
                                <i className="top-divider" aria-hidden="true" />
                                <button
                                    className="spec-toggle active"
                                    disabled={runtime.phase === "stopped" || dialogs.length > 0}
                                    onClick={() => void requestSpecMode(false)}
                                >
                                    <span className="diamond-icon" aria-hidden="true" /> Leave Spec
                                </button>
                                <button
                                    className="inspector-toggle"
                                    aria-label="Show session pulse"
                                    title="Show session pulse"
                                    onClick={() =>
                                        void persist({ layout: { inspectorOpen: !desktop.layout.inspectorOpen } })
                                    }
                                >
                                    <Icon name="panel-right" size={16} />
                                </button>
                            </div>
                        ) : desktop.layout.filesOpen ? (
                            <div className="top-actions file-actions">
                                {gitBranch ? (
                                    <span className="branch-label">
                                        <Icon name="branch" size={14} /> {gitBranch}
                                    </span>
                                ) : null}
                                <button
                                    className="icon-button"
                                    title="Refresh files and changes"
                                    aria-label="Refresh files and changes"
                                    onClick={() => setFilesRefreshToken((token) => token + 1)}
                                >
                                    <Icon name="refresh" size={16} />
                                </button>
                                <button
                                    className="inspector-toggle active"
                                    aria-label="Close files panel"
                                    title="Close files panel"
                                    onClick={() => void persist({ layout: { filesOpen: false } })}
                                >
                                    <Icon name="panel-right" size={16} />
                                </button>
                            </div>
                        ) : (
                            <div className="top-actions">
                                <ModelSelector
                                    models={models}
                                    value={`${String(activeModel.provider ?? "")}/${String(activeModel.id ?? "")}`}
                                    disabled={runtime.phase === "stopped" || agentBusy}
                                    onChange={(value) => void switchModel(value)}
                                />
                                <label className="top-select thinking-select">
                                    <select
                                        aria-label="Thinking level"
                                        value={String(sessionState.thinkingLevel ?? "off")}
                                        disabled={runtime.phase === "stopped"}
                                        onChange={async (event) => {
                                            await window.specpi.sendRuntimeCommand({
                                                type: "set_thinking_level",
                                                level: event.target.value,
                                            });
                                            await hydrate(selectedProject);
                                        }}
                                    >
                                        <option value="off">off</option>
                                        {thinkingLevels
                                            .filter((level) => level !== "off")
                                            .map((level) => (
                                                <option key={level} value={level}>
                                                    {level}
                                                </option>
                                            ))}
                                    </select>
                                    <Icon name="chevron-down" size={12} />
                                </label>
                                <i className="top-divider" aria-hidden="true" />
                                <button
                                    className="spec-toggle"
                                    disabled={
                                        runtime.phase === "stopped" || runtime.phase === "failed" || dialogs.length > 0
                                    }
                                    aria-pressed={false}
                                    title="Enter Spec mode"
                                    onClick={() => void requestSpecMode(true)}
                                >
                                    <span className="diamond-icon" aria-hidden="true" /> Spec
                                </button>
                                <button
                                    className="commands-button"
                                    disabled={runtime.phase === "stopped"}
                                    onClick={() => setPalette(true)}
                                >
                                    Commands
                                    <kbd>{/Macintosh/iu.test(navigator.userAgent) ? "⌘K" : "Ctrl K"}</kbd>
                                </button>
                                <button
                                    className={`inspector-toggle ${desktop.layout.inspectorOpen ? "active" : ""}`}
                                    aria-label={
                                        desktop.layout.inspectorOpen ? "Collapse session pulse" : "Expand session pulse"
                                    }
                                    title={
                                        desktop.layout.inspectorOpen ? "Collapse session pulse" : "Expand session pulse"
                                    }
                                    onClick={() =>
                                        void persist({ layout: { inspectorOpen: !desktop.layout.inspectorOpen } })
                                    }
                                >
                                    <Icon name="panel-right" size={16} />
                                </button>
                            </div>
                        )}
                    </header>
                ) : null}
                <div className="content-row">
                    {selectedProject ? (
                        <>
                            <div className="workbench-main">
                                <section className="chat-column">
                                    <Transcript conversation={conversation} specMode={specMode} />
                                    <div className="composer-area">
                                        {dialogs[0] ? <ExtensionDialog request={dialogs[0]} respond={respond} /> : null}
                                        {Array.from(widgets.entries()).map(([key, lines]) => (
                                            <div className="widget" key={key}>
                                                {lines.map((line, index) => (
                                                    <div key={index}>{line}</div>
                                                ))}
                                            </div>
                                        ))}
                                        {conversation.queue.steering.map((message) => (
                                            <div className="queue-chip" key={`s-${message}`}>
                                                Steer · {message}
                                            </div>
                                        ))}
                                        {conversation.queue.followUp.map((message) => (
                                            <div className="queue-chip" key={`f-${message}`}>
                                                Follow-up · {message}
                                            </div>
                                        ))}
                                        {commandFeedback ? (
                                            <div className="command-feedback" role="status">
                                                <span aria-hidden="true">›_</span> {commandFeedback}
                                            </div>
                                        ) : null}
                                        {attachments.length > 0 ? (
                                            <div className="attachments">
                                                {attachments.map((item) => (
                                                    <span key={item.name}>
                                                        {item.name}
                                                        <button
                                                            onClick={() =>
                                                                setAttachments((current) =>
                                                                    current.filter((entry) => entry !== item),
                                                                )
                                                            }
                                                        >
                                                            ×
                                                        </button>
                                                    </span>
                                                ))}
                                            </div>
                                        ) : null}
                                        <div className="composer-shell">
                                            {slashSuggestions.length > 0 ? (
                                                <div className="slash-menu" role="listbox" aria-label="Slash commands">
                                                    <header>
                                                        <span>{slashSuggestions.length} Commands</span>
                                                        <small>↑↓ navigate · Tab complete · ↵ run</small>
                                                    </header>
                                                    {slashSuggestions.map((suggestion, index) => (
                                                        <button
                                                            key={`${suggestion.name}:${suggestion.replacement}`}
                                                            className={index === autocompleteIndex ? "active" : ""}
                                                            role="option"
                                                            aria-selected={index === autocompleteIndex}
                                                            onMouseDown={(event) => event.preventDefault()}
                                                            onMouseEnter={() => setAutocompleteIndex(index)}
                                                            onClick={() => {
                                                                setDraft(`${suggestion.replacement} `);
                                                                setAutocompleteIndex(0);
                                                                setAutocompleteOpen(true);
                                                                composerRef.current?.focus();
                                                            }}
                                                        >
                                                            <strong>{suggestion.replacement}</strong>
                                                            <span>{suggestion.detail ?? suggestion.description}</span>
                                                            <small>{suggestion.source}</small>
                                                        </button>
                                                    ))}
                                                </div>
                                            ) : null}
                                            <div className="composer">
                                                <textarea
                                                    ref={composerRef}
                                                    value={draft}
                                                    disabled={dialogs.length > 0 || runtime.phase === "stopped"}
                                                    placeholder={
                                                        runtime.phase === "stopped"
                                                            ? "Open a project to start Pi"
                                                            : "Ask Pi anything, or type / for commands…"
                                                    }
                                                    onChange={(event) => {
                                                        const next = event.target.value;
                                                        setDraft(next);
                                                        setAutocompleteOpen(
                                                            next.startsWith("/") && !next.includes("\n"),
                                                        );
                                                        setAutocompleteIndex(0);
                                                        historyIndex.current = -1;
                                                    }}
                                                    onPaste={(event) => {
                                                        const images = [...event.clipboardData.files].filter((file) =>
                                                            file.type.startsWith("image/"),
                                                        );
                                                        if (images.length > 0) {
                                                            event.preventDefault();
                                                            void addImages(images).catch((caught) =>
                                                                setError(
                                                                    caught instanceof Error
                                                                        ? caught.message
                                                                        : String(caught),
                                                                ),
                                                            );
                                                        }
                                                    }}
                                                    onKeyDown={async (event) => {
                                                        const suggestion = slashSuggestions[autocompleteIndex];
                                                        if (
                                                            slashSuggestions.length > 0 &&
                                                            (event.key === "ArrowDown" || event.key === "ArrowUp")
                                                        ) {
                                                            event.preventDefault();
                                                            setAutocompleteIndex((index) =>
                                                                event.key === "ArrowDown"
                                                                    ? Math.min(slashSuggestions.length - 1, index + 1)
                                                                    : Math.max(0, index - 1),
                                                            );
                                                        } else if (suggestion && event.key === "Tab") {
                                                            event.preventDefault();
                                                            setDraft(`${suggestion.replacement} `);
                                                            setAutocompleteIndex(0);
                                                            setAutocompleteOpen(true);
                                                        } else if (
                                                            suggestion &&
                                                            event.key === "Enter" &&
                                                            !event.shiftKey &&
                                                            draft.trim() !== suggestion.replacement
                                                        ) {
                                                            event.preventDefault();
                                                            setDraft(`${suggestion.replacement} `);
                                                            setAutocompleteIndex(0);
                                                            setAutocompleteOpen(true);
                                                        } else if (event.key === "Enter" && !event.shiftKey) {
                                                            event.preventDefault();
                                                            await runComposerInput();
                                                        } else if (
                                                            event.key === "ArrowUp" &&
                                                            slashSuggestions.length === 0 &&
                                                            (draft.length === 0 ||
                                                                event.currentTarget.selectionStart === 0)
                                                        ) {
                                                            const nextIndex = Math.min(
                                                                promptHistory.current.length - 1,
                                                                historyIndex.current + 1,
                                                            );
                                                            if (nextIndex >= 0) {
                                                                event.preventDefault();
                                                                if (historyIndex.current < 0) {
                                                                    historyDraft.current = draft;
                                                                }

                                                                historyIndex.current = nextIndex;
                                                                setDraft(promptHistory.current[nextIndex] ?? "");
                                                            }
                                                        } else if (
                                                            event.key === "ArrowDown" &&
                                                            slashSuggestions.length === 0 &&
                                                            historyIndex.current >= 0
                                                        ) {
                                                            event.preventDefault();
                                                            historyIndex.current -= 1;
                                                            setDraft(
                                                                historyIndex.current < 0
                                                                    ? historyDraft.current
                                                                    : (promptHistory.current[historyIndex.current] ??
                                                                          ""),
                                                            );
                                                        } else if (event.key === "Escape" && autocompleteOpen) {
                                                            event.preventDefault();
                                                            setAutocompleteOpen(false);
                                                        } else if (event.key === "Escape" && agentBusy) {
                                                            const cleared = object(
                                                                await window.specpi.sendRuntimeCommand({
                                                                    type: "clear_queue",
                                                                }),
                                                            );
                                                            const recovered = [
                                                                ...(Array.isArray(cleared.steering)
                                                                    ? cleared.steering
                                                                    : []),
                                                                ...(Array.isArray(cleared.followUp)
                                                                    ? cleared.followUp
                                                                    : []),
                                                            ]
                                                                .filter(
                                                                    (item): item is string => typeof item === "string",
                                                                )
                                                                .join("\n");
                                                            if (recovered) {
                                                                setDraft(recovered);
                                                            }

                                                            await window.specpi.sendRuntimeCommand({ type: "abort" });
                                                        }
                                                    }}
                                                />
                                                <div className="composer-controls">
                                                    <div className="composer-start">
                                                        <button
                                                            className="attach-button"
                                                            title="Attach image"
                                                            aria-label="Attach image"
                                                            onClick={() =>
                                                                document.getElementById("image-input")?.click()
                                                            }
                                                        >
                                                            <Icon name="image" size={16} />
                                                        </button>
                                                        <input
                                                            id="image-input"
                                                            hidden
                                                            type="file"
                                                            accept="image/png,image/jpeg,image/gif,image/webp"
                                                            multiple
                                                            onChange={(event) => {
                                                                const input = event.currentTarget;
                                                                void addImages([...(input.files ?? [])])
                                                                    .catch((caught) =>
                                                                        setError(
                                                                            caught instanceof Error
                                                                                ? caught.message
                                                                                : String(caught),
                                                                        ),
                                                                    )
                                                                    .finally(() => {
                                                                        input.value = "";
                                                                    });
                                                            }}
                                                        />
                                                        <i className="composer-divider" aria-hidden="true" />
                                                        <label
                                                            className={`protection-picker ${guardMode}`}
                                                            title="Command protection for this session"
                                                        >
                                                            <Icon name="shield" size={14} />
                                                            <select
                                                                aria-label="Command protection"
                                                                value={guardMode}
                                                                disabled={dialogs.length > 0}
                                                                onChange={(event) =>
                                                                    void changeGuardMode(
                                                                        event.target.value as
                                                                            "off" | "guard" | "strict",
                                                                    )
                                                                }
                                                            >
                                                                <option value="off">Off</option>
                                                                <option value="guard">Guard</option>
                                                                <option value="strict">Strict</option>
                                                            </select>
                                                            <Icon
                                                                name="chevron-down"
                                                                size={11}
                                                                className="picker-chevron"
                                                            />
                                                        </label>
                                                        <div
                                                            className="delivery-toggle"
                                                            aria-label="Queued message delivery"
                                                        >
                                                            <button
                                                                className={delivery === "steer" ? "active" : ""}
                                                                onClick={() => setDelivery("steer")}
                                                            >
                                                                Steer
                                                            </button>
                                                            <button
                                                                className={delivery === "followUp" ? "active" : ""}
                                                                onClick={() => setDelivery("followUp")}
                                                            >
                                                                Follow up
                                                            </button>
                                                        </div>
                                                    </div>
                                                    <div className="composer-end">
                                                        <span className="newline-hint" aria-hidden="true">
                                                            {draft.trim().startsWith("/")
                                                                ? "↵ runs immediately"
                                                                : "⇧↵ newline"}
                                                        </span>
                                                        {agentBusy ? (
                                                            <button
                                                                className="abort-button"
                                                                onClick={() =>
                                                                    void window.specpi.sendRuntimeCommand({
                                                                        type: "abort",
                                                                    })
                                                                }
                                                            >
                                                                Abort
                                                            </button>
                                                        ) : null}
                                                        <button
                                                            className="send"
                                                            disabled={!draft.trim() || dialogs.length > 0}
                                                            onClick={() => void runComposerInput()}
                                                        >
                                                            {draft.trim().startsWith("/")
                                                                ? "Run"
                                                                : agentBusy
                                                                  ? "Queue"
                                                                  : "Send"}
                                                            <Icon name="arrow-up" size={14} />
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="composer-hints" aria-hidden="true">
                                            <span>
                                                <kbd>/</kbd> commands
                                            </span>
                                            <span>
                                                <kbd>Shift ↵</kbd> new line
                                            </span>
                                            <span>
                                                <kbd>Ctrl L</kbd> focus
                                            </span>
                                        </div>
                                        <div className="statusline">
                                            <span>{Array.from(statuses.values()).join(" · ")}</span>
                                            <span>{usageText}</span>
                                        </div>
                                    </div>
                                </section>
                                {filesMounted ? (
                                    <FilesPanel
                                        open={desktop.layout.filesOpen}
                                        root={selectedProject.path}
                                        tab={filesTab}
                                        setTab={setFilesTab}
                                        close={() => void persist({ layout: { filesOpen: false } })}
                                        sendComment={(message) => setDraft(message)}
                                        refreshToken={conversation.toolCount + filesRefreshToken}
                                        onGitStatus={(git) => {
                                            setChangedFiles(git.files.length);
                                            setGitBranch(git.branch ?? "");
                                        }}
                                    />
                                ) : null}
                            </div>
                            <aside
                                className={`run-inspector${inspectorHidden ? " collapsed" : ""}`}
                                aria-label="Session pulse"
                                aria-hidden={inspectorHidden}
                                inert={inspectorHidden ? true : undefined}
                            >
                                <header>
                                    <span>Session pulse</span>
                                    <strong className={`runtime-state ${runtime.phase}`}>
                                        <i /> {statusText}
                                    </strong>
                                </header>
                                <section className="inspector-overview">
                                    <div className="inspector-model">
                                        <strong title={modelLabel}>{modelLabel}</strong>
                                        <span>{String(sessionState.thinkingLevel ?? "off")}</span>
                                    </div>
                                    <div className="context-heading">
                                        <strong>
                                            {contextUsage.percent != null
                                                ? Number(contextUsage.percent).toFixed(0)
                                                : "—"}
                                            <small>%</small>
                                        </strong>
                                        <span>Context used</span>
                                    </div>
                                    <div className="context-meter">
                                        <i
                                            style={{
                                                width: `${Math.min(100, Math.max(0, Number(contextUsage.percent) || 0))}%`,
                                            }}
                                        />
                                    </div>
                                    <div className="context-detail">
                                        <span>
                                            {formatCount(contextUsage.tokens)} of{" "}
                                            {formatCount(contextUsage.contextWindow)}
                                        </span>
                                        <strong>
                                            {typeof sessionStats.cost === "number"
                                                ? `$${sessionStats.cost.toFixed(4)}`
                                                : "$—"}
                                        </strong>
                                    </div>
                                </section>
                                <div className="metric-grid">
                                    <div>
                                        <span>Turns</span>
                                        <strong>{formatCount(totalTurns)}</strong>
                                    </div>
                                    <div>
                                        <span>Tools</span>
                                        <strong>{formatCount(totalTools)}</strong>
                                    </div>
                                    <div>
                                        <span>Elapsed</span>
                                        <strong>{formatElapsed(displayElapsed)}</strong>
                                    </div>
                                    <div>
                                        <span>Messages</span>
                                        <strong>{formatCount(messageTotal)}</strong>
                                    </div>
                                    <div>
                                        <span>Changes</span>
                                        <strong className="accent-value">{formatCount(changedFiles)}</strong>
                                    </div>
                                    <div>
                                        <span>Queued</span>
                                        <strong>{formatCount(queueTotal)}</strong>
                                    </div>
                                </div>
                                <section className="token-breakdown">
                                    <h2>Tokens</h2>
                                    <div>
                                        <span>Input</span>
                                        <strong>{formatCount(tokenStats.input)}</strong>
                                    </div>
                                    <div>
                                        <span>Output</span>
                                        <strong>{formatCount(tokenStats.output)}</strong>
                                    </div>
                                    <div>
                                        <span>Cache</span>
                                        <strong>
                                            {formatCount(
                                                Number(tokenStats.cacheRead ?? 0) + Number(tokenStats.cacheWrite ?? 0),
                                            )}
                                        </strong>
                                    </div>
                                </section>
                                <section className="policy-section">
                                    <h2>Policy</h2>
                                    <dl className="run-state-list">
                                        <dt>guard</dt>
                                        <dd className={guardReady ? "good" : "warning"}>{guardState}</dd>
                                        <dt>scope</dt>
                                        <dd className={scopeReady ? "good" : "warning"}>{scopeState}</dd>
                                        <dt>spec</dt>
                                        <dd className={specMode ? "good" : ""}>{specMode ? "active" : "off"}</dd>
                                        <dt>wishlist</dt>
                                        <dd>{wishlistState}</dd>
                                        <dt>experiment</dt>
                                        <dd>{experimentState}</dd>
                                    </dl>
                                </section>
                                <div className="inspector-spacer" />
                                <footer className="inspector-footer">
                                    <span title={String(sessionState.sessionId ?? "")}>
                                        session {String(sessionState.sessionId ?? "—").slice(0, 8)}
                                    </span>
                                    <span>{runtime.piVersion ? `Pi ${runtime.piVersion}` : "Pi —"}</span>
                                </footer>
                            </aside>
                        </>
                    ) : (
                        <section className="empty-workspace">
                            <div className="empty-content">
                                <span className="empty-mark">π</span>
                                <h1>What should Pi work on?</h1>
                                <p>Pi and SpecPi remain in control. This window is only their local interface.</p>
                                <button className="primary-action" onClick={() => void addProject()}>
                                    <Icon name="plus" size={15} /> Open project
                                </button>
                                {desktop.projects.length > 0 ? (
                                    <div className="recent-projects">
                                        <h2>Recent</h2>
                                        <div>
                                            {desktop.projects.slice(0, 3).map((project) => (
                                                <button
                                                    key={project.id}
                                                    onClick={() => void startProject(project, project.lastSessionPath)}
                                                >
                                                    <span>{project.label.slice(0, 1).toUpperCase()}</span>
                                                    <div>
                                                        <strong>{project.label}</strong>
                                                        <small>{compactPath(project.path)}</small>
                                                    </div>
                                                    <small>{relativeTime(project.lastOpenedAt)}</small>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                ) : null}
                            </div>
                            <footer>
                                <span>no telemetry</span>
                                <span>no auto-update · no listener</span>
                            </footer>
                        </section>
                    )}
                </div>
            </section>

            {pendingProject ? (
                <div
                    className="modal-backdrop trust-backdrop"
                    onMouseDown={(event) => event.target === event.currentTarget && setPendingProject(undefined)}
                >
                    <section
                        className="modal trust-modal"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="trust-title"
                    >
                        <header className="trust-heading">
                            <span className="trust-icon">
                                <Icon name="shield" size={16} />
                            </span>
                            <div>
                                <h2 id="trust-title">Trust this project for one run?</h2>
                                <span>{compactPath(pendingProject)}</span>
                            </div>
                        </header>
                        <p>
                            Pi project resources may execute code. Trust is always explicit and scoped to this session.
                        </p>
                        <div className="trust-actions">
                            <button className="preferred" onClick={() => void confirmProject("approve")}>
                                <strong>Trust this run</strong>
                                <span>this session only</span>
                            </button>
                            <button onClick={() => void confirmProject("default")}>
                                <strong>Use Pi’s decision</strong>
                                <span>defer to its own record</span>
                            </button>
                            <button onClick={() => void confirmProject("deny")}>
                                <strong>Ignore project resources</strong>
                                <span>nothing loaded this run</span>
                            </button>
                        </div>
                        <footer className="trust-footer">
                            <span>Esc to cancel</span>
                            <button className="secondary" onClick={() => setPendingProject(undefined)}>
                                Cancel
                            </button>
                        </footer>
                    </section>
                </div>
            ) : null}
            {palette ? (
                <CommandPalette
                    commands={paletteCommands}
                    close={() => setPalette(false)}
                    run={(command) => {
                        if (command.startsWith("@")) {
                            void runDesktopCommand(command);
                        } else {
                            void runComposerInput(command);
                        }
                    }}
                />
            ) : null}
            {renameSessionOpen ? (
                <SessionNameDialog
                    initialName={typeof sessionState.sessionName === "string" ? sessionState.sessionName : ""}
                    close={() => setRenameSessionOpen(false)}
                    rename={async (name) => {
                        await window.specpi.sendRuntimeCommand({ type: "set_session_name", name });
                        await hydrate(selectedProject);
                    }}
                />
            ) : null}
            {branchChoices ? (
                <div className="modal-backdrop">
                    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="branch-title">
                        <h2 id="branch-title">Branch session</h2>
                        <p>Select the user message that should become the new branch tip.</p>
                        <div className="command-list">
                            {branchChoices.map((choice) => (
                                <button key={choice.entryId} onClick={() => void forkSession(choice.entryId)}>
                                    <span>{choice.text}</span>
                                </button>
                            ))}
                        </div>
                        <div className="modal-actions">
                            <button className="secondary" onClick={() => setBranchChoices(undefined)}>
                                Cancel
                            </button>
                        </div>
                    </section>
                </div>
            ) : null}
            {treeView ? (
                <div className="modal-backdrop">
                    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="tree-title">
                        <h2 id="tree-title">Session tree</h2>
                        <pre>{JSON.stringify(treeView, null, 2)}</pre>
                        <div className="modal-actions">
                            <button onClick={() => setTreeView(undefined)}>Close</button>
                        </div>
                    </section>
                </div>
            ) : null}
            {runtimePanel ? (
                <div className="modal-backdrop">
                    <section
                        className="modal runtime-modal"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="runtime-title"
                    >
                        <header className="modal-header horizontal">
                            <h2 id="runtime-title">Pi runtime</h2>
                            <span className={`runtime-state ${runtime.phase}`}>{statusText}</span>
                        </header>
                        <dl className="runtime-details">
                            <dt>Status</dt>
                            <dd>{runtime.phase}</dd>
                            <dt>Version</dt>
                            <dd>{runtime.piVersion ?? "Not connected"}</dd>
                            <dt>Executable</dt>
                            <dd>{runtime.piPath ?? desktop.piPath ?? "PATH discovery"}</dd>
                            <dt>Project</dt>
                            <dd>{runtime.cwd ? compactPath(runtime.cwd) : "—"}</dd>
                            <dt>Generation</dt>
                            <dd>{runtime.generation}</dd>
                            <dt>Theme</dt>
                            <dd>
                                <select
                                    value={desktop.theme}
                                    onChange={(event) =>
                                        void persist({ theme: event.target.value as DesktopState["theme"] })
                                    }
                                >
                                    <option value="system">System</option>
                                    <option value="dark">Dark</option>
                                    <option value="light">Light</option>
                                </select>
                            </dd>
                        </dl>
                        {runtime.error ? <p className="error">{runtime.error}</p> : null}
                        <h3>Redacted diagnostics</h3>
                        <pre>{diagnostics.length > 0 ? diagnostics.join("\n") : "No diagnostics recorded."}</pre>
                        <div className="modal-actions">
                            <button className="secondary" onClick={() => void chooseRuntime()}>
                                Choose Pi…
                            </button>
                            <button className="secondary" onClick={() => void window.specpi.saveRuntimeDiagnostics()}>
                                Export diagnostics…
                            </button>
                            <button
                                className="secondary"
                                disabled={runtime.phase === "stopped"}
                                onClick={() => void window.specpi.stopRuntime()}
                            >
                                Stop
                            </button>
                            <button
                                disabled={!selectedProject}
                                onClick={() => {
                                    if (
                                        !window.confirm(
                                            "Restarting reloads resources and resets transient extension state and Command Guard session approvals. Continue?",
                                        )
                                    ) {
                                        return;
                                    }

                                    setRuntimePanel(false);
                                    if (selectedProject) {
                                        void window.specpi
                                            .stopRuntime()
                                            .then(() => startProject(selectedProject, selectedProject.lastSessionPath));
                                    }
                                }}
                            >
                                Restart
                            </button>
                            <button onClick={() => setRuntimePanel(false)}>Close</button>
                        </div>
                    </section>
                </div>
            ) : null}
            <div className="toasts" aria-live="polite">
                {toasts.map((item) => (
                    <div key={item.id} className={`toast ${item.level}`}>
                        {item.message}
                    </div>
                ))}
            </div>
            {error ? (
                <div className="error-banner">
                    <span>{error}</span>
                    <button onClick={() => setError("")}>×</button>
                </div>
            ) : null}
            {spinup ? (
                <div className="spinup-backdrop">
                    <section className="spinup-card" role="status" aria-live="polite" aria-label="Starting Pi">
                        <header className="spinup-heading">
                            <div className="spinup-mark" aria-hidden="true">
                                <i />
                                <span>π</span>
                            </div>
                            <div>
                                <h2>
                                    {spinup.sessionLabel
                                        ? `Opening ${spinup.sessionLabel}`
                                        : `Starting ${spinup.projectLabel}`}
                                </h2>
                                <span>local Pi runtime · {formatElapsed(spinupElapsed)}</span>
                            </div>
                        </header>
                        <div className="spinup-steps" aria-hidden="true">
                            <div className="complete">
                                <Icon name="check" size={15} />
                                <span>Runtime spawned</span>
                                <small>local</small>
                            </div>
                            <div className="active">
                                <i />
                                <span>Loading SpecPi extensions</span>
                                <small>in progress</small>
                            </div>
                            <div>
                                <i />
                                <span>Waiting for Pi to answer RPC</span>
                            </div>
                            <div>
                                <i />
                                <span>Parsing session file</span>
                            </div>
                        </div>
                        <div className="spinup-progress" aria-hidden="true">
                            <i />
                        </div>
                        <p>{spinupDetail(spinupElapsed)}</p>
                        <button
                            className="spinup-cancel"
                            onClick={() => {
                                startGeneration.current += 1;
                                setSpinup(undefined);
                                void window.specpi.stopRuntime();
                            }}
                        >
                            Cancel start
                        </button>
                    </section>
                </div>
            ) : null}
        </main>
    );
}
