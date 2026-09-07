const vscode = require("vscode");
const { randomUUID, createHash } = require("node:crypto");
const { RpcClient } = require("./rpc-client.js");
const { resolveLaunch } = require("./launch.js");
const { createState, applyEvent, resetRunState, replaceMessages, safeModel, appendNotice } = require("./chat-state.js");
const { collectAttachment, formatPrompt } = require("./context.js");
const { resolveCodeReference } = require("./code-references.js");
const { collectImageAttachment, normalizeImage, MAX_IMAGE_TOTAL_BYTES } = require("./images.js");
const { editPrompt, forkChat, exportChat, showUsage, markdownTranscript } = require("./conversation-actions.js");
const { findFiles, reviewChanges } = require("./workspace-actions.js");
const { ImageQueue } = require("./image-queue.js");
const { DELEGATE_WIDGET, decodeDelegates, delegateCompletionText } = require("./delegates.js");
const { ConversationCoordinator } = require("./conversation-coordinator.js");

const PREFIX = "specpi.chat";
const MAX_INPUT = 64 * 1024;
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const ACTIVE_STATUSES = new Set(["busy", "retrying", "compacting"]);
const USAGE_STATUS_KEYS = new Set(["aa-codex-usage", "provider-usage"]);

class ChatController {
    constructor(context, options = {}) {
        this.context = context;
        this.coordinator = options.coordinator;
        this.conversationKey = options.conversationKey;
        this.state = createState();
        this.attachments = [];
        this.mediaIds = new WeakMap();
        this.sentMediaIds = new Set();
        this.imageQueue = new ImageQueue();
        this.pendingDelegateStops = new Set();
        this.delegateSummaries = new Map();
        this.dialogs = [];
        this.client = null;
        this.connection = null;
        this.generation = 0;
        this.eventRevision = 0;
        this.refreshRevision = 0;
        this.sessionRevision = 0;
        this.contextEpoch = 0;
        this.sending = false;
        this.transitioning = false;
        this.disposed = false;
        this.workspace = options.workspace || vscode.workspace.workspaceFolders?.[0];
        this.state.workspace = this.workspace?.name || "Open a folder to begin";
        this.publish();
    }

    publish() {
        if (this.disposed) {
            return;
        }

        this.state.sending = this.sending || this.transitioning;
        this.state.contextToken = this.contextToken();
        this.state.recoveredDrafts = this.imageQueue.recovered.map((item) => ({
            id: item.id,
            text: item.text,
            imageCount: item.attachments.filter((attachment) => attachment.kind === "image").length,
        }));
        this.state.attachments = this.attachments.map((attachment) =>
            attachment.kind === "image"
                ? attachment
                : { id: attachment.id, label: attachment.label, detail: attachment.detail },
        );
        if (!this.isForeground()) {
            this.sentMediaIds.clear();
            this.coordinator.conversationUpdated(this);

            return;
        }

        const media = [];
        const retained = new Set();
        const projectImage = (image) => {
            let mediaId = this.mediaIds.get(image);
            if (!mediaId) {
                mediaId = createHash("sha256").update(image.mimeType).update(image.data).digest("hex");
                this.mediaIds.set(image, mediaId);
            }

            retained.add(mediaId);
            if (!this.sentMediaIds.has(mediaId)) {
                media.push({
                    id: mediaId,
                    data: image.data,
                    mimeType: image.mimeType,
                    width: image.width,
                    height: image.height,
                    byteLength: image.byteLength,
                });
                this.sentMediaIds.add(mediaId);
            }

            const { data: _data, ...metadata } = image;

            return { ...metadata, mediaId };
        };

        const state = {
            ...this.state,
            delegation: this.state.delegation
                ? {
                      ...this.state.delegation,
                      canStop: !this.transitioning,
                      jobs: this.state.delegation.jobs.map((job) => ({
                          ...job,
                          stopPending: this.pendingDelegateStops.has(`${job.batchId}/${job.id}/${job.attemptId}`),
                      })),
                  }
                : undefined,
            attachments: this.state.attachments.map((item) => (item.kind === "image" ? projectImage(item) : item)),
            messages: this.state.messages.map((item) =>
                item.images?.length ? { ...item, images: item.images.map(projectImage) } : item,
            ),
        };
        this.sentMediaIds = retained;
        this.coordinator.conversationUpdated(this, {
            type: "state",
            state,
            media,
            retainedMediaIds: [...retained],
        });
    }

    post(message) {
        this.coordinator.postConversation(this, message);
    }

    isForeground() {
        return this.coordinator.active === this;
    }

    fail(error) {
        // Errors are shown only in this local view, never copied into logs or telemetry.
        this.state.error = String(error?.message || "The operation could not finish.").slice(0, 2000);
        if (!this.client) {
            this.state.status = "error";
        }

        this.publish();
    }

    requireWorkspace() {
        if (!vscode.workspace.isTrusted) {
            throw new Error(
                "Trust this workspace in VS Code before starting Pi. Workspace extensions and tools can execute code.",
            );
        }

        if (!this.workspace || this.workspace.uri.scheme !== "file") {
            throw new Error("Open a local folder, or a folder on a remote VS Code extension host, to use SpecPi Chat.");
        }

        if (
            !vscode.workspace.workspaceFolders?.some(
                (folder) => folder.uri.toString() === this.workspace.uri.toString(),
            )
        ) {
            throw new Error("The selected folder is no longer open. Choose a workspace folder.");
        }

        return this.workspace.uri.fsPath;
    }

    async connect() {
        this.requireWorkspace();
        if (this.restartStopping) {
            throw new Error("Wait for Pi to stop restarting before connecting.");
        }

        if (this.disposed) {
            throw new Error("SpecPi Chat has closed.");
        }

        if (this.connection && this.connectionGeneration === this.generation) {
            return this.connection;
        }

        if (this.client) {
            return;
        }

        const connection = this.startConnection();
        this.connection = connection;
        this.connectionGeneration = this.generation;
        try {
            await connection;
        } finally {
            if (this.connection === connection) {
                this.connection = null;
            }
        }
    }

    async startConnection() {
        const generation = ++this.generation;
        this.delegateSummaries.clear();
        const cwd = this.requireWorkspace();
        resetRunState(this.state);
        this.state.status = "connecting";
        this.state.runtimeStatus = {};
        this.state.delegation = undefined;
        this.state.error = undefined;
        this.state.connectionMessage = "Starting Pi and loading its extensions. This can take up to 90 seconds.";
        this.publish();
        let client;
        let rpcReady = false;
        const startupNotices = new Set();
        try {
            const configuration = vscode.workspace.getConfiguration(PREFIX);
            const launch = await resolveLaunch({
                piPath: configuration.get("piPath", ""),
                nodePath: configuration.get("nodePath", ""),
            });
            if (generation !== this.generation || this.disposed) {
                return;
            }

            const storage = this.context.storageUri;
            if (!storage || storage.scheme !== "file") {
                throw new Error("VS Code workspace storage is unavailable. Reopen a saved folder or workspace.");
            }

            this.catalog = this.coordinator.catalogFor(this.workspace);
            await this.catalog.list();
            const args = [...launch.args, "--mode", "rpc", "--session-dir", this.catalog.sessionDirectory];
            if (this.forkSourceSessionId || this.activeSessionId) {
                const session = await this.catalog.resolve(this.forkSourceSessionId || this.activeSessionId);
                if (session) {
                    args.push(this.forkSourceSessionId ? "--fork" : "--session", session.sessionFile);
                } else {
                    throw new Error("This conversation is no longer available in the local catalog.");
                }
            }

            if (generation !== this.generation || this.disposed) {
                return;
            }

            client = new RpcClient({ command: launch.command, args, cwd, env: process.env });
            this.client = client;
            this.clientWorkspace = cwd;
            client.on("event", (event) => {
                if (this.client !== client || generation !== this.generation) {
                    return;
                }

                if (event.type === "extension_ui_request") {
                    if (!rpcReady && DIALOG_METHODS.has(event.method)) {
                        // Pi 0.84.4 binds session_start before attaching its stdin reader.
                        // A selected mode or approval here may be silently ignored until
                        // the extension's fallback expires. Never imply that it was applied.
                        if (typeof event.id === "string" && event.id.length <= 200) {
                            client.send({ type: "extension_ui_response", id: event.id, cancelled: true });
                        }

                        const legacyGuard = event.method === "select" && event.title === "SpecPi command guard";
                        const notice = legacyGuard
                            ? "An older SpecPi Guard startup prompt is waiting to expire (about 30 seconds). " +
                              "No mode change was requested. After connecting, use /guard to choose a mode. " +
                              "Updating the SpecPi harness removes this startup delay."
                            : "Pi opened a dialog before its chat connection was ready. It was cancelled without approval. " +
                              "If startup does not finish, update the extension that opens the dialog and reconnect.";
                        startupNotices.add(
                            legacyGuard
                                ? "An older SpecPi Guard startup prompt delayed this connection. " +
                                      "No mode change was requested. Use /guard to choose a mode. " +
                                      "Updating the SpecPi harness removes this startup delay."
                                : notice,
                        );
                        this.state.connectionMessage = notice;
                        this.publish();
                    } else {
                        this.handleUiRequest(event, client);
                    }
                } else {
                    this.eventRevision += 1;
                    if (event.type === "message_start" && event.message?.role === "user") {
                        this.imageQueue.consume(event.message);
                    }

                    applyEvent(this.state, event);
                    if (!rpcReady) {
                        this.state.status = "connecting";
                    }

                    this.schedulePublish();
                    if (rpcReady && event.type === "agent_settled") {
                        void this.refresh(client).catch((error) => this.fail(error));
                    }
                }
            });
            client.on("exit", () => {
                if (this.client === client) {
                    this.client = null;
                    this.imageQueue.clear();
                    this.cancelDialogs();
                    resetRunState(this.state);
                    this.state.status = "error";
                    this.state.runtimeStatus = {};
                    this.state.delegation = undefined;
                    this.state.error =
                        "Pi stopped. Reconnect to resume this chat. Check Pi and provider setup in a terminal if this repeats.";
                    this.publish();
                }
            });
            client.on("diagnostic", (message) => {
                if (this.client === client) {
                    this.state.error = message;
                    this.publish();
                }
            });
            await client.start();
            await client.waitUntilReady();
            if (this.client !== client || generation !== this.generation || this.disposed) {
                return;
            }

            rpcReady = true;
            await this.coordinator.applyPendingName(this, client);
            await this.refresh(client, true);
            if (this.client === client && generation === this.generation && !this.disposed) {
                this.state.error = undefined;
                this.state.connectionMessage = undefined;
                for (const notice of startupNotices) {
                    appendNotice(this.state, notice);
                }

                this.publish();
            }
        } catch (error) {
            if (this.client === client) {
                this.client = null;
            }

            if (generation === this.generation) {
                this.cancelDialogs();
            }

            await client?.stop();
            if (generation === this.generation) {
                resetRunState(this.state);
                this.state.status = "error";
                this.state.delegation = undefined;
                this.state.connectionMessage = undefined;
                this.fail(error);
                throw error;
            }
        }
    }

    schedulePublish() {
        if (!this.publishTimer) {
            this.publishTimer = setTimeout(() => {
                this.publishTimer = undefined;
                this.publish();
            }, 32);
        }
    }

    async refresh(client = this.client, full = false) {
        if (!client) {
            return;
        }

        const generation = this.generation;
        const sessionRevision = this.sessionRevision;
        const eventRevision = this.eventRevision;
        const refreshRevision = ++this.refreshRevision;
        const current = () =>
            client === this.client &&
            generation === this.generation &&
            sessionRevision === this.sessionRevision &&
            refreshRevision === this.refreshRevision;
        const types = full
            ? [
                  "get_state",
                  "get_available_models",
                  "get_commands",
                  "get_available_thinking_levels",
                  "get_session_stats",
                  "get_messages",
              ]
            : ["get_state", "get_available_thinking_levels", "get_session_stats"];
        const values = await Promise.all(
            types.map(async (type) => {
                try {
                    return await client.request(type);
                } catch (error) {
                    if (type === "get_messages" && error?.code === "PI_RPC_HISTORY_TOO_LARGE") {
                        return { displayOmitted: true };
                    }

                    throw error;
                }
            }),
        );
        if (!current()) {
            return;
        }

        const data = Object.fromEntries(types.map((type, index) => [type, values[index]]));
        const runtime = data.get_state;
        if (runtime.sessionId && this.runtimeSessionId !== runtime.sessionId) {
            if (this.runtimeSessionId) {
                this.delegateSummaries.clear();
                this.state.delegation = undefined;
            }

            this.runtimeSessionId = runtime.sessionId;
            this.contextEpoch += 1;
        }

        this.state.model = safeModel(runtime.model);
        this.state.thinkingLevel = runtime.thinkingLevel;
        this.state.thinkingLevels = data.get_available_thinking_levels?.levels || [];
        if (eventRevision === this.eventRevision) {
            applyEvent(this.state, { type: "response", command: "get_state", success: true, data: runtime });
        }

        this.state.title = runtime.sessionName || "New chat";
        const tokens = data.get_session_stats?.tokens;
        this.state.tokens =
            tokens &&
            Object.fromEntries(
                ["input", "output", "cacheRead", "cacheWrite", "total"].map((key) => [
                    key,
                    Number.isFinite(tokens[key]) && tokens[key] >= 0 ? tokens[key] : 0,
                ]),
            );
        const usage = data.get_session_stats?.contextUsage;
        this.state.contextUsage =
            usage &&
            Object.fromEntries(
                ["tokens", "contextWindow", "percent"].map((key) => [
                    key,
                    Number.isFinite(usage[key]) && usage[key] >= 0 ? usage[key] : null,
                ]),
            );
        const cost = data.get_session_stats?.cost;
        this.state.cost = Number.isFinite(cost) && cost >= 0 ? cost : undefined;
        if (full) {
            this.state.models = (data.get_available_models?.models || []).map(safeModel).filter(Boolean).slice(0, 1000);
            applyEvent(this.state, {
                type: "response",
                command: "get_commands",
                success: true,
                data: data.get_commands,
            });
            if (data.get_messages?.displayOmitted) {
                if (!runtime.sessionId || this.displaySessionId !== runtime.sessionId) {
                    replaceMessages(this.state, []);
                }

                if (!this.state.historyTruncated || this.displaySessionId !== runtime.sessionId) {
                    appendNotice(
                        this.state,
                        "This chat's saved transcript exceeds the 64 MiB display limit. Pi is still connected, but older messages could not be loaded into this view. You can continue the conversation, use /compact, or start a new chat.",
                    );
                }

                this.state.historyTruncated = true;
            } else if (eventRevision === this.eventRevision) {
                replaceMessages(this.state, data.get_messages?.messages || []);
                this.state.historyTruncated = false;
            }

            this.displaySessionId = runtime.sessionId;
            for (const [id, summary] of this.delegateSummaries) {
                appendNotice(this.state, summary.text, summary.isError, id);
            }
        }

        if (runtime.sessionFile && !this.suppressRemember) {
            this.coordinator.sessionObserved(this, runtime.sessionId);
            const remembered = await this.catalog.remember(runtime);
            if (!current()) {
                return;
            }

            if (remembered) {
                this.activeSessionId = runtime.sessionId;
                await this.coordinator.sessionRemembered(this, runtime.sessionId);
                if (!current()) {
                    return;
                }
            }
        }

        this.publish();
    }

    async disconnect() {
        ++this.generation;
        ++this.sessionRevision;
        if (this.branchOperation) {
            this.branchOperation = undefined;
            this.transitioning = false;
            this.forkSourceSessionId = undefined;
            this.suppressRemember = false;
        }

        const client = this.client;
        this.cancelDialogs();
        this.client = null;
        this.clientWorkspace = undefined;
        this.imageQueue.clear();
        resetRunState(this.state);
        this.state.status = "disconnected";
        this.state.runtimeStatus = {};
        this.state.delegation = undefined;
        this.state.connectionMessage = undefined;
        this.state.queueCount = 0;
        this.publish();
        await client?.stop();
    }

    async restart() {
        if (this.restartOperation) {
            return this.restartOperation;
        }

        this.requireWorkspace();
        const operation = this.restartConnection();
        this.restartOperation = operation;
        try {
            await operation;
        } finally {
            if (this.restartOperation === operation) {
                this.restartOperation = undefined;
            }
        }
    }

    async restartConnection() {
        this.restartStopping = true;
        let generation;
        try {
            const stopping = this.disconnect();
            generation = this.generation;
            await stopping;
        } finally {
            this.restartStopping = false;
        }

        if (!this.disposed && generation === this.generation) {
            await this.connect();
        }
    }

    async stop() {
        const client = this.client;
        const generation = this.generation;
        const sessionRevision = this.sessionRevision;
        const current = () =>
            client === this.client && generation === this.generation && sessionRevision === this.sessionRevision;
        if (!client) {
            return;
        }

        const failClosed = async (message) => {
            if (!current()) {
                return;
            }

            const disconnecting = this.disconnect();
            const disconnectedGeneration = this.generation;
            await disconnecting;
            if (!this.disposed && !this.client && this.generation === disconnectedGeneration) {
                this.fail(new Error(message));
            }
        };

        this.cancelDialogs();
        let queue;
        try {
            queue = await client.request("clear_queue");
        } catch {
            await failClosed(
                "Pi could not clear queued work, so the connection was closed. Reconnect to resume this chat.",
            );

            return;
        }

        if (!current()) {
            return;
        }

        try {
            await client.request("abort");
        } catch {
            await failClosed("Pi did not acknowledge Stop, so the connection was closed.");

            return;
        }

        if (!current()) {
            return;
        }

        const recovery = this.imageQueue.recover(queue);
        const recovered = recovery.remainingTexts;
        if (recovery.droppedCount) {
            appendNotice(
                this.state,
                "Some image messages could not be matched to Pi's stopped queue. They were not restored because they may have already run. Check the conversation before attaching them again.",
            );
        }

        if (recovered.length) {
            this.post({ type: "draft", text: recovered.join("\n\n"), mode: "restore" });
        }

        await this.refresh(client);
    }

    async send(text, mode = "prompt", requestId) {
        if (
            typeof text !== "string" ||
            (!text.trim() && !this.attachments.some((item) => item.kind === "image")) ||
            text.length > MAX_INPUT
        ) {
            throw new Error("Enter a message of at most 64 KiB, or attach an image.");
        }

        if (this.sending || this.transitioning) {
            this.post({ type: "draft", text, mode: "restore" });
            throw new Error("Wait for the current chat action to finish.");
        }

        this.sending = true;
        this.publish();
        const attached = [...this.attachments];
        const workspace = this.workspace;
        let client;
        let connectionGeneration;
        let accepted = false;
        let queuedId;
        try {
            if (attached.some((item) => item.kind === "image") && text.trimStart().startsWith("/")) {
                throw new Error(
                    "Pi slash commands do not consume image attachments. Send your images with a normal message, or remove them before running a command.",
                );
            }

            if (/^\/help\s*$/.test(text)) {
                appendNotice(
                    this.state,
                    "Use /new for a fresh chat, /compact to compact context, and the command menu for installed Pi skills and SpecPi commands. Choose models and thinking below the composer. Attach files or selected text explicitly. Enter sends; Shift+Enter inserts a newline; Stop clears queued messages before aborting. Provider login is managed in the Pi terminal.",
                );

                return;
            }

            if (/^\/(?:settings|login|logout)\s*$/.test(text)) {
                appendNotice(
                    this.state,
                    "Manage provider sign-in and Pi settings in a terminal using Pi. SpecPi Chat reuses Pi's configuration; reconnect after making changes.",
                );

                return;
            }

            const connection = this.connect();
            connectionGeneration = this.generation;
            await connection;
            if (!this.client || this.workspace !== workspace || this.generation !== connectionGeneration) {
                if (
                    !this.disposed &&
                    this.workspace === workspace &&
                    !this.client &&
                    this.generation === connectionGeneration + 1 &&
                    this.state.status === "disconnected"
                ) {
                    this.post({ type: "draft", text, mode: "restore" });
                }

                return;
            }

            this.requireWorkspace();
            client = this.client;
            if (this.clientWorkspace !== this.workspace.uri.fsPath) {
                throw new Error("Pi is connected to a different folder. Disconnect and reconnect before sending.");
            }

            const images = attached.filter((item) => item.kind === "image").map(normalizeImage);
            const message = formatPrompt(
                text,
                attached.filter((item) => item.kind !== "image"),
            );

            if (/^\/model\s*$/.test(text)) {
                if (!this.isForeground()) {
                    this.post({ type: "draft", text, mode: "restore" });

                    return;
                }

                const selected = await vscode.window.showQuickPick(
                    this.state.models.map((model) => ({
                        label: model.name || model.id,
                        description: model.provider,
                        model,
                    })),
                    { title: "SpecPi Chat · Choose model" },
                );
                if (selected && this.client === client && this.isForeground()) {
                    await this.setModel(selected.model.id, selected.model.provider, { allowSending: true });
                }

                return;
            }

            if (/^\/new\s*$/.test(text)) {
                this.sending = false;
                await this.newChat();

                return;
            }

            if (/^\/compact\s*$/.test(text)) {
                if (ACTIVE_STATUSES.has(this.state.status)) {
                    throw new Error("Wait for Pi to finish before compacting this chat.");
                }

                await client.request("compact", {}, { timeoutMs: 0 });
                await this.refresh(client, true);

                return;
            }

            const options = { message };
            if (images.length) {
                if (!this.state.model?.input?.includes("image")) {
                    throw new Error(
                        "Choose a model that supports images before sending. Your images and message are still attached.",
                    );
                }

                options.images = images.map(({ data, mimeType }) => ({ type: "image", data, mimeType }));
            }

            if (ACTIVE_STATUSES.has(this.state.status)) {
                options.streamingBehavior = mode === "steer" ? "steer" : "followUp";
                if (images.length) {
                    queuedId = randomUUID();
                    this.imageQueue.track({ id: queuedId, text, message, attachments: attached });
                }
            }

            if (
                this.state.title === "New chat" &&
                !text.trimStart().startsWith("/") &&
                !ACTIVE_STATUSES.has(this.state.status)
            ) {
                const name = (text.trim() || attached.find((item) => item.kind === "image")?.label || "Image chat")
                    .trim()
                    .split(/\r?\n/u)[0]
                    .replace(/[\u0000-\u001f\u007f]/gu, " ")
                    .slice(0, 80);
                await client.request("set_session_name", { name });
                if (this.client !== client) {
                    return;
                }
            }

            await client.request("prompt", options, { timeoutMs: 0 });
            accepted = true;
            if (this.validRequestId(requestId)) {
                this.post({ type: "sendResult", requestId, accepted: true });
            }

            if (this.client !== client) {
                return;
            }

            this.attachments = this.attachments.filter(
                (attachment) => !attached.some((item) => item.id === attachment.id),
            );
            this.state.error = undefined;
            await this.refresh(client);
        } catch (error) {
            if (connectionGeneration !== undefined && this.generation !== connectionGeneration) {
                return;
            }

            if (client && this.client !== client) {
                return;
            }

            if (accepted) {
                this.fail(
                    new Error(
                        "Pi accepted your message, but Chat could not refresh its status. " +
                            "Use Refresh status to check the conversation; do not resend the accepted message.",
                    ),
                );

                return;
            }

            if (this.workspace === workspace && (!client || this.client === client)) {
                this.post({ type: "draft", text, mode: "restore" });
            }

            throw error;
        } finally {
            if (!accepted && queuedId) {
                this.imageQueue.discard(queuedId);
            }

            this.sending = false;
            this.publish();
            if (!accepted && this.validRequestId(requestId)) {
                this.post({ type: "sendResult", requestId, accepted: false });
            }
        }
    }

    async newChat() {
        return this.coordinator.newChat(this);
    }

    async history() {
        return this.coordinator.history();
    }

    async chooseWorkspace() {
        return this.coordinator.chooseWorkspace();
    }

    async attachSelection() {
        const workspacePath = this.requireWorkspace();
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty || editor.document.uri.scheme !== "file") {
            throw new Error("Select text in a workspace file first, then choose Add Selection to SpecPi Chat.");
        }

        await this.addAttachment({
            workspacePath,
            filePath: editor.document.uri.fsPath,
            text: editor.document.getText(editor.selection),
            startLine: editor.selection.start.line + 1,
            endLine: editor.selection.end.line + 1,
        });
    }

    async attachFile(uri) {
        const workspace = this.workspace;
        const revision = this.sessionRevision;
        const workspacePath = this.requireWorkspace();
        const selected = uri
            ? [uri]
            : await vscode.window.showOpenDialog({
                  title: "Attach workspace file to SpecPi Chat",
                  defaultUri: this.workspace.uri,
                  canSelectFolders: false,
                  canSelectMany: true,
              });
        if (!selected?.length || !this.attachmentContextCurrent(workspace, revision)) {
            return;
        }

        const attachments = [];
        for (const file of selected) {
            if (!this.attachmentContextCurrent(workspace, revision)) {
                return;
            }

            if (file.scheme !== "file") {
                throw new Error("Choose ordinary local workspace files.");
            }

            attachments.push(await this.collectFile({ workspacePath, filePath: file.fsPath }, workspace, revision));
        }

        this.commitAttachments(attachments, workspace, revision);
    }

    async addAttachment(input) {
        const workspace = this.workspace;
        const revision = this.sessionRevision;
        const attachment = await collectAttachment(input);
        if (this.commitAttachments([attachment], workspace, revision) && this.isForeground()) {
            await vscode.commands.executeCommand(`${PREFIX}.open`);
        }
    }

    validRequestId(value) {
        return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/u.test(value);
    }

    contextToken() {
        return `${this.conversationKey}:${this.generation}-${this.sessionRevision}-${this.contextEpoch}`;
    }

    attachmentContextCurrent(workspace, revision) {
        if (this.disposed || this.workspace !== workspace || this.sessionRevision !== revision || this.transitioning) {
            return false;
        }

        this.requireWorkspace();

        return true;
    }

    commitAttachments(attachments, workspace, revision) {
        if (!this.attachmentContextCurrent(workspace, revision)) {
            return false;
        }

        const combined = [...this.attachments, ...attachments];
        if (combined.length > 8) {
            throw new Error("Attach up to eight files, selections, or images per message.");
        }

        const bytes = combined.reduce((total, item) => total + (item.kind === "image" ? item.byteLength : 0), 0);
        if (bytes > MAX_IMAGE_TOTAL_BYTES) {
            throw new Error("Attach no more than 20 MiB of images per message.");
        }

        this.attachments.push(...attachments);
        this.publish();

        return true;
    }

    async collectFile({ workspacePath, filePath }, workspace = this.workspace, revision = this.sessionRevision) {
        if (/\.(?:png|jpe?g|gif|webp)$/iu.test(filePath)) {
            const target = await resolveCodeReference({ workspacePath, reference: filePath });
            if (!this.attachmentContextCurrent(workspace, revision)) {
                throw new Error("The chat changed before the image could be attached. Choose it again in this chat.");
            }

            return collectImageAttachment({ filePath: target.path });
        }

        return collectAttachment({ workspacePath, filePath });
    }

    async attachImage(uri) {
        const workspace = this.workspace;
        const revision = this.sessionRevision;
        this.requireWorkspace();
        const selected = uri
            ? [uri]
            : await vscode.window.showOpenDialog({
                  title: "Attach images to SpecPi Chat",
                  defaultUri: workspace.uri,
                  canSelectFolders: false,
                  canSelectMany: true,
                  filters: { Images: ["png", "jpg", "jpeg", "gif", "webp"] },
              });
        if (!selected?.length || !this.attachmentContextCurrent(workspace, revision)) {
            return;
        }

        if (selected.length > 8) {
            throw new Error("Attach up to eight images per message.");
        }

        const attachments = [];
        for (const file of selected) {
            if (!this.attachmentContextCurrent(workspace, revision)) {
                return;
            }

            if (file.scheme !== "file") {
                throw new Error("Choose ordinary local image files.");
            }

            attachments.push(await collectImageAttachment({ filePath: file.fsPath }));
        }

        this.commitAttachments(attachments, workspace, revision);
    }

    addImageData(images) {
        const workspace = this.workspace;
        const revision = this.sessionRevision;
        this.requireWorkspace();
        if (!Array.isArray(images) || !images.length || images.length > 8) {
            throw new Error("Attach between one and eight images.");
        }

        const attachments = images.map((input, index) => {
            const image = normalizeImage(input);

            return {
                ...image,
                id: randomUUID(),
                kind: "image",
                label: image.name || `Image ${index + 1}`,
                detail: `${image.width} × ${image.height} · ${Math.ceil(image.byteLength / 1024)} KiB`,
            };
        });
        this.commitAttachments(attachments, workspace, revision);
    }

    async attachDroppedFiles(uris) {
        const workspace = this.workspace;
        const revision = this.sessionRevision;
        const workspacePath = this.requireWorkspace();
        if (!Array.isArray(uris) || !uris.length || uris.length > 8) {
            throw new Error("Drop between one and eight workspace files.");
        }

        const attachments = [];
        for (const value of uris) {
            if (!this.attachmentContextCurrent(workspace, revision)) {
                return;
            }

            if (typeof value !== "string" || value.length > 4096 || !/^file:\/\/\/(?!\/)/iu.test(value)) {
                throw new Error("Only local workspace file links can be attached by dropping them here.");
            }

            const target = await resolveCodeReference({ workspacePath, reference: value });
            if (!this.attachmentContextCurrent(workspace, revision)) {
                return;
            }

            attachments.push(await this.collectFile({ workspacePath, filePath: target.path }, workspace, revision));
        }

        this.commitAttachments(attachments, workspace, revision);
    }

    async previewImage(reference, requestId) {
        if (!this.validRequestId(requestId)) {
            return;
        }

        const workspace = this.workspace;
        const revision = this.sessionRevision;
        try {
            const workspacePath = this.requireWorkspace();
            const target = await resolveCodeReference({ workspacePath, reference });
            if (!this.attachmentContextCurrent(workspace, revision)) {
                return;
            }

            const image = await collectImageAttachment({ filePath: target.path });
            if (this.attachmentContextCurrent(workspace, revision)) {
                this.post({ type: "imagePreview", requestId, image: normalizeImage(image) });
            }
        } catch (error) {
            if (!this.disposed && this.workspace === workspace && this.sessionRevision === revision) {
                this.post({
                    type: "imagePreview",
                    requestId,
                    error: String(error?.message || "This image could not be previewed.").slice(0, 2000),
                });
            }
        }
    }

    handleUiRequest(request, client) {
        if (DIALOG_METHODS.has(request.method)) {
            if (
                typeof request.id !== "string" ||
                request.id.length > 200 ||
                this.dialogs.length >= 8 ||
                this.dialogs.some((item) => item.request.id === request.id)
            ) {
                client.send({ type: "extension_ui_response", id: request.id, cancelled: true });

                return;
            }

            if (
                request.method === "select" &&
                (!Array.isArray(request.options) ||
                    request.options.some((item) => typeof item !== "string") ||
                    request.options.length > 100)
            ) {
                client.send({ type: "extension_ui_response", id: request.id, cancelled: true });

                return;
            }

            const item = { request, client };
            const timeout =
                Number.isFinite(request.timeout) && request.timeout > 0 ? Math.min(request.timeout, 600_000) : 120_000;
            item.timer = setTimeout(() => this.finishDialog(item, { cancelled: true }), timeout);
            this.dialogs.push(item);
            this.showDialog();

            return;
        }

        if (request.method === "setWidget" && request.widgetKey === DELEGATE_WIDGET) {
            const previous = this.state.delegation;
            this.state.delegation = decodeDelegates(request.widgetLines) || undefined;
            for (const job of this.state.delegation?.jobs || []) {
                const id = `delegate-${job.batchId}-${job.id}-${job.attemptId}`;
                // Pi disposes full worker input at settlement. Retain only the
                // already displayed bounded label, within this connection.
                job.task ||=
                    previous?.jobs.find(
                        (item) =>
                            item.batchId === job.batchId && item.id === job.id && item.attemptId === job.attemptId,
                    )?.task ||
                    this.delegateSummaries.get(id)?.task ||
                    "";
                if (job.settling || ["queued", "running"].includes(job.state)) {
                    continue;
                }

                const summary = { text: delegateCompletionText(job), task: job.task, isError: job.state === "failed" };
                if (this.delegateSummaries.get(id)?.text !== summary.text) {
                    this.delegateSummaries.set(id, summary);
                    if (this.delegateSummaries.size > 32) {
                        this.delegateSummaries.delete(this.delegateSummaries.keys().next().value);
                    }

                    appendNotice(this.state, summary.text, summary.isError, id);
                }
            }

            this.publish();

            return;
        }

        if (request.method === "set_editor_text") {
            this.post({ type: "draft", text: String(request.text || "").slice(0, MAX_INPUT) });
        } else if (request.method === "notify") {
            appendNotice(this.state, String(request.message || "").slice(0, 4000), request.notifyType === "error");
        } else if (request.method === "setStatus" || request.method === "setWidget") {
            this.state.runtimeStatus = this.state.runtimeStatus || {};
            const key = String(request.statusKey || request.widgetKey || "Pi").slice(0, 80);
            // Reserve the two known usage keys so generic widgets cannot crowd
            // them out. The total remains bounded to 24 generic + 2 usage keys.
            const genericCount = Object.keys(this.state.runtimeStatus).filter(
                (name) => !USAGE_STATUS_KEYS.has(name),
            ).length;
            if (USAGE_STATUS_KEYS.has(key) || genericCount < 24 || Object.hasOwn(this.state.runtimeStatus, key)) {
                const value =
                    typeof request.statusText === "string"
                        ? request.statusText
                        : Array.isArray(request.widgetLines)
                          ? request.widgetLines
                                .filter((line) => typeof line === "string")
                                .slice(0, 100)
                                .join("\n")
                          : undefined;
                if (value) {
                    this.state.runtimeStatus[key] = String(value).slice(0, 4000);
                } else {
                    delete this.state.runtimeStatus[key];
                }
            }
        }

        this.publish();
    }

    showDialog() {
        const request = this.dialogs[0]?.request;
        this.state.uiRequest = request
            ? {
                  id: request.id,
                  method: request.method,
                  title: String(request.title || "Pi request").slice(0, 1000),
                  message: String(request.message || "").slice(0, 24_000),
                  options: request.options,
                  placeholder: String(request.placeholder || "").slice(0, 1000),
                  prefill: String(request.prefill || "").slice(0, MAX_INPUT),
              }
            : undefined;
        this.publish();
    }

    finishDialog(item, response) {
        const index = this.dialogs.indexOf(item);
        if (index < 0) {
            return;
        }

        clearTimeout(item.timer);
        this.dialogs.splice(index, 1);
        if (this.client === item.client) {
            item.client.send({ type: "extension_ui_response", id: item.request.id, ...response });
        }

        this.showDialog();
    }

    cancelDialogs() {
        for (const item of [...this.dialogs]) {
            this.finishDialog(item, { cancelled: true });
        }
    }

    respondToDialog(message) {
        const item = this.dialogs[0];
        if (!item || item.request.id !== message.id || item.client !== this.client) {
            return;
        }

        if (message.cancelled === true) {
            this.finishDialog(item, { cancelled: true });
        } else if (item.request.method === "confirm" && typeof message.confirmed === "boolean") {
            this.finishDialog(item, { confirmed: message.confirmed });
        } else if (
            ["select", "input", "editor"].includes(item.request.method) &&
            typeof message.value === "string" &&
            message.value.length <= MAX_INPUT
        ) {
            if (item.request.method !== "select" || item.request.options.includes(message.value)) {
                this.finishDialog(item, { value: message.value });
            }
        }
    }

    async stopDelegate(message) {
        this.requireWorkspace();
        const client = this.client;
        const token = this.contextToken();
        const job = this.state.delegation?.jobs.find(
            (candidate) =>
                candidate.batchId === message.batchId &&
                candidate.id === message.jobId &&
                candidate.attemptId === message.attemptId,
        );
        if (
            !client ||
            !this.isForeground() ||
            this.transitioning ||
            token !== message.contextToken ||
            !["ready", "busy", "retrying", "compacting"].includes(this.state.status) ||
            !this.state.commands.some((command) => command.name === "delegate") ||
            !job ||
            !["queued", "running"].includes(job.state)
        ) {
            throw new Error("That delegate attempt is no longer available in the selected conversation.");
        }

        const key = `${job.batchId}/${job.id}/${job.attemptId}`;
        if (this.pendingDelegateStops.has(key)) {
            return;
        }

        this.pendingDelegateStops.add(key);
        this.publish();
        try {
            // An extension command executes immediately, even while the parent
            // streams. Do not send/clear the user's draft, images or queued work.
            await client.request("prompt", {
                message: `/delegate cancel-worker ${job.batchId} ${job.id} ${job.attemptId}`,
            });
        } catch (error) {
            if (this.client === client && this.contextToken() === token) {
                this.fail(error);
            }
        } finally {
            this.pendingDelegateStops.delete(key);
            if (this.client === client && this.contextToken() === token) {
                this.publish();
            }
        }
    }

    async openCode(reference) {
        const workspace = this.workspace;
        const workspacePath = this.requireWorkspace();
        const current = () =>
            !this.disposed &&
            this.isForeground() &&
            this.workspace === workspace &&
            this.requireWorkspace() === workspacePath;
        const target = await resolveCodeReference({ workspacePath, reference });
        if (!current()) {
            return;
        }

        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target.path));
        if (!current()) {
            return;
        }

        const start = document.validatePosition(new vscode.Position(target.line - 1, target.column - 1));
        const end =
            target.endLine === undefined
                ? start
                : document.validatePosition(new vscode.Position(target.endLine - 1, Number.MAX_SAFE_INTEGER));
        const selection = new vscode.Range(start, end);
        const editor = await vscode.window.showTextDocument(document, { preview: true, selection });
        editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    async setModel(modelId, provider, { allowSending = false } = {}) {
        this.requireWorkspace();
        if (
            this.state.status !== "ready" ||
            this.transitioning ||
            (this.sending && !allowSending) ||
            !this.state.models.some((model) => model.id === modelId && model.provider === provider)
        ) {
            throw new Error("Choose an available model while Pi is idle.");
        }

        const client = this.client;
        await client.request("set_model", { modelId, provider });
        await this.refresh(client);
    }

    async handleMessage(message) {
        if (!message || typeof message !== "object" || typeof message.type !== "string" || this.disposed) {
            return;
        }

        switch (message.type) {
            case "ready":
                this.sentMediaIds.clear();
                this.publish();
                break;
            case "connect":
                await this.connect();
                break;
            case "disconnect":
                await this.disconnect();
                break;
            case "refresh": {
                this.requireWorkspace();
                const client = this.client;
                const generation = this.generation;
                const sessionRevision = this.sessionRevision;
                const eventRevision = this.eventRevision;
                const previousError = this.state.error;
                if (!client || this.state.status === "connecting" || this.transitioning) {
                    return;
                }

                try {
                    await this.refresh(client, true);
                } catch (error) {
                    if (
                        this.client === client &&
                        this.generation === generation &&
                        this.sessionRevision === sessionRevision
                    ) {
                        throw error;
                    }

                    return;
                }

                if (
                    this.client === client &&
                    this.generation === generation &&
                    this.sessionRevision === sessionRevision &&
                    this.eventRevision === eventRevision &&
                    this.state.error === previousError
                ) {
                    this.state.error = undefined;
                    this.publish();
                }

                break;
            }

            case "send":
                try {
                    await this.send(message.text, message.mode, message.requestId);
                } catch (error) {
                    if (this.validRequestId(message.requestId)) {
                        this.post({ type: "sendResult", requestId: message.requestId, accepted: false });
                    }

                    throw error;
                }

                break;
            case "stopDelegate":
                await this.stopDelegate(message);
                break;
            case "stop":
                await this.stop();
                break;
            case "newChat":
                await this.newChat();
                break;
            case "history":
                await this.history();
                break;
            case "chooseWorkspace":
                await this.chooseWorkspace();
                break;
            case "attachSelection":
                await this.attachSelection();
                break;
            case "attachFile":
            case "attachImage":
            case "attachImageData":
            case "attachDroppedFiles": {
                let error;
                try {
                    if (
                        ["attachImageData", "attachDroppedFiles"].includes(message.type) &&
                        message.contextToken !== this.contextToken()
                    ) {
                        throw new Error(
                            "The chat changed while the files were being read. Add them again in the intended chat.",
                        );
                    }

                    if (message.type === "attachFile") {
                        await this.attachFile();
                    } else if (message.type === "attachImage") {
                        await this.attachImage();
                    } else if (message.type === "attachImageData") {
                        this.addImageData(message.images);
                    } else {
                        await this.attachDroppedFiles(message.uris);
                    }
                } catch (failure) {
                    error = String(failure?.message || "The attachments could not be added.").slice(0, 2000);
                    this.fail(failure);
                }

                if (this.validRequestId(message.requestId)) {
                    this.post({ type: "attachmentResult", requestId: message.requestId, ...(error ? { error } : {}) });
                }

                break;
            }

            case "previewImage":
                if (message.contextToken !== this.contextToken()) {
                    if (this.validRequestId(message.requestId)) {
                        this.post({
                            type: "imagePreview",
                            requestId: message.requestId,
                            error: "The chat changed. Open the image from the current conversation.",
                        });
                    }

                    break;
                }

                await this.previewImage(message.reference, message.requestId);
                break;
            case "settings":
                await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:tannermidd.specpi-chat");
                break;
            case "reviewChanges":
                await reviewChanges(this, vscode);
                break;
            case "editPrompt":
                await editPrompt(this, vscode);
                break;
            case "forkChat":
                await forkChat(this, vscode);
                break;
            case "exportChat":
                await exportChat(this, vscode);
                break;
            case "copyConversation":
                this.requireWorkspace();
                await vscode.env.clipboard.writeText(markdownTranscript(this.state));
                this.post({ type: "conversationCopied" });
                break;
            case "showUsage":
                await showUsage(this, vscode);
                break;
            case "findFiles":
                if (this.validRequestId(message.requestId)) {
                    await findFiles(this, vscode, message.query, message.requestId);
                }

                break;
            case "attachMention": {
                if (!this.validRequestId(message.requestId)) {
                    break;
                }

                if (message.contextToken !== this.contextToken()) {
                    this.post({
                        type: "attachmentResult",
                        requestId: message.requestId,
                        success: false,
                        error: "The chat changed. Choose the file again in the intended conversation.",
                    });

                    break;
                }

                const workspace = this.workspace;
                const revision = this.sessionRevision;
                let success = false;
                let error;
                try {
                    const workspacePath = this.requireWorkspace();
                    const target = await resolveCodeReference({ workspacePath, reference: message.path });
                    if (this.attachmentContextCurrent(workspace, revision)) {
                        const attachment = await this.collectFile(
                            { workspacePath, filePath: target.path },
                            workspace,
                            revision,
                        );
                        success = this.commitAttachments([attachment], workspace, revision);
                    }
                } catch (failure) {
                    error = String(failure?.message || "The selected context could not be attached.").slice(0, 2000);
                }

                this.post({
                    type: "attachmentResult",
                    requestId: message.requestId,
                    success,
                    ...(error ? { error } : {}),
                });
                break;
            }

            case "removeAttachment":
                this.attachments = this.attachments.filter((item) => item.id !== message.id);
                this.publish();
                break;
            case "restoreQueuedDraft": {
                const draft = this.imageQueue.recovered.find((item) => item.id === message.id);
                if (draft && this.commitAttachments(draft.attachments, this.workspace, this.sessionRevision)) {
                    this.imageQueue.discard(draft.id);
                    this.post({ type: "draft", text: draft.text, mode: "restore" });
                    this.publish();
                }

                break;
            }

            case "dismissQueuedDraft":
                if (this.imageQueue.recovered.some((item) => item.id === message.id)) {
                    this.imageQueue.discard(message.id);
                    this.publish();
                }

                break;
            case "clearError":
                this.state.error = undefined;
                this.publish();
                break;
            case "uiResponse":
                this.respondToDialog(message);
                break;
            case "copy":
                if (typeof message.text === "string" && message.text.length <= 128 * 1024) {
                    await vscode.env.clipboard.writeText(message.text);
                    if (typeof message.requestId === "string" && message.requestId.length <= 100) {
                        this.post({ type: "copied", requestId: message.requestId });
                    }
                }

                break;
            case "openLink": {
                if (typeof message.url !== "string" || message.url.length > 4096) {
                    return;
                }

                const url = new URL(message.url);
                if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) {
                    await vscode.env.openExternal(vscode.Uri.parse(url.href));
                }

                break;
            }

            case "openCode":
                await this.openCode(message.reference);
                break;

            case "command":
                if (this.state.commands.some((command) => command.name === message.name)) {
                    this.post({ type: "draft", text: `/${message.name} ` });
                }

                break;
            case "setModel":
                await this.setModel(message.modelId, message.provider);
                break;
            case "setThinking":
                this.requireWorkspace();
                if (
                    this.state.status !== "ready" ||
                    this.transitioning ||
                    this.sending ||
                    !this.state.thinkingLevels.includes(message.level)
                ) {
                    throw new Error("Choose a supported thinking level while Pi is idle.");
                }

                await this.client.request("set_thinking_level", { level: message.level });
                await this.refresh();
                break;
        }
    }

    dispose() {
        if (this.disposed) {
            return;
        }

        this.disposed = true;
        clearTimeout(this.publishTimer);
        void this.disconnect();
    }
}

function activate(context) {
    const controller = new ConversationCoordinator(context, { vscode, ChatController });
    context.subscriptions.push(controller);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider("specpi.chat", controller, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );
    const commands = {
        open: async () => {
            await vscode.commands.executeCommand("workbench.view.extension.specpi-chat");
            controller.view?.show(true);
            controller.post({ type: "focus" });
        },
        connect: () => controller.connect(),
        disconnect: () => controller.disconnect(),
        restart: () => controller.restart(),
        new: () => controller.newChat(),
        history: () => controller.history(),
        stop: () => controller.stop(),
        attachSelection: () => controller.attachSelection(),
        attachFile: (uri) => controller.attachFile(uri),
        attachImage: (uri) => controller.attachImage(uri),
        editPrompt: () => controller.handleMessage({ type: "editPrompt" }),
        forkChat: () => controller.handleMessage({ type: "forkChat" }),
        exportChat: () => controller.handleMessage({ type: "exportChat" }),
        showUsage: () => controller.handleMessage({ type: "showUsage" }),
        chooseWorkspace: () => controller.chooseWorkspace(),
        settings: () => controller.handleMessage({ type: "settings" }),
    };
    for (const [name, callback] of Object.entries(commands)) {
        context.subscriptions.push(
            vscode.commands.registerCommand(`${PREFIX}.${name}`, async (...args) => {
                const selected = controller.active;
                try {
                    return await callback(...args);
                } catch (error) {
                    selected.fail(error);
                    if (selected.isForeground()) {
                        void vscode.window.showErrorMessage(selected.state.error);
                    }
                }
            }),
        );
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => controller.workspaceFoldersChanged()),
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(PREFIX)) {
                // Running conversations keep their launch configuration until explicitly reconnected.
                controller.publish();
            }
        }),
    );

    return { controller };
}

module.exports = { activate, ChatController, ConversationCoordinator };
