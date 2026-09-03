import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell, type IpcMainInvokeEvent } from "electron";
import { copyFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IPC, type DesktopStatePatch } from "../shared/ipc";
import {
    desktopStatePatchSchema,
    diffRequestSchema,
    extensionUiResponseSchema,
    externalUrlSchema,
    fileRequestSchema,
    rpcCommandSchema,
    sessionDraftSchema,
    sessionRecordSchema,
    startRuntimeSchema,
} from "../shared/schemas";
import type { RpcCommand, RuntimeEvent, RuntimeStatus, StartRuntimeOptions } from "../shared/rpc";
import { listDirectory, previewFile } from "./file-service";
import { readGitDiff, readGitStatus } from "./git-service";
import { RuntimePool } from "./runtime-pool";
import { StateStore } from "./state-store";
import { TITLE_BAR_HEIGHT, windowThemeColors } from "./window-theme";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

interface WindowContext {
    window: BrowserWindow;
    runtimes: RuntimePool;
    launchIntent?: StartRuntimeOptions;
    closing: boolean;
}

const windows = new Map<number, WindowContext>();
let store: StateStore;
let quitting = false;

function send(context: WindowContext, channel: string, payload: unknown): void {
    if (!context.window.isDestroyed()) {
        context.window.webContents.send(channel, payload);
    }
}

function applyWindowTheme(): void {
    const colors = windowThemeColors(store.get().theme, nativeTheme.shouldUseDarkColors);
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

async function createWindow(launchIntent?: StartRuntimeOptions): Promise<WindowContext> {
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
            devTools: Boolean(process.env.ELECTRON_RENDERER_URL),
        },
    });
    const context: WindowContext = {
        window: browserWindow,
        runtimes: new RuntimePool(),
        launchIntent,
        closing: false,
    };
    const webContentsId = browserWindow.webContents.id;
    windows.set(webContentsId, context);
    context.runtimes.on("event", (event: RuntimeEvent) => send(context, IPC.runtimeEvent, event));
    context.runtimes.on("status", (status: RuntimeStatus) => send(context, IPC.runtimeStatus, status));
    context.runtimes.on("roster", () => send(context, IPC.runtimeRoster, context.runtimes.roster()));

    if (!process.env.ELECTRON_RENDERER_URL && process.platform !== "darwin") {
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

    if (process.env.ELECTRON_RENDERER_URL) {
        await browserWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
        await browserWindow.loadFile(path.join(currentDirectory, "../renderer/index.html"));
    }

    return context;
}

function contextFor(event: IpcMainInvokeEvent): WindowContext {
    const context = windows.get(event.sender.id);
    if (
        !context ||
        event.sender !== context.window.webContents ||
        event.senderFrame !== context.window.webContents.mainFrame
    ) {
        throw new Error("Rejected IPC from an untrusted frame");
    }

    return context;
}

function registerIpc(): void {
    ipcMain.handle(IPC.chooseProject, async (event) => {
        const context = contextFor(event);
        const result = await dialog.showOpenDialog(context.window, { properties: ["openDirectory"] });
        if (result.canceled || !result.filePaths[0]) {
            return undefined;
        }

        return realpath(result.filePaths[0]);
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

        return result.canceled ? undefined : result.filePaths[0];
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

        return realpath(result.filePaths[0]);
    });
    ipcMain.handle(IPC.openWorkspace, async (event, options) => {
        contextFor(event);
        await createWindow(startRuntimeSchema.parse(options));
    });
    ipcMain.handle(IPC.launchIntent, (event) => contextFor(event).launchIntent);
    ipcMain.handle(IPC.getDesktopState, (event) => {
        contextFor(event);

        return store.get();
    });
    ipcMain.handle(IPC.updateDesktopState, async (event, patch: DesktopStatePatch) => {
        contextFor(event);
        const safe = desktopStatePatchSchema.parse(patch);
        const next = await store.update(safe);
        if (safe.theme) {
            applyWindowTheme();
        }

        return next;
    });
    ipcMain.handle(IPC.saveSessionDraft, async (event, request) => {
        contextFor(event);
        const safe = sessionDraftSchema.parse(request);

        return store.updateSessionDraft(safe.sessionId, safe.draft);
    });
    ipcMain.handle(IPC.saveSession, async (event, session) => {
        contextFor(event);

        return store.saveSession(sessionRecordSchema.parse(session));
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
    ipcMain.handle(IPC.runtimeStart, async (event, options) => {
        const context = contextFor(event);
        const safe = startRuntimeSchema.parse(options);

        return context.runtimes.activate(safe);
    });
    ipcMain.handle(IPC.runtimeStop, (event) => {
        const context = contextFor(event);

        return context.runtimes.stopActive();
    });
    ipcMain.handle(IPC.runtimeCommand, async (event, command: RpcCommand) => {
        const context = contextFor(event);
        const safe = rpcCommandSchema.parse(command) as RpcCommand;
        const result = await context.runtimes.request(safe);
        if (safe.type === "export_html" && result && typeof result === "object" && "path" in result) {
            const sourcePath = (result as { path?: unknown }).path;
            if (typeof sourcePath === "string") {
                context.runtimes.authorizeExport(await realpath(sourcePath));
            }
        }

        return result;
    });
    ipcMain.handle(IPC.runtimeUiResponse, async (event, response) => {
        await contextFor(event).runtimes.respond(extensionUiResponseSchema.parse(response));
    });
    ipcMain.handle(IPC.listDirectory, async (event, request) => {
        contextFor(event);
        const safe = fileRequestSchema.parse(request);

        return listDirectory(safe.projectRoot, safe.relativePath);
    });
    ipcMain.handle(IPC.readFile, async (event, request) => {
        contextFor(event);
        const safe = fileRequestSchema.parse(request);

        return previewFile(safe.projectRoot, safe.relativePath);
    });
    ipcMain.handle(IPC.gitStatus, async (event, projectRoot: string) => {
        contextFor(event);
        const safe = fileRequestSchema.shape.projectRoot.parse(projectRoot);

        return readGitStatus(safe);
    });
    ipcMain.handle(IPC.gitDiff, async (event, request) => {
        contextFor(event);
        const safe = diffRequestSchema.parse(request);

        return readGitDiff(safe.projectRoot, safe.relativePath);
    });
    ipcMain.handle(IPC.saveExport, async (event, sourcePath: string) => {
        const context = contextFor(event);
        const source = await realpath(fileRequestSchema.shape.projectRoot.parse(sourcePath));
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
    registerIpc();
    nativeTheme.on("updated", applyWindowTheme);
    const context = await createWindow();
    if (process.env.SPECPI_DESKTOP_SMOKE === "1" || process.argv.includes("--smoke")) {
        const smoke = await context.window.webContents.executeJavaScript(
            "({ title: document.title, hasBridge: typeof window.specpi?.getDesktopState === 'function' })",
            true,
        );
        await context.window.webContents.executeJavaScript(
            `window.specpi.openWorkspace({ cwd: ${JSON.stringify(process.cwd())}, trust: "deny", noSession: true })`,
            true,
        );
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
