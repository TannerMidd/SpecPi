import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IPC, type DesktopStatePatch } from "../shared/ipc";
import {
    absolutePathSchema,
    activeSessionMetadataSchema,
    desktopStatePatchSchema,
    diffRequestSchema,
    extensionUiResponseSchema,
    externalUrlSchema,
    fileRequestSchema,
    projectCapabilitySchema,
    rpcCommandSchema,
    sessionDraftSchema,
    sessionTitleSchema,
    workspaceRequestSchema,
} from "../shared/schemas";
import type { DesktopState } from "../shared/domain";
import type { RpcCommand, RuntimeEvent, RuntimeStatus, WorkspaceRequest } from "../shared/rpc";
import { listDirectory, previewFile } from "./file-service";
import { readGitDiff, readGitStatus } from "./git-service";
import { canonicalPath, displayNativePath } from "./path-identity";
import { isTrustedRendererUrl, resolveRendererTarget, type RendererTarget } from "./renderer-origin";
import { RuntimePool } from "./runtime-pool";
import { StateStore } from "./state-store";
import { TITLE_BAR_HEIGHT, windowThemeColors } from "./window-theme";
import {
    WorkspaceController,
    type ConfirmCompatibility,
    type TrustChoice,
    type WorkspaceContext,
} from "./workspace-controller";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const rendererFile = path.join(currentDirectory, "../renderer/index.html");
const smokeMode = process.env.SPECPI_DESKTOP_SMOKE === "1" || process.argv.includes("--smoke");

interface WindowContext extends WorkspaceContext {
    window: BrowserWindow;
    rendererTarget: RendererTarget;
    launchIntent?: WorkspaceRequest;
    closing: boolean;
}

const windows = new Map<number, WindowContext>();
let store: StateStore;
let workspaces: WorkspaceController;
let quitting = false;

function send(context: WindowContext, channel: string, payload: unknown): void {
    if (!context.window.isDestroyed()) {
        context.window.webContents.send(channel, payload);
    }
}

function broadcastState(state: DesktopState): void {
    for (const context of windows.values()) {
        send(context, IPC.desktopStateChanged, state);
    }
}

function applyWindowTheme(state = store.get()): void {
    const colors = windowThemeColors(state.theme, nativeTheme.shouldUseDarkColors);
    for (const context of windows.values()) {
        if (context.window.isDestroyed()) {
            continue;
        }

        context.window.setBackgroundColor(colors.backgroundColor);
        if (process.platform !== "darwin") {
            context.window.setTitleBarOverlay({
                color: colors.color,
                symbolColor: colors.symbolColor,
                height: TITLE_BAR_HEIGHT,
            });
        }
    }
}

async function createWindow(launchIntent?: WorkspaceRequest, importSource?: WindowContext): Promise<WindowContext> {
    const rendererTarget = resolveRendererTarget({
        packaged: app.isPackaged,
        rendererFile,
        developmentUrl: process.env.ELECTRON_RENDERER_URL,
    });
    const colors = windowThemeColors(store.get().theme, nativeTheme.shouldUseDarkColors);
    const browserWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 880,
        minHeight: 600,
        backgroundColor: colors.backgroundColor,
        titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
        titleBarOverlay:
            process.platform === "darwin"
                ? false
                : { color: colors.color, symbolColor: colors.symbolColor, height: TITLE_BAR_HEIGHT },
        show: false,
        webPreferences: {
            preload: path.join(currentDirectory, "../preload/index.cjs"),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            devTools: rendererTarget.devTools,
        },
    });
    const context: WindowContext = {
        id: randomUUID(),
        window: browserWindow,
        rendererTarget,
        runtimes: new RuntimePool(),
        launchIntent,
        closing: false,
    };
    const webContentsId = browserWindow.webContents.id;
    windows.set(webContentsId, context);
    try {
        if (launchIntent?.importToken && importSource) {
            workspaces.transferSessionImport(launchIntent.importToken, importSource.id, context.id);
        }
    } catch (error) {
        windows.delete(webContentsId);
        browserWindow.destroy();
        throw error;
    }

    context.runtimes.on("event", (event: RuntimeEvent) => send(context, IPC.runtimeEvent, event));
    context.runtimes.on("status", (status: RuntimeStatus) => send(context, IPC.runtimeStatus, status));
    context.runtimes.on("roster", () => send(context, IPC.runtimeRoster, context.runtimes.roster()));

    if (rendererTarget.kind === "file" && process.platform !== "darwin") {
        browserWindow.removeMenu();
    }

    browserWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    browserWindow.webContents.session.setPermissionCheckHandler(() => false);
    browserWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
    );
    browserWindow.webContents.on("will-navigate", (event) => event.preventDefault());
    browserWindow.once("ready-to-show", () => browserWindow.show());
    browserWindow.on("close", (event) => {
        if (!quitting && !context.closing && context.runtimes.hasRunningProcesses()) {
            event.preventDefault();
            context.closing = true;
            void context.runtimes.stopAll().finally(() => browserWindow.destroy());
        }
    });
    browserWindow.once("closed", () => {
        windows.delete(webContentsId);
        void context.runtimes.stopAll();
    });

    if (rendererTarget.kind === "development") {
        await browserWindow.loadURL(rendererTarget.url);
    } else {
        await browserWindow.loadFile(rendererTarget.filePath);
    }

    return context;
}

function contextFor(event: IpcMainInvokeEvent): WindowContext {
    const context = windows.get(event.sender.id);
    if (
        !context ||
        event.sender !== context.window.webContents ||
        event.senderFrame !== context.window.webContents.mainFrame ||
        !isTrustedRendererUrl(event.senderFrame.url, context.rendererTarget)
    ) {
        throw new Error("Rejected IPC from an untrusted frame");
    }

    return context;
}

const confirmCompatibility = async (context: WindowContext, warning: string): Promise<boolean> => {
    if (smokeMode) {
        return false;
    }

    const result = await dialog.showMessageBox(context.window, {
        type: "warning",
        title: "Use an unvalidated Pi version?",
        message: warning,
        detail: "SpecPi Desktop has not validated this Pi protocol version. Continue only if you accept compatibility risk for this process.",
        buttons: ["Cancel", "Continue"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
    });

    return result.response === 1;
};

async function chooseTrust(context: WindowContext, projectPath: string): Promise<TrustChoice | undefined> {
    if (smokeMode) {
        return "deny";
    }

    const result = await dialog.showMessageBox(context.window, {
        type: "warning",
        title: "Start Pi in this project?",
        message: "Choose project-resource trust for this Pi run",
        detail: `${displayNativePath(projectPath)}\n\nProject resources may execute code. This choice applies only to the new Pi process and is not saved.`,
        buttons: ["Use Pi's decision", "Ignore project resources", "Trust this run", "Cancel"],
        defaultId: 0,
        cancelId: 3,
        noLink: true,
    });
    const choices: Array<TrustChoice | undefined> = ["default", "deny", "approve", undefined];

    return choices[result.response];
}

function publishState(state: DesktopState): DesktopState {
    broadcastState(state);
    applyWindowTheme(state);

    return state;
}

function registerIpc(): void {
    ipcMain.handle(IPC.chooseProject, async (event) => {
        const context = contextFor(event);
        const result = await dialog.showOpenDialog(context.window, { properties: ["openDirectory"] });
        if (result.canceled || !result.filePaths[0]) {
            return undefined;
        }

        return workspaces.registerProject(result.filePaths[0]);
    });
    ipcMain.handle(IPC.choosePi, async (event) => {
        const context = contextFor(event);
        const result = await dialog.showOpenDialog(context.window, {
            properties: ["openFile"],
            filters:
                process.platform === "win32"
                    ? [{ name: "Pi executable", extensions: ["exe", "cmd"] }]
                    : [{ name: "Pi executable", extensions: ["*"] }],
        });
        if (result.canceled || !result.filePaths[0]) {
            return undefined;
        }

        return workspaces.setPiExecutable(result.filePaths[0]);
    });
    ipcMain.handle(IPC.chooseSession, async (event) => {
        const context = contextFor(event);
        const result = await dialog.showOpenDialog(context.window, {
            defaultPath: path.join(app.getPath("home"), ".pi", "agent", "sessions"),
            properties: ["openFile"],
            filters: [{ name: "Pi session", extensions: ["jsonl"] }],
        });
        if (result.canceled || !result.filePaths[0]) {
            return undefined;
        }

        return workspaces.createSessionImport(context, result.filePaths[0]);
    });
    ipcMain.handle(IPC.openWorkspace, async (event, request) => {
        const context = contextFor(event);
        const safe = workspaceRequestSchema.parse(request);
        await createWindow(safe, safe.importToken ? context : undefined);
    });
    ipcMain.handle(IPC.launchIntent, (event) => {
        const context = contextFor(event);
        const intent = context.launchIntent;
        context.launchIntent = undefined;

        return intent;
    });
    ipcMain.handle(IPC.getDesktopState, (event) => {
        contextFor(event);

        return store.get();
    });
    ipcMain.handle(IPC.updateDesktopState, async (event, patch: DesktopStatePatch) => {
        contextFor(event);
        const safe = desktopStatePatchSchema.parse(patch);

        return publishState(await store.updatePreferences(safe));
    });
    ipcMain.handle(IPC.saveSessionDraft, async (event, request) => {
        const context = contextFor(event);
        const safe = sessionDraftSchema.parse(request);

        return workspaces.saveSessionDraft(context, safe.sessionId, safe.draft);
    });
    ipcMain.handle(IPC.saveSessionTitle, async (event, request) => {
        const context = contextFor(event);
        const safe = sessionTitleSchema.parse(request);

        return workspaces.saveSessionTitle(context, safe.sessionId, safe.title);
    });
    ipcMain.handle(IPC.saveActiveSession, async (event, metadata) => {
        const context = contextFor(event);

        return workspaces.saveActiveSession(context, activeSessionMetadataSchema.parse(metadata));
    });
    ipcMain.handle(IPC.runtimeSnapshot, (event) => contextFor(event).runtimes.snapshot());
    ipcMain.handle(IPC.runtimeRoster, (event) => contextFor(event).runtimes.roster());
    ipcMain.handle(IPC.runtimeDiagnostics, (event) => contextFor(event).runtimes.diagnostics());
    ipcMain.handle(IPC.saveDiagnostics, async (event) => {
        const context = contextFor(event);
        const result = await dialog.showSaveDialog(context.window, {
            defaultPath: "specpi-desktop-diagnostics.txt",
            filters: [{ name: "Text", extensions: ["txt"] }],
        });
        if (result.canceled || !result.filePath) {
            return undefined;
        }

        await writeFile(result.filePath, `${context.runtimes.diagnostics().join("\n")}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });

        return result.filePath;
    });
    ipcMain.handle(IPC.runtimeStart, async (event, request) => {
        const context = contextFor(event);
        const safe = workspaceRequestSchema.parse(request);

        const confirm: ConfirmCompatibility = (warning) => confirmCompatibility(context, warning);

        return workspaces.activate(context, safe, (project) => chooseTrust(context, project.path), confirm);
    });
    ipcMain.handle(IPC.runtimeStop, (event) => contextFor(event).runtimes.stopActive());
    ipcMain.handle(IPC.runtimeCommand, async (event, command: RpcCommand) => {
        const context = contextFor(event);
        const safe = rpcCommandSchema.parse(command) as RpcCommand;

        return context.runtimes.request(safe);
    });
    ipcMain.handle(IPC.runtimeUiResponse, async (event, response) => {
        await contextFor(event).runtimes.respond(extensionUiResponseSchema.parse(response));
    });
    ipcMain.handle(IPC.listDirectory, async (event, request) => {
        const context = contextFor(event);
        const safe = fileRequestSchema.parse(request);

        return listDirectory(await workspaces.activeProjectRoot(context, safe.projectId), safe.relativePath);
    });
    ipcMain.handle(IPC.readFile, async (event, request) => {
        const context = contextFor(event);
        const safe = fileRequestSchema.parse(request);

        return previewFile(await workspaces.activeProjectRoot(context, safe.projectId), safe.relativePath);
    });
    ipcMain.handle(IPC.gitStatus, async (event, request) => {
        const context = contextFor(event);
        const safe = projectCapabilitySchema.parse(request);

        return readGitStatus(await workspaces.activeProjectRoot(context, safe.projectId));
    });
    ipcMain.handle(IPC.gitDiff, async (event, request) => {
        const context = contextFor(event);
        const safe = diffRequestSchema.parse(request);

        return readGitDiff(await workspaces.activeProjectRoot(context, safe.projectId), safe.relativePath);
    });
    ipcMain.handle(IPC.saveExport, async (event, sourcePath: string) => {
        const context = contextFor(event);
        const source = await canonicalPath(absolutePathSchema.parse(sourcePath));
        if (!context.runtimes.isExportAuthorized(source)) {
            throw new Error("The file was not produced by this Pi runtime");
        }

        const result = await dialog.showSaveDialog(context.window, {
            defaultPath: path.basename(source),
            filters: [{ name: "HTML", extensions: ["html"] }],
        });
        if (result.canceled || !result.filePath) {
            return undefined;
        }

        if (!context.runtimes.isExportAuthorized(source)) {
            throw new Error("The active Pi runtime changed before the export was saved");
        }

        await copyFile(source, result.filePath);

        return result.filePath;
    });
    ipcMain.handle(IPC.copyText, (event, text: string) => {
        contextFor(event);
        if (typeof text !== "string" || Buffer.byteLength(text) > 1024 * 1024) {
            throw new Error("Clipboard text exceeds the size limit");
        }

        clipboard.writeText(text);
    });
    ipcMain.handle(IPC.openExternal, async (event, url: string) => {
        contextFor(event);
        await shell.openExternal(externalUrlSchema.parse(url));
    });
}

app.whenReady().then(async () => {
    store = new StateStore(app.getPath("userData"));
    await store.load();
    workspaces = new WorkspaceController(store, { stateChanged: publishState });
    registerIpc();
    nativeTheme.on("updated", () => applyWindowTheme());
    const context = await createWindow();
    if (smokeMode) {
        const smoke = await context.window.webContents.executeJavaScript(
            "({ title: document.title, hasBridge: typeof window.specpi?.getDesktopState === 'function' })",
            true,
        );
        await createWindow();
        const windowCount = BrowserWindow.getAllWindows().length;
        if (smoke.title !== "SpecPi Desktop" || smoke.hasBridge !== true || windowCount !== 2) {
            console.error("SPECPI_DESKTOP_SMOKE_FAILED", JSON.stringify({ ...smoke, windowCount }));
            app.exit(1);

            return;
        }

        console.log("SPECPI_DESKTOP_SMOKE_OK", JSON.stringify({ windowCount }));
        app.quit();

        return;
    }

    app.on("activate", async () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            await createWindow();
        }
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("before-quit", (event) => {
    const active = [...windows.values()].filter((context) => context.runtimes.hasRunningProcesses());
    if (!quitting && active.length > 0) {
        event.preventDefault();
        quitting = true;
        void Promise.all(active.map((context) => context.runtimes.stopAll())).finally(() => app.quit());
    }
});
