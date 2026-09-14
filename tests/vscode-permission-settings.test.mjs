import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { fields, parse, validate } = require("../vscode/media/permission-config.js");
const { configPath, loadPermissionSettings, savePermissionSettings } = require("../vscode/src/permission-settings.js");

function fixture(t) {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-permissions-")));
    const workspace = path.join(directory, "workspace");
    const home = path.join(directory, "home");
    fs.mkdirSync(workspace);
    fs.mkdirSync(home);
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const options = { env: {}, home };
    const load = (scope = "global") => loadPermissionSettings(workspace, scope, options);

    return { directory, workspace, home, options, load };
}

test("permission configuration exposes all current knobs, preserves order and supports JSON comments", () => {
    const text = `{
        // Synthetic policy; no live Pi state.
        "yoloMode": false,
        "permissionReviewLog": false,
        "debugLog": false,
        "doublePressToConfirm": true,
        "forwardingTimeoutMs": 1234,
        "promptMaxRows": 24,
        "promptFieldMaxWidth": 400,
        "reviewLogFieldMaxWidth": 1000,
        "permission": {"*":"ask", "bash":{"*":"deny", "git status":"allow"}, "path_write":{"*.env":{"action":"deny","reason":"Private"}}, "custom_tool":"ask"},
        "shellTools": {"bg_run":{"commandArgument":"command"}},
        "piInfrastructureReadPaths": ["~/docs/*"],
        "authorizerChain": [],
        "$schema": "https://example.invalid/schema.json",
        "toolInputPreviewMaxLength": 100
    }`;
    const config = validate(text);
    for (const [key] of fields) {
        assert.ok(Object.hasOwn(config, key), key);
    }

    assert.deepEqual(Object.keys(config.permission.bash), ["*", "git status"]);
    assert.equal(
        parse('{"$schema":"https://example.invalid/*not-comment*/"}').$schema,
        "https://example.invalid/*not-comment*/",
    );
    assert.deepEqual(validate("{}"), {});
});

test("invalid or unsupported settings cannot be silently dropped on save", () => {
    for (const text of [
        "null",
        "[]",
        "{",
        '{"yoloMode":true,}',
        '{"yoloMode":"true"}',
        '{"yolo":true}',
        '{"forwardingTimeoutMs":0}',
        '{"promptMaxRows":1.5}',
        '{"debugLog":null}',
        '{"permission":{"bash":"yes"}}',
        '{"permission":{"path_wrote":"deny"}}',
        '{"permission":{"bash":{"":"deny"}}}',
        '{"permission":{"":"deny"}}',
        '{"permission":{"bash":{"*":{"action":"allow"}}}}',
        '{"permission":{"bash":{"*":{"action":"deny","reason":1}}}}',
        '{"permission":{"__proto__":"allow"}}',
        '{"shellTools":{"bg_run":{}}}',
        '{"shellTools":{"bg_run":{"commandArgument":"command","typo":true}}}',
        '{"piInfrastructureReadPaths":[""]}',
        '{"authorizerChain":{}}',
        '{"permission":{"read":{"*":{"action":"deny","reason":"' + "x".repeat(501) + '"}}}}',
    ]) {
        assert.throws(() => validate(text), /JSON|configuration/u, text);
    }
});

test("paths honor the host Pi directory and bind project scope to the selected workspace", (t) => {
    const f = fixture(t);
    assert.equal(
        configPath(f.workspace, "global", f.options),
        path.join(f.home, ".pi", "agent", "extensions", "pi-permission-system", "config.json"),
    );
    for (const [agent, expected] of [
        ["~", f.home],
        ["~/custom", path.join(f.home, "custom")],
        ["~\\custom", process.platform === "win32" ? path.join(f.home, "custom") : path.join(f.workspace, "~\\custom")],
        ["~other", path.join(f.workspace, "~other")],
        ["custom", path.join(f.workspace, "custom")],
        [path.join(f.directory, "custom"), path.join(f.directory, "custom")],
    ]) {
        assert.equal(
            configPath(f.workspace, "global", { home: f.home, env: { PI_CODING_AGENT_DIR: agent } }),
            path.join(expected, "extensions", "pi-permission-system", "config.json"),
        );
    }

    assert.equal(
        f.load("project").path,
        path.join(f.workspace, ".pi", "extensions", "pi-permission-system", "config.json"),
    );
    assert.throws(() => f.load("../../escape"), /global or project/u);
});

test("loading is non-mutating; saves create only the selected config and retain verified backups", (t) => {
    const f = fixture(t);
    const initial = f.load();
    assert.equal(initial.exists, false);
    assert.equal(fs.existsSync(path.join(f.home, ".pi")), false);
    const firstText = '// retained comment\n{"permission":{"bash":{"*":"ask","git status":"allow"}}}\n';
    const first = savePermissionSettings(initial, firstText);
    assert.equal(fs.readFileSync(first.path, "utf8"), firstText);
    assert.equal(first.backup, undefined);
    const second = savePermissionSettings(first, '{"permission":{"bash":"deny"}}\n');
    assert.equal(fs.readFileSync(second.backup, "utf8"), firstText);
    assert.equal(second.revision, f.load().revision);
    assert.equal(f.load("project").exists, false);
    assert.deepEqual(
        fs.readdirSync(path.dirname(second.path)).sort(),
        [path.basename(second.backup), "config.json"].sort(),
    );
    if (process.platform !== "win32") {
        assert.equal(fs.statSync(second.path).mode & 0o777, 0o600);
        assert.equal(fs.statSync(second.backup).mode & 0o777, 0o600);
    }
});

test("invalid, oversized, conflicting and concurrently locked writes preserve disk contents", (t) => {
    const f = fixture(t);
    const initial = f.load();
    assert.throws(() => savePermissionSettings(initial, '{"yoloMode":"on"}'));
    assert.equal(fs.existsSync(path.dirname(initial.path)), false);
    assert.throws(() => savePermissionSettings(initial, JSON.stringify({ $schema: "é".repeat(40000) })), /64 KiB/u);
    const first = savePermissionSettings(initial, "{}\n");
    fs.writeFileSync(first.path, '{"permission":{"*":"deny"}}');
    assert.throws(() => savePermissionSettings(first, '{"yoloMode":true}'), /changed on disk/u);
    const current = f.load();
    fs.writeFileSync(`${current.path}.specpi-lock`, "");
    assert.throws(() => savePermissionSettings(current, '{"yoloMode":true}'), /saved elsewhere/u);
    fs.unlinkSync(`${current.path}.specpi-lock`);
    assert.equal(fs.readFileSync(first.path, "utf8"), current.text);
});

test("malformed existing JSON stays available for repair without losing its backup", (t) => {
    const f = fixture(t);
    const initial = f.load("project");
    fs.mkdirSync(path.dirname(initial.path), { recursive: true });
    fs.writeFileSync(initial.path, '{"yoloMode":');
    const loaded = f.load("project");
    assert.equal(loaded.text, '{"yoloMode":');
    const saved = savePermissionSettings(loaded, "{}\n");
    assert.equal(fs.readFileSync(saved.backup, "utf8"), loaded.text);
});

test("permission file access rejects links, hardlinks, oversized and non-UTF8 files", (t) => {
    const f = fixture(t);
    const filename = f.load().path;
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.mkdirSync(filename);
    assert.throws(() => f.load(), /regular file/u);
    fs.rmdirSync(filename);
    fs.writeFileSync(filename, Buffer.alloc(65537));
    assert.throws(() => f.load(), /64 KiB/u);
    fs.writeFileSync(filename, Buffer.from([0xff]));
    assert.throws(() => f.load(), /UTF-8/u);
    fs.writeFileSync(filename, "{}");
    fs.linkSync(filename, path.join(f.directory, "linked"));
    assert.throws(() => f.load(), /unlinked/u);
});

test("symlinked configuration ancestors cannot redirect reads or writes", (t) => {
    const f = fixture(t);
    const target = path.join(f.directory, "target");
    fs.mkdirSync(target);
    try {
        fs.symlinkSync(target, path.join(f.workspace, ".pi"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
        if (["EPERM", "EACCES"].includes(error.code)) {
            t.skip("Symlink creation is unavailable on this host.");

            return;
        }

        throw error;
    }

    assert.throws(() => f.load("project"), /links/u);
    assert.deepEqual(fs.readdirSync(target), []);
});

test("BOM-prefixed configurations can be repaired with byte-exact backups", (t) => {
    const f = fixture(t);
    const filename = f.load().path;
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const original = Buffer.from("\uFEFF{}\r\n");
    fs.writeFileSync(filename, original);
    const snapshot = f.load();
    assert.deepEqual(Buffer.from(snapshot.text), original);
    const saved = savePermissionSettings(snapshot, '{"yoloMode":false}\n');
    assert.deepEqual(fs.readFileSync(saved.backup), original);
    assert.equal(fs.readFileSync(filename, "utf8"), '{"yoloMode":false}\n');
});

for (const failure of [
    "backup-write",
    "backup-check",
    "temp-write",
    "rename",
    "verify",
    "external-edit",
    "new-file-verify",
]) {
    test(`permission transaction survives ${failure} failure`, (t) => {
        const f = fixture(t);
        const filename = f.load().path;
        const original = Buffer.from("\uFEFF{}\r\n");
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        if (failure !== "new-file-verify") {
            fs.writeFileSync(filename, original);
        }

        const snapshot = f.load();
        const write = fs.writeFileSync;
        const read = fs.readFileSync;
        const readSync = fs.readSync;
        const rename = fs.renameSync;
        let replaced = false;
        let injected = false;
        const ioError = () => Object.assign(new Error("Synthetic I/O failure"), { code: "EIO" });
        t.mock.method(fs, "writeFileSync", (target, ...args) => {
            if (
                (failure === "backup-write" && String(target).endsWith(".bak")) ||
                (failure === "temp-write" && String(target).endsWith(".tmp"))
            ) {
                injected = true;
                write(target, "partial", { flag: "wx", mode: 0o600 });
                throw ioError();
            }

            return write(target, ...args);
        });
        t.mock.method(fs, "readFileSync", (target, ...args) => {
            if (failure === "backup-check" && String(target).endsWith(".bak")) {
                injected = true;

                return Buffer.from("damaged backup");
            }

            return read(target, ...args);
        });
        t.mock.method(fs, "renameSync", (from, to) => {
            if (failure === "rename") {
                injected = true;
                throw ioError();
            }

            rename(from, to);
            replaced = true;
            if (failure === "external-edit") {
                injected = true;
                write(to, '{"permission":{"*":"deny"}}');
            }
        });
        t.mock.method(fs, "readSync", (...args) => {
            if (["verify", "new-file-verify"].includes(failure) && replaced && !injected) {
                injected = true;
                throw ioError();
            }

            return readSync(...args);
        });
        assert.throws(() => savePermissionSettings(snapshot, '{"yoloMode":true}'), /Synthetic I\/O|verified/u);
        t.mock.restoreAll();
        assert.equal(injected, true);
        if (failure === "new-file-verify") {
            assert.equal(fs.existsSync(filename), false);
        } else if (failure === "external-edit") {
            assert.equal(fs.readFileSync(filename, "utf8"), '{"permission":{"*":"deny"}}');
        } else {
            assert.deepEqual(fs.readFileSync(filename), original, "Original bytes must survive failure/rollback");
        }

        assert.equal(fs.existsSync(`${filename}.specpi-lock`), false);
        assert.equal(
            fs.readdirSync(path.dirname(filename)).some((name) => name.endsWith(".tmp")),
            false,
        );
        if (failure === "verify") {
            const backup = fs.readdirSync(path.dirname(filename)).find((name) => name.endsWith(".bak"));
            assert.deepEqual(fs.readFileSync(path.join(path.dirname(filename), backup)), original);
        }
    });
}
