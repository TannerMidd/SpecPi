import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SessionCatalog } from "../vscode/src/session-catalog.js";

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "specpi-vscode-sessions-")));
    const workspacePath = path.join(root, "workspace");
    const directory = path.join(root, "extension-storage");
    await fs.mkdir(workspacePath);
    const catalog = new SessionCatalog({ directory, workspacePath });
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await catalog.list();

    return { root, directory, workspacePath, catalog };
}

async function sessionFile(catalog, name = "session.jsonl") {
    const file = path.join(catalog.sessionDirectory, name);
    await fs.writeFile(file, "Synthetic transcript that the catalog must never read.\n");

    return file;
}

test("session catalog stores only bounded references and preserves transcripts when forgetting", async (t) => {
    const { directory, workspacePath, catalog } = await fixture(t);
    const file = await sessionFile(catalog);
    const record = await catalog.remember({
        sessionId: "session-one",
        sessionFile: file,
        sessionName: "  A useful\nchat\u0000 title  ",
        transcript: "This supplied extra field must not be retained.",
    });
    assert.deepEqual(record, {
        sessionId: "session-one",
        sessionName: "A useful chat  title",
        sessionFile: file,
        updatedAt: record.updatedAt,
        archived: false,
    });
    assert.ok(Number.isSafeInteger(record.updatedAt));
    assert.deepEqual(await catalog.list(), [record]);
    assert.deepEqual(await new SessionCatalog({ directory, workspacePath }).resolve("session-one"), record);
    const stored = JSON.parse(await fs.readFile(catalog.catalogFile, "utf8"));
    assert.deepEqual(stored, { version: 1, sessions: [record] });
    assert.equal(await catalog.remove("session-one"), true);
    assert.equal(await catalog.remove("session-one"), false);
    assert.equal(await catalog.resolve("session-one"), undefined);
    assert.deepEqual(await catalog.list(), []);
    assert.equal(await fs.readFile(file, "utf8"), "Synthetic transcript that the catalog must never read.\n");
    assert.deepEqual((await fs.readdir(catalog.directory)).sort(), ["catalog.json", "sessions"]);
});

test("session catalogs isolate workspaces and do not discover unregistered session files", async (t) => {
    const { directory, workspacePath, catalog } = await fixture(t);
    const file = await sessionFile(catalog);
    await sessionFile(catalog, "unregistered.jsonl");
    assert.deepEqual(await catalog.list(), []);
    const record = await catalog.remember({ sessionId: "registered", sessionFile: file });
    const other = new SessionCatalog({ directory, workspacePath: path.join(workspacePath, "other") });
    assert.notEqual(other.sessionDirectory, catalog.sessionDirectory);
    assert.deepEqual(await other.list(), []);
    await assert.rejects(other.remember({ sessionId: "other", sessionFile: file }), /own workspace storage/u);
    assert.deepEqual(await catalog.list(), [record]);
    assert.equal(record.sessionName, "New chat");
    assert.match(path.basename(catalog.directory), /^[a-f0-9]{64}$/u);
});

test("session catalog resolves workspace aliases into the same storage identity", async (t) => {
    const { root, directory, workspacePath, catalog } = await fixture(t);
    const alias = path.join(root, "workspace-alias");

    try {
        await fs.symlink(workspacePath, alias, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
        if (error.code === "EPERM" || error.code === "EACCES") {
            t.skip("Creating a workspace alias requires symlink privileges on this host.");

            return;
        }

        throw error;
    }

    const aliased = new SessionCatalog({ directory, workspacePath: alias });
    assert.equal(aliased.sessionDirectory, catalog.sessionDirectory);
});

test("session references reject traversal, outside paths, invalid identifiers, and non-files", async (t) => {
    const { root, catalog } = await fixture(t);
    const file = await sessionFile(catalog);
    const outside = path.join(root, "outside.jsonl");
    await fs.writeFile(outside, "Synthetic unrelated data.");

    for (const sessionPath of [
        outside,
        "session.jsonl",
        `${catalog.sessionDirectory}${path.sep}..${path.sep}sessions${path.sep}session.jsonl`,
        catalog.sessionDirectory,
    ]) {
        await assert.rejects(catalog.remember({ sessionId: "invalid-path", sessionFile: sessionPath }));
    }

    for (const sessionId of ["", "../escape", "has whitespace", "nul\0value", "x".repeat(129)]) {
        await assert.rejects(catalog.remember({ sessionId, sessionFile: file }), /invalid session identifier/u);
    }

    assert.equal(await catalog.resolve("../escape"), undefined);
    assert.equal(
        await catalog.remember({
            sessionId: "pending",
            sessionFile: path.join(catalog.sessionDirectory, "missing.jsonl"),
        }),
        null,
    );
    assert.deepEqual(await catalog.list(), []);
    assert.equal(await fs.readFile(outside, "utf8"), "Synthetic unrelated data.");
});

test("session references reject linked directories and hard links without reading their contents", async (t) => {
    const { root, catalog } = await fixture(t);
    const outsideDirectory = path.join(root, "outside");
    await fs.mkdir(outsideDirectory);
    const outside = path.join(outsideDirectory, "unrelated.jsonl");
    await fs.writeFile(outside, "Synthetic unrelated data.");
    const linkedFile = path.join(catalog.sessionDirectory, "hardlink.jsonl");
    await fs.link(outside, linkedFile);
    await assert.rejects(catalog.remember({ sessionId: "hardlink", sessionFile: linkedFile }), /unlinked files/u);
    const linkedDirectory = path.join(catalog.sessionDirectory, "linked");

    try {
        await fs.symlink(outsideDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
        if (error.code === "EPERM" || error.code === "EACCES") {
            t.diagnostic("Directory symlink assertion skipped because this host denies symlink creation.");

            return;
        }

        throw error;
    }

    await assert.rejects(
        catalog.remember({ sessionId: "symlink", sessionFile: path.join(linkedDirectory, "unrelated.jsonl") }),
        /symbolic links/u,
    );
    assert.deepEqual(await catalog.list(), []);
    assert.equal(await fs.readFile(outside, "utf8"), "Synthetic unrelated data.");
});

test("catalog storage refuses symbolic link redirection before creating session directories", async (t) => {
    const { root, workspacePath } = await fixture(t);
    const outsideDirectory = path.join(root, "outside-storage");
    await fs.mkdir(outsideDirectory);
    const linkedStorage = path.join(root, "linked-storage");

    try {
        await fs.symlink(outsideDirectory, linkedStorage, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
        if (error.code === "EPERM" || error.code === "EACCES") {
            t.skip("Creating a storage alias requires symlink privileges on this host.");

            return;
        }

        throw error;
    }

    const catalog = new SessionCatalog({ directory: linkedStorage, workspacePath });
    await assert.rejects(catalog.list(), /symbolic links/u);
    assert.deepEqual(await fs.readdir(outsideDirectory), []);
});

test("catalog survives concurrent remembers, keeps latest ordering, and preserves an existing name", async (t) => {
    const { directory, workspacePath, catalog } = await fixture(t);
    const secondCatalog = new SessionCatalog({ directory, workspacePath });
    const first = await sessionFile(catalog, "first.jsonl");
    const second = await sessionFile(catalog, "second.jsonl");
    await Promise.all([
        catalog.remember({ sessionId: "first", sessionFile: first, sessionName: "First title" }),
        secondCatalog.remember({ sessionId: "second", sessionFile: second, sessionName: "Second title" }),
    ]);
    assert.deepEqual(
        (await catalog.list()).map((record) => record.sessionId),
        ["second", "first"],
    );
    const updated = await catalog.remember({ sessionId: "first", sessionFile: first });
    assert.deepEqual((await catalog.list())[0], updated);
    assert.equal(updated.sessionName, "First title");
    await catalog.remember({ sessionId: "first", sessionFile: first, sessionName: "x".repeat(400) });
    assert.equal((await catalog.resolve("first")).sessionName.length, 160);
    await fs.unlink(first);
    assert.equal(await catalog.resolve("first"), undefined);
    assert.equal((await catalog.list()).length, 1);
});

test("renaming and archiving preserve conversation recency and survive later session refreshes", async (t) => {
    const { directory, workspacePath, catalog } = await fixture(t);
    const file = await sessionFile(catalog);
    const first = await catalog.remember({ sessionId: "first", sessionFile: file, sessionName: "Original" });
    const second = await catalog.remember({ sessionId: "second", sessionFile: file, sessionName: "Latest" });
    const renamed = await catalog.rename("first", "  Planned\nwork\u0000  ");
    assert.deepEqual(renamed, { ...first, sessionName: "Planned work" });
    const archived = await catalog.setArchived("first", true);
    assert.deepEqual(archived, { ...renamed, archived: true });
    const reopened = new SessionCatalog({ directory, workspacePath });
    assert.deepEqual(await reopened.list(), [second, archived]);
    const refreshed = await reopened.remember({ sessionId: "first", sessionFile: file });
    assert.equal(refreshed.sessionName, "Planned work");
    assert.equal(refreshed.archived, true);
    const restored = await catalog.setArchived("first", false);
    assert.deepEqual(restored, { ...refreshed, archived: false });
    assert.deepEqual(await catalog.list(), [restored, second]);
    await catalog.rename("first", "x".repeat(400));
    assert.equal((await catalog.resolve("first")).sessionName.length, 160);
    assert.equal(await catalog.rename("missing", "Name"), undefined);
    assert.equal(await catalog.setArchived("missing", true), undefined);
    assert.equal(await catalog.rename("../escape", "Name"), undefined);
    assert.equal(await catalog.setArchived("../escape", true), undefined);
    await assert.rejects(catalog.rename("first", null), /text conversation name/u);

    for (const value of [undefined, null, "true", 1, {}]) {
        await assert.rejects(catalog.setArchived("first", value), /boolean conversation archive state/u);
    }

    assert.equal(await fs.readFile(file, "utf8"), "Synthetic transcript that the catalog must never read.\n");
});

test("version one catalogs without archive metadata remain usable and validate new archive fields", async (t) => {
    const { catalog } = await fixture(t);
    const file = await sessionFile(catalog);
    const legacy = { sessionId: "legacy", sessionName: "Original", sessionFile: file, updatedAt: 1234 };
    const data = JSON.stringify({ version: 1, sessions: [legacy] });
    await fs.writeFile(catalog.catalogFile, data);
    assert.deepEqual(await catalog.list(), [{ ...legacy, archived: false }]);
    assert.equal(await fs.readFile(catalog.catalogFile, "utf8"), data, "Reading must not migrate metadata");
    await catalog.setArchived("legacy", true);
    assert.deepEqual(await catalog.resolve("legacy"), { ...legacy, archived: true });

    for (const archived of [null, "false", 0, [], {}]) {
        const malformed = JSON.stringify({ version: 1, sessions: [{ ...legacy, archived }] });
        await fs.writeFile(catalog.catalogFile, malformed);
        await assert.rejects(catalog.list(), /invalid metadata/u);
        await assert.rejects(catalog.rename("legacy", "Changed"), /invalid metadata/u);
        await assert.rejects(catalog.setArchived("legacy", false), /invalid metadata/u);
        assert.equal(await fs.readFile(catalog.catalogFile, "utf8"), malformed);
    }
});

test("concurrent refresh, rename, and archive updates retain all metadata across catalog instances", async (t) => {
    const { directory, workspacePath, catalog } = await fixture(t);
    const other = new SessionCatalog({ directory, workspacePath });
    const file = await sessionFile(catalog);
    await catalog.remember({ sessionId: "shared", sessionFile: file, sessionName: "Original" });
    await Promise.all([
        catalog.rename("shared", "Renamed"),
        other.setArchived("shared", true),
        catalog.remember({ sessionId: "shared", sessionFile: file }),
    ]);
    const record = await other.resolve("shared");
    assert.equal(record.sessionName, "Renamed");
    assert.equal(record.archived, true);
    assert.deepEqual((await fs.readdir(catalog.directory)).sort(), ["catalog.json", "sessions"]);
});

test("catalog bounds metadata and retains the latest 200 references", async (t) => {
    const { catalog } = await fixture(t);
    const file = await sessionFile(catalog);
    const sessions = Array.from({ length: 200 }, (_, index) => ({
        sessionId: `session-${index}`,
        sessionName: "Title",
        sessionFile: file,
        updatedAt: 1,
    }));
    await fs.writeFile(catalog.catalogFile, JSON.stringify({ version: 1, sessions }));
    await catalog.remember({ sessionId: "newest", sessionFile: file });
    const records = await catalog.list();
    assert.equal(records.length, 200);
    assert.equal(records[0].sessionId, "newest");
    assert.equal(records.at(-1).sessionId, "session-198");
    assert.ok((await fs.stat(catalog.catalogFile)).size <= 256 * 1024);
    const oversized = " ".repeat(256 * 1024 + 1);
    await fs.writeFile(catalog.catalogFile, oversized);
    await assert.rejects(catalog.list(), /bounded regular file/u);
    await assert.rejects(catalog.remember({ sessionId: "new", sessionFile: file }), /bounded regular file/u);
    assert.equal((await fs.stat(catalog.catalogFile)).size, oversized.length);
});

test("catalog rejects corrupt or redirected metadata without overwriting it", async (t) => {
    const { root, catalog } = await fixture(t);
    const file = await sessionFile(catalog);
    const outside = path.join(root, "unrelated.jsonl");
    await fs.writeFile(outside, "Synthetic unrelated data.");

    for (const data of [
        "{invalid-json",
        JSON.stringify({ version: 2, sessions: [] }),
        JSON.stringify({
            version: 1,
            sessions: [{ sessionId: "bad", sessionName: "Title", sessionFile: outside, updatedAt: 1 }],
        }),
        JSON.stringify({
            version: 1,
            sessions: [{ sessionId: "bad", sessionName: "x".repeat(161), sessionFile: file, updatedAt: 1 }],
        }),
    ]) {
        await fs.writeFile(catalog.catalogFile, data);
        await assert.rejects(catalog.list());
        await assert.rejects(catalog.remember({ sessionId: "new", sessionFile: file }));
        assert.equal(await fs.readFile(catalog.catalogFile, "utf8"), data);
    }
});

test("catalog operations open metadata only and never open registered or unregistered transcripts", async (t) => {
    const { catalog } = await fixture(t);
    const file = await sessionFile(catalog);
    await sessionFile(catalog, "unregistered.jsonl");
    const originalOpen = fs.open.bind(fs);
    const opened = [];
    const mock = t.mock.method(fs, "open", async (target, ...args) => {
        opened.push(String(target));
        assert.notEqual(path.extname(String(target)), ".jsonl", "Catalog must never open a transcript");

        return originalOpen(target, ...args);
    });
    await catalog.remember({ sessionId: "registered", sessionFile: file });
    await catalog.list();
    await catalog.resolve("registered");
    await catalog.rename("registered", "Renamed");
    await catalog.setArchived("registered", true);
    await catalog.setArchived("registered", false);
    await catalog.remove("registered");
    mock.mock.restore();
    assert.ok(opened.includes(catalog.catalogFile));
});

test("independent extension processes retain concurrent session updates", { timeout: 15000 }, async (t) => {
    const { directory, workspacePath, catalog } = await fixture(t);
    const first = await sessionFile(catalog, "first-process.jsonl");
    const second = await sessionFile(catalog, "second-process.jsonl");
    const shared = await sessionFile(catalog, "shared-process.jsonl");
    await catalog.remember({ sessionId: "shared-process", sessionFile: shared, sessionName: "Original" });
    const modulePath = fileURLToPath(new URL("../vscode/src/session-catalog.js", import.meta.url));
    const source = `
        const { SessionCatalog } = require(process.argv[1]);
        const input = JSON.parse(process.argv[2]);
        const catalog = new SessionCatalog(input);
        const read = catalog._read.bind(catalog);
        catalog._read = async () => {
            const records = await read();
            await new Promise((resolve) => setTimeout(resolve, 150));
            return records;
        };
        process.once("message", async () => {
            try {
                if (input.operation === "rename") {
                    await catalog.rename(input.sessionId, "Renamed across processes");
                } else if (input.operation === "archive") {
                    await catalog.setArchived(input.sessionId, true);
                } else {
                    await catalog.remember(input);
                }
                process.disconnect();
            } catch (error) {
                process.stderr.write(error.message);
                process.exitCode = 1;
                process.disconnect();
            }
        });
        process.send("ready");
    `;

    function writer(sessionId, file, operation = "remember") {
        const child = spawn(
            process.execPath,
            [
                "--eval",
                source,
                modulePath,
                JSON.stringify({ directory, workspacePath, sessionId, sessionFile: file, operation }),
            ],
            { stdio: ["ignore", "ignore", "pipe", "ipc"] },
        );
        let errors = "";
        child.stderr.on("data", (chunk) => {
            errors += chunk;
        });
        const ready = new Promise((resolve, reject) => {
            child.once("message", resolve);
            child.once("error", reject);
            child.once("exit", (code) => {
                if (code !== 0) {
                    reject(new Error(`Session writer failed to start: ${errors}`));
                }
            });
        });
        const completed = new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Session writer failed: ${errors}`));
                }
            });
        });
        t.after(() => {
            if (child.exitCode === null) {
                child.kill();
            }
        });

        return { child, ready, completed };
    }

    const writers = [
        writer("first-process", first),
        writer("second-process", second),
        writer("shared-process", shared),
        writer("shared-process", shared, "rename"),
        writer("shared-process", shared, "archive"),
    ];
    await Promise.all(writers.map((entry) => entry.ready));

    for (const entry of writers) {
        entry.child.send("start");
    }

    await Promise.all(writers.map((entry) => entry.completed));
    assert.deepEqual((await catalog.list()).map((entry) => entry.sessionId).sort(), [
        "first-process",
        "second-process",
        "shared-process",
    ]);
    const sharedRecord = await catalog.resolve("shared-process");
    assert.equal(sharedRecord.sessionName, "Renamed across processes");
    assert.equal(sharedRecord.archived, true);
    assert.deepEqual((await fs.readdir(catalog.directory)).sort(), ["catalog.json", "sessions"]);
});

test("existing locks time out without deletion while read-only history remains available", async (t) => {
    const { catalog } = await fixture(t);
    const file = await sessionFile(catalog);
    const record = await catalog.remember({ sessionId: "saved", sessionFile: file });
    await fs.mkdir(catalog.lockDirectory);
    const started = performance.now();
    await assert.rejects(catalog.remove("saved"), { code: "SPECPI_CATALOG_LOCKED" });
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 2900 && elapsed < 6000, `Lock must have a bounded timeout; observed ${elapsed} ms`);
    assert.ok((await fs.stat(catalog.lockDirectory)).isDirectory());
    assert.deepEqual(await catalog.list(), [record]);
});

test("failed atomic writes preserve previous metadata and release only the acquired lock", async (t) => {
    const { catalog } = await fixture(t);
    const file = await sessionFile(catalog);
    const record = await catalog.remember({ sessionId: "saved", sessionFile: file });
    const original = await fs.readFile(catalog.catalogFile, "utf8");
    const originalRename = fs.rename.bind(fs);
    const mock = t.mock.method(fs, "rename", async (source, destination) => {
        if (destination === catalog.catalogFile) {
            const error = new Error("Synthetic atomic rename failure");
            error.code = "EACCES";

            throw error;
        }

        return originalRename(source, destination);
    });
    await assert.rejects(
        catalog.remember({ sessionId: "unsaved", sessionFile: file }),
        /Synthetic atomic rename failure/u,
    );
    await assert.rejects(catalog.rename("saved", "Unsaved title"), /Synthetic atomic rename failure/u);
    await assert.rejects(catalog.setArchived("saved", true), /Synthetic atomic rename failure/u);
    mock.mock.restore();
    assert.equal(await fs.readFile(catalog.catalogFile, "utf8"), original);
    assert.deepEqual(await catalog.list(), [record]);
    assert.deepEqual((await fs.readdir(catalog.directory)).sort(), ["catalog.json", "sessions"]);
    assert.equal(await catalog.remove("saved"), true);
});
