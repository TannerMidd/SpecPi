"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { constants, realpathSync } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_RECORDS = 200;
const MAX_CATALOG_BYTES = 256 * 1024;
const MAX_PATH_LENGTH = 4096;
const MAX_TITLE_LENGTH = 160;
const LOCK_TIMEOUT_MS = 3000;
const operations = new Map();

function pathKey(value) {
    const resolved = path.resolve(value);

    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function validId(value) {
    return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value);
}

function titleFor(value) {
    if (typeof value !== "string") {
        return "New chat";
    }

    return (
        value
            .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
            .trim()
            .slice(0, MAX_TITLE_LENGTH) || "New chat"
    );
}

async function assertNoSymlinks(target, allowMissing = false) {
    const resolved = path.resolve(target);
    const root = path.parse(resolved).root;
    let current = root;

    for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        let entry;

        try {
            entry = await fs.lstat(current);
        } catch (error) {
            if (allowMissing && error.code === "ENOENT") {
                return;
            }

            throw error;
        }

        if (entry.isSymbolicLink()) {
            throw new Error("SpecPi Chat storage must not contain symbolic links.");
        }
    }
}

/** Stores only the extension's own session references; never reads a Pi transcript. */
class SessionCatalog {
    constructor({ directory, workspacePath }) {
        if (typeof directory !== "string" || !path.isAbsolute(directory)) {
            throw new Error("SpecPi Chat requires an absolute storage directory.");
        }

        if (typeof workspacePath !== "string" || !path.isAbsolute(workspacePath)) {
            throw new Error("SpecPi Chat requires an absolute workspace path.");
        }

        let workspace = path.resolve(workspacePath);

        try {
            workspace = realpathSync(workspace);
        } catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
        }

        const workspaceId = createHash("sha256").update(pathKey(workspace)).digest("hex");
        this.directory = path.join(path.resolve(directory), "workspaces", workspaceId);
        this.sessionDirectory = path.join(this.directory, "sessions");
        this.catalogFile = path.join(this.directory, "catalog.json");
        this.lockDirectory = path.join(this.directory, "catalog.lock");
    }

    async list() {
        return this._serialize(async () => {
            await this._prepare();

            return this._read();
        });
    }

    async remember({ sessionId, sessionFile, sessionName } = {}) {
        if (!validId(sessionId)) {
            throw new Error("SpecPi Chat received an invalid session identifier.");
        }

        return this._mutate(async () => {
            let file;

            try {
                file = await this._sessionFile(sessionFile);
            } catch (error) {
                if (error.code === "ENOENT") {
                    return null;
                }

                throw error;
            }

            const records = await this._read();
            const previous = records.find((record) => record.sessionId === sessionId);
            const record = {
                sessionId,
                sessionName: sessionName === undefined && previous ? previous.sessionName : titleFor(sessionName),
                sessionFile: file,
                updatedAt: Date.now(),
                archived: previous?.archived || false,
            };
            await this._write(
                [record, ...records.filter((entry) => entry.sessionId !== sessionId)].slice(0, MAX_RECORDS),
            );

            return { ...record };
        });
    }

    async resolve(id) {
        if (!validId(id)) {
            return undefined;
        }

        const records = await this.list();

        return records.find((record) => record.sessionId === id);
    }

    async remove(id) {
        if (!validId(id)) {
            return false;
        }

        return this._mutate(async () => {
            const records = await this._read();
            const remaining = records.filter((record) => record.sessionId !== id);

            if (remaining.length === records.length) {
                return false;
            }

            await this._write(remaining);

            return true;
        });
    }

    async rename(id, name) {
        if (typeof name !== "string") {
            throw new Error("SpecPi Chat requires a text conversation name.");
        }

        return this._updateMetadata(id, { sessionName: titleFor(name) });
    }

    async setArchived(id, archived) {
        if (typeof archived !== "boolean") {
            throw new Error("SpecPi Chat requires a boolean conversation archive state.");
        }

        return this._updateMetadata(id, { archived });
    }

    async _updateMetadata(id, changes) {
        if (!validId(id)) {
            return undefined;
        }

        return this._mutate(async () => {
            const records = await this._read();
            const index = records.findIndex((record) => record.sessionId === id);

            if (index < 0) {
                return undefined;
            }

            const record = { ...records[index], ...changes };
            records[index] = record;
            await this._write(records);

            return { ...record };
        });
    }

    async _serialize(action) {
        const key = pathKey(this.catalogFile);
        const previous = operations.get(key) || Promise.resolve();
        const operation = previous.catch(() => {}).then(action);
        operations.set(key, operation);

        try {
            return await operation;
        } finally {
            if (operations.get(key) === operation) {
                operations.delete(key);
            }
        }
    }

    async _prepare() {
        await assertNoSymlinks(this.sessionDirectory, true);
        await fs.mkdir(this.sessionDirectory, { recursive: true, mode: 0o700 });
        await assertNoSymlinks(this.sessionDirectory);
    }

    async _mutate(action) {
        return this._serialize(async () => {
            await this._prepare();
            await assertNoSymlinks(this.lockDirectory, true);
            const deadline = performance.now() + LOCK_TIMEOUT_MS;
            let identity;

            while (!identity) {
                try {
                    await fs.mkdir(this.lockDirectory, { mode: 0o700 });
                    identity = await fs.lstat(this.lockDirectory);
                } catch (error) {
                    if (error.code !== "EEXIST") {
                        throw error;
                    }

                    const entry = await fs.lstat(this.lockDirectory).catch((statError) => {
                        if (statError.code === "ENOENT") {
                            return null;
                        }

                        throw statError;
                    });

                    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
                        throw new Error("SpecPi Chat session catalog lock must be a regular directory.");
                    }

                    const remaining = deadline - performance.now();

                    if (remaining <= 0) {
                        const locked = new Error(
                            "SpecPi Chat session catalog is locked. If no other window is saving, close VS Code and remove its catalog.lock directory before retrying.",
                        );
                        locked.code = "SPECPI_CATALOG_LOCKED";

                        throw locked;
                    }

                    await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
                }
            }

            try {
                return await action();
            } finally {
                const current = await fs.lstat(this.lockDirectory);

                if (
                    !current.isDirectory() ||
                    current.isSymbolicLink() ||
                    current.dev !== identity.dev ||
                    current.ino !== identity.ino
                ) {
                    throw new Error("SpecPi Chat session catalog lock changed while saving.");
                }

                await fs.rmdir(this.lockDirectory);
            }
        });
    }

    async _sessionFile(value) {
        if (
            typeof value !== "string" ||
            value.length > MAX_PATH_LENGTH ||
            value.includes("\0") ||
            !path.isAbsolute(value) ||
            value.split(/[\\/]/u).some((part) => part === "." || part === "..")
        ) {
            throw new Error("SpecPi Chat received an invalid session file path.");
        }

        const resolved = path.resolve(value);
        const relative = path.relative(this.sessionDirectory, resolved);

        if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error("SpecPi Chat can only resume sessions in its own workspace storage.");
        }

        await assertNoSymlinks(resolved);
        const entry = await fs.lstat(resolved);

        if (!entry.isFile() || entry.nlink > 1) {
            throw new Error("SpecPi Chat session references must be regular, unlinked files.");
        }

        const canonical = await fs.realpath(resolved);

        if (pathKey(canonical) !== pathKey(resolved)) {
            throw new Error("SpecPi Chat session paths must be canonical.");
        }

        return canonical;
    }

    async _read() {
        let handle;

        try {
            await assertNoSymlinks(this.catalogFile);
            handle = await fs.open(this.catalogFile, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
            const entry = await handle.stat();

            if (!entry.isFile() || entry.nlink > 1 || entry.size > MAX_CATALOG_BYTES) {
                throw new Error("SpecPi Chat session catalog is not a bounded regular file.");
            }

            const buffer = Buffer.alloc(MAX_CATALOG_BYTES + 1);
            let bytesRead = 0;

            while (bytesRead < buffer.length) {
                const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);

                if (chunk.bytesRead === 0) {
                    break;
                }

                bytesRead += chunk.bytesRead;
            }

            if (bytesRead > MAX_CATALOG_BYTES) {
                throw new Error("SpecPi Chat session catalog exceeds its size limit.");
            }

            let data;

            try {
                data = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
            } catch {
                throw new Error("SpecPi Chat session catalog contains invalid JSON.");
            }

            if (data?.version !== 1 || !Array.isArray(data.sessions) || data.sessions.length > MAX_RECORDS) {
                throw new Error("SpecPi Chat session catalog has an unsupported format.");
            }

            const records = [];
            const seen = new Set();

            for (const record of data.sessions) {
                if (
                    !record ||
                    !validId(record.sessionId) ||
                    seen.has(record.sessionId) ||
                    typeof record.sessionName !== "string" ||
                    record.sessionName !== titleFor(record.sessionName) ||
                    (record.archived !== undefined && typeof record.archived !== "boolean") ||
                    !Number.isSafeInteger(record.updatedAt) ||
                    record.updatedAt < 0
                ) {
                    throw new Error("SpecPi Chat session catalog contains invalid metadata.");
                }

                seen.add(record.sessionId);

                try {
                    const file = await this._sessionFile(record.sessionFile);
                    records.push({
                        sessionId: record.sessionId,
                        sessionName: record.sessionName,
                        sessionFile: file,
                        updatedAt: record.updatedAt,
                        archived: record.archived || false,
                    });
                } catch (error) {
                    if (error.code !== "ENOENT") {
                        throw error;
                    }
                }
            }

            return records;
        } catch (error) {
            if (error.code === "ENOENT") {
                return [];
            }

            throw error;
        } finally {
            await handle?.close();
        }
    }

    async _write(records) {
        let serialized = JSON.stringify({ version: 1, sessions: records }, null, 4) + "\n";

        while (Buffer.byteLength(serialized) > MAX_CATALOG_BYTES && records.length > 0) {
            records.pop();
            serialized = JSON.stringify({ version: 1, sessions: records }, null, 4) + "\n";
        }

        await assertNoSymlinks(this.catalogFile, true);
        const temporary = path.join(this.directory, `.catalog-${randomUUID()}.tmp`);
        let handle;

        try {
            handle = await fs.open(temporary, "wx", 0o600);
            await handle.writeFile(serialized, "utf8");
            await handle.sync();
            await handle.close();
            handle = undefined;
            await assertNoSymlinks(this.catalogFile, true);
            await fs.rename(temporary, this.catalogFile);
        } finally {
            await handle?.close();
            await fs.rm(temporary, { force: true });
        }
    }
}

module.exports = { SessionCatalog };
