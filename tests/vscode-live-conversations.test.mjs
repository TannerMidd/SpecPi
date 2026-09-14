import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileFunction } from "node:vm";

const extensionFile = fileURLToPath(new URL("../vscode/src/extension.js", import.meta.url));
const extensionRequire = createRequire(extensionFile);

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });

    return { promise, resolve, reject };
}

function uri(filePath) {
    return { scheme: "file", fsPath: filePath, toString: () => pathToFileURL(filePath).href };
}

function fixture(t, options = {}) {
    const clients = [];
    const posted = [];
    const nativeDialogs = [];
    const folders = ["first", "second"].map((name) => ({
        name,
        uri: uri(path.resolve(".specpi-test", `live-${name}`)),
    }));
    const stores = new Map();
    const vscode = {
        StatusBarAlignment: { Right: 2 },
        workspace: {
            isTrusted: true,
            workspaceFolders: folders,
            getConfiguration: () => ({ get: (_key, fallback) => fallback }),
        },
        window: {
            createStatusBarItem: () => ({ show() {}, dispose() {} }),
            showWorkspaceFolderPick: async () => options.pickWorkspace?.() || folders[1],
            showQuickPick: async (items) => {
                nativeDialogs.push(items);

                return options.quickPick?.(items);
            },
            showWarningMessage: async (...args) => {
                nativeDialogs.push(args);
            },
        },
        commands: { executeCommand: async () => {} },
    };

    class FakeCatalog {
        constructor(input) {
            this.sessionDirectory = path.join(input.directory, "sessions");
            this.store = stores.get(input.workspacePath) || new Map();
            stores.set(input.workspacePath, this.store);
        }

        async list() {
            return options.list ? options.list(this) : [...this.store.values()];
        }

        async resolve(id) {
            return this.store.get(id);
        }

        async remember(runtime) {
            if (!runtime.sessionFile) {
                return undefined;
            }

            const old = this.store.get(runtime.sessionId);
            const entry = { ...runtime, updatedAt: Date.now(), archived: old?.archived === true };
            this.store.set(runtime.sessionId, entry);
            await options.remembered?.(runtime, this);

            return entry;
        }

        async rename(id, sessionName) {
            const entry = this.store.get(id);
            if (entry) {
                entry.sessionName = sessionName;
            }

            return entry;
        }

        async setArchived(id, archived) {
            const entry = this.store.get(id);
            if (entry) {
                entry.archived = archived;
            }

            return entry;
        }
    }

    class FakeClient extends EventEmitter {
        constructor(launch) {
            super();
            this.launch = launch;
            this.requests = [];
            this.sent = [];
            this.stops = 0;
            this.runtime = {
                isStreaming: false,
                pendingMessageCount: 0,
                sessionId: `session-${clients.length + 1}`,
                sessionName: "New chat",
            };
            this.runtime.sessionFile = path.join(launch.cwd, `${this.runtime.sessionId}.jsonl`);
            const sessionIndex = launch.args.indexOf("--session");
            if (sessionIndex !== -1) {
                this.runtime = {
                    ...this.runtime,
                    ...[...stores.get(launch.cwd).values()].find(
                        (entry) => entry.sessionFile === launch.args[sessionIndex + 1],
                    ),
                };
            }

            clients.push(this);
        }

        async start() {}

        async waitUntilReady() {
            await options.ready?.(this);
        }

        async request(type, args, requestOptions) {
            this.requests.push({ type, args, options: requestOptions });
            const result = options.request?.(type, args, this);
            if (result !== undefined) {
                return result;
            }

            if (type === "get_state") {
                return { ...this.runtime };
            }

            if (type === "set_session_name") {
                this.runtime.sessionName = args.name;
            }

            if (type === "clone" || type === "fork") {
                this.runtime.sessionId += "-branch";
                this.runtime.sessionFile = path.join(this.launch.cwd, `${this.runtime.sessionId}.jsonl`);
                this.runtime.sessionName = "New branch";
            }

            return (
                {
                    get_available_models: { models: [] },
                    get_commands: { commands: [] },
                    get_available_thinking_levels: { levels: ["medium"] },
                    get_session_stats: { cost: 0.12 },
                    get_messages: { messages: [] },
                    clear_queue: { steering: [], followUp: [] },
                }[type] || {}
            );
        }

        send(message) {
            this.sent.push(message);
        }

        async stop() {
            this.stops += 1;
        }
    }

    const dependencies = {
        vscode,
        "./rpc-client.js": { RpcClient: FakeClient },
        "./session-catalog.js": { SessionCatalog: FakeCatalog },
        "./launch.js": { resolveLaunch: async () => ({ command: "synthetic-pi", args: [] }) },
    };
    const load = (file) => {
        const module = { exports: {} };
        compileFunction(fs.readFileSync(file, "utf8"), ["require", "module", "exports"], { filename: file })(
            (name) => dependencies[name] || extensionRequire(name),
            module,
            module.exports,
        );

        return module.exports;
    };

    dependencies["./conversation-coordinator.js"] = load(
        path.join(path.dirname(extensionFile), "conversation-coordinator.js"),
    );
    const { ChatController, ConversationCoordinator } = load(extensionFile);
    const coordinator = new ConversationCoordinator(
        {
            extensionUri: uri(path.dirname(path.dirname(extensionFile))),
            storageUri: uri(path.resolve(".specpi-test", "live-storage")),
            subscriptions: [],
        },
        { vscode, ChatController },
    );
    coordinator.view = {
        webview: {
            postMessage(message) {
                posted.push(structuredClone(message));

                return Promise.resolve(true);
            },
        },
    };
    coordinator.publish();
    t.after(async () => {
        await coordinator.disconnectAll();
        coordinator.dispose();
    });

    return { coordinator, clients, folders, posted, nativeDialogs, stores, vscode };
}

test("history and new chat do not launch Pi; switching preserves live runtime, attachments, queue and approvals", async (t) => {
    const { coordinator, clients, posted, nativeDialogs } = fixture(t);
    const first = coordinator.active;
    const firstId = coordinator.state.conversationKey;
    await coordinator.history();
    assert.equal(clients.length, 0);
    assert.ok(posted.some((message) => message.type === "showHistory"));
    await coordinator.connect();
    const client = first.client;
    first.attachments = [{ id: "context", label: "file.js", detail: "1 line" }];
    const image = extensionRequire("./images.js").normalizeImage({
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        mimeType: "image/png",
    });
    first.imageQueue.track({
        id: "queued",
        text: "queued",
        message: "queued",
        attachments: [{ ...image, kind: "image", id: "image", label: "pixel.png" }],
    });
    client.emit("event", { type: "agent_start" });
    first.publish();
    await coordinator.newChat();
    assert.equal(clients.length, 1);
    assert.notEqual(coordinator.state.conversationKey, firstId);
    assert.equal(client.stops, 0);
    await coordinator.connect();
    assert.equal(clients.length, 2);
    const second = coordinator.active;
    client.emit("event", { type: "extension_ui_request", id: "approval", method: "confirm", title: "Continue?" });
    assert.equal(coordinator.state.uiRequest, undefined);
    assert.equal(coordinator.state.conversations.find((record) => record.id === firstId).status, "needs-input");
    assert.equal(coordinator.state.conversations.find((record) => record.id === firstId).unread, true);
    assert.deepEqual(client.sent, []);
    await coordinator.selectConversation(firstId);
    assert.equal(coordinator.client, client);
    assert.equal(coordinator.state.status, "busy");
    assert.equal(first.attachments[0].id, "context");
    assert.equal(first.imageQueue.pending.length, 1);
    assert.equal(coordinator.state.uiRequest.id, "approval");
    assert.equal(clients.length, 2);
    assert.equal(second.client.stops, 0);
    await coordinator.handleMessage({ type: "uiResponse", conversationKey: firstId, id: "approval", confirmed: true });
    assert.deepEqual(client.sent, [{ type: "extension_ui_response", id: "approval", confirmed: true }]);
    assert.equal(nativeDialogs.length, 0);
});

test("restart resumes only the selected conversation and preserves its draft and attachments", async (t) => {
    const { coordinator, clients } = fixture(t);
    await coordinator.connect();
    const background = coordinator.client;
    background.emit("event", { type: "agent_start" });
    await coordinator.newChat();
    await coordinator.connect();
    const selected = coordinator.active;
    const previous = selected.client;
    const sessionId = selected.activeSessionId;
    const record = coordinator.records.get(coordinator.activeId);
    record.draft.text = "Unsent draft";
    selected.attachments = [{ id: "context", label: "file.js", detail: "1 line" }];
    await coordinator.restart();
    assert.equal(clients.length, 3);
    assert.equal(previous.stops, 1);
    assert.equal(background.stops, 0);
    assert.equal(coordinator.active, selected);
    assert.equal(selected.activeSessionId, sessionId);
    assert.ok(selected.client.launch.args.includes("--session"));
    assert.equal(record.draft.text, "Unsent draft");
    assert.equal(selected.attachments[0].id, "context");
});

test("live usage reports stay with their conversation across switching and selected-only disconnect", async (t) => {
    const { coordinator } = fixture(t);
    await coordinator.connect();
    const first = coordinator.active;
    const firstId = coordinator.activeId;
    first.client.emit("event", {
        type: "extension_ui_request",
        method: "setStatus",
        statusKey: "aa-codex-usage",
        statusText: "codex 75%",
    });
    await coordinator.newChat();
    await coordinator.connect();
    const second = coordinator.active;
    const secondId = coordinator.activeId;
    second.client.emit("event", {
        type: "extension_ui_request",
        method: "setStatus",
        statusKey: "provider-usage",
        statusText: "claude 25% 5h",
    });
    first.client.emit("event", {
        type: "extension_ui_request",
        method: "setStatus",
        statusKey: "aa-codex-usage",
        statusText: "codex 70%",
    });
    assert.deepEqual(coordinator.state.runtimeStatus, { "provider-usage": "claude 25% 5h" });
    await coordinator.selectConversation(firstId);
    assert.deepEqual(coordinator.state.runtimeStatus, { "aa-codex-usage": "codex 70%" });
    await coordinator.disconnect();
    assert.deepEqual(coordinator.state.runtimeStatus, {});
    await coordinator.selectConversation(secondId);
    assert.deepEqual(coordinator.state.runtimeStatus, { "provider-usage": "claude 25% 5h" });
});

test("drafts, selection, send mode and delayed failures belong to their original conversation", async (t) => {
    const pending = deferred();
    const { coordinator, posted } = fixture(t, {
        request: (type) => (type === "prompt" ? pending.promise : undefined),
    });
    await coordinator.connect();
    const first = coordinator.active;
    const firstId = coordinator.activeId;
    const send = coordinator.handleMessage({
        type: "send",
        text: "original work",
        requestId: "send-first",
        conversationKey: firstId,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await coordinator.newChat();
    const secondId = coordinator.activeId;
    await coordinator.handleMessage({
        type: "saveDraft",
        conversationKey: secondId,
        text: "second draft",
        selectionStart: 2,
        selectionEnd: 5,
        sendMode: "steer",
    });
    await coordinator.handleMessage({
        type: "saveDraft",
        conversationKey: firstId,
        text: "later first draft",
        selectionStart: 1,
        selectionEnd: 1,
        sendMode: "followUp",
    });
    pending.reject(new Error("Synthetic rejection"));
    await send;
    assert.equal(coordinator.state.draft.text, "second draft");
    assert.equal(coordinator.state.error, undefined);
    assert.equal(first.state.error, "Synthetic rejection");
    assert.ok(
        posted.some(
            (message) =>
                message.type === "draft" && message.conversationKey === firstId && message.text === "original work",
        ),
    );
    assert.ok(
        posted.some(
            (message) =>
                message.type === "sendResult" && message.conversationKey === firstId && message.accepted === false,
        ),
    );
    await coordinator.selectConversation(firstId);
    assert.equal(coordinator.state.draft.text, "original work\n\nlater first draft");
    await coordinator.selectConversation(secondId);
    assert.deepEqual(coordinator.state.draft, {
        text: "second draft",
        selectionStart: 2,
        selectionEnd: 5,
        sendMode: "steer",
        selectionEnabled: true,
    });
});

test("late or unknown conversation actions cannot stop, send or approve the selected runtime", async (t) => {
    const { coordinator, clients } = fixture(t);
    await coordinator.connect();
    const firstId = coordinator.activeId;
    await coordinator.newChat();
    await coordinator.connect();
    const selected = coordinator.active;
    selected.handleUiRequest({ id: "same-id", method: "confirm", title: "Proceed?" }, selected.client);
    for (const conversationKey of [firstId, "unknown"]) {
        await coordinator.handleMessage({ type: "disconnect", conversationKey });
        await coordinator.handleMessage({ type: "send", conversationKey, text: "wrong conversation" });
        await coordinator.handleMessage({ type: "uiResponse", conversationKey, id: "same-id", confirmed: true });
    }

    assert.equal(clients[0].stops, 0);
    assert.equal(clients[1].stops, 0);
    assert.deepEqual(clients[1].sent, []);
    assert.ok(!clients[1].requests.some((request) => request.type === "prompt"));
});

test("connecting in the background finishes on the same stable conversation key", async (t) => {
    const ready = deferred();
    const { coordinator, clients } = fixture(t, {
        ready: (client) => (clients[0] === client ? ready.promise : undefined),
    });
    const first = coordinator.active;
    const firstId = coordinator.activeId;
    const connecting = coordinator.connect();
    await new Promise((resolve) => setImmediate(resolve));
    await coordinator.newChat();
    const second = coordinator.active;
    ready.resolve();
    await connecting;
    assert.equal(coordinator.active, second);
    assert.equal(first.state.status, "ready");
    assert.equal(first.conversationKey, firstId);
    assert.equal(clients.length, 1);
    await coordinator.selectConversation(firstId);
    assert.equal(coordinator.active, first);
    assert.equal(clients.length, 1);
});

test("workspace switching preserves both clients and returns to the last conversation", async (t) => {
    let chosen;
    const { coordinator, clients, folders } = fixture(t, { pickWorkspace: () => chosen });
    await coordinator.connect();
    const first = coordinator.active;
    const firstId = coordinator.activeId;
    chosen = folders[1];
    await coordinator.chooseWorkspace();
    assert.equal(coordinator.workspace, folders[1]);
    await coordinator.connect();
    const second = coordinator.active;
    chosen = folders[0];
    await coordinator.chooseWorkspace();
    assert.equal(coordinator.active, first);
    assert.equal(coordinator.activeId, firstId);
    assert.equal(second.client.stops, 0);
    assert.equal(first.client.stops, 0);
    await coordinator.disconnect();
    assert.equal(first.client, null);
    assert.equal(clients[0].stops, 1);
    assert.equal(clients[1].stops, 0);
});

test("saved history loads metadata without a process and resumes one independent runtime", async (t) => {
    const { coordinator, clients, folders } = fixture(t);
    const catalog = coordinator.catalogFor(folders[0]);
    await catalog.remember({
        sessionId: "saved-session",
        sessionName: "Saved history",
        sessionFile: path.join(folders[0].uri.fsPath, "saved.jsonl"),
    });
    await coordinator.history();
    assert.equal(clients.length, 0);
    const saved = coordinator.state.conversations.find((record) => record.title === "Saved history");
    assert.equal(saved.status, "saved");
    assert.ok(!JSON.stringify(coordinator.state.conversations).includes("sessionFile"));
    assert.ok(!JSON.stringify(coordinator.state.conversations).includes(folders[0].uri.fsPath));
    await coordinator.selectConversation(saved.id);
    assert.equal(clients.length, 1);
    assert.equal(coordinator.activeId, saved.id);
    assert.equal(coordinator.activeSessionId, "saved-session");
    assert.ok(clients[0].launch.args.includes("--session"));
    await coordinator.history();
    assert.equal(coordinator.state.conversations.filter((record) => record.title === "Saved history").length, 1);
});

test("rename and archive update metadata without stopping or switching a background run", async (t) => {
    const { coordinator, clients } = fixture(t);
    await coordinator.connect();
    const first = coordinator.active;
    const firstId = coordinator.activeId;
    clients[0].emit("event", { type: "agent_start" });
    await coordinator.newChat();
    const second = coordinator.active;
    await coordinator.renameConversation(firstId, "Renamed background");
    await coordinator.archiveConversation(firstId, true);
    assert.equal(coordinator.active, second);
    assert.equal(clients[0].stops, 0);
    assert.equal(first.state.status, "busy");
    const row = coordinator.state.conversations.find((record) => record.id === firstId);
    assert.equal(row.title, "Renamed background");
    assert.equal(row.archived, true);
    await assert.rejects(coordinator.selectConversation(firstId), /Restore archived/);
    await coordinator.archiveConversation(firstId, false);
    await coordinator.selectConversation(firstId);
    assert.equal(coordinator.active, first);
    assert.equal(first.state.status, "busy");
});

test("fork starts from an isolated CLI copy and preserves source process, draft and session", async (t) => {
    const { coordinator, clients } = fixture(t);
    await coordinator.connect();
    const source = coordinator.active;
    const sourceId = coordinator.activeId;
    const sessionId = source.activeSessionId;
    await coordinator.handleMessage({
        type: "saveDraft",
        conversationKey: sourceId,
        text: "source draft",
        sendMode: "prompt",
    });
    assert.equal(
        await coordinator.branchConversation(
            source,
            "fork",
            { entryId: "entry-1" },
            { text: "edited prompt", images: [] },
        ),
        true,
    );
    assert.equal(clients.length, 2);
    assert.ok(clients[1].launch.args.includes("--fork"));
    assert.ok(!clients[1].launch.args.includes("--session"));
    assert.ok(clients[1].requests.some((request) => request.type === "fork" && request.args.entryId === "entry-1"));
    assert.ok(!clients[0].requests.some((request) => request.type === "fork" || request.type === "clone"));
    assert.equal(clients[0].stops, 0);
    assert.equal(source.activeSessionId, sessionId);
    assert.equal(source.transitioning, false);
    assert.equal(coordinator.state.draft.text, "edited prompt");
    assert.ok(!clients.some((client) => client.requests.some((request) => request.type === "prompt")));
    await coordinator.selectConversation(sourceId);
    assert.equal(coordinator.client, clients[0]);
    assert.equal(coordinator.state.draft.text, "source draft");
});

test("editing through the real coordinator restores exact text and images only in the new branch", async (t) => {
    const image = {
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    };
    const text = "  Exact original prompt\n";
    const { coordinator, clients } = fixture(t, {
        quickPick: (items) => items[0],
        request(type) {
            if (type === "get_entries") {
                return {
                    leafId: "prompt-1",
                    entries: [
                        {
                            type: "message",
                            id: "prompt-1",
                            parentId: null,
                            message: { role: "user", content: [{ type: "text", text }, image] },
                        },
                    ],
                };
            }
        },
    });
    await coordinator.connect();
    const source = coordinator.active;
    const sourceFile = clients[0].runtime.sessionFile;
    source.attachments = [{ id: "unsent-source", kind: "file", label: "source.js" }];
    await coordinator.handleMessage({ type: "saveDraft", text: "unsent source draft" });
    await coordinator.handleMessage({ type: "editPrompt", conversationKey: source.conversationKey });
    const target = coordinator.active;
    assert.notEqual(target, source);
    assert.equal(clients[1].launch.args[clients[1].launch.args.indexOf("--fork") + 1], sourceFile);
    assert.deepEqual(
        clients[1].requests.find(({ type }) => type === "fork"),
        { type: "fork", args: { entryId: "prompt-1" }, options: { timeoutMs: 0 } },
    );
    assert.equal(coordinator.state.draft.text, text);
    assert.equal(target.attachments[0].kind, "image");
    assert.equal(target.attachments[0].data, image.data);
    assert.equal(target.attachments[0].width, 1);
    assert.ok(target.attachments[0].id);
    assert.equal(source.attachments[0].id, "unsent-source");
    assert.ok(!clients[0].requests.some(({ type }) => type === "fork"));
    assert.ok(!clients.some((client) => client.requests.some(({ type }) => type === "prompt")));
    await coordinator.selectConversation(source.conversationKey);
    assert.equal(coordinator.state.draft.text, "unsent source draft");
});

test("cancelled and rejected branches leave the source runtime and draft unchanged", async (t) => {
    for (const outcome of ["cancel", "reject"]) {
        const { coordinator, clients } = fixture(t, {
            request(type) {
                if (type === "fork") {
                    if (outcome === "reject") {
                        throw new Error("Synthetic branch rejection");
                    }

                    return { cancelled: true };
                }
            },
        });
        await coordinator.connect();
        const source = coordinator.active;
        const sessionId = source.activeSessionId;
        source.attachments = [{ id: "source-file", kind: "file", label: "source.js" }];
        await coordinator.handleMessage({ type: "saveDraft", text: "source draft" });
        assert.equal(
            await coordinator.branchConversation(
                source,
                "fork",
                { entryId: "entry-1" },
                { text: "edited", images: [] },
            ),
            false,
        );
        assert.equal(clients[1].stops, 1);
        assert.match(
            coordinator.active.state.error,
            outcome === "reject" ? /Synthetic branch rejection/ : /branch could not be created/,
        );
        assert.equal(source.state.error, undefined);
        assert.equal(clients[0].stops, 0);
        assert.equal(source.activeSessionId, sessionId);
        assert.equal(source.attachments[0].id, "source-file");
        assert.equal(source.transitioning, false);
        assert.ok(!clients[0].requests.some(({ type }) => type === "fork" || type === "clone"));
        await coordinator.selectConversation(source.conversationKey);
        assert.equal(coordinator.state.draft.text, "source draft");
    }
});

test("accepted branch refresh failure preserves its draft and cannot contaminate a reconnected target", async (t) => {
    for (const replace of [false, true]) {
        const pending = deferred();
        const started = deferred();
        let branched = false;
        const { coordinator, clients } = fixture(t, {
            request(type, args, client) {
                if (type === "fork") {
                    branched = true;
                }

                if (type === "get_state" && branched && client === clients[1]) {
                    started.resolve();

                    return pending.promise;
                }
            },
        });
        await coordinator.connect();
        const source = coordinator.active;
        const result = coordinator.branchConversation(
            source,
            "fork",
            { entryId: "entry-1" },
            { text: "exact edited draft", images: [] },
        );
        await started.promise;
        const target = coordinator.active;
        assert.equal(coordinator.state.draft.text, "exact edited draft");
        if (replace) {
            await target.disconnect();
            await target.connect();
        }

        pending.reject(new Error("Synthetic post-acceptance refresh failure"));
        assert.equal(await result, false);
        assert.equal(coordinator.state.draft.text, "exact edited draft");
        if (replace) {
            assert.equal(target.client, clients[2]);
            assert.equal(target.state.error, undefined);
        } else {
            assert.match(target.state.error, /branch was created.*draft restored.*do not repeat/);
            assert.equal(target.client, clients[1]);
            assert.equal(clients[1].stops, 0);
        }

        assert.equal(clients.flatMap((client) => client.requests).filter(({ type }) => type === "fork").length, 1);
        assert.ok(!clients.some((client) => client.requests.some(({ type }) => type === "prompt")));
        assert.equal(source.client, clients[0]);
        assert.equal(source.transitioning, false);
    }
});

test("dispose stops every live runtime, including archived and other-workspace conversations", async (t) => {
    const { coordinator, clients } = fixture(t);
    await coordinator.connect();
    await coordinator.archiveConversation(coordinator.activeId, true);
    await coordinator.newChat();
    await coordinator.connect();
    await coordinator.chooseWorkspace();
    await coordinator.connect();
    coordinator.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
        clients.map((client) => client.stops),
        [1, 1, 1],
    );
});

test("history cannot create a second runtime owner during in-flight session persistence", async (t) => {
    const stored = deferred();
    const release = deferred();
    const { coordinator, clients } = fixture(t, {
        remembered: async () => {
            stored.resolve();
            await release.promise;
        },
    });
    const firstId = coordinator.activeId;
    const connecting = coordinator.connect();
    await stored.promise;
    await coordinator.loadHistory();
    assert.equal(coordinator.state.conversations.length, 1);
    release.resolve();
    await connecting;
    assert.equal(coordinator.state.conversationKey, firstId);
    await coordinator.selectConversation(firstId);
    assert.equal(clients.length, 1);
});

test("publishing cannot roll back a newly observed runtime identity during catalog persistence", async (t) => {
    const stored = deferred();
    const release = deferred();
    let pause = false;
    const { coordinator, clients } = fixture(t, {
        remembered: async () => {
            if (pause) {
                stored.resolve();
                await release.promise;
            }
        },
    });
    await coordinator.connect();
    const id = coordinator.activeId;
    pause = true;
    clients[0].runtime.sessionId = "replacement-session";
    clients[0].runtime.sessionFile = path.join(clients[0].launch.cwd, "replacement-session.jsonl");
    const refreshing = coordinator.refresh();
    await stored.promise;
    coordinator.publish();
    await coordinator.loadHistory();
    assert.equal(
        [...coordinator.records.values()].filter((record) => record.sessionId === "replacement-session").length,
        1,
    );
    release.resolve();
    await refreshing;
    assert.equal(coordinator.activeId, id);
    assert.equal(coordinator.activeSessionId, "replacement-session");
});

test("branch target rejects prompts and model changes until mutation finishes", async (t) => {
    const started = deferred();
    const finish = deferred();
    const { coordinator, clients } = fixture(t, {
        request: (type) => {
            if (type === "clone") {
                started.resolve();

                return finish.promise;
            }
        },
    });
    await coordinator.connect();
    const branching = coordinator.branchConversation(coordinator.active, "clone", {}, { text: "", images: [] });
    await started.promise;
    const target = coordinator.active;
    assert.equal(coordinator.state.sending, true);
    await coordinator.handleMessage({ type: "send", text: "racing prompt", requestId: "race" });
    target.state.models = [{ id: "model", provider: "synthetic" }];
    await coordinator.handleMessage({ type: "setModel", modelId: "model", provider: "synthetic" });
    assert.ok(!clients[1].requests.some((request) => request.type === "prompt" || request.type === "set_model"));
    finish.resolve({});
    assert.equal(await branching, true);
    assert.equal(target.transitioning, false);
    assert.equal(coordinator.state.sending, false);
});

test("a stale failed branch cannot close or contaminate an explicitly reconnected target", async (t) => {
    const started = deferred();
    const finish = deferred();
    const { coordinator, clients } = fixture(t, {
        request: (type) => {
            if (type === "clone") {
                started.resolve();

                return finish.promise;
            }
        },
    });
    await coordinator.connect();
    const branching = coordinator.branchConversation(
        coordinator.active,
        "clone",
        {},
        { text: "branch draft", images: [] },
    );
    await started.promise;
    const target = coordinator.active;
    await coordinator.disconnect();
    await coordinator.connect();
    const replacement = coordinator.client;
    assert.equal(clients.length, 3);
    assert.ok(!replacement.launch.args.includes("--fork"));
    finish.reject(new Error("Old clone failed"));
    assert.equal(await branching, false);
    assert.equal(target.client, replacement);
    assert.equal(replacement.stops, 0);
    assert.equal(target.state.error, undefined);
    assert.equal(coordinator.state.draft.text, "");
    assert.equal(target.suppressRemember, false);
});

test("a failed branch cleanup finishing after reconnect cannot add an obsolete error", async (t) => {
    const started = deferred();
    const finish = deferred();
    const stopping = deferred();
    const stopGate = deferred();
    const { coordinator } = fixture(t, {
        request: (type) => {
            if (type === "clone") {
                started.resolve();

                return finish.promise;
            }
        },
    });
    await coordinator.connect();
    const branching = coordinator.branchConversation(coordinator.active, "clone", {}, { text: "", images: [] });
    await started.promise;
    const target = coordinator.active;
    const oldClient = target.client;
    oldClient.stop = async () => {
        oldClient.stops += 1;
        stopping.resolve();
        await stopGate.promise;
    };

    finish.reject(new Error("Old branch failed"));
    await stopping.promise;
    await coordinator.connect();
    const replacement = coordinator.client;
    assert.notEqual(replacement, oldClient);
    assert.equal(target.state.status, "ready");
    assert.equal(target.state.error, undefined);
    stopGate.resolve();
    assert.equal(await branching, false);
    assert.equal(target.client, replacement);
    assert.equal(target.state.status, "ready");
    assert.equal(target.state.error, undefined);
    assert.equal(replacement.stops, 0);
});

test("archival before first persistence and saved rename survive subsequent refresh", async (t) => {
    const { coordinator } = fixture(t);
    const id = coordinator.activeId;
    await coordinator.renameConversation(id, "Before connecting");
    await coordinator.archiveConversation(id, true);
    await coordinator.connect();
    const sessionId = coordinator.activeSessionId;
    assert.equal(coordinator.state.title, "Before connecting");
    assert.equal((await coordinator.catalog.resolve(sessionId)).archived, true);
    await coordinator.refresh();
    assert.equal((await coordinator.catalog.resolve(sessionId)).sessionName, "Before connecting");
    await coordinator.disconnect();
    await coordinator.renameConversation(id, "While disconnected");
    await coordinator.connect();
    assert.equal(coordinator.state.title, "While disconnected");
    assert.equal((await coordinator.catalog.resolve(sessionId)).sessionName, "While disconnected");
});

test("resuming an evicted saved conversation fails instead of launching a blank replacement", async (t) => {
    const { coordinator, clients, folders } = fixture(t);
    const catalog = coordinator.catalogFor(folders[0]);
    await catalog.remember({
        sessionId: "evicted-session",
        sessionName: "Original",
        sessionFile: path.join(folders[0].uri.fsPath, "old.jsonl"),
    });
    await coordinator.history();
    const saved = coordinator.state.conversations.find((record) => record.title === "Original");
    catalog.store.clear();
    await assert.rejects(coordinator.selectConversation(saved.id), /no longer available/);
    assert.equal(clients.length, 0);
    assert.equal(coordinator.activeId, saved.id);
    assert.equal(coordinator.state.status, "error");
});

test("160-character saved names retain their complete title when resumed and renamed during connection", async (t) => {
    const ready = deferred();
    const { coordinator, clients, folders } = fixture(t, { ready: () => ready.promise });
    const name = "A".repeat(160);
    const renamed = "B".repeat(160);
    const catalog = coordinator.catalogFor(folders[0]);
    await catalog.remember({
        sessionId: "long-title",
        sessionName: name,
        sessionFile: path.join(folders[0].uri.fsPath, "long.jsonl"),
    });
    await coordinator.history();
    const saved = coordinator.state.conversations.find((record) => record.title === name);
    assert.ok(saved);
    const selecting = coordinator.selectConversation(saved.id);
    await new Promise((resolve) => setImmediate(resolve));
    const renaming = coordinator.renameConversation(saved.id, renamed);
    ready.resolve();
    await Promise.all([selecting, renaming]);
    assert.equal(coordinator.state.status, "ready");
    assert.equal(coordinator.state.title, renamed);
    assert.equal((await catalog.resolve("long-title")).sessionName, renamed);
    assert.equal(clients[0].runtime.sessionName, renamed);
    assert.ok(
        clients[0].requests
            .filter((request) => request.type === "set_session_name")
            .every((request) => request.args.name.length === 160),
    );
});

test("the offered selection is re-derived for the conversation being switched to", async (t) => {
    const { coordinator, folders, vscode } = fixture(t);
    await coordinator.connect();
    const firstId = coordinator.activeId;
    const selectionPath = path.join(folders[0].uri.fsPath, "helper.ts");
    fs.mkdirSync(folders[0].uri.fsPath, { recursive: true });
    fs.writeFileSync(selectionPath, "first\nconst target = true;\nlast\n");
    vscode.window.activeTextEditor = {
        document: { uri: uri(selectionPath) },
        selection: { isEmpty: false, start: { line: 1 }, end: { line: 1 } },
    };
    coordinator.updateSelectionContext();
    assert.equal(coordinator.selectionContext.filePath, selectionPath);

    await coordinator.newChat();
    const secondId = coordinator.activeId;
    assert.notEqual(secondId, firstId);
    // A switch re-derives the offer against the newly selected conversation
    // rather than leaving the previous chip in place.
    assert.equal(coordinator.selectionContext.filePath, selectionPath);

    vscode.window.activeTextEditor = undefined;
    await coordinator.selectConversation(firstId);
    assert.equal(coordinator.selectionContext, null);
    assert.equal(coordinator.state.selectionContext, null);
});
