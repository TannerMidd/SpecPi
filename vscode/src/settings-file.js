"use strict";

// The single guarded transaction Chat uses for every Pi settings file it
// writes: bounded read with link and identity checks, lock, revision check,
// backup, atomic replace, verification, and rollback on failure.
// permission-settings.js and pi-defaults.js both go through here so the
// hardening can never drift between two near-identical copies.

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const MISSING_REVISION = "missing";

const digest = (data) => createHash("sha256").update(data).digest("hex");

// Resolve the deepest existing ancestor before inspecting it. A relocated
// macOS home or a junctioned Windows profile puts a link in the ancestry of
// every settings file, which is ordinary and not a redirection we should
// refuse; what matters is that the path we finally write through resolves to
// real directories. Components below that ancestor do not exist yet and are
// checked, and optionally created, by walkDirectories.
function realDirectory(directory) {
    const pending = [];
    let current = directory;
    for (;;) {
        try {
            const resolved = fs.realpathSync(current);

            return pending.length ? path.join(resolved, ...pending.reverse()) : resolved;
        } catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
        }

        const parent = path.dirname(current);
        if (parent === current) {
            return directory;
        }

        pending.push(path.basename(current));
        current = parent;
    }
}

function walkDirectories(directory, options) {
    const parent = path.dirname(directory);
    if (parent !== directory) {
        walkDirectories(parent, options);
    }

    let stat;
    try {
        stat = fs.lstatSync(directory);
    } catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }

        if (options.missing) {
            throw options.missing(directory);
        }

        if (!options.create) {
            return;
        }

        fs.mkdirSync(directory, { mode: 0o700 });
        stat = fs.lstatSync(directory);
    }

    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(options.link);
    }
}

// Inspect only the chosen file's ancestry, never enumerate Pi state. `missing`
// turns an absent directory into a caller-worded error; without it an absent
// directory is either created (`create`) or simply accepted.
//
// `resolve` follows links before checking, which suits a path the user chose
// themselves: a relocated macOS home or a junctioned Windows profile puts a
// link above every file under it. Leave it off for any path that lives inside
// an opened workspace, where a repository could ship a link of its own to
// redirect the write.
function checkDirectories(directory, { create = false, resolve = false, missing, link } = {}) {
    walkDirectories(resolve ? realDirectory(directory) : directory, { create, missing, link });
}

// Read the raw file with link, identity, and size checks. The returned text
// keeps a leading BOM so backups and rollback stay byte-exact; callers that
// parse the text are responsible for stripping it (see parseJson).
function readFile(filename, { maxBytes, missingText = "{}", messages }) {
    let stat;
    try {
        stat = fs.lstatSync(filename);
    } catch (error) {
        if (error.code === "ENOENT") {
            return { path: filename, exists: false, text: missingText, revision: MISSING_REVISION };
        }

        throw error;
    }

    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) {
        throw new Error(messages.file);
    }

    const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let data;
    try {
        const opened = fs.fstatSync(fd);
        if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink !== 1 || !opened.isFile()) {
            throw new Error(messages.opening);
        }

        data = Buffer.alloc(maxBytes + 1);
        const length = fs.readSync(fd, data, 0, data.length, 0);
        if (length > maxBytes) {
            throw new Error(messages.size);
        }

        data = data.subarray(0, length);
    } finally {
        fs.closeSync(fd);
    }

    let text;
    try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
    } catch {
        throw new Error(messages.encoding);
    }

    return { path: filename, exists: true, text, revision: digest(data) };
}

// JSON.parse rejects a leading BOM, which readFile deliberately preserves.
function parseJson(text) {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

// Synchronous, bounded transaction. Callers recheck human and runtime
// authority immediately before this call; no asynchronous yield separates that
// check from the write. The lock coordinates Chat writers, and the revision
// also detects ordinary edits by terminals and other windows.
function replaceFile({ filename, text, read, revision, unchanged, messages }) {
    const revised = digest(Buffer.from(text, "utf8"));
    const lock = `${filename}.specpi-lock`;
    let lockFd;
    try {
        lockFd = fs.openSync(lock, "wx", 0o600);
    } catch (error) {
        if (error.code === "EEXIST") {
            throw new Error(messages.lock);
        }

        throw error;
    }

    const temporary = `${filename}.${randomUUID()}.tmp`;
    let backup;
    let replaced = false;
    let previous;
    try {
        previous = read();
        if (previous.revision !== revision) {
            throw new Error(messages.changed);
        }

        if (previous.exists && unchanged(previous)) {
            return { previous, saved: previous, changed: false };
        }

        if (previous.exists) {
            backup = `${filename}.${randomUUID()}.bak`;
            fs.writeFileSync(backup, previous.text, { flag: "wx", mode: 0o600 });
            if (digest(fs.readFileSync(backup)) !== previous.revision) {
                throw new Error(messages.backup);
            }
        }

        fs.writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
        if (read().revision !== previous.revision) {
            throw new Error(messages.during);
        }

        fs.renameSync(temporary, filename);
        replaced = true;
        const saved = read();
        if (saved.revision !== revised) {
            throw new Error(messages.verify);
        }

        return { previous, saved, backup, changed: true };
    } catch (error) {
        // Do not overwrite a later external edit while attempting rollback.
        if (replaced && read().revision === revised) {
            if (previous.exists) {
                fs.writeFileSync(temporary, previous.text, { flag: "wx", mode: 0o600 });
                fs.renameSync(temporary, filename);
            } else {
                fs.unlinkSync(filename);
            }
        }

        throw error;
    } finally {
        if (fs.existsSync(temporary)) {
            fs.unlinkSync(temporary);
        }

        fs.closeSync(lockFd);
        fs.unlinkSync(lock);
    }
}

module.exports = { MISSING_REVISION, digest, checkDirectories, readFile, parseJson, replaceFile };
