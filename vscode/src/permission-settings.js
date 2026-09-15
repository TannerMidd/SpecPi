const os = require("node:os");
const path = require("node:path");
const { validate } = require("../media/permission-config.js");
const { checkDirectories, readFile, replaceFile } = require("./settings-file.js");

const MAX_BYTES = 64 * 1024;

const MESSAGES = {
    file: "Permission configuration must be an unlinked regular file of at most 64 KiB.",
    opening: "Permission configuration changed while opening it. Reload settings.",
    size: "Permission configuration exceeds 64 KiB.",
    encoding: "Permission configuration must be UTF-8 text.",
    link: "Permission configuration directories must not be links or special files.",
    lock: "Permission settings are being saved elsewhere (or a stale .specpi-lock remains). Reload after that save finishes.",
    changed: "Permission settings changed on disk. Reload settings before saving; your draft has not been written.",
    backup: "Permission settings backup could not be verified.",
    during: "Permission settings changed during save. Reload settings before trying again.",
    verify: "Saved permission settings could not be verified.",
};

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

function readConfig(filename) {
    checkDirectories(path.dirname(filename), { link: MESSAGES.link });

    return readFile(filename, { maxBytes: MAX_BYTES, missingText: "{}\n", messages: MESSAGES });
}

function loadPermissionSettings(workspace, scope, options) {
    return { ...readConfig(configPath(workspace, scope, options)), scope };
}

// Synchronous, bounded transaction: the controller rechecks human/context
// authority immediately before this call. No asynchronous yield separates that
// check from the write. The guarded transaction itself lives in
// settings-file.js, shared with Pi startup defaults.
function savePermissionSettings(snapshot, text) {
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BYTES) {
        throw new Error("Permission configuration exceeds 64 KiB.");
    }

    validate(text);
    const filename = snapshot.path;
    checkDirectories(path.dirname(filename), { create: true, link: MESSAGES.link });
    const result = replaceFile({
        filename,
        text,
        read: () => readFile(filename, { maxBytes: MAX_BYTES, missingText: "{}\n", messages: MESSAGES }),
        revision: snapshot.revision,
        unchanged: (previous) => previous.text === text,
        messages: MESSAGES,
    });

    return result.changed
        ? { ...result.saved, scope: snapshot.scope, backup: result.backup }
        : { ...result.previous, scope: snapshot.scope };
}

module.exports = { configPath, loadPermissionSettings, savePermissionSettings };
