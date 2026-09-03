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
    startRuntimeSchema,
} from "../shared/schemas";
import type { RpcCommand, RuntimeEvent, RuntimeStatus } from "../shared/rpc";
import { listDirectory, previewFile } from "./file-service";
import { readGitDiff, readGitStatus } from "./git-service";
import { PiProcess } from "./pi-process";
import { StateStore } from "./state-store";
import { TITLE_BAR_HEIGHT, windowThemeColors } from "./window-theme";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtime = new PiProcess();
let window: BrowserWindow | undefined;
let store: StateStore;
const exportPaths = new Set<string>();

function send(channel: string, payload: unknown): void {
    if (window && !window.isDestroyed()) {
        window.webContents.send(channel, payload);
    }
}

function applyWindowTheme(): void {
    if (!window || window.isDestroyed()) {
        return;
    }

    const colors = windowThemeColors(store.get().theme, nativeTheme.shouldUseDarkColors);
    window.setBackgroundColor(colors.backgroundColor);
    if (process.platform !== "darwin") {
        window.setTitleBarOverlay({ color: colors.color, symbolColor: colors.symbolColor, height: TITLE_BAR_HEIGHT });
    }
}

async function createWindow(): Promise<void> {
    const colors = windowThemeColors(store.get().theme, nativeTheme.shouldUseDarkColors);
    window = new BrowserWindow({
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
    if (!process.env.ELECTRON_RENDERER_URL && process.platform !== "darwin") {
        window.removeMenu();
    }

    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.once("ready-to-show", () => window?.show());
    window.once("closed", () => {
        window = undefined;
        void runtime.stop();
    });

    if (process.env.ELECTRON_RENDERER_URL) {
        await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
        await window.loadFile(path.join(currentDirectory, "../renderer/index.html"));
    }
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
        throw new Error("Rejected IPC from an untrusted frame");
    }
}

function registerIpc(): void {
    ipcMain.handle(IPC.chooseProject, async (event) => {
        assertTrustedSender(event);
        const result = await dialog.showOpenDialog(window!, { properties: ["openDirectory"] });
        if (result.canceled || !result.filePaths[0]) {
            return undefined;
        }

        return realpath(result.filePaths[0]);
    });
    ipcMain.handle(IPC.choosePi, async (event) => {
        assertTrustedSender(event);
        const result = await dialog.showOpenDialog(window!, {
            properties: ["openFile"],
            filters:
                process.platform === "win32"
                    ? [{ name: "Pi executable", extensions: ["exe", "cmd"] }]
                    : [{ name: "Pi executable", extensions: ["*"] }],
        });

        return result.canceled ? undefined : result.filePaths[0];
    });
    ipcMain.handle(IPC.chooseSession, async (event) => {
        assertTrustedSender(event);
        const result = await dialog.showOpenDialog(window!, {
            defaultPath: path.join(app.getPath("home"), ".pi", "agent", "sessions"),
            properties: ["openFile"],
            filters: [{ name: "Pi session", extensions: ["jsonl"] }],
        });
        if (result.canceled || !result.filePaths[0]) {
            return undefined;
        }

        return realpath(result.filePaths[0]);
    });
    ipcMain.handle(IPC.getDesktopState, (event) => {
        assertTrustedSender(event);

        return store.get();
    });
    ipcMain.handle(IPC.updateDesktopState, async (event, patch: DesktopStatePatch) => {
        assertTrustedSender(event);
        const safe = desktopStatePatchSchema.parse(patch);
        const next = await store.update(safe);
        if (safe.theme) {
            applyWindowTheme();
        }

        return next;
    });
    ipcMain.handle(IPC.saveSessionDraft, async (event, request) => {
        assertTrustedSender(event);
        const safe = sessionDraftSchema.parse(request);

        return store.updateSessionDraft(safe.sessionId, safe.draft);
    });
    ipcMain.handle(IPC.runtimeSnapshot, (event) => {
        assertTrustedSender(event);

        return runtime.snapshot();
    });
    ipcMain.handle(IPC.runtimeDiagnostics, (event) => {
        assertTrustedSender(event);

        return runtime.diagnostics();
    });
    ipcMain.handle(IPC.saveDiagnostics, async (event) => {
        assertTrustedSender(event);
        const result = await dialog.showSaveDialog(window!, {
            defaultPath: "specpi-desktop-diagnostics.txt",
            filters: [{ name: "Text", extensions: ["txt"] }],
        });
        if (result.canceled || !result.filePath) {
            return undefined;
        }

        await writeFile(result.filePath, `${runtime.diagnostics().join("\n")}\n`, { encoding: "utf8", mode: 0o600 });

        return result.filePath;
    });
    ipcMain.handle(IPC.runtimeStart, async (event, options) => {
        assertTrustedSender(event);
        const safe = startRuntimeSchema.parse(options);
        exportPaths.clear();

        return runtime.start(safe);
    });
    ipcMain.handle(IPC.runtimeStop, (event) => {
        assertTrustedSender(event);
        exportPaths.clear();

        return runtime.stop();
    });
    ipcMain.handle(IPC.runtimeCommand, async (event, command: RpcCommand) => {
        assertTrustedSender(event);
        const safe = rpcCommandSchema.parse(command) as RpcCommand;
        const result = await runtime.request(safe);
        if (safe.type === "export_html" && result && typeof result === "object" && "path" in result) {
            const sourcePath = (result as { path?: unknown }).path;
            if (typeof sourcePath === "string") {
                exportPaths.add(await realpath(sourcePath));
            }
        }

        return result;
    });
    ipcMain.handle(IPC.runtimeUiResponse, async (event, response) => {
        assertTrustedSender(event);
        await runtime.respond(extensionUiResponseSchema.parse(response));
    });
    ipcMain.handle(IPC.listDirectory, async (event, request) => {
        assertTrustedSender(event);
        const safe = fileRequestSchema.parse(request);

        return listDirectory(safe.projectRoot, safe.relativePath);
    });
    ipcMain.handle(IPC.readFile, async (event, request) => {
        assertTrustedSender(event);
        const safe = fileRequestSchema.parse(request);

        return previewFile(safe.projectRoot, safe.relativePath);
    });
    ipcMain.handle(IPC.gitStatus, async (event, projectRoot: string) => {
        assertTrustedSender(event);
        const safe = fileRequestSchema.shape.projectRoot.parse(projectRoot);

        return readGitStatus(safe);
    });
    ipcMain.handle(IPC.gitDiff, async (event, request) => {
        assertTrustedSender(event);
        const safe = diffRequestSchema.parse(request);

        return readGitDiff(safe.projectRoot, safe.relativePath);
    });
    ipcMain.handle(IPC.saveExport, async (event, sourcePath: string) => {
        assertTrustedSender(event);
        const source = await realpath(fileRequestSchema.shape.projectRoot.parse(sourcePath));
        if (!exportPaths.has(source)) {
            throw new Error("The file was not produced by this Pi runtime");
        }

        const result = await dialog.showSaveDialog(window!, {
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
        assertTrustedSender(event);
        if (typeof text !== "string" || Buffer.byteLength(text) > 1024 * 1024) {
            throw new Error("Clipboard text exceeds the size limit");
        }

        clipboard.writeText(text);
    });
    ipcMain.handle(IPC.openExternal, async (event, url: string) => {
        assertTrustedSender(event);
        await shell.openExternal(externalUrlSchema.parse(url));
    });
}

runtime.on("event", (event: RuntimeEvent) => send(IPC.runtimeEvent, event));
runtime.on("status", (status: RuntimeStatus) => send(IPC.runtimeStatus, status));

app.whenReady().then(async () => {
    store = new StateStore(app.getPath("userData"));
    await store.load();
    registerIpc();
    nativeTheme.on("updated", applyWindowTheme);
    await createWindow();
    if (process.env.SPECPI_DESKTOP_SMOKE === "1" || process.argv.includes("--smoke")) {
        const smoke = await window!.webContents.executeJavaScript(
            "({ title: document.title, hasBridge: typeof window.specpi?.getDesktopState === 'function' })",
            true,
        );
        if (smoke.title !== "SpecPi Desktop" || smoke.hasBridge !== true) {
            console.error("SPECPI_DESKTOP_SMOKE_FAILED", JSON.stringify(smoke));
            app.exit(1);

            return;
        }

        console.log("SPECPI_DESKTOP_SMOKE_OK");
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
    if (runtime.snapshot().status.phase !== "stopped") {
        event.preventDefault();
        void runtime.stop().finally(() => app.quit());
    }
});
