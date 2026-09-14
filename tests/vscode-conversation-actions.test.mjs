import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { deflateSync } from "node:zlib";

const require = createRequire(import.meta.url);
const {
    editPrompt,
    forkChat,
    exportChat,
    showUsage,
    markdownTranscript,
} = require("../vscode/src/conversation-actions.js");

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((success, failure) => {
        resolve = success;
        reject = failure;
    });

    return { promise, resolve, reject };
}

function image(totalBytes = 0) {
    function chunk(type, bytes) {
        const payload = Buffer.concat([Buffer.from(type), bytes]);
        let crc = 0xffffffff;
        for (const byte of payload) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit += 1) {
                crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
            }
        }

        const result = Buffer.alloc(bytes.length + 12);
        result.writeUInt32BE(bytes.length, 0);
        payload.copy(result, 4);
        result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);

        return result;
    }

    const header = Buffer.alloc(13);
    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 6;
    const chunks = [
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
        chunk("IEND", Buffer.alloc(0)),
    ];
    const minimum = chunks.reduce((sum, current) => sum + current.length, 0);
    if (totalBytes > minimum + 12) {
        const text = Buffer.alloc(totalBytes - minimum - 12, 65);
        Buffer.from("comment\0").copy(text);
        chunks.splice(2, 0, chunk("tEXt", text));
    }

    const bytes = Buffer.concat(chunks);

    return { type: "image", mimeType: "image/png", data: bytes.toString("base64") };
}

function tree() {
    return {
        leafId: "answer-two",
        entries: [
            { type: "model_change", id: "root", parentId: null },
            {
                type: "message",
                id: "user-one",
                parentId: "root",
                message: { role: "user", content: "  First prompt\nexact spacing  " },
            },
            {
                type: "message",
                id: "answer-one",
                parentId: "user-one",
                message: { role: "assistant", content: [{ type: "text", text: "First answer" }] },
            },
            {
                type: "message",
                id: "abandoned",
                parentId: "answer-one",
                message: { role: "user", content: "Abandoned prompt" },
            },
            {
                type: "message",
                id: "user-two",
                parentId: "answer-one",
                message: {
                    role: "user",
                    content: [
                        { type: "text", text: "Second " },
                        { type: "text", text: "prompt" },
                    ],
                },
            },
            {
                type: "message",
                id: "answer-two",
                parentId: "user-two",
                message: { role: "assistant", content: [{ type: "text", text: "Second answer" }] },
            },
        ],
    };
}

function fixture(options = {}) {
    const requests = [];
    const posts = [];
    const picks = [];
    const information = [];
    const documents = [];
    const shown = [];
    const refreshes = [];
    const branches = [];
    const entries = options.entries || tree();
    const controller = {
        workspace: { name: "Fixture workspace" },
        catalog: {},
        activeSessionId: "original-session",
        generation: 2,
        sessionRevision: 3,
        transitioning: false,
        sending: false,
        disposed: false,
        trusted: true,
        foreground: true,
        isForeground() {
            return this.foreground;
        },
        imageQueue: {
            clear() {
                this.cleared = true;
            },
        },
        attachments: [{ id: "unsent-file", kind: "file", label: "example.js" }],
        state: {
            status: "ready",
            title: "Original chat",
            workspace: "Fixture workspace",
            messages: [{ role: "user", text: "Visible original message" }],
        },
        requireWorkspace() {
            if (!this.trusted) {
                throw new Error("Workspace is not trusted");
            }

            return "fixture-workspace";
        },
        cancelDialogs() {
            this.cancelCount = (this.cancelCount || 0) + 1;
        },
        publish() {
            this.publishCount = (this.publishCount || 0) + 1;
        },
        post(message) {
            posts.push(message);
        },
        async refresh(client, full) {
            refreshes.push({ client, full });
            throw new Error("Conversation actions must not refresh the source after branching");
        },
        async branchConversation(command, payload, draft) {
            branches.push({ command, payload, draft });

            return options.branch ? options.branch(command, payload, draft) : true;
        },
    };
    controller.client = {
        async request(type, data, requestOptions) {
            requests.push({ type, data, options: requestOptions });
            const override = await options.request?.(type, data, controller, requests);
            if (override !== undefined) {
                return override;
            }

            if (type === "get_entries") {
                return structuredClone(entries);
            }

            if (type === "get_session_stats") {
                return {
                    tokens: { input: 0, output: 20 },
                    cost: 0,
                    contextUsage: { tokens: null, percent: null, contextWindow: 128000 },
                };
            }

            return { cancelled: false, text: "Wrong response text must not replace original images or text" };
        },
    };
    const vscode = {
        window: {
            async showQuickPick(items, settings) {
                picks.push({ items, settings });
                if (options.pick) {
                    return options.pick(items, controller);
                }

                return items.find((item) => item.entryId === "user-one") || items[0];
            },
            async showInformationMessage(message) {
                information.push(message);
            },
            async showTextDocument(document, settings) {
                shown.push({ document, settings });
                await options.showDocument?.(controller);
            },
        },
        workspace: {
            async openTextDocument(settings) {
                documents.push(settings);
                await options.openDocument?.(controller);

                return { settings, isUntitled: true };
            },
        },
    };

    return { controller, vscode, requests, posts, picks, information, documents, shown, refreshes, branches, entries };
}

test("edit earlier prompt selects only active-branch users, forks before the selected message, and restores exact text", async () => {
    const f = fixture();
    assert.equal(await editPrompt(f.controller, f.vscode), true);
    assert.deepEqual(
        f.picks[0].items.map((item) => item.entryId),
        ["user-two", "user-one"],
    );
    assert.equal(f.picks[0].settings.matchOnDescription, true);
    assert.match(f.picks[0].items[0].detail, /Code files remain unchanged/);
    assert.deepEqual(
        f.requests.map((request) => request.type),
        ["get_entries", "get_entries"],
    );
    assert.deepEqual(f.branches, [
        {
            command: "fork",
            payload: { entryId: "user-one" },
            draft: { text: "  First prompt\nexact spacing  ", images: [] },
        },
    ]);
    assert.equal(f.controller.activeSessionId, "original-session");
    assert.equal(f.controller.attachments[0].id, "unsent-file");
    assert.deepEqual(f.posts, []);
});

test("edit preserves image-only prompts and multiple text blocks without automatically sending", async () => {
    const original = tree();
    original.entries.find((entry) => entry.id === "user-one").message.content = [image()];
    const f = fixture({ entries: original });
    assert.equal(await editPrompt(f.controller, f.vscode), true);
    assert.equal(f.picks[0].items[1].label, "Image prompt");
    assert.equal(f.branches[0].draft.text, "");
    assert.equal(f.branches[0].draft.images[0].data, image().data);
    assert.equal(f.branches[0].draft.images[0].width, 1);
    assert.ok(f.branches[0].draft.images[0].byteLength > 0);
    assert.equal(f.controller.attachments[0].id, "unsent-file");
    assert.equal(
        f.requests.some((request) => request.type === "prompt"),
        false,
    );

    const second = fixture({ pick: (items) => items.find((item) => item.entryId === "user-two") });
    await editPrompt(second.controller, second.vscode);
    assert.equal(second.branches[0].draft.text, "Second prompt");
});

test("live-conversation branching delegates validated drafts without replacing the source runtime or draft", async () => {
    for (const action of [editPrompt, forkChat]) {
        const entries = tree();
        entries.entries.find((entry) => entry.id === "user-one").message.content = [
            { type: "text", text: "  Prompt with an image\n" },
            image(),
        ];
        const f = fixture({ entries });
        const sourceClient = f.controller.client;
        const sourceState = structuredClone(f.controller.state);
        const sourceAttachments = structuredClone(f.controller.attachments);
        const branches = [];
        f.controller.foreground = true;
        f.controller.branchConversation = async (command, payload, draft) => {
            branches.push({ command, payload, draft });

            return true;
        };

        assert.equal(await action(f.controller, f.vscode), true);
        assert.equal(branches.length, 1);
        if (action === editPrompt) {
            assert.equal(branches[0].command, "fork");
            assert.deepEqual(branches[0].payload, { entryId: "user-one" });
            assert.equal(branches[0].draft.text, "  Prompt with an image\n");
            assert.equal(branches[0].draft.images[0].data, image().data);
        } else {
            assert.deepEqual(branches[0], { command: "clone", payload: {}, draft: { text: "", images: [] } });
        }

        assert.ok(f.requests.every((request) => request.type === "get_entries"));
        assert.equal(f.controller.client, sourceClient);
        assert.equal(f.controller.activeSessionId, "original-session");
        assert.equal(f.controller.sessionRevision, 3);
        assert.equal(f.controller.transitioning, false);
        assert.equal(f.controller.cancelCount, undefined);
        assert.equal(f.controller.imageQueue.cleared, undefined);
        assert.deepEqual(f.controller.state, sourceState);
        assert.deepEqual(f.controller.attachments, sourceAttachments);
        assert.deepEqual(f.refreshes, []);
        assert.deepEqual(f.posts, []);
    }
});

test("cancelled or failed live branching cannot fall back to replacing the source conversation", async () => {
    for (const failure of [false, true]) {
        const f = fixture();
        f.controller.branchConversation = async () => {
            if (failure) {
                throw new Error("New conversation could not start");
            }

            return false;
        };

        if (failure) {
            await assert.rejects(forkChat(f.controller, f.vscode), /could not start/);
        } else {
            assert.equal(await forkChat(f.controller, f.vscode), false);
        }

        assert.deepEqual(
            f.requests.map((request) => request.type),
            ["get_entries"],
        );
        assert.equal(f.controller.activeSessionId, "original-session");
        assert.equal(f.controller.attachments[0].id, "unsent-file");
        assert.equal(f.controller.sessionRevision, 3);
        assert.deepEqual(f.posts, []);
    }
});

test("background conversation actions cannot open dialogs or branch after the foreground selection changes", async () => {
    for (const action of [editPrompt, forkChat, exportChat, showUsage]) {
        const f = fixture();
        f.controller.foreground = false;
        await assert.rejects(action(f.controller, f.vscode), /Select this conversation/);
        assert.deepEqual(f.requests, []);
        assert.deepEqual(f.documents, []);
        assert.deepEqual(f.picks, []);
    }

    for (const action of [editPrompt, forkChat, showUsage]) {
        const f = fixture({
            request: (type, payload, controller) => {
                controller.foreground = false;
            },
        });
        assert.equal(await action(f.controller, f.vscode), false);
        assert.equal(f.requests.length, 1);
        assert.deepEqual(f.picks, []);
        assert.deepEqual(f.posts, []);
    }

    const changedDuringPick = fixture({
        pick: (items, controller) => {
            controller.foreground = false;

            return items[0];
        },
    });
    changedDuringPick.controller.branchConversation = () => {
        throw new Error("A stale picker must not create a branch");
    };

    assert.equal(await editPrompt(changedDuringPick.controller, changedDuringPick.vscode), false);
    assert.equal(changedDuringPick.requests.length, 1);
    assert.deepEqual(changedDuringPick.posts, []);

    const changedDuringExport = fixture({
        openDocument: (controller) => {
            controller.foreground = false;
        },
    });
    assert.equal(await exportChat(changedDuringExport.controller, changedDuringExport.vscode), false);
    assert.deepEqual(changedDuringExport.shown, []);
});

test("invalid, unsupported, excessive, or oversized restored content cannot mutate a conversation", async () => {
    const cases = [
        [{ type: "image", mimeType: "image/png", data: "not-base64" }],
        [{ type: "image", mimeType: "image/svg+xml", data: Buffer.from("<svg/>").toString("base64") }],
        [{ type: "file", uri: "outside-workspace" }],
        Array.from({ length: 9 }, image),
        "x".repeat(64 * 1024 + 1),
    ];
    for (const content of cases) {
        const entries = tree();
        entries.entries.find((entry) => entry.id === "user-one").message.content = content;
        const f = fixture({ entries });
        await assert.rejects(editPrompt(f.controller, f.vscode));
        assert.deepEqual(f.branches, []);
        assert.equal(f.controller.sessionRevision, 3);
        assert.equal(f.controller.attachments[0].id, "unsent-file");
        assert.deepEqual(f.posts, []);
    }
});

test("cancelling a picker or delegated branch preserves the source conversation and composer", async () => {
    for (const cancelAt of ["picker", "fork"]) {
        const f = fixture({
            pick: (items) => (cancelAt === "picker" ? undefined : items[0]),
            branch: () => false,
        });
        assert.equal(await editPrompt(f.controller, f.vscode), false);
        assert.equal(f.controller.activeSessionId, "original-session");
        assert.equal(f.controller.state.title, "Original chat");
        assert.equal(f.controller.attachments[0].id, "unsent-file");
        assert.equal(f.controller.cancelCount, undefined);
        assert.equal(f.controller.imageQueue.cleared, undefined);
        assert.equal(f.controller.transitioning, false);
        assert.deepEqual(f.refreshes, []);
        assert.deepEqual(f.posts, []);
    }
});

test("aggregate image restoration limits reject excess image bytes before a fork", async () => {
    const entries = tree();
    const large = image(5 * 1024 * 1024);
    entries.entries.find((entry) => entry.id === "user-one").message.content = Array.from({ length: 5 }, () => large);
    const f = fixture({ entries });
    await assert.rejects(editPrompt(f.controller, f.vscode), /20 MiB/);
    assert.deepEqual(f.branches, []);
    assert.equal(f.controller.sessionRevision, 3);
    assert.equal(f.controller.attachments[0].id, "unsent-file");
});

test("editing rejects missing/cyclic branches and refuses an active leaf that changes while choosing", async () => {
    for (const change of ["missing", "cycle", "leaf"]) {
        const f = fixture({
            request: (type, data, controller, requests) => {
                if (type !== "get_entries") {
                    return undefined;
                }

                const entries = tree();
                if (change === "missing") {
                    entries.entries[0].parentId = "missing";
                } else if (change === "cycle") {
                    entries.entries[0].parentId = "answer-two";
                } else if (requests.filter((request) => request.type === "get_entries").length > 1) {
                    entries.leafId = "user-two";
                }

                return entries;
            },
        });
        await assert.rejects(editPrompt(f.controller, f.vscode), /incomplete|cyclic|conversation changed/);
        assert.deepEqual(f.branches, []);
        assert.deepEqual(f.posts, []);
    }
});

test("conversation actions enforce connection, idle state, trusted workspace, and exclusive transition", async () => {
    for (const change of [
        (controller) => {
            controller.client = null;
        },
        (controller) => {
            controller.state.status = "busy";
        },
        (controller) => {
            controller.sending = true;
        },
        (controller) => {
            controller.state.queueCount = 2;
        },
        (controller) => {
            controller.transitioning = true;
        },
        (controller) => {
            controller.trusted = false;
        },
        (controller) => {
            controller.disposed = true;
        },
    ]) {
        const f = fixture();
        change(f.controller);
        await assert.rejects(editPrompt(f.controller, f.vscode));
        await assert.rejects(forkChat(f.controller, f.vscode));
        assert.deepEqual(f.requests, []);
    }
});

test("picker races cannot fork a replacement connection, revision, workspace, or untrusted folder", async () => {
    for (const change of [
        (controller) => {
            controller.generation += 1;
        },
        (controller) => {
            controller.sessionRevision += 1;
        },
        (controller) => {
            controller.workspace = { name: "Another folder" };
        },
        (controller) => {
            controller.trusted = false;
        },
        (controller) => {
            controller.state.status = "busy";
        },
        (controller) => {
            controller.client = null;
        },
    ]) {
        const f = fixture({
            pick: (items, controller) => {
                change(controller);

                return items[0];
            },
        });
        assert.equal(await editPrompt(f.controller, f.vscode), false);
        assert.deepEqual(f.branches, []);
        assert.deepEqual(f.posts, []);
        assert.equal(f.controller.attachments[0].id, "unsent-file");
    }
});

test("an empty conversation cannot be branched", async () => {
    const empty = fixture({ entries: { entries: [], leafId: null } });
    assert.equal(await forkChat(empty.controller, empty.vscode), false);
    assert.equal(empty.information.length, 1);
    assert.deepEqual(empty.branches, []);
});

test("visible Markdown export includes reasoning/tool inputs and image placeholders without reading image payloads", async () => {
    const f = fixture();
    f.controller.client = null;
    f.controller.state.status = "disconnected";
    f.controller.state.messages = [
        {
            role: "user",
            text: "Describe this",
            images: [
                {
                    mimeType: "image/png",
                    width: 1,
                    height: 1,
                    get data() {
                        throw new Error("Image payload must not be read during export");
                    },
                },
            ],
        },
        { role: "assistant", text: "Visible reply", thinking: "Visible reasoning" },
        { role: "tool", toolName: "read", input: '{\n  "text": "```"\n}', text: "Visible tool output", isError: true },
    ];
    assert.equal(await exportChat(f.controller, f.vscode), true);
    assert.equal(f.documents[0].language, "markdown");
    assert.match(f.documents[0].content, /Visible reasoning/);
    assert.match(f.documents[0].content, /Tool input\n\n````\n/);
    assert.match(f.documents[0].content, /Image omitted: image\/png, 1 × 1/);
    assert.match(f.documents[0].content, /Status: error/);
    assert.equal(f.documents[0].content.includes("base64"), false);
    assert.equal(f.shown[0].document.isUntitled, true);
    assert.equal(f.shown[0].settings.preview, false);
    assert.deepEqual(f.requests, []);
});

test("Markdown export does not open a stale document after a workspace switch", async () => {
    const f = fixture({
        openDocument: (controller) => {
            controller.workspace = { name: "New workspace" };
        },
    });
    assert.equal(await exportChat(f.controller, f.vscode), false);
    assert.equal(f.documents.length, 1);
    assert.deepEqual(f.shown, []);
    assert.match(markdownTranscript({ messages: [] }), /Visible conversation export/);
});

test("late rejecting reads cannot report errors into replacement chat contexts", async () => {
    const scenarios = [
        { action: editPrompt, type: "get_entries", occurrence: 1 },
        { action: editPrompt, type: "get_entries", occurrence: 2 },
        { action: forkChat, type: "get_entries", occurrence: 1 },
        { action: showUsage, type: "get_session_stats", occurrence: 1 },
    ];
    const changes = [
        (controller) => {
            controller.generation += 1;
        },
        (controller) => {
            controller.sessionRevision += 1;
        },
        (controller) => {
            controller.workspace = { name: "Replacement workspace" };
        },
        (controller) => {
            controller.client = {};
        },
        (controller) => {
            controller.trusted = false;
        },
    ];
    for (const scenario of scenarios) {
        for (const change of changes) {
            const pending = deferred();
            const started = deferred();
            let count = 0;
            const f = fixture({
                request: (type) => {
                    if (type === scenario.type && ++count === scenario.occurrence) {
                        started.resolve();

                        return pending.promise;
                    }
                },
            });
            const result = scenario.action(f.controller, f.vscode);
            await started.promise;
            change(f.controller);
            pending.reject(new Error("Late failure from replaced Pi context"));
            assert.equal(await result, false, `${scenario.action.name}/${scenario.type}`);
            assert.deepEqual(f.posts, []);
            assert.equal(f.controller.transitioning, false);
            assert.equal(f.controller.attachments[0].id, "unsent-file");
        }
    }
});

test("late native picker and export errors cannot escape after the requested context changes", async () => {
    for (const stage of ["picker", "open", "show"]) {
        const pending = deferred();
        const started = deferred();
        const wait = () => {
            started.resolve();

            return pending.promise;
        };

        const f = fixture({
            ...(stage === "picker" ? { pick: wait } : {}),
            ...(stage === "open" ? { openDocument: wait } : {}),
            ...(stage === "show" ? { showDocument: wait } : {}),
        });
        const result = stage === "picker" ? editPrompt(f.controller, f.vscode) : exportChat(f.controller, f.vscode);
        await started.promise;
        f.controller.workspace = { name: "New export context" };
        pending.reject(new Error("Late native operation failure"));
        assert.equal(await result, false);
        assert.deepEqual(f.posts, []);
        assert.deepEqual(f.branches, []);
    }
});

test("current RPC and native errors remain visible even when the current operation enters an error state", async () => {
    for (const action of [editPrompt, forkChat, showUsage]) {
        const f = fixture({
            request: (type, data, controller) => {
                controller.state.status = "error";
                throw new Error("Current operation failure");
            },
        });
        await assert.rejects(action(f.controller, f.vscode), /Current operation failure/);
    }

    const f = fixture({
        openDocument: () => {
            throw new Error("Current document failure");
        },
    });
    await assert.rejects(exportChat(f.controller, f.vscode), /Current document failure/);
});

test("usage remains read-only and available during active work and queued sends", async () => {
    for (const status of ["ready", "busy", "retrying", "compacting"]) {
        const f = fixture();
        f.controller.state.status = status;
        f.controller.state.queueCount = 2;
        f.controller.sending = true;
        assert.equal(await showUsage(f.controller, f.vscode), true, status);
        assert.deepEqual(
            f.requests.map((request) => request.type),
            ["get_session_stats"],
        );
        assert.equal(f.picks.length, 1);
        assert.equal(f.controller.state.status, status);
        assert.equal(f.controller.sending, true);
    }
});

test("usage cannot query a connection before readiness or during a session transition", async () => {
    for (const status of ["connecting", "disconnected", "error", "ready"]) {
        const f = fixture();
        f.controller.state.status = status;
        f.controller.transitioning = status === "ready";
        await assert.rejects(showUsage(f.controller, f.vscode), /connect|switch/);
        assert.deepEqual(f.requests, []);
        assert.deepEqual(f.picks, []);
    }
});

test("usage uses Pi's actual stats, keeps unknown context distinct from zero, and labels session-wide totals", async () => {
    const f = fixture();
    assert.equal(await showUsage(f.controller, f.vscode), true);
    assert.deepEqual(
        f.requests.map((request) => request.type),
        ["get_session_stats"],
    );
    const fields = new Map(f.picks[0].items.map((item) => [item.label, item.description]));
    assert.equal(fields.get("Input tokens"), "0");
    assert.equal(fields.get("Output tokens"), "20");
    assert.equal(fields.get("Total session tokens"), "Unavailable");
    assert.equal(fields.get("Current context tokens"), "Unavailable");
    assert.equal(fields.get("Context used"), "Unavailable");
    assert.equal(fields.get("Reported cost (USD)"), "$0");
    assert.match(f.picks[0].settings.placeHolder, /other branches/);

    const stale = fixture({
        request: (type, data, controller) => {
            controller.generation += 1;

            return {};
        },
    });
    assert.equal(await showUsage(stale.controller, stale.vscode), false);
    assert.deepEqual(stale.picks, []);
});
