"use strict";

const path = require("node:path");
const { randomBytes, randomUUID } = require("node:crypto");
const { SessionCatalog } = require("./session-catalog.js");
const { getWebviewHtml } = require("./webview.js");

const MAX_DRAFT = 128 * 1024;
const HISTORY_ACTIONS = new Set(["selectConversation", "renameConversation", "archiveConversation"]);

function title(value) {
    return (
        String(value || "New chat")
            .replace(/[\u0000-\u001f\u007f]/gu, " ")
            .trim()
            .slice(0, 160) || "New chat"
    );
}

/** Owns independent Pi runtimes. Selection changes only the view, never runtime identity. */
class ConversationCoordinator {
    constructor(context, { vscode, ChatController }) {
        this.context = context;
        this.vscode = vscode;
        this.ChatController = ChatController;
        this.records = new Map();
        this.workspaces = new Map();
        this.disposed = false;
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 25);
        this.statusBar.command = "specpi.chat.open";
        this.statusBar.name = "SpecPi Chat";
        this.statusBar.show();
        context.subscriptions.push(this.statusBar);
        this.selectRecord(this.createRecord(vscode.workspace.workspaceFolders?.[0]));
    }

    get active() {
        return this.records.get(this.activeId)?.controller;
    }

    get state() {
        const controller = this.active;
        if (!controller) {
            return {};
        }

        return Object.assign(controller.state, this.viewMetadata());
    }

    get client() {
        return this.active?.client;
    }

    get workspace() {
        return this.active?.workspace;
    }

    get catalog() {
        return this.active?.catalog;
    }

    get activeSessionId() {
        return this.active?.activeSessionId;
    }

    get attachments() {
        return this.active?.attachments || [];
    }

    workspaceKey(workspace) {
        return workspace?.uri.toString() || "no-workspace";
    }

    workspaceRecord(workspace) {
        const key = this.workspaceKey(workspace);
        let record = this.workspaces.get(key);
        if (!record) {
            record = { workspace, loading: false, error: undefined, lastActive: undefined, revision: 0 };
            this.workspaces.set(key, record);
        }

        return record;
    }

    catalogFor(workspace) {
        const record = this.workspaceRecord(workspace);
        const storage = this.context.storageUri;
        if (!storage || storage.scheme !== "file" || !workspace) {
            throw new Error("VS Code workspace storage is unavailable. Reopen a saved folder or workspace.");
        }

        record.catalog ||= new SessionCatalog({
            directory: path.join(storage.fsPath, "chat"),
            workspacePath: workspace.uri.fsPath,
        });

        return record.catalog;
    }

    createRecord(workspace, entry) {
        const id = randomUUID();
        const record = {
            id,
            workspace,
            title: title(entry?.sessionName),
            updatedAt: entry?.updatedAt || Date.now(),
            sessionId: entry?.sessionId,
            archived: entry?.archived === true,
            unread: false,
            draft: { text: "", selectionStart: 0, selectionEnd: 0, sendMode: "prompt" },
            lastEventRevision: 0,
        };
        this.records.set(id, record);
        this.workspaceRecord(workspace);
        if (!entry) {
            this.materialize(record);
        }

        return record;
    }

    materialize(record) {
        if (record.controller) {
            return record.controller;
        }

        const controller = new this.ChatController(this.context, {
            coordinator: this,
            conversationKey: record.id,
            workspace: record.workspace,
        });
        record.controller = controller;
        controller.activeSessionId = record.sessionId;
        controller.state.title = record.title;
        controller.branchConversation = (command, payload, draft) =>
            this.branchConversation(controller, command, payload, draft);
        if (record.sessionId) {
            record.pendingName = record.title;
        }

        return controller;
    }

    selectRecord(record) {
        if (this.disposed) {
            return;
        }

        this.active?.sentMediaIds.clear();
        this.activeId = record.id;
        record.unread = false;
        this.workspaceRecord(record.workspace).lastActive = record.id;
        this.materialize(record).sentMediaIds.clear();
        this.publish();
    }

    viewMetadata() {
        const active = this.records.get(this.activeId);
        const workspace = this.workspaceRecord(active?.workspace);
        const conversations = [...this.records.values()]
            .filter((record) => this.workspaceKey(record.workspace) === this.workspaceKey(active?.workspace))
            .map((record) => ({
                id: record.id,
                title: record.title,
                updatedAt: record.updatedAt,
                status: record.controller?.state.uiRequest ? "needs-input" : record.controller?.state.status || "saved",
                isActive: record.id === this.activeId,
                unread: record.unread,
                archived: record.archived,
                workspaceName: record.workspace?.name || "No workspace",
            }))
            .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));

        return {
            conversationKey: active?.id,
            conversations,
            historyLoading: workspace.loading,
            historyError: workspace.error,
            draft: active?.draft,
        };
    }

    conversationUpdated(controller, payload) {
        if (this.disposed) {
            return;
        }

        const record = this.records.get(controller.conversationKey);
        if (!record?.controller) {
            return;
        }

        record.title = title(controller.state.title);
        if (record.lastEventRevision !== controller.eventRevision) {
            record.lastEventRevision = controller.eventRevision;
            record.updatedAt = Date.now();
            record.unread = record.id !== this.activeId;
        }

        if (controller.state.uiRequest && record.id !== this.activeId) {
            record.unread = true;
        }

        if (record.lastError !== controller.state.error && controller.state.error && record.id !== this.activeId) {
            record.unread = true;
        }

        record.lastError = controller.state.error;

        if (controller !== this.active) {
            this.publish();

            return;
        }

        if (!payload) {
            return;
        }

        const icons = {
            busy: "sync~spin",
            retrying: "sync~spin",
            compacting: "sync~spin",
            connecting: "loading~spin",
            error: "warning",
        };
        const pending = [...this.records.values()].filter((item) => item.controller?.state.uiRequest).length;
        this.statusBar.text = `$(${pending ? "bell" : icons[controller.state.status] || "comment-discussion"}) SpecPi`;
        this.statusBar.tooltip = `SpecPi Chat · ${controller.state.status} · ${controller.state.workspace}${pending ? ` · ${pending} awaiting input` : ""}`;
        Object.assign(controller.state, this.viewMetadata());
        if (this.view) {
            void this.view.webview.postMessage({
                ...payload,
                conversationKey: record.id,
                state: { ...payload.state, ...this.viewMetadata() },
            });
        } else {
            controller.sentMediaIds.clear();
        }
    }

    publish() {
        this.active?.publish();
    }

    saveDraft(record, input) {
        if (!record || typeof input.text !== "string" || input.text.length > MAX_DRAFT) {
            return;
        }

        const position = (value) =>
            Number.isInteger(value) ? Math.max(0, Math.min(input.text.length, value)) : input.text.length;
        record.draft = {
            text: input.text,
            selectionStart: position(input.selectionStart),
            selectionEnd: position(input.selectionEnd),
            sendMode: ["steer", "followUp", "prompt"].includes(input.sendMode) ? input.sendMode : "prompt",
        };
    }

    postConversation(controller, message) {
        const record = this.records.get(controller.conversationKey);
        if (!record || this.disposed) {
            return;
        }

        if (message.type === "draft" && typeof message.text === "string") {
            let text = message.text;
            if (message.mode === "restore" && record.draft.text && record.draft.text !== text) {
                text = `${text}\n\n${record.draft.text}`;
            }

            this.saveDraft(record, {
                ...record.draft,
                text: text.slice(0, MAX_DRAFT),
                selectionStart: text.length,
                selectionEnd: text.length,
            });
        }

        void this.view?.webview.postMessage({
            ...message,
            conversationKey: record.id,
            ...(message.type === "draft" ? { draftSnapshot: { ...record.draft } } : {}),
        });
    }

    post(message) {
        if (this.active) {
            this.postConversation(this.active, message);
        }
    }

    resolveWebviewView(view) {
        this.view = view;
        for (const record of this.records.values()) {
            record.controller?.sentMediaIds.clear();
        }

        const { vscode } = this;
        const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
        view.webview.options = { enableScripts: true, localResourceRoots: [media] };
        view.webview.html = getWebviewHtml({
            cspSource: view.webview.cspSource,
            scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.js")).toString(),
            styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.css")).toString(),
            extrasScriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(media, "chat-extras.js")).toString(),
            extrasStyleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(media, "chat-extras.css")).toString(),
            nonce: randomBytes(24).toString("base64"),
        });
        view.webview.onDidReceiveMessage(
            (message) => {
                void this.handleMessage(message).catch((error) => this.fail(error));
            },
            undefined,
            this.context.subscriptions,
        );
        view.onDidDispose(
            () => {
                if (this.view === view) {
                    this.view = undefined;
                    for (const record of this.records.values()) {
                        record.controller?.sentMediaIds.clear();
                    }
                }
            },
            undefined,
            this.context.subscriptions,
        );
        this.publish();
    }

    async loadHistory(workspace = this.workspace) {
        const scope = this.workspaceRecord(workspace);
        const revision = ++scope.revision;
        scope.loading = true;
        scope.error = undefined;
        this.publish();
        try {
            const entries = await this.catalogFor(workspace).list();
            if (this.disposed || revision !== scope.revision) {
                return;
            }

            for (const entry of entries) {
                let record = [...this.records.values()].find(
                    (item) =>
                        this.workspaceKey(item.workspace) === this.workspaceKey(workspace) &&
                        item.sessionId === entry.sessionId,
                );
                if (!record) {
                    record = this.createRecord(workspace, entry);
                } else if (!record.controller?.client) {
                    record.title = title(entry.sessionName);
                    record.updatedAt = Math.max(record.updatedAt, entry.updatedAt);
                }

                record.archived = entry.archived === true;
            }
        } catch (error) {
            if (revision === scope.revision) {
                scope.error = String(error?.message || "Conversation history could not be loaded.").slice(0, 2000);
            }
        } finally {
            if (revision === scope.revision) {
                scope.loading = false;
                this.publish();
            }
        }
    }

    async history() {
        this.active.requireWorkspace();
        this.post({ type: "showHistory" });
        await this.loadHistory();
    }

    async selectConversation(id) {
        const record = this.records.get(id);
        if (!record || record.archived || this.workspaceKey(record.workspace) !== this.workspaceKey(this.workspace)) {
            throw new Error(
                "Choose an available conversation from this workspace. Restore archived chats before opening them.",
            );
        }

        const resume = Boolean(record.sessionId && !record.controller?.client);
        this.selectRecord(record);
        if (resume) {
            await record.controller.connect();
        }
    }

    async newChat(source = this.active) {
        if (source !== this.active || this.disposed) {
            return;
        }

        source.requireWorkspace();
        this.selectRecord(this.createRecord(source.workspace));
        this.post({ type: "focus" });
    }

    async chooseWorkspace() {
        const source = this.active;
        const workspace = await this.vscode.window.showWorkspaceFolderPick({
            placeHolder: "Choose the folder Pi will work in",
        });
        if (
            !workspace ||
            this.disposed ||
            source !== this.active ||
            this.workspaceKey(workspace) === this.workspaceKey(this.workspace)
        ) {
            return;
        }

        const scope = this.workspaceRecord(workspace);
        const record = this.records.get(scope.lastActive) || this.createRecord(workspace);
        this.selectRecord(record);
        await this.loadHistory(workspace);
    }

    async renameConversation(id, name) {
        if (typeof name !== "string" || !name.trim() || name.length > 160) {
            throw new Error("Use a conversation name of 1–160 characters.");
        }

        const record = this.records.get(id);
        if (!record || this.workspaceKey(record.workspace) !== this.workspaceKey(this.workspace)) {
            throw new Error("This conversation is no longer in the current workspace list.");
        }

        const value = title(name);
        const controller = record.controller;
        record.pendingName = value;
        if (controller?.state.status === "connecting" && controller.connection) {
            await controller.connection;
        }

        if (controller?.client && controller.state.status !== "connecting") {
            controller.refreshRevision += 1;
            await controller.client.request("set_session_name", { name: value });
            controller.refreshRevision += 1;
        }

        if (record.sessionId) {
            await this.catalogFor(record.workspace).rename(record.sessionId, value);
        }

        record.title = value;
        if (controller) {
            controller.state.title = value;
        }

        this.publish();
    }

    async applyPendingName(controller, client) {
        const record = this.records.get(controller.conversationKey);
        while (record?.pendingName && controller.client === client && !controller.disposed) {
            const name = record.pendingName;
            await client.request("set_session_name", { name });
            if (record.pendingName === name) {
                return;
            }
        }
    }

    async sessionRemembered(controller, sessionId) {
        const record = this.records.get(controller.conversationKey);
        if (record?.archived) {
            await this.catalogFor(record.workspace).setArchived(sessionId, true);
        }
    }

    sessionObserved(controller, sessionId) {
        const record = this.records.get(controller.conversationKey);
        if (record && typeof sessionId === "string") {
            record.sessionId = sessionId;
        }
    }

    async archiveConversation(id, archived) {
        if (typeof archived !== "boolean") {
            throw new Error("Choose whether to archive or restore this conversation.");
        }

        const record = this.records.get(id);
        if (!record || this.workspaceKey(record.workspace) !== this.workspaceKey(this.workspace)) {
            throw new Error("This conversation is no longer in the current workspace list.");
        }

        if (record.sessionId) {
            await this.catalogFor(record.workspace).setArchived(record.sessionId, archived);
        }

        record.archived = archived;
        this.publish();
    }

    async branchConversation(source, command, payload, draft) {
        if (source !== this.active || !source.activeSessionId || !["clone", "fork"].includes(command)) {
            throw new Error("Save this conversation and select it before creating a branch.");
        }

        source.transitioning = true;
        const record = this.createRecord(source.workspace);
        const target = record.controller;
        const operation = Symbol("branch");
        target.branchOperation = operation;
        target.transitioning = true;
        target.forkSourceSessionId = source.activeSessionId;
        target.suppressRemember = true;
        target.state.title = "New branch";
        this.selectRecord(record);
        let accepted = false;
        let attemptClient;
        let attemptGeneration;
        const current = () =>
            !target.disposed &&
            target.branchOperation === operation &&
            target.generation === attemptGeneration &&
            (!attemptClient || target.client === attemptClient);
        try {
            const connection = target.connect();
            attemptGeneration = target.generation;
            await connection;
            const client = target.client;
            if (!client || !current()) {
                return false;
            }

            attemptClient = client;
            target.sessionRevision += 1;

            const result = await client.request(command, payload, { timeoutMs: 0 });
            if (!current() || result?.cancelled) {
                return false;
            }

            accepted = true;
            target.forkSourceSessionId = undefined;
            target.suppressRemember = false;
            target.sessionRevision += 1;
            target.attachments = draft.images.map((image, index) => ({
                ...image,
                id: randomUUID(),
                kind: "image",
                label: image.name || `Image ${index + 1}`,
                detail: `${image.width} × ${image.height} · ${image.mimeType}`,
            }));
            target.post({ type: "draft", text: draft.text });
            await this.applyPendingName(target, client);
            if (!current()) {
                return false;
            }

            await target.refresh(client, true);
            target.publish();
            target.post({ type: "focus" });

            return true;
        } catch (error) {
            if (current()) {
                target.fail(
                    accepted
                        ? new Error(
                              "The new branch was created and its draft restored, but its status could not refresh. Refresh this conversation before continuing; do not repeat the fork.",
                              { cause: error },
                          )
                        : error,
                );
            }

            return false;
        } finally {
            source.transitioning = false;
            source.publish();
            if (!accepted && current()) {
                target.state.error ||= "The branch could not be created. The original conversation is unchanged.";
                await target.disconnect();
            }

            if (target.branchOperation === operation) {
                target.branchOperation = undefined;
                target.transitioning = false;
            }

            target.publish();
        }
    }

    async handleMessage(message) {
        if (!message || typeof message !== "object" || typeof message.type !== "string" || this.disposed) {
            return;
        }

        const record = this.records.get(message.conversationKey || this.activeId);
        if (!record) {
            return;
        }

        if (message.type === "saveDraft") {
            this.saveDraft(record, message);

            return;
        }

        if (record.id !== this.activeId) {
            return;
        }

        if (HISTORY_ACTIONS.has(message.type)) {
            let error;
            try {
                if (message.type === "selectConversation") {
                    await this.selectConversation(message.id);
                } else if (message.type === "renameConversation") {
                    await this.renameConversation(message.id, message.name);
                } else {
                    await this.archiveConversation(message.id, message.archived);
                }
            } catch (failure) {
                error = String(failure?.message || "The conversation action could not finish.").slice(0, 2000);
            }

            void this.view?.webview.postMessage({
                type: "historyActionResult",
                action: message.type,
                id: message.id,
                ...(error ? { error } : {}),
            });

            return;
        }

        const controller = record.controller;
        try {
            await controller.handleMessage(message);
        } catch (error) {
            controller.fail(error);
        }
    }

    fail(error) {
        this.active?.fail(error);
    }

    connect() {
        return this.active.connect();
    }

    disconnect() {
        return this.active.disconnect();
    }

    restart() {
        return this.active.restart();
    }

    stop() {
        return this.active.stop();
    }

    refresh(...args) {
        return this.active.refresh(...args);
    }

    attachSelection() {
        return this.active.attachSelection();
    }

    attachFile(uri) {
        return this.active.attachFile(uri);
    }

    attachImage(uri) {
        return this.active.attachImage(uri);
    }

    async disconnectAll() {
        await Promise.all([...this.records.values()].map((record) => record.controller?.disconnect()));
    }

    workspaceFoldersChanged() {
        const folders = this.vscode.workspace.workspaceFolders || [];
        for (const record of this.records.values()) {
            if (!folders.some((folder) => this.workspaceKey(folder) === this.workspaceKey(record.workspace))) {
                void record.controller?.disconnect();
            }
        }

        if (!folders.some((folder) => this.workspaceKey(folder) === this.workspaceKey(this.workspace))) {
            const scope = this.workspaceRecord(folders[0]);
            this.selectRecord(this.records.get(scope.lastActive) || this.createRecord(folders[0]));
        }
    }

    dispose() {
        if (this.disposed) {
            return;
        }

        this.disposed = true;
        for (const record of this.records.values()) {
            record.controller?.dispose();
        }
    }
}

module.exports = { ConversationCoordinator };
