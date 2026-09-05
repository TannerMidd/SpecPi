import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSnapshot } from "../extensions/delegation/snapshot.mjs";

function project(t, files = {}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-snapshot-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [relative, text] of Object.entries(files)) {
        const filename = path.join(root, relative);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, text);
    }

    return root;
}

function snapshot(t, root, paths, options) {
    const value = createSnapshot(root, paths, options);
    t.after(() => value.destroy());

    return value;
}

function bounded(value) {
    assert.ok(Buffer.byteLength(JSON.stringify(value), "utf8") <= 16 * 1024);
}

test("snapshots expose immutable descriptors and bounded reads of selected UTF-8 sources", (t) => {
    const original = "alpha\r\nβeta 🍎\r\ngamma\r\n";
    const root = project(t, { "src/demo.mjs": original, "unused.txt": "unselected text" });
    const value = snapshot(t, root, ["src/demo.mjs"]);
    assert.deepEqual(value.sources, [
        {
            id: "s1",
            path: "src/demo.mjs",
            digest: createHash("sha256").update(original).digest("hex"),
            bytes: Buffer.byteLength(original),
            lineCount: 3,
        },
    ]);
    assert.ok(Object.isFrozen(value));
    assert.ok(Object.isFrozen(value.sources));
    assert.ok(Object.isFrozen(value.sources[0]));
    assert.deepEqual(value.read("s1", 2, 1), {
        sourceId: "s1",
        digest: value.sources[0].digest,
        startLine: 2,
        endLine: 2,
        text: "βeta 🍎",
        truncated: false,
    });
    assert.equal(value.read("s1").text, "alpha\nβeta 🍎\ngamma");
    assert.deepEqual(value.search("unselected"), []);
    assert.equal(value.assertFresh(), undefined);
    assert.deepEqual(fs.readdirSync(root).sort(), ["src", "unused.txt"]);
});

test("read IDs and line bounds cannot expand selection", (t) => {
    const root = project(t, { "demo.ts": "one\ntwo\n", "empty.md": "" });
    const value = snapshot(t, root, ["demo.ts", "empty.md"]);
    for (const id of ["demo.ts", "../demo.ts", "s3", "s01", null, {}, 1]) {
        assert.throws(() => value.read(id), /Snapshot/);
    }

    for (const start of [0, -1, 1.2, 3, NaN, Infinity, "1"]) {
        assert.throws(() => value.read("s1", start), /Snapshot/);
    }

    for (const maximum of [0, -1, 1.2, 201, NaN, Infinity, "2"]) {
        assert.throws(() => value.read("s1", 1, maximum), /Snapshot/);
    }

    assert.equal(value.sources[1].lineCount, 0);
    assert.deepEqual(value.read("s2"), {
        sourceId: "s2",
        digest: value.sources[1].digest,
        startLine: 1,
        endLine: 0,
        text: "",
        truncated: false,
    });
});

test("read and literal case-sensitive search obey line and UTF-8 response quotas", (t) => {
    const root = project(t, {
        "many.txt": Array.from({ length: 250 }, (_, index) => `match ${index}`).join("\n"),
        "unicode.txt": Array.from({ length: 30 }, () => "🍎".repeat(250)).join("\n"),
        "huge.txt": "x".repeat(17000),
    });
    const value = snapshot(t, root, ["many.txt", "unicode.txt", "huge.txt"]);
    assert.equal(value.read("s1").endLine, 200);
    const read = value.read("s2");
    bounded(read);
    assert.equal(read.truncated, true);
    assert.ok(read.endLine > 1 && read.endLine < 30);
    assert.equal(read.text.includes("�"), false);
    const matches = value.search("match");
    assert.equal(matches.length, 20);
    assert.deepEqual(matches[0], { sourceId: "s1", line: 1, text: "match 0" });
    assert.equal(value.search("match", 2).length, 2);
    assert.deepEqual(value.search("Match"), []);
    assert.deepEqual(value.search(".*"), []);
    const unicodeMatches = value.search("🍎");
    bounded(unicodeMatches);
    assert.ok(unicodeMatches.length > 1 && unicodeMatches.length < 20);
    assert.throws(() => value.read("s3"), /response quota/);
    assert.throws(() => value.search("xxx"), /response quota/);
    for (const query of ["", "x".repeat(201), "\n", "\0", undefined, {}]) {
        assert.throws(() => value.search(query), /Snapshot/);
    }

    for (const limit of [0, -1, 21, 1.5, NaN, Infinity, "2"]) {
        assert.throws(() => value.search("match", limit), /Snapshot/);
    }
});

test("all paths are screened before filesystem reads and cannot escape the root", (t) => {
    const root = project(t, { "normal.md": "fixture" });
    const open = t.mock.method(fs, "openSync", () => {
        throw new Error("Unexpected file read.");
    });
    const rejected = [
        "../outside.md",
        "sub/../../outside.md",
        "./normal.md",
        "sub//normal.md",
        "",
        "..\\outside.md",
        "/outside.md",
        "C:\\outside.md",
        "C:outside.md",
        "\\\\server\\share\\test.md",
        "normal.md:stream",
        "normal.md\0",
        "normal.md ",
        "sub./normal.md",
        "*.md",
        "?.md",
        "NUL.md",
        "aux.txt",
        "con.md",
        "COM1.ts",
        "lpt9.txt",
        "COM¹.txt",
        ".git/config.json",
        ".pi/settings.json",
        ".codex/config.toml",
        ".ssh/config.json",
        "src/auth.json",
        "src/provider-auth.ts",
        "secrets/config.json",
        "credentials.json",
        "session/data.json",
        "sessions/data.json",
        "history/log.md",
        "missions/plan.md",
        "trust.json",
        ".env",
        ".env.local",
        "nested/.env.json",
        "image.png",
        "archive.zip",
        "program.exe",
    ];
    for (const relative of rejected) {
        assert.throws(() => createSnapshot(root, ["normal.md", relative]), /^Error: Snapshot creation rejected\.$/);
    }

    assert.throws(() => createSnapshot(root, ["normal.md", "normal.md"]), /Snapshot/);
    assert.throws(() => createSnapshot(root, [null]), /Snapshot/);
    assert.throws(() => createSnapshot(root, "normal.md"), /Snapshot/);
    assert.throws(() => createSnapshot(path.join(root, ".pi"), []), /Snapshot/);
    assert.equal(open.mock.callCount(), 0);
    open.mock.restore();
});

test("search scopes cannot reveal sibling files or spend the caller's result quota", (t) => {
    const root = project(t, {
        "sibling.md": "match sibling one\nmatch sibling two\n",
        "selected.md": "match selected one\nmatch selected two\n",
    });
    const value = snapshot(t, root, ["sibling.md", "selected.md"]);
    assert.deepEqual(value.search("match", 1, new Set(["s2"])), [
        { sourceId: "s2", line: 1, text: "match selected one" },
    ]);
    assert.equal(value.search("match", 20, new Set(["s2"])).length, 2);
    assert.deepEqual(value.search("sibling", 20, new Set(["s2"])), []);
    assert.deepEqual(value.search("match", 20, new Set()), []);
    for (const scope of [new Set(["s3"]), new Set(["s1", "s3"]), new Set([null]), ["s1"], null, {}]) {
        assert.throws(() => value.search("match", 20, scope), /Snapshot search scope rejected/);
    }
});

test("snapshot rejects directories, hard links, binary content, and invalid UTF-8", (t) => {
    const root = project(t, {
        "normal.md": "fixture",
        "binary.txt": Buffer.from([65, 0, 66]),
        "invalid.txt": Buffer.from([0xc3, 0x28]),
        "control.txt": Buffer.from([65, 27, 66]),
    });
    fs.mkdirSync(path.join(root, "folder.md"));
    fs.linkSync(path.join(root, "normal.md"), path.join(root, "linked.md"));
    for (const relative of [
        "normal.md",
        "linked.md",
        "folder.md",
        "binary.txt",
        "invalid.txt",
        "control.txt",
        "missing.md",
    ]) {
        assert.throws(() => createSnapshot(root, [relative]), /Snapshot creation rejected/);
    }
});

test("snapshot rejects selected directory junction redirects", (t) => {
    const root = project(t, { "normal.md": "fixture", "real/nested.md": "nested fixture" });
    try {
        fs.symlinkSync(
            path.join(root, "real"),
            path.join(root, "redirect"),
            process.platform === "win32" ? "junction" : "dir",
        );
    } catch (error) {
        if (error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOTSUP") {
            t.skip("Platform does not permit symlink/junction creation.");

            return;
        }

        throw error;
    }

    assert.throws(() => createSnapshot(root, ["redirect/nested.md"]), /Snapshot/);
    assert.throws(() => createSnapshot(path.join(root, "redirect"), ["nested.md"]), /Snapshot/);
});

test("snapshot rejects selected file symlinks", (t) => {
    const root = project(t, { "normal.md": "fixture" });
    try {
        fs.symlinkSync(path.join(root, "normal.md"), path.join(root, "link.md"), "file");
    } catch (error) {
        if (error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOTSUP") {
            t.skip("Platform does not permit file symlink creation.");

            return;
        }

        throw error;
    }

    assert.throws(() => createSnapshot(root, ["link.md"]), /Snapshot/);
});

test("aggregate file and byte quotas apply before capture and may only be lowered", (t) => {
    const root = project(t, {
        "one.txt": "1234",
        "two.txt": "5678",
        "large.txt": Buffer.alloc(8 * 1024 * 1024 + 1, 65),
    });
    assert.equal(snapshot(t, root, ["one.txt", "two.txt"], { maxFiles: 2, maxBytes: 8 }).sources.length, 2);
    assert.throws(() => createSnapshot(root, ["one.txt", "two.txt"], { maxFiles: 1 }), /Snapshot/);
    assert.throws(() => createSnapshot(root, ["one.txt", "two.txt"], { maxBytes: 7 }), /Snapshot/);
    assert.throws(() => createSnapshot(root, ["large.txt"]), /Snapshot/);
    assert.throws(
        () =>
            createSnapshot(
                root,
                Array.from({ length: 201 }, (_, index) => `f${index}.md`),
            ),
        /Snapshot/,
    );
    for (const options of [
        { maxFiles: 201 },
        { maxBytes: 8 * 1024 * 1024 + 1 },
        { maxFiles: 0 },
        { maxBytes: -1 },
        { maxFiles: 1.5 },
        { maxBytes: "8" },
        null,
    ]) {
        assert.throws(() => createSnapshot(root, [], options), /Snapshot/);
    }

    assert.deepEqual(snapshot(t, root, []).sources, []);
});

test("capture rejects cross-file drift and closes every opened descriptor", (t) => {
    const root = project(t, { "one.md": "first", "two.md": "second" });
    const firstPath = path.join(root, "one.md");
    const secondInode = fs.statSync(path.join(root, "two.md"), { bigint: true }).ino;
    const originalRead = fs.readSync;
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    const descriptors = new Set();
    let changed = false;
    const open = t.mock.method(fs, "openSync", (...args) => {
        const descriptor = originalOpen(...args);
        descriptors.add(descriptor);

        return descriptor;
    });
    const close = t.mock.method(fs, "closeSync", (descriptor) => {
        originalClose(descriptor);
        descriptors.delete(descriptor);
    });
    const read = t.mock.method(fs, "readSync", (...args) => {
        const received = originalRead(...args);
        if (!changed && received > 0 && fs.fstatSync(args[0], { bigint: true }).ino === secondInode) {
            changed = true;
            fs.writeFileSync(firstPath, "drift");
        }

        return received;
    });
    assert.throws(() => createSnapshot(root, ["one.md", "two.md"]), /Snapshot creation rejected/);
    assert.equal(changed, true);
    assert.equal(descriptors.size, 0);
    read.mock.restore();
    close.mock.restore();
    open.mock.restore();
});

test("descriptor identity is checked before reading a raced replacement", (t) => {
    const root = project(t, { "demo.md": "fixture", "other.md": "another" });
    const demoPath = path.join(root, "demo.md");
    const originalOpen = fs.openSync;
    let replaced = false;
    const open = t.mock.method(fs, "openSync", (filename, ...args) => {
        if (!replaced && filename === demoPath) {
            replaced = true;
            fs.renameSync(demoPath, path.join(root, "old.md"));
            fs.renameSync(path.join(root, "other.md"), demoPath);
        }

        return originalOpen(filename, ...args);
    });
    const read = t.mock.method(fs, "readSync", () => {
        throw new Error("Replacement contents must not be read.");
    });
    assert.throws(() => createSnapshot(root, ["demo.md"]), /Snapshot creation rejected/);
    assert.equal(replaced, true);
    assert.equal(read.mock.callCount(), 0);
    read.mock.restore();
    open.mock.restore();
});

test("freshness rejects changed bytes while reads retain only the captured content", (t) => {
    const root = project(t, { "demo.md": "before\n" });
    const value = snapshot(t, root, ["demo.md"]);
    fs.writeFileSync(path.join(root, "demo.md"), "after!\n");
    assert.throws(() => value.assertFresh(), /^Error: Snapshot source unavailable or changed\.$/);
    assert.equal(value.read("s1").text, "before");
    assert.deepEqual(value.search("after"), []);
});

test("freshness rejects replacement identity, missing files, and new hard links", (t) => {
    const root = project(t, { "replacement.md": "same", "missing.md": "same", "linked.md": "same" });
    const replaced = snapshot(t, root, ["replacement.md"]);
    fs.renameSync(path.join(root, "replacement.md"), path.join(root, "old.md"));
    fs.writeFileSync(path.join(root, "replacement.md"), "same");
    assert.throws(() => replaced.assertFresh(), /Snapshot/);
    const missing = snapshot(t, root, ["missing.md"]);
    fs.unlinkSync(path.join(root, "missing.md"));
    assert.throws(() => missing.assertFresh(), /Snapshot/);
    const linked = snapshot(t, root, ["linked.md"]);
    fs.linkSync(path.join(root, "linked.md"), path.join(root, "alias.md"));
    assert.throws(() => linked.assertFresh(), /Snapshot/);
});

test("freshness checks directory identity without rejecting unrelated sibling changes", (t) => {
    const root = project(t, { "src/demo.md": "fixture" });
    const value = snapshot(t, root, ["src/demo.md"]);
    fs.writeFileSync(path.join(root, "src/sibling.md"), "ordinary fixture");
    value.assertFresh();
    fs.renameSync(path.join(root, "src"), path.join(root, "old"));
    fs.mkdirSync(path.join(root, "src"));
    fs.renameSync(path.join(root, "old/demo.md"), path.join(root, "src/demo.md"));
    assert.throws(() => value.assertFresh(), /Snapshot/);
});

test("destroy is idempotent and revokes all content operations without writing artifacts", (t) => {
    const root = project(t, { "demo.md": "retained fixture" });
    const value = snapshot(t, root, ["demo.md"]);
    value.destroy();
    value.destroy();
    assert.throws(() => value.read("s1"), /Snapshot closed/);
    assert.throws(() => value.search("fixture"), /Snapshot closed/);
    assert.throws(() => value.assertFresh(), /Snapshot closed/);
    assert.deepEqual(Object.keys(value.sources[0]), ["id", "path", "digest", "bytes", "lineCount"]);
    assert.deepEqual(fs.readdirSync(root), ["demo.md"]);
});
