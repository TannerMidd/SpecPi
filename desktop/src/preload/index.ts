import { contextBridge, ipcRenderer } from "electron";
import { IPC, type DesktopApi, type DesktopStatePatch } from "../shared/ipc";
import {
    desktopStatePatchSchema,
    desktopStateSchema,
    diffRequestSchema,
    extensionUiResponseSchema,
    fileNodeSchema,
    filePreviewSchema,
    fileRequestSchema,
    gitStatusSchema,
    projectCapabilitySchema,
    projectRecordSchema,
    rpcCommandSchema,
    runtimeDescriptorSchema,
    runtimeEventSchema,
    runtimeSnapshotSchema,
    runtimeStartResultSchema,
    runtimeStatusSchema,
    activeSessionMetadataSchema,
    sessionDraftSchema,
    sessionImportSelectionSchema,
    sessionTitleSchema,
    workspaceRequestSchema,
} from "../shared/schemas";
import type {
    ExtensionUiResponse,
    RpcCommand,
    RuntimeDescriptor,
    RuntimeEvent,
    RuntimeSnapshot,
    RuntimeStatus,
    WorkspaceRequest,
} from "../shared/rpc";

const api: DesktopApi = {
    chooseProject: async () => {
        const value = await ipcRenderer.invoke(IPC.chooseProject);

        return value === undefined ? undefined : projectRecordSchema.parse(value);
    },
    choosePi: async () => {
        const value = await ipcRenderer.invoke(IPC.choosePi);

        return value === undefined ? undefined : desktopStateSchema.parse(value);
    },
    chooseSession: async () => {
        const value = await ipcRenderer.invoke(IPC.chooseSession);

        return value === undefined ? undefined : sessionImportSelectionSchema.parse(value);
    },
    openWorkspace: (request: WorkspaceRequest) =>
        ipcRenderer.invoke(IPC.openWorkspace, workspaceRequestSchema.parse(request)),
    getLaunchIntent: async () => {
        const value = await ipcRenderer.invoke(IPC.launchIntent);

        return value === undefined ? undefined : workspaceRequestSchema.parse(value);
    },
    getDesktopState: async () => desktopStateSchema.parse(await ipcRenderer.invoke(IPC.getDesktopState)),
    updateDesktopState: async (patch: DesktopStatePatch) =>
        desktopStateSchema.parse(
            await ipcRenderer.invoke(IPC.updateDesktopState, desktopStatePatchSchema.parse(patch)),
        ),
    saveSessionDraft: async (sessionId, draft) =>
        desktopStateSchema.parse(
            await ipcRenderer.invoke(IPC.saveSessionDraft, sessionDraftSchema.parse({ sessionId, draft })),
        ),
    saveSessionTitle: async (sessionId, title) =>
        desktopStateSchema.parse(
            await ipcRenderer.invoke(IPC.saveSessionTitle, sessionTitleSchema.parse({ sessionId, title })),
        ),
    saveActiveSession: async (metadata) =>
        desktopStateSchema.parse(
            await ipcRenderer.invoke(IPC.saveActiveSession, activeSessionMetadataSchema.parse(metadata)),
        ),
    getRuntimeSnapshot: async () =>
        runtimeSnapshotSchema.parse(await ipcRenderer.invoke(IPC.runtimeSnapshot)) as RuntimeSnapshot,
    getRuntimeRoster: async () =>
        runtimeDescriptorSchema
            .array()
            .max(32)
            .parse(await ipcRenderer.invoke(IPC.runtimeRoster)),
    getRuntimeDiagnostics: async () =>
        ((await ipcRenderer.invoke(IPC.runtimeDiagnostics)) as unknown[])
            .map((item) => String(item).slice(0, 8_192))
            .slice(0, 200),
    saveRuntimeDiagnostics: () => ipcRenderer.invoke(IPC.saveDiagnostics),
    startRuntime: async (request: WorkspaceRequest) =>
        runtimeStartResultSchema.parse(
            await ipcRenderer.invoke(IPC.runtimeStart, workspaceRequestSchema.parse(request)),
        ),
    stopRuntime: () => ipcRenderer.invoke(IPC.runtimeStop),
    sendRuntimeCommand: (command: RpcCommand) =>
        ipcRenderer.invoke(IPC.runtimeCommand, rpcCommandSchema.parse(command)),
    respondToExtension: (response: ExtensionUiResponse) =>
        ipcRenderer.invoke(IPC.runtimeUiResponse, extensionUiResponseSchema.parse(response)),
    listDirectory: async (projectId, relativePath) =>
        fileNodeSchema
            .array()
            .max(2_000)
            .parse(await ipcRenderer.invoke(IPC.listDirectory, fileRequestSchema.parse({ projectId, relativePath }))),
    readFile: async (projectId, relativePath) =>
        filePreviewSchema.parse(
            await ipcRenderer.invoke(IPC.readFile, fileRequestSchema.parse({ projectId, relativePath })),
        ),
    getGitStatus: async (projectId) =>
        gitStatusSchema.parse(await ipcRenderer.invoke(IPC.gitStatus, projectCapabilitySchema.parse({ projectId }))),
    getGitDiff: (projectId, relativePath) =>
        ipcRenderer.invoke(IPC.gitDiff, diffRequestSchema.parse({ projectId, relativePath })),
    saveExport: (sourcePath) => ipcRenderer.invoke(IPC.saveExport, sourcePath),
    copyText: (text) => ipcRenderer.invoke(IPC.copyText, text),
    openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
    onDesktopState: (listener) => {
        const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => {
            const parsed = desktopStateSchema.safeParse(payload);
            if (parsed.success) {
                listener(parsed.data);
            }
        };

        ipcRenderer.on(IPC.desktopStateChanged, wrapped);

        return () => ipcRenderer.removeListener(IPC.desktopStateChanged, wrapped);
    },
    onRuntimeEvent: (listener) => {
        const wrapped = (_event: Electron.IpcRendererEvent, payload: RuntimeEvent) => {
            const parsed = runtimeEventSchema.safeParse(payload);
            if (parsed.success) {
                listener(parsed.data as RuntimeEvent);
            }
        };

        ipcRenderer.on(IPC.runtimeEvent, wrapped);

        return () => ipcRenderer.removeListener(IPC.runtimeEvent, wrapped);
    },
    onRuntimeStatus: (listener) => {
        const wrapped = (_event: Electron.IpcRendererEvent, payload: RuntimeStatus) => {
            const parsed = runtimeStatusSchema.safeParse(payload);
            if (parsed.success) {
                listener(parsed.data);
            }
        };

        ipcRenderer.on(IPC.runtimeStatus, wrapped);

        return () => ipcRenderer.removeListener(IPC.runtimeStatus, wrapped);
    },
    onRuntimeRoster: (listener) => {
        const wrapped = (_event: Electron.IpcRendererEvent, payload: RuntimeDescriptor[]) => {
            const parsed = runtimeDescriptorSchema.array().max(32).safeParse(payload);
            if (parsed.success) {
                listener(parsed.data);
            }
        };

        ipcRenderer.on(IPC.runtimeRoster, wrapped);

        return () => ipcRenderer.removeListener(IPC.runtimeRoster, wrapped);
    },
};

contextBridge.exposeInMainWorld("specpi", Object.freeze(api));
