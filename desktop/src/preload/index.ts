import { contextBridge, ipcRenderer } from "electron";
import { IPC, type DesktopApi, type DesktopStatePatch } from "../shared/ipc";
import {
    desktopStateSchema,
    fileNodeSchema,
    filePreviewSchema,
    gitStatusSchema,
    runtimeEventSchema,
    runtimeSnapshotSchema,
    runtimeStatusSchema,
} from "../shared/schemas";
import type {
    ExtensionUiResponse,
    RpcCommand,
    RuntimeEvent,
    RuntimeSnapshot,
    RuntimeStatus,
    StartRuntimeOptions,
} from "../shared/rpc";

const api: DesktopApi = {
    chooseProject: () => ipcRenderer.invoke(IPC.chooseProject),
    choosePi: () => ipcRenderer.invoke(IPC.choosePi),
    chooseSession: () => ipcRenderer.invoke(IPC.chooseSession),
    getDesktopState: async () => desktopStateSchema.parse(await ipcRenderer.invoke(IPC.getDesktopState)),
    updateDesktopState: async (patch: DesktopStatePatch) =>
        desktopStateSchema.parse(await ipcRenderer.invoke(IPC.updateDesktopState, patch)),
    saveSessionDraft: async (sessionId, draft) =>
        desktopStateSchema.parse(await ipcRenderer.invoke(IPC.saveSessionDraft, { sessionId, draft })),
    getRuntimeSnapshot: async () =>
        runtimeSnapshotSchema.parse(await ipcRenderer.invoke(IPC.runtimeSnapshot)) as RuntimeSnapshot,
    getRuntimeDiagnostics: async () =>
        ((await ipcRenderer.invoke(IPC.runtimeDiagnostics)) as unknown[])
            .map((item) => String(item).slice(0, 8_192))
            .slice(0, 200),
    saveRuntimeDiagnostics: () => ipcRenderer.invoke(IPC.saveDiagnostics),
    startRuntime: async (options: StartRuntimeOptions) =>
        runtimeStatusSchema.parse(await ipcRenderer.invoke(IPC.runtimeStart, options)),
    stopRuntime: () => ipcRenderer.invoke(IPC.runtimeStop),
    sendRuntimeCommand: (command: RpcCommand) => ipcRenderer.invoke(IPC.runtimeCommand, command),
    respondToExtension: (response: ExtensionUiResponse) => ipcRenderer.invoke(IPC.runtimeUiResponse, response),
    listDirectory: async (projectRoot, relativePath) =>
        fileNodeSchema
            .array()
            .max(2_000)
            .parse(await ipcRenderer.invoke(IPC.listDirectory, { projectRoot, relativePath })),
    readFile: async (projectRoot, relativePath) =>
        filePreviewSchema.parse(await ipcRenderer.invoke(IPC.readFile, { projectRoot, relativePath })),
    getGitStatus: async (projectRoot) => gitStatusSchema.parse(await ipcRenderer.invoke(IPC.gitStatus, projectRoot)),
    getGitDiff: (projectRoot, relativePath) => ipcRenderer.invoke(IPC.gitDiff, { projectRoot, relativePath }),
    saveExport: (sourcePath) => ipcRenderer.invoke(IPC.saveExport, sourcePath),
    copyText: (text) => ipcRenderer.invoke(IPC.copyText, text),
    openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
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
};

contextBridge.exposeInMainWorld("specpi", Object.freeze(api));
