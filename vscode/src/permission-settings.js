const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { validate, appendDestructiveGuard } = require("../media/permission-config.js");

const MAX_BYTES = 64 * 1024;
const digest = (text) => createHash("sha256").update(text).digest("hex");

function configPath(workspace, scope, { env = process.env, home = os.homedir() } = {}) {
    if (!["global", "project"].includes(scope) || !path.isAbsolute(workspace)) {
        throw new Error("Choose global or project permission settings in an open workspace.");
    }

    let agent = env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
    if (agent === "~") {
        agent = home;
    } else if (agent.startsWith("~/") || (process.platform === "win32" && agent.startsWith("~\\"))) {
        agent = path.join(home, agent.slice(2));
    }

    const base = scope === "global" ? path.resolve(workspace, agent) : path.join(workspace, ".pi");

    return path.join(base, "extensions", "pi-permission-system", "config.json");
}

// Inspect only the chosen config's ancestry, never enumerate Pi state. Refuse
// links and special files instead of redirecting a settings edit elsewhere.
function checkDirectories(directory, create = false) {
    const parent = path.dirname(directory);
    if (parent !== directory) {
        checkDirectories(parent, create);
    }

    let stat;
    try {
        stat = fs.lstatSync(directory);
    } catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }

        if (!create) {
            return;
        }

        fs.mkdirSync(directory, { mode: 0o700 });
        stat = fs.lstatSync(directory);
    }

    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Permission configuration directories must not be links or special files.");
    }
}

function readConfig(filename) {
    checkDirectories(path.dirname(filename));
    let stat;
    try {
        stat = fs.lstatSync(filename);
    } catch (error) {
        if (error.code === "ENOENT") {
            return { path: filename, exists: false, text: "{}\n", revision: "missing" };
        }

        throw error;
    }

    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) {
        throw new Error("Permission configuration must be an unlinked regular file of at most 64 KiB.");
    }

    const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let data;
    try {
        const opened = fs.fstatSync(fd);
        if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink !== 1 || !opened.isFile()) {
            throw new Error("Permission configuration changed while opening it. Reload settings.");
        }

        data = Buffer.alloc(MAX_BYTES + 1);
        const length = fs.readSync(fd, data, 0, data.length, 0);
        if (length > MAX_BYTES) {
            throw new Error("Permission configuration exceeds 64 KiB.");
        }

        data = data.subarray(0, length);
    } finally {
        fs.closeSync(fd);
    }

    let text;
    try {
        // Preserve the BOM in the text so backups and rollback remain byte-exact.
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
    } catch {
        throw new Error("Permission configuration must be UTF-8 text.");
    }

    return { path: filename, exists: true, text, revision: digest(data) };
}

function loadPermissionSettings(workspace, scope, options) {
    return { ...readConfig(configPath(workspace, scope, options)), scope };
}

// Metadata only: never open agent definitions or inspect prompts/frontmatter.
// A nonempty directory means the additional policy scopes cannot be certified.
function requireNoAgentPolicies(directory) {
    checkDirectories(directory);
    let handle;
    try {
        handle = fs.opendirSync(directory, { bufferSize: 1 });
    } catch (error) {
        if (error.code === "ENOENT") {
            return;
        }

        throw new Error("Cannot verify agent-policy directories. Destructive guard was not applied.");
    }

    try {
        if (handle.readSync()) {
            throw new Error(
                "Custom agent definitions are present. This project preset cannot verify their policy; existing settings are unchanged.",
            );
        }
    } finally {
        handle.closeSync();
    }
}

function prepareDestructiveGuard(snapshot, text, workspace, options) {
    if (snapshot.scope !== "project" || snapshot.path !== configPath(workspace, "project", options)) {
        throw new Error(
            "Load project scope to use Destructive guard. Global changes could affect unverified projects.",
        );
    }

    const baseline = validate(snapshot.text);
    if (JSON.stringify(validate(text)) !== JSON.stringify(baseline)) {
        throw new Error("Save or discard other draft edits before applying Destructive guard.");
    }

    if (readConfig(snapshot.path).revision !== snapshot.revision) {
        throw new Error("Project permission settings changed. Reload before applying Destructive guard.");
    }

    const global = loadPermissionSettings(workspace, "global", options);
    const agentDirectories = [
        path.join(path.dirname(path.dirname(path.dirname(global.path))), "agents"),
        path.join(workspace, ".pi", "agents"),
    ];
    for (const directory of agentDirectories) {
        requireNoAgentPolicies(directory);
    }

    const result = appendDestructiveGuard(text, global.text);

    return {
        text: result.text,
        profile: {
            surface: result.surface,
            baselineText: snapshot.text,
            global: { path: global.path, revision: global.revision },
            agentDirectories,
        },
    };
}

function verifyDestructiveGuard(profile, text) {
    const config = validate(text);
    const rules = config.permission?.[profile.surface];
    if (
        !rules ||
        typeof rules !== "object" ||
        !Object.keys(rules).length ||
        Object.values(rules).some((rule) => rule !== "deny" && rule?.action !== "deny")
    ) {
        throw new Error("The guard group must contain only deny rules. Undo the profile for other policy changes.");
    }

    const expected = validate(profile.baselineText);
    expected.permission = { ...expected.permission, [profile.surface]: rules };
    expected.yoloMode = false;
    if (JSON.stringify(config) !== JSON.stringify(expected)) {
        throw new Error(
            "Keep existing settings unchanged and the guard group last. Undo the profile for other changes.",
        );
    }

    if (readConfig(profile.global.path).revision !== profile.global.revision) {
        throw new Error("Inherited global settings changed. Reload and reapply Destructive guard before saving.");
    }

    for (const directory of profile.agentDirectories) {
        requireNoAgentPolicies(directory);
    }
}

// Synchronous, bounded transaction: the controller rechecks human/context
// authority immediately before this call. No asynchronous yield separates that
// check from the write. The lock coordinates Chat writers; the revision also
// detects ordinary edits by terminals and other windows.
function savePermissionSettings(snapshot, text, profile) {
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BYTES) {
        throw new Error("Permission configuration exceeds 64 KiB.");
    }

    validate(text);
    if (profile) {
        verifyDestructiveGuard(profile, text);
    }

    const filename = snapshot.path;
    checkDirectories(path.dirname(filename), true);
    const lock = `${filename}.specpi-lock`;
    let lockFd;
    try {
        lockFd = fs.openSync(lock, "wx", 0o600);
    } catch (error) {
        if (error.code === "EEXIST") {
            throw new Error(
                "Permission settings are being saved elsewhere (or a stale .specpi-lock remains). Reload after that save finishes.",
            );
        }

        throw error;
    }

    const temporary = `${filename}.${randomUUID()}.tmp`;
    let backup;
    let replaced = false;
    let previous;
    try {
        previous = readConfig(filename);
        if (previous.revision !== snapshot.revision) {
            throw new Error(
                "Permission settings changed on disk. Reload settings before saving; your draft has not been written.",
            );
        }

        if (previous.exists && previous.text === text) {
            return { ...previous, scope: snapshot.scope };
        }

        if (previous.exists) {
            backup = `${filename}.${randomUUID()}.bak`;
            fs.writeFileSync(backup, previous.text, { flag: "wx", mode: 0o600 });
            if (digest(fs.readFileSync(backup)) !== previous.revision) {
                throw new Error("Permission settings backup could not be verified.");
            }
        }

        fs.writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
        if (readConfig(filename).revision !== previous.revision) {
            throw new Error("Permission settings changed during save. Reload settings before trying again.");
        }

        if (profile) {
            verifyDestructiveGuard(profile, text);
        }

        fs.renameSync(temporary, filename);
        replaced = true;
        const saved = readConfig(filename);
        if (saved.revision !== digest(text)) {
            throw new Error("Saved permission settings could not be verified.");
        }

        return { ...saved, scope: snapshot.scope, backup };
    } catch (error) {
        // Do not overwrite a later external edit while attempting rollback.
        if (replaced && readConfig(filename).revision === digest(text)) {
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

module.exports = {
    configPath,
    loadPermissionSettings,
    savePermissionSettings,
    prepareDestructiveGuard,
    verifyDestructiveGuard,
};
