import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import actions from "../vscode/src/workspace-actions.js";

const { findFiles, reviewChanges, workspaceHiddenFilter } = actions;

function uri(filePath, properties = {}) {
    return {
        scheme: "file",
        authority: "",
        query: "",
        fragment: "",
        fsPath: filePath,
        ...properties,
        toString() {
            return `${this.scheme}:${this.authority}:${this.fsPath}?${this.query}#${this.fragment}`;
        },
    };
}

function fixture(root = path.join(os.tmpdir(), "specpi-workspace-actions")) {
    const workspace = { name: "example", uri: uri(root) };
    const posts = [];
    const calls = [];
    const notifications = [];
    const vscode = {
        RelativePattern: class {
            constructor(base, pattern) {
                this.base = base;
                this.pattern = pattern;
            }
        },
        workspace: {
            isTrusted: true,
            workspaceFolders: [workspace],
            async findFiles(...args) {
                calls.push(["findFiles", ...args]);

                return [];
            },
        },
        extensions: {
            getExtension() {
                return undefined;
            },
        },
        window: {
            async showInformationMessage(message) {
                notifications.push(message);
            },
            async showQuickPick(items, options) {
                calls.push(["picker", items, options]);

                return items[0];
            },
        },
        commands: {
            async executeCommand(...args) {
                calls.push(args);
            },
        },
    };
    const controller = {
        workspace,
        generation: 1,
        sessionRevision: 1,
        disposed: false,
        post(message) {
            posts.push(message);
        },
        requireWorkspace() {
            if (!vscode.workspace.isTrusted) {
                throw new Error("Trust the workspace first.");
            }

            if (!vscode.workspace.workspaceFolders.includes(this.workspace)) {
                throw new Error("Workspace folder closed.");
            }

            return this.workspace.uri.fsPath;
        },
    };

    return { root, workspace, vscode, controller, posts, calls, notifications };
}

async function diskFixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "specpi-workspace-actions-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "file.js"), "working tree\n");

    return fixture(root);
}

function installGit(f, groups, { active = true, root = f.root } = {}) {
    const repo = {
        rootUri: uri(root),
        state: { workingTreeChanges: [], indexChanges: [], untrackedChanges: [], mergeChanges: [], ...groups },
        async status() {
            f.calls.push(["status"]);
        },
    };
    const api = {
        repositories: [repo],
        getRepository(selected) {
            assert.equal(selected, f.workspace.uri);

            return repo;
        },
        toGitUri(source, ref) {
            f.calls.push(["toGitUri", source, ref]);

            return uri(source.fsPath, { scheme: "git", query: JSON.stringify({ path: source.fsPath, ref }) });
        },
    };
    const exported = {
        enabled: true,
        getAPI(version) {
            assert.equal(version, 1);

            return api;
        },
    };
    f.vscode.extensions.getExtension = (id) => {
        assert.equal(id, "vscode.git");

        return {
            isActive: active,
            exports: exported,
            async activate() {
                f.calls.push(["activate"]);

                return exported;
            },
        };
    };

    return { repo, api };
}

function change(f, status, file = "src/file.js", original) {
    const current = uri(path.join(f.root, file));

    return {
        uri: current,
        originalUri: original ? uri(path.join(f.root, original)) : current,
        ...(original ? { renameUri: current } : {}),
        status,
    };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => {
        resolve = done;
        reject = fail;
    });

    return { promise, resolve, reject };
}

test("background conversation workspace actions do not search or open native UI", async () => {
    const f = fixture();
    f.controller.isForeground = () => false;
    await findFiles(f.controller, f.vscode, "", 1);
    await reviewChanges(f.controller, f.vscode);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.posts, []);
    assert.deepEqual(f.notifications, []);
});

test("file suggestions enumerate only selected-workspace metadata and filter private paths", async () => {
    const f = fixture();
    const names = [
        "src/a.js",
        "src/b.js",
        "src/auth.ts",
        "sessions/view.ts",
        ".env",
        "auth.json",
        "src/credentials.txt",
        ".pi/config.json",
        ".git/config",
        "node_modules/library.js",
        ".aws/config",
        ".pi/agent/sessions/chat.jsonl",
        "../outside.js",
        "source:stream",
        "src/not-a-line#L123",
        "src/not-a-column:45:2",
    ];
    f.vscode.workspace.findFiles = async (pattern, excludes, max) => {
        assert.equal(pattern.base, f.workspace);
        assert.equal(pattern.pattern, "**/*");
        assert.match(excludes, /\*\*\/\.git\/\*\*/u);
        assert.match(excludes, /\*\*\/\.pi\/\*\*/u);
        assert.equal(max, 500);

        // None of these files exist: listing must not read/open document contents.
        return [
            ...names.map((name) => uri(path.resolve(f.root, name))),
            uri(path.join(f.root, "remote.js"), { scheme: "vscode-remote" }),
            uri(path.join(f.root, "network.js"), { authority: "server" }),
        ];
    };

    await findFiles(f.controller, f.vscode, "", "query-1");
    assert.deepEqual(f.posts, [
        {
            type: "fileSuggestions",
            requestId: "query-1",
            files: [
                { path: "sessions/view.ts", label: "sessions/view.ts", kind: "file" },
                { path: "src/a.js", label: "src/a.js", kind: "file" },
                { path: "src/auth.ts", label: "src/auth.ts", kind: "file" },
                { path: "src/b.js", label: "src/b.js", kind: "file" },
            ],
        },
    ]);
});

test("file suggestions bound input/output and prefer matching paths and basenames", async () => {
    const f = fixture();
    f.vscode.workspace.findFiles = async () =>
        ["a/source.js", "source.js", "src/source.js", ...Array.from({ length: 60 }, (_, i) => `lib/source${i}.js`)].map(
            (name) => uri(path.join(f.root, name)),
        );
    await findFiles(f.controller, f.vscode, "SOURCE", 1);
    assert.equal(f.posts[0].files.length, 30);
    assert.equal(f.posts[0].files[0].path, "source.js");
    await findFiles(f.controller, f.vscode, "src\\", 2);
    assert.deepEqual(f.posts[1].files, [{ path: "src/source.js", label: "src/source.js", kind: "file" }]);
    f.vscode.workspace.findFiles = () => {
        throw new Error("Invalid queries must not perform searches.");
    };

    await findFiles(f.controller, f.vscode, "x".repeat(257), 3);
    await findFiles(f.controller, f.vscode, {}, 4);
    assert.deepEqual(
        f.posts.slice(-2).map((post) => post.files),
        [[], []],
    );
});

test("file suggestions narrow filename and directory queries before the 500 matching-file cap", async () => {
    const f = fixture();
    const inventory = [
        ...Array.from({ length: 650 }, (_, index) => `ordinary/file${index}.js`),
        "later/Target.ts",
        "later/Sub/Target.test.ts",
        "later/Sub/another.js",
    ];
    f.vscode.workspace.findFiles = async (pattern, _excludes, max) => {
        assert.ok(max > 0 && max <= 500);

        return inventory
            .filter((name) => path.posix.matchesGlob(name, pattern.pattern))
            .slice(0, max)
            .map((name) => uri(path.join(f.root, name)));
    };

    await findFiles(f.controller, f.vscode, "target", 1);
    assert.deepEqual(f.posts[0].files.map((file) => file.path).sort(), ["later/Sub/Target.test.ts", "later/Target.ts"]);
    await findFiles(f.controller, f.vscode, "LATER\\SUB/", 2);
    assert.deepEqual(f.posts[1].files.map((file) => file.path).sort(), [
        "later/Sub/Target.test.ts",
        "later/Sub/another.js",
    ]);
    await findFiles(f.controller, f.vscode, "later", 3);
    assert.equal(f.posts[2].files.length, 5);
    assert.deepEqual(
        f.posts[2].files
            .filter((file) => file.kind === "directory")
            .map((file) => file.path)
            .sort(),
        ["later/", "later/Sub/"],
    );
    await findFiles(f.controller, f.vscode, "", 4);
    assert.equal(f.posts[3].files.length, 30);
    assert.ok(f.posts[3].files.every((file) => file.path.startsWith("ordinary/")));
});

test("file suggestion globs preserve literal metacharacters and ASCII case without query expansion", async () => {
    const f = fixture();
    const patterns = [];
    f.vscode.workspace.findFiles = async (pattern) => {
        patterns.push(pattern.pattern);

        return [];
    };

    await findFiles(f.controller, f.vscode, "Src\\Main.TS", 1);
    assert.deepEqual(patterns, [
        "**/*[sS][rR][cC]/[mM][aA][iI][nN].[tT][sS]*",
        "**/*[sS][rR][cC]/[mM][aA][iI][nN].[tT][sS]*/**",
    ]);
    assert.ok(path.posix.matchesGlob("nested/SRC/main.ts", patterns[0]));
    assert.ok(!path.posix.matchesGlob("nested/SRC/domain.ts", patterns[0]));
    await findFiles(f.controller, f.vscode, "a[1]{x,y}*?.TS", 2);
    assert.deepEqual(patterns.slice(2), [
        "**/*[aA][[]1[]][{][xX][,][yY][}][*][?].[tT][sS]*",
        "**/*[aA][[]1[]][{][xX][,][yY][}][*][?].[tT][sS]*/**",
    ]);
    // VS Code documents singleton ranges for literal punctuation. Node's glob
    // implementation differs for combined literal braces, so assert the exact
    // emitted syntax above rather than using Node as an oracle for that case.
    for (const character of ["[", "]", "{", "}", "*", "?", ","]) {
        assert.ok(path.posix.matchesGlob(character, `[${character}]`));
    }

    await findFiles(f.controller, f.vscode, "src/[id]", 3);
    assert.ok(path.posix.matchesGlob("src/[id]/page.ts", patterns[5]));
    assert.ok(!path.posix.matchesGlob("src/i/page.ts", patterns[5]));
});

test("file suggestions discard older searches and stale workspace/session/trust results", async () => {
    for (const invalidate of [
        (f) => (f.controller.generation += 1),
        (f) => (f.controller.sessionRevision += 1),
        (f) => (f.controller.workspace = { ...f.workspace }),
        (f) => (f.controller.disposed = true),
        (f) => (f.controller.isForeground = () => false),
        (f) => (f.vscode.workspace.isTrusted = false),
        (f) => (f.vscode.workspace.workspaceFolders = []),
    ]) {
        const f = fixture();
        const gate = deferred();
        f.vscode.workspace.findFiles = () => gate.promise;
        const pending = findFiles(f.controller, f.vscode, "", 1);
        invalidate(f);
        gate.resolve([uri(path.join(f.root, "a.js"))]);
        await pending;
        assert.deepEqual(f.posts, []);
    }

    const f = fixture();
    const first = deferred();
    f.vscode.workspace.findFiles = () => first.promise;
    const old = findFiles(f.controller, f.vscode, "", 1);
    f.vscode.workspace.findFiles = async () => [uri(path.join(f.root, "new.js"))];
    await findFiles(f.controller, f.vscode, "", 2);
    first.resolve([uri(path.join(f.root, "old.js"))]);
    await old;
    assert.deepEqual(
        f.posts.map((post) => post.requestId),
        [2],
    );
});

test("stale file-search failures do not surface errors in a replacement workspace or newer search", async () => {
    const f = fixture();
    let rejectSearch;
    f.vscode.workspace.findFiles = () =>
        new Promise((_resolve, reject) => {
            rejectSearch = reject;
        });
    const pending = findFiles(f.controller, f.vscode, "", 1);
    f.controller.workspace = { ...f.workspace };
    rejectSearch(new Error("Old workspace search failed."));
    await pending;
    assert.deepEqual(f.posts, []);

    f.controller.workspace = f.workspace;
    const old = findFiles(f.controller, f.vscode, "", 2);
    const rejectOld = rejectSearch;
    f.vscode.workspace.findFiles = async () => [];
    await findFiles(f.controller, f.vscode, "", 3);
    rejectOld(new Error("Superseded search failed."));
    await old;
    assert.deepEqual(
        f.posts.map((post) => post.requestId),
        [3],
    );
    f.vscode.workspace.findFiles = async () => {
        throw new Error("Current search failed.");
    };

    await assert.rejects(findFiles(f.controller, f.vscode, "", 4), /Current search failed/u);
});

test("stale Git status and picker failures do not surface errors in a replacement workspace", async (t) => {
    for (const stage of ["status", "picker"]) {
        const f = await diskFixture(t);
        const { repo } = installGit(f, { workingTreeChanges: [change(f, 5)] });
        const entered = deferred();
        let rejectOperation;
        const failLater = () => {
            entered.resolve();

            return new Promise((_resolve, reject) => {
                rejectOperation = reject;
            });
        };

        if (stage === "status") {
            repo.status = failLater;
        } else {
            f.vscode.window.showQuickPick = failLater;
        }

        const pending = reviewChanges(f.controller, f.vscode);
        await entered.promise;
        f.controller.workspace = { ...f.workspace };
        rejectOperation(new Error(`Old ${stage} failed.`));
        await pending;
        assert.ok(!f.calls.some(([type]) => type.startsWith("vscode.")));
    }

    const current = await diskFixture(t);
    const { repo } = installGit(current, {});
    repo.status = async () => {
        throw new Error("Current Git status failed.");
    };

    await assert.rejects(reviewChanges(current.controller, current.vscode), /Current Git status failed/u);
});

test("Git review cancels delayed native UI and errors after its conversation loses foreground", async (t) => {
    for (const stage of ["activation", "status", "picker"]) {
        for (const fail of [false, true]) {
            const f = await diskFixture(t);
            let foreground = true;
            f.controller.isForeground = () => foreground;
            const { repo } = installGit(f, { workingTreeChanges: [change(f, 5)] });
            const entered = deferred();
            const operation = deferred();
            let result;
            const pause = () => {
                entered.resolve();

                return operation.promise;
            };

            if (stage === "activation") {
                const extension = f.vscode.extensions.getExtension("vscode.git");
                result = extension.exports;
                f.vscode.extensions.getExtension = () => ({ ...extension, isActive: false, activate: pause });
            } else if (stage === "status") {
                repo.status = pause;
            } else {
                f.vscode.window.showQuickPick = (items) => {
                    result = items[0];

                    return pause();
                };
            }

            const pending = reviewChanges(f.controller, f.vscode);
            await entered.promise;
            const calls = [...f.calls];
            foreground = false;
            if (fail) {
                operation.reject(new Error(`Background ${stage} failed.`));
            } else {
                operation.resolve(result);
            }

            await pending;
            assert.deepEqual(f.calls, calls, stage);
            assert.deepEqual(f.notifications, [], stage);
        }
    }
});

test("Git review suppresses empty-change notifications after a background repository becomes unavailable", async (t) => {
    const f = await diskFixture(t);
    const repositoryRoot = path.join(f.root, "src");
    installGit(f, {}, { root: repositoryRoot });
    const entered = deferred();
    const canonicalRoot = deferred();
    const realpath = fs.realpath;
    t.mock.method(fs, "realpath", (filePath, ...args) => {
        if (filePath === repositoryRoot) {
            entered.resolve();

            return canonicalRoot.promise;
        }

        return realpath(filePath, ...args);
    });
    const pending = reviewChanges(f.controller, f.vscode);
    await entered.promise;
    f.controller.isForeground = () => false;
    canonicalRoot.reject(Object.assign(new Error("Repository was removed."), { code: "ENOENT" }));
    await pending;
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.notifications, []);
});

test("Git review activates Git API and opens working tree diff with its index-aware baseline", async (t) => {
    const f = await diskFixture(t);
    const selected = change(f, 5);
    installGit(f, { workingTreeChanges: [selected] }, { active: false });
    await reviewChanges(f.controller, f.vscode);
    assert.ok(f.calls.some(([type]) => type === "activate"));
    const picker = f.calls.find(([type]) => type === "picker");
    assert.equal(picker[2].title, "Workspace changes");
    assert.match(picker[2].placeHolder, /before this chat/u);
    assert.match(picker[1][0].description, /Working tree/u);
    const opened = f.calls.find(([type]) => type === "vscode.diff");
    assert.equal(JSON.parse(opened[1].query).ref, "~");
    assert.equal(opened[2], selected.uri);
    assert.match(opened[3], /^Workspace changes/u);
    assert.deepEqual(opened[4], { preview: false });
});

test("staged and working changes stay distinct, and staged diff compares HEAD to index", async (t) => {
    const f = await diskFixture(t);
    installGit(f, { workingTreeChanges: [change(f, 5)], indexChanges: [change(f, 0)] });
    f.vscode.window.showQuickPick = async (items) => {
        assert.equal(items.length, 2);

        return items.find((item) => item.group === "indexChanges");
    };

    await reviewChanges(f.controller, f.vscode);
    const opened = f.calls.find(([type]) => type === "vscode.diff");
    assert.equal(opened[1].scheme, "git");
    assert.equal(JSON.parse(opened[1].query).ref, "HEAD");
    assert.equal(opened[2].scheme, "git");
    assert.equal(JSON.parse(opened[2].query).ref, "");
});

test("staged rename uses the deleted original path and index version of its new path", async (t) => {
    const f = await diskFixture(t);
    const renamed = change(f, 3, "src/file.js", "removed-folder/old.js");
    installGit(f, { indexChanges: [renamed] });
    await reviewChanges(f.controller, f.vscode);
    const opened = f.calls.find(([type]) => type === "vscode.diff");
    assert.equal(JSON.parse(opened[1].query).path, renamed.originalUri.fsPath);
    assert.equal(JSON.parse(opened[2].query).path, renamed.uri.fsPath);
});

test("additions, deletions, and untracked files open the appropriate native document", async (t) => {
    for (const [group, status, file, ref] of [
        ["indexChanges", 1, "src/file.js", ""],
        ["indexChanges", 2, "src/deleted.js", "HEAD"],
        ["workingTreeChanges", 6, "removed/deleted.js", "~"],
        ["untrackedChanges", 7, "src/file.js", undefined],
    ]) {
        const f = await diskFixture(t);
        installGit(f, { [group]: [change(f, status, file)] });
        await reviewChanges(f.controller, f.vscode);
        const opened = f.calls.find(([type]) => type === "vscode.open");
        assert.ok(opened);
        if (ref === undefined) {
            assert.equal(opened[1].scheme, "file");
        } else {
            assert.equal(JSON.parse(opened[1].query).ref, ref);
        }
    }
});

test("Git review filters private and unrelated paths before showing its picker", async (t) => {
    const f = await diskFixture(t);
    installGit(f, {
        workingTreeChanges: [
            change(f, 5),
            change(f, 5, ".env"),
            change(f, 5, "../outside.js"),
            change(f, 5, ".pi/sessions/a.jsonl"),
            change(f, 5, "src/file.js", ".env"),
            { ...change(f, 5), uri: uri(path.join(f.root, "src/file.js"), { scheme: "command" }) },
        ],
    });
    f.vscode.window.showQuickPick = async (items) => {
        assert.equal(items.length, 1);

        return undefined;
    };

    await reviewChanges(f.controller, f.vscode);
    assert.ok(!f.calls.some(([type]) => type.startsWith("vscode.")));
});

test("Git review validates canonical paths and rejects outside hardlinks before opening", async (t) => {
    const f = await diskFixture(t);
    await fs.link(path.join(f.root, "src/file.js"), path.join(f.root, "hardlink.js"));
    installGit(f, { workingTreeChanges: [change(f, 5, "hardlink.js")] });
    await assert.rejects(reviewChanges(f.controller, f.vscode), /hard links/u);
    assert.ok(!f.calls.some(([type]) => type.startsWith("vscode.")));
});

test("Git review rejects current and deleted paths reached through outside directory links", async (t) => {
    const f = await diskFixture(t);
    const external = await diskFixture(t);
    const link = path.join(f.root, "linked");
    try {
        await fs.symlink(path.join(external.root, "src"), link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
        if (error.code === "EPERM" || error.code === "EACCES") {
            t.skip("This host does not allow creating directory links.");

            return;
        }

        throw error;
    }

    installGit(f, { workingTreeChanges: [change(f, 5, "linked/file.js")] });
    await assert.rejects(reviewChanges(f.controller, f.vscode), /outside the workspace/u);
    installGit(f, { workingTreeChanges: [change(f, 6, "linked/deleted.js")] });
    await assert.rejects(reviewChanges(f.controller, f.vscode), /parent cannot be opened safely/u);
    assert.ok(!f.calls.some(([type]) => type.startsWith("vscode.")));

    let outsideStatus = 0;
    const { repo } = installGit(f, {}, { root: link });
    repo.status = async () => {
        outsideStatus += 1;
    };

    await reviewChanges(f.controller, f.vscode);
    assert.equal(outsideStatus, 0);
});

test("Git review scopes parent repositories to the selected folder and includes safe nested repositories", async (t) => {
    const f = await diskFixture(t);
    const { api } = installGit(
        f,
        { workingTreeChanges: [change(f, 5), change(f, 5, "../sibling/file.js")] },
        { root: path.dirname(f.root) },
    );
    let nestedStatus = 0;
    let privateStatus = 0;
    api.repositories.push({
        rootUri: uri(path.join(f.root, "src")),
        state: { indexChanges: [change(f, 0)] },
        async status() {
            nestedStatus += 1;
        },
    });
    api.repositories.push({
        rootUri: uri(path.join(f.root, ".pi")),
        state: {},
        async status() {
            privateStatus += 1;
        },
    });
    f.vscode.window.showQuickPick = async (items) => {
        assert.equal(items.length, 2);
        assert.ok(items.every((item) => item.label === "src/file.js"));

        return undefined;
    };

    await reviewChanges(f.controller, f.vscode);
    assert.equal(nestedStatus, 1);
    assert.equal(privateStatus, 0);
});

test("Git review discards picker results after trust, generation, session, workspace, or foreground changes", async (t) => {
    for (const invalidate of [
        (f) => (f.controller.generation += 1),
        (f) => (f.controller.sessionRevision += 1),
        (f) => (f.controller.workspace = { ...f.workspace }),
        (f) => (f.vscode.workspace.isTrusted = false),
        (f) => (f.controller.isForeground = () => false),
    ]) {
        const f = await diskFixture(t);
        installGit(f, { workingTreeChanges: [change(f, 5)] });
        f.vscode.window.showQuickPick = async (items) => {
            invalidate(f);

            return items[0];
        };

        await reviewChanges(f.controller, f.vscode);
        assert.ok(!f.calls.some(([type]) => type.startsWith("vscode.")));
    }
});

test("Git review rejects a changed Git entry instead of opening a stale selection", async (t) => {
    const f = await diskFixture(t);
    const { repo } = installGit(f, { workingTreeChanges: [change(f, 5)] });
    f.vscode.window.showQuickPick = async (items) => {
        repo.state.workingTreeChanges = [];

        return items[0];
    };

    await assert.rejects(reviewChanges(f.controller, f.vscode), /updated while the picker was open/u);
    assert.ok(!f.calls.some(([type]) => type.startsWith("vscode.")));
});

test("Git review provides useful empty/missing-Git fallbacks without staging or restoring", async (t) => {
    const missing = fixture();
    await reviewChanges(missing.controller, missing.vscode);
    assert.deepEqual(missing.calls, [["workbench.view.scm"]]);
    assert.match(missing.notifications[0], /unavailable/u);
    const empty = await diskFixture(t);
    installGit(empty, {});
    await reviewChanges(empty.controller, empty.vscode);
    assert.match(empty.notifications[0], /No reviewable changes/u);
    const unrelated = await diskFixture(t);
    installGit(unrelated, {}, { root: path.resolve(unrelated.root, "../another-repository") });
    await reviewChanges(unrelated.controller, unrelated.vscode);
    assert.deepEqual(unrelated.calls, [["workbench.view.scm"]]);
    assert.ok(![missing, empty, unrelated].some((f) => f.calls.some(([type]) => /stage|restore|checkout/u.test(type))));
});

test("file suggestions respect files.exclude, search.exclude, and the workspace .gitignore", async (t) => {
    const f = await diskFixture(t);
    await fs.writeFile(path.join(f.root, "generated.js"), "generated\n");
    await fs.writeFile(path.join(f.root, "notes.log"), "log\n");
    await fs.writeFile(path.join(f.root, "keep.log"), "kept log\n");
    await fs.mkdir(path.join(f.root, "dist"));
    await fs.writeFile(path.join(f.root, "dist", "bundle.js"), "bundle\n");
    await fs.writeFile(path.join(f.root, "src", "generated.js"), "nested generated\n");
    await fs.writeFile(path.join(f.root, ".gitignore"), "*.log\n!keep.log\ndist/\n");
    f.vscode.workspace.getConfiguration = (section) => ({
        get(property) {
            if (section === "files" && property === "exclude") {
                return { "**/generated.js": true };
            }

            if (section === "search" && property === "exclude") {
                return { "**/extra.tmp": true };
            }

            return undefined;
        },
    });
    f.vscode.workspace.findFiles = async (pattern) =>
        ["generated.js", "notes.log", "keep.log", "dist/bundle.js", "src/generated.js"]
            .filter((name) => path.posix.matchesGlob(name, pattern.pattern) || pattern.pattern.includes("*/**"))
            .map((name) => uri(path.join(f.root, name)));

    await findFiles(f.controller, f.vscode, "generated", "q1");
    // files.exclude applies at any depth; .gitignore does not re-include settings exclusions.
    assert.deepEqual(f.posts[0].files, []);
    await findFiles(f.controller, f.vscode, "log", "q2");
    assert.deepEqual(
        f.posts[1].files.map((file) => file.path),
        ["keep.log"],
    );
    await findFiles(f.controller, f.vscode, "dist", "q3");
    // The directory rule hides both the folder candidate and files beneath it.
    assert.deepEqual(f.posts[2].files, []);
    await findFiles(f.controller, f.vscode, "extra", "q4");
    assert.deepEqual(f.posts[3].files, []);
});

test("ignore reads reject linked, special, oversized and invalid files before using their rules", async (t) => {
    const f = await diskFixture(t);
    const ignore = path.join(f.root, ".gitignore");
    const hidden = () => workspaceHiddenFilter(f.vscode, f.workspace, f.root);
    const error = /regular, unlinked UTF-8 file of at most 64 KiB/u;
    // Both targets are synthetic. No real credential or private runtime file is read.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "specpi-ignore-outside-"));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    const targets = [path.join(outside, "example.txt"), path.join(f.root, ".env")];
    for (const target of targets) {
        await fs.writeFile(target, "outside-rule.txt\n");
        await fs.symlink(target, ignore);
        const open = t.mock.method(fs, "open", () => assert.fail("Linked ignore targets must not be opened"));
        await assert.rejects(hidden(), error);
        assert.equal(open.mock.callCount(), 0);
        open.mock.restore();
        await fs.unlink(ignore);
    }

    await fs.link(targets[0], ignore);
    await assert.rejects(hidden(), error);
    await fs.unlink(ignore);
    await fs.mkdir(ignore);
    await assert.rejects(hidden(), error);
    await fs.rmdir(ignore);
    // Simulate a FIFO/device on every platform and prove it is never opened.
    const stat = t.mock.method(fs, "lstat", async () => ({ isFile: () => false }));
    const open = t.mock.method(fs, "open", () => assert.fail("Special ignore files must not be opened"));
    await assert.rejects(hidden(), error);
    assert.equal(open.mock.callCount(), 0);
    stat.mock.restore();
    open.mock.restore();
    await fs.writeFile(ignore, "x".repeat(64 * 1024 + 1));
    await assert.rejects(hidden(), error);
    await fs.writeFile(ignore, Buffer.from([0xff]));
    await assert.rejects(hidden(), error);
});

test("ignore reads preserve valid rules, refresh content, and revalidate cached paths", async (t) => {
    const f = await diskFixture(t);
    const ignore = path.join(f.root, ".gitignore");
    const hidden = () => workspaceHiddenFilter(f.vscode, f.workspace, f.root);
    await fs.writeFile(ignore, "private-notes/\n[z-a]\n");
    assert.equal((await hidden())("private-notes/draft.txt"), true);
    assert.equal((await hidden())("public.txt"), false);
    await fs.writeFile(ignore, "*.log\n");
    assert.equal((await hidden())("private-notes/draft.txt"), false);
    assert.equal((await hidden())("error.log"), true);
    await fs.unlink(ignore);
    await fs.symlink(path.join(f.root, "src", "file.js"), ignore);
    await assert.rejects(hidden(), /regular, unlinked/u);
    await fs.unlink(ignore);
    assert.equal((await hidden())("error.log"), false);
});

test("search.useIgnoreFiles=false restores gitignored files in suggestions", async (t) => {
    const f = await diskFixture(t);
    await fs.writeFile(path.join(f.root, "notes.log"), "log\n");
    await fs.writeFile(path.join(f.root, ".gitignore"), "*.log\n");
    f.vscode.workspace.getConfiguration = (section) => ({
        get(property) {
            if (section === "search" && property === "useIgnoreFiles") {
                return false;
            }

            return {};
        },
    });
    f.vscode.workspace.findFiles = async () => [uri(path.join(f.root, "notes.log"))];

    await findFiles(f.controller, f.vscode, "log", "q1");
    assert.deepEqual(f.posts[0].files, [{ path: "notes.log", label: "notes.log", kind: "file" }]);
});

test("directory suggestions keep matching folders with kind and trailing slash", async (t) => {
    const f = await diskFixture(t);
    await fs.mkdir(path.join(f.root, "components", "inner"), { recursive: true });
    await fs.writeFile(path.join(f.root, "components", "button.tsx"), "button\n");
    await fs.writeFile(path.join(f.root, "components", "inner", "field.tsx"), "field\n");
    await fs.writeFile(path.join(f.root, ".gitignore"), "secret/\n");
    await fs.mkdir(path.join(f.root, "secretFolder"));
    await fs.writeFile(path.join(f.root, "secretFolder", "hidden.js"), "hidden\n");
    await fs.mkdir(path.join(f.root, "secret"));
    await fs.writeFile(path.join(f.root, "secret", "key.txt"), "key\n");
    f.vscode.workspace.getConfiguration = () => ({ get: () => ({}) });
    f.vscode.workspace.findFiles = async (pattern) =>
        ["components/button.tsx", "components/inner/field.tsx", "secretFolder/hidden.js", "secret/key.txt"]
            .filter((name) => path.posix.matchesGlob(name, pattern.pattern))
            .map((name) => uri(path.join(f.root, name)));

    await findFiles(f.controller, f.vscode, "components", "q1");
    const directories = f.posts[0].files.filter((file) => file.kind === "directory");
    assert.deepEqual(
        directories.map((file) => file.path),
        ["components/", "components/inner/"],
    );
    await findFiles(f.controller, f.vscode, "secret", "q2");
    // The gitignored secret/ directory never appears; the similarly named
    // secretFolder/ does, because it is not itself ignored.
    assert.deepEqual(
        f.posts[1].files.filter((file) => file.kind === "directory").map((file) => file.path),
        ["secretFolder/"],
    );
});
