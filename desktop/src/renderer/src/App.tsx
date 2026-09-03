import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { DesktopState, ProjectRecord, SessionRecord } from "../../shared/domain";
import type { ExtensionUiRequest, RpcCommand, RuntimeEvent, RuntimeStatus } from "../../shared/rpc";
import { CommandPalette, type CommandInfo } from "./components/CommandPalette";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { FilesPanel } from "./components/FilesPanel";
import { SessionNameDialog } from "./components/SessionNameDialog";
import { Transcript } from "./components/Transcript";
import { stripAnsi } from "./lib/text";
import { emptyConversation, messagesToItems, reduceRuntimeEvent } from "./state/conversation";
import { mergeSessionRecord } from "./state/sessions";

interface ModelInfo {
    id: string;
    provider: string;
    name?: string;
}

interface Toast {
    id: string;
    message: string;
    level: "info" | "warning" | "error";
}

interface BranchChoice {
    entryId: string;
    text: string;
}

const DESKTOP_COMMANDS: CommandInfo[] = [
    {
        name: "New session",
        description: "Start a fresh Pi session in this project",
        source: "Desktop action",
        invocation: "@new-session",
    },
    {
        name: "Compact context",
        description: "Ask Pi to compact the current context",
        source: "Desktop action",
        invocation: "@compact",
    },
    {
        name: "Branch session",
        description: "Fork from a selected user message",
        source: "Desktop action",
        invocation: "@branch",
    },
    {
        name: "Clone session",
        description: "Clone the current Pi session into a new session file",
        source: "Desktop action",
        invocation: "@clone",
    },
    {
        name: "Open Pi session file",
        description: "Open a Pi JSONL session that is not yet indexed",
        source: "Desktop action",
        invocation: "@open-session",
    },
    {
        name: "Session tree",
        description: "Inspect Pi's read-only session tree",
        source: "Desktop action",
        invocation: "@tree",
    },
    {
        name: "Rename session",
        description: "Set the current Pi session name",
        source: "Desktop action",
        invocation: "@rename",
    },
    {
        name: "Label current entry",
        description: "Set a Pi session-tree label",
        source: "Desktop action",
        invocation: "@label",
    },
    {
        name: "Export transcript",
        description: "Save Pi's current transcript as HTML",
        source: "Desktop action",
        invocation: "@export",
    },
    {
        name: "Abort current turn",
        description: "Stop Pi's active agent turn",
        source: "Desktop action",
        invocation: "@abort",
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
    const runtimeRef = useRef(runtime);
    runtimeRef.current = runtime;
    const [conversation, dispatch] = useReducer(reduceRuntimeEvent, undefined, emptyConversation);
    const [commands, setCommands] = useState<CommandInfo[]>([]);
    const [models, setModels] = useState<ModelInfo[]>([]);
    const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
    const [sessionState, setSessionState] = useState<Record<string, unknown>>({});
    const [sessionStats, setSessionStats] = useState<Record<string, unknown>>({});
    const [dialogs, setDialogs] = useState<ExtensionUiRequest[]>([]);
    const [toasts, setToasts] = useState<Toast[]>([]);
    const [statuses, setStatuses] = useState(new Map<string, string>());
    const [widgets, setWidgets] = useState(new Map<string, string[]>());
    const [palette, setPalette] = useState(false);
    const [draft, setDraft] = useState("");
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
    const [selectedProject, setSelectedProject] = useState<ProjectRecord>();
    const [pendingProject, setPendingProject] = useState<string>();
    const [branchChoices, setBranchChoices] = useState<BranchChoice[]>();
    const [renameSessionOpen, setRenameSessionOpen] = useState(false);
    const [filesTab, setFilesTab] = useState<"files" | "changes">("files");
    const [changedFiles, setChangedFiles] = useState(0);
    const [runtimePanel, setRuntimePanel] = useState(false);
    const [treeView, setTreeView] = useState<unknown>();
    const [diagnostics, setDiagnostics] = useState<readonly string[]>([]);
    const [busy, setBusy] = useState(false);
    const [sessionChanging, setSessionChanging] = useState(false);
    const [error, setError] = useState("");

    const toast = useCallback((message: string, level: Toast["level"] = "info") => {
        const id = crypto.randomUUID();
        setToasts((current) => [...current.slice(-4), { id, message: stripAnsi(message).slice(0, 2_000), level }]);
        setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 6_000);
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
                    ? commandList.map((item) => {
                          const command = object(item) as unknown as CommandInfo;

                          return command.name === "files"
                              ? { ...command, name: "Files & changes", invocation: "@files" }
                              : command;
                      })
                    : [],
            );
            setModels(Array.isArray(modelList) ? modelList.map((item) => object(item) as unknown as ModelInfo) : []);
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
                    name: typeof stateData.sessionName === "string" ? stateData.sessionName : existing?.name,
                    model: object(stateData.model).id
                        ? `${String(object(stateData.model).provider)}/${String(object(stateData.model).id)}`
                        : existing?.model,
                    lastOpenedAt: new Date().toISOString(),
                    draft: existing?.draft ?? draftOverride ?? "",
                };
                const sessions = mergeSessionRecord(desktopState.sessions, record);
                const projects = desktopState.projects.map((item) =>
                    item.id === project.id
                        ? { ...item, lastSessionPath: sessionFile, lastOpenedAt: new Date().toISOString() }
                        : item,
                );

                return persist({ sessions, projects, activeSessionId: record.id, activeProjectId: project.id });
            }

            return desktopState;
        },
        [desktop, persist],
    );

    useEffect(() => {
        let active = true;
        void Promise.all([window.specpi.getDesktopState(), window.specpi.getRuntimeSnapshot()]).then(
            ([state, snapshot]) => {
                if (!active) {
                    return;
                }

                setDesktop(state);
                setRuntime(snapshot.status);
                setDialogs(snapshot.pendingUi);
                const project = state.projects.find((item) => item.id === state.activeProjectId);
                setSelectedProject(project);
            },
        );
        const offStatus = window.specpi.onRuntimeStatus((status) => {
            setRuntime(status);
            if (status.phase === "stopped" || status.phase === "failed") {
                setDialogs([]);
            }
        });
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
        const onKeyDown = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && dialogs.length === 0) {
                event.preventDefault();
                if (runtime.phase !== "stopped") {
                    setPalette(true);
                }
            } else if (event.key === "Escape" && palette) {
                setPalette(false);
            }
        };

        window.addEventListener("keydown", onKeyDown);

        return () => window.removeEventListener("keydown", onKeyDown);
    }, [dialogs.length, palette, runtime.phase]);

    useEffect(() => {
        if (!selectedProject) {
            setChangedFiles(0);

            return;
        }

        let active = true;
        void window.specpi
            .getGitStatus(selectedProject.path)
            .then((git) => {
                if (active) {
                    setChangedFiles(git.files.length);
                }
            })
            .catch(() => {
                if (active) {
                    setChangedFiles(0);
                }
            });

        return () => {
            active = false;
        };
    }, [selectedProject?.path, conversation.toolCount]);

    useEffect(() => {
        if (!desktop?.activeSessionId) {
            return;
        }

        const sessionId = desktop.activeSessionId;
        const timer = setTimeout(() => {
            void window.specpi
                .saveSessionDraft(sessionId, draft)
                .then(setDesktop)
                .catch(() => undefined);
        }, 350);

        return () => clearTimeout(timer);
    }, [draft, desktop?.activeSessionId]);

    const startProject = async (project: ProjectRecord, sessionPath?: string, desktopOverride?: DesktopState) => {
        const desktopState = desktopOverride ?? desktop;
        if (!desktopState) {
            return;
        }

        if (["streaming", "compacting", "retrying"].includes(runtime.phase)) {
            if (!window.confirm("Abort the active turn and open this project?")) {
                return;
            }

            await window.specpi.sendRuntimeCommand({ type: "abort" });
        }

        setBusy(true);
        setError("");
        setSelectedProject(project);
        dispatch({ generation: runtime.generation, record: { type: "desktop_clear" } });
        try {
            const started = await window.specpi.startRuntime({
                cwd: project.path,
                piPath: desktopState.piPath,
                trust: project.trust,
                sessionPath,
            });
            if (started.compatibilityWarning && !window.confirm(`${started.compatibilityWarning}\n\nContinue?`)) {
                await window.specpi.stopRuntime();

                return;
            }

            const next = await persist({ activeProjectId: project.id });
            const hydrated = await hydrate(project, next);
            const activeSession = hydrated?.sessions.find((session) => session.id === hydrated.activeSessionId);
            setDraft(activeSession?.draft ?? "");
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

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
        const images = attachments.map(({ name: _name, ...image }) => image);
        try {
            let command: RpcCommand;
            if (runtime.phase === "streaming" || runtime.phase === "retrying" || runtime.phase === "compacting") {
                command =
                    delivery === "steer" ? { type: "steer", message, images } : { type: "follow_up", message, images };
            } else {
                command = { type: "prompt", message, images };
            }

            setDraft("");
            setAttachments([]);
            await window.specpi.sendRuntimeCommand(command);
        } catch (caught) {
            setDraft(message);
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    };

    const respond = async (response: Parameters<typeof window.specpi.respondToExtension>[0]) => {
        await window.specpi.respondToExtension(response);
        setDialogs((current) => current.filter((item) => item.id !== response.id));
    };

    const saveCurrentDraft = async (): Promise<DesktopState | undefined> => {
        if (!desktop?.activeSessionId) {
            return desktop;
        }

        const next = await window.specpi.saveSessionDraft(desktop.activeSessionId, draft);
        setDesktop(next);

        return next;
    };

    const runDesktopCommand = async (command: string) => {
        const changesSession = ["@new-session", "@clone", "@open-session"].includes(command);
        if (changesSession && sessionChanging) {
            return;
        }

        if (changesSession) {
            setSessionChanging(true);
        }

        try {
            if (command === "@files") {
                setFilesTab("files");
                await persist({ layout: { filesOpen: true } });
            } else if (command === "@abort") {
                await window.specpi.sendRuntimeCommand({ type: "abort" });
            } else if (command === "@new-session") {
                const saved = await saveCurrentDraft();
                await window.specpi.sendRuntimeCommand({ type: "new_session" });
                dispatch({ generation: runtimeRef.current.generation, record: { type: "desktop_clear" } });
                await hydrate(selectedProject, saved, "");
                setDraft("");
            } else if (command === "@compact") {
                await window.specpi.sendRuntimeCommand({ type: "compact" });
            } else if (command === "@clone") {
                const saved = await saveCurrentDraft();
                await window.specpi.sendRuntimeCommand({ type: "clone" });
                dispatch({ generation: runtimeRef.current.generation, record: { type: "desktop_clear" } });
                await hydrate(selectedProject, saved, "");
                setDraft("");
            } else if (command === "@open-session") {
                const sessionPath = await window.specpi.chooseSession();
                if (sessionPath && selectedProject) {
                    const saved = await saveCurrentDraft();
                    await startProject(selectedProject, sessionPath, saved);
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
                setRenameSessionOpen(true);
            } else if (command === "@label") {
                const result = object(await window.specpi.sendRuntimeCommand({ type: "get_entries" }));
                const label = window.prompt("Label for the current entry");
                if (typeof result.leafId === "string" && label !== null) {
                    await window.specpi.sendRuntimeCommand({
                        type: "set_label",
                        entryId: result.leafId,
                        label: label.trim() || undefined,
                    });
                }
            } else if (command === "@export") {
                const result = object(await window.specpi.sendRuntimeCommand({ type: "export_html" }));
                if (typeof result.path === "string") {
                    await window.specpi.saveExport(result.path);
                }
            }
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            if (changesSession) {
                setSessionChanging(false);
            }
        }
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
        if (sessionChanging || session.id === desktop?.activeSessionId) {
            return;
        }

        setSessionChanging(true);
        setError("");
        try {
            if (runtime.phase === "streaming" || runtime.phase === "compacting" || runtime.phase === "retrying") {
                if (!window.confirm("Abort the active turn and switch sessions?")) {
                    return;
                }

                await window.specpi.sendRuntimeCommand({ type: "abort" });
            }

            const saved = await saveCurrentDraft();
            const result = object(
                await window.specpi.sendRuntimeCommand({ type: "switch_session", sessionPath: session.sessionPath }),
            );
            if (result.cancelled === true) {
                return;
            }

            dispatch({ generation: runtimeRef.current.generation, record: { type: "desktop_clear" } });
            await hydrate(selectedProject, saved, session.draft);
            setDraft(session.draft);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setSessionChanging(false);
        }
    };

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

    const activeModel = object(sessionState.model);
    const modelGroups = useMemo(() => {
        const groups = new Map<string, ModelInfo[]>();
        for (const model of models) {
            groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
        }

        return groups;
    }, [models]);
    const currentSessions = desktop?.sessions.filter((item) => item.projectId === selectedProject?.id) ?? [];
    const paletteCommands = [...DESKTOP_COMMANDS, ...commands];
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
    const guardState = statusValue(statuses, "guard", "not set");
    const scopeState = statusValue(statuses, "scope", "inactive");
    const wishlistState = statusValue(statuses, "wishlist", "inactive");
    const experimentState = statusValue(statuses, "experiment", "none");
    const scopeReady = /clean|inactive|unset/iu.test(scopeState);
    const guardReady = guardState !== "not set" && !/off/iu.test(guardState);
    const runtimeReady = runtime.phase !== "stopped" && runtime.phase !== "failed";
    const specPhase =
        runtime.phase === "streaming"
            ? "REASONING"
            : runtime.phase === "waiting-for-user"
              ? "REVIEW"
              : runtime.phase.toUpperCase();

    if (!desktop) {
        return <main className="loading">Loading SpecPi Desktop…</main>;
    }

    return (
        <main className={specMode ? "app spec-active" : "app"}>
            <header className={`window-titlebar${/Macintosh/iu.test(navigator.userAgent) ? " mac" : ""}`}>
                <span aria-hidden="true">π</span>
                <strong>SpecPi Desktop</strong>
            </header>
            <aside className="sidebar">
                <header className="brand">
                    <span className="brand-mark" aria-hidden="true">
                        π
                    </span>
                    <div>
                        <strong>SpecPi</strong>
                        <small>Desktop</small>
                    </div>
                </header>
                <button className="new-project" onClick={() => void addProject()}>
                    ＋ Open project
                </button>
                <div className="section-heading project-heading">Projects</div>
                <nav className="projects" aria-label="Projects">
                    {desktop.projects.map((project) => (
                        <button
                            key={project.id}
                            className={project.id === selectedProject?.id ? "active" : ""}
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
                <section className="sessions">
                    <div className="section-heading">
                        <span>Sessions</span>
                        <div>
                            <button
                                title="Open Pi session file"
                                aria-label="Open Pi session file"
                                disabled={!selectedProject || sessionChanging}
                                onClick={() => void runDesktopCommand("@open-session")}
                            >
                                ◇
                            </button>
                            <button
                                title="New session"
                                aria-label="New session"
                                disabled={!selectedProject || sessionChanging}
                                onClick={() => void runDesktopCommand("@new-session")}
                            >
                                ＋
                            </button>
                        </div>
                    </div>
                    {currentSessions.map((session) => (
                        <button
                            key={session.id}
                            className={session.id === desktop.activeSessionId ? "active" : ""}
                            disabled={sessionChanging}
                            onClick={() => void switchSession(session)}
                        >
                            <strong>{session.name || "Untitled session"}</strong>
                            <small>
                                {session.id === desktop.activeSessionId ? "active · " : ""}
                                {relativeTime(session.lastOpenedAt)}
                            </small>
                        </button>
                    ))}
                </section>
                <footer>
                    <button onClick={() => void openRuntimePanel()}>⚙ Runtime</button>
                    <small>{runtime.piVersion ? `Pi ${runtime.piVersion}` : "Pi not connected"}</small>
                </footer>
            </aside>

            <section className="workspace">
                <header className="topbar">
                    {selectedProject ? (
                        <nav className="workspace-tabs" aria-label="Workspace views">
                            <button
                                className={!desktop.layout.filesOpen ? "active" : ""}
                                onClick={() => void persist({ layout: { filesOpen: false } })}
                            >
                                Chat
                            </button>
                            <button
                                className={desktop.layout.filesOpen && filesTab === "files" ? "active" : ""}
                                onClick={() => {
                                    setFilesTab("files");
                                    void persist({ layout: { filesOpen: true } });
                                }}
                            >
                                Files
                            </button>
                            <button
                                className={desktop.layout.filesOpen && filesTab === "changes" ? "active" : ""}
                                onClick={() => {
                                    setFilesTab("changes");
                                    void persist({ layout: { filesOpen: true } });
                                }}
                            >
                                Changes {changedFiles || ""}
                            </button>
                        </nav>
                    ) : (
                        <div className="project-title">
                            <strong>No project</strong>
                            <span className="runtime-state stopped">Stopped</span>
                        </div>
                    )}
                    <div className="top-actions">
                        <select
                            aria-label="Model"
                            value={`${String(activeModel.provider ?? "")}/${String(activeModel.id ?? "")}`}
                            disabled={runtime.phase === "stopped" || agentBusy}
                            onChange={(event) => void switchModel(event.target.value)}
                        >
                            <option value="">Model</option>
                            {[...modelGroups.entries()].map(([provider, providerModels]) => (
                                <optgroup key={provider} label={provider}>
                                    {providerModels.map((model) => (
                                        <option
                                            key={`${model.provider}/${model.id}`}
                                            value={`${model.provider}/${model.id}`}
                                        >
                                            {model.name || model.id}
                                        </option>
                                    ))}
                                </optgroup>
                            ))}
                        </select>
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
                        <button
                            className="commands-button"
                            disabled={runtime.phase === "stopped"}
                            onClick={() => setPalette(true)}
                        >
                            ⌘K&nbsp; Commands
                        </button>
                    </div>
                </header>
                {specMode ? (
                    <div className="spec-banner">
                        <div>
                            <strong>π SPEC EXECUTION</strong>
                            <span>{specPhase}</span>
                        </div>
                        <div>
                            <span>T{String(conversation.turnCount).padStart(2, "0")}</span>
                            <span>X{String(conversation.toolCount).padStart(2, "0")}</span>
                            <span>
                                SCOPE{" "}
                                {Array.from(statuses.keys()).some((key) => key.includes("scope")) ? "ACTIVE" : "UNSET"}
                            </span>
                        </div>
                    </div>
                ) : null}
                <div className="content-row">
                    {selectedProject ? (
                        <>
                            <div className="workbench-main">
                                <section className="chat-column">
                                    <Transcript conversation={conversation} specMode={specMode} />
                                    <div className="composer-area">
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
                                        <div className="composer">
                                            <textarea
                                                value={draft}
                                                disabled={dialogs.length > 0 || runtime.phase === "stopped"}
                                                placeholder={
                                                    runtime.phase === "stopped"
                                                        ? "Open a project to start Pi"
                                                        : "Ask Pi to work on something…"
                                                }
                                                onChange={(event) => setDraft(event.target.value)}
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
                                                    if (event.key === "Enter" && !event.shiftKey) {
                                                        event.preventDefault();
                                                        await runPrompt();
                                                    } else if (event.key === "Escape") {
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
                                                            .filter((item): item is string => typeof item === "string")
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
                                                        onClick={() => document.getElementById("image-input")?.click()}
                                                    >
                                                        ＋
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
                                                    <div
                                                        className="delivery-toggle"
                                                        aria-label="Queued message delivery"
                                                    >
                                                        <button
                                                            className={delivery === "steer" ? "active" : ""}
                                                            onClick={() => setDelivery("steer")}
                                                        >
                                                            Steer now
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
                                                    {agentBusy ? (
                                                        <button
                                                            className="abort-button"
                                                            onClick={() =>
                                                                void window.specpi.sendRuntimeCommand({ type: "abort" })
                                                            }
                                                        >
                                                            Abort
                                                        </button>
                                                    ) : null}
                                                    <button
                                                        className="send"
                                                        disabled={!draft.trim() || dialogs.length > 0}
                                                        onClick={() => void runPrompt()}
                                                    >
                                                        {agentBusy ? "Queue" : "Send"}
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="statusline">
                                            <span>{Array.from(statuses.values()).join(" · ")}</span>
                                            <span>{usageText}</span>
                                        </div>
                                    </div>
                                </section>
                                {desktop.layout.filesOpen ? (
                                    <FilesPanel
                                        root={selectedProject.path}
                                        tab={filesTab}
                                        setTab={setFilesTab}
                                        close={() => void persist({ layout: { filesOpen: false } })}
                                        sendComment={(message) => setDraft(message)}
                                        refreshToken={conversation.toolCount}
                                        onGitStatus={(git) => setChangedFiles(git.files.length)}
                                    />
                                ) : null}
                            </div>
                            <aside
                                className={`run-inspector ${desktop.layout.filesOpen ? "files-open" : ""}`}
                                aria-label="Run inspector"
                            >
                                <header>
                                    <span>Run</span>
                                    <strong className={`runtime-state ${runtime.phase}`}>
                                        <i /> {statusText}
                                    </strong>
                                </header>
                                <div className="run-counts">
                                    <div>
                                        <span>Turn</span>
                                        <strong>{String(conversation.turnCount).padStart(2, "0")}</strong>
                                    </div>
                                    <div>
                                        <span>Tools</span>
                                        <strong>{String(conversation.toolCount).padStart(2, "0")}</strong>
                                    </div>
                                </div>
                                <dl className="run-state-list">
                                    <dt>guard</dt>
                                    <dd className={guardReady ? "good" : "warning"}>{guardState}</dd>
                                    <dt>scope</dt>
                                    <dd className={scopeReady ? "good" : "warning"}>{scopeState}</dd>
                                    <dt>wishlist</dt>
                                    <dd>{wishlistState}</dd>
                                    <dt>experiment</dt>
                                    <dd>{experimentState}</dd>
                                </dl>
                                <section className="completion-gates">
                                    <h2>Completion gates</h2>
                                    <div className={runtimeReady ? "gate complete" : "gate pending"}>
                                        <i /> Pi runtime {runtimeReady ? "ready" : "stopped"}
                                    </div>
                                    <div className={guardReady ? "gate complete" : "gate pending"}>
                                        <i /> command guard
                                    </div>
                                    <div className={scopeReady ? "gate complete" : "gate pending"}>
                                        <i /> scope review
                                    </div>
                                </section>
                                <div className="inspector-spacer" />
                                <footer className="usage-panel">
                                    <div>
                                        <span>context</span>
                                        <strong>
                                            {contextUsage.percent != null
                                                ? `${Number(contextUsage.percent).toFixed(0)}%`
                                                : "—"}
                                        </strong>
                                    </div>
                                    <div className="context-meter">
                                        <i
                                            style={{
                                                width: `${Math.min(100, Math.max(0, Number(contextUsage.percent) || 0))}%`,
                                            }}
                                        />
                                    </div>
                                    <div>
                                        <span>
                                            {typeof tokenStats.total === "number"
                                                ? `${tokenStats.total.toLocaleString()} tokens`
                                                : "tokens —"}
                                        </span>
                                        <strong>
                                            {typeof sessionStats.cost === "number"
                                                ? `$${sessionStats.cost.toFixed(4)}`
                                                : "$—"}
                                        </strong>
                                    </div>
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
                                    Open project…
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
                                <span>Pi not connected</span>
                                <span>no telemetry · no auto-update</span>
                            </footer>
                        </section>
                    )}
                </div>
            </section>

            {pendingProject ? (
                <div className="modal-backdrop">
                    <section
                        className="modal trust-modal"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="trust-title"
                    >
                        <header className="modal-header">
                            <h2 id="trust-title">Project trust</h2>
                            <span>{compactPath(pendingProject)}</span>
                        </header>
                        <div className="modal-body">
                            <p>Pi project resources may execute code. Choose how this RPC launch should treat them.</p>
                            <div className="trust-actions">
                                <button onClick={() => void confirmProject("default")}>
                                    <strong>Use Pi decision</strong>
                                    <span>defer to Pi’s own record</span>
                                </button>
                                <button onClick={() => void confirmProject("deny")}>
                                    <strong>Ignore this run</strong>
                                    <span>no project resources</span>
                                </button>
                                <button className="preferred" onClick={() => void confirmProject("approve")}>
                                    <strong>Trust this run</strong>
                                    <span>this session only</span>
                                </button>
                            </div>
                            <div className="modal-actions">
                                <button className="secondary" onClick={() => setPendingProject(undefined)}>
                                    Cancel
                                </button>
                            </div>
                        </div>
                    </section>
                </div>
            ) : null}
            {dialogs[0] ? <ExtensionDialog request={dialogs[0]} respond={respond} /> : null}
            {palette ? (
                <CommandPalette
                    commands={paletteCommands}
                    close={() => setPalette(false)}
                    run={(command) =>
                        command.startsWith("@") ? void runDesktopCommand(command) : void runPrompt(command)
                    }
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
                                        void startProject(selectedProject, selectedProject.lastSessionPath);
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
            {busy ? <div className="busy">Connecting to Pi…</div> : null}
        </main>
    );
}
