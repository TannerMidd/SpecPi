"use strict";

// Read and write the configuration files of the pinned packages that expose
// one: pi-subagents (its own extension config plus the "subagents" block of a
// Pi settings file) and pi-web-access (a provider credential store).
//
// Every write goes through the guarded transaction in settings-file.js, the
// same one behind permission settings and Pi startup defaults: bounded read
// with link and identity checks, lock, revision check, backup, atomic replace,
// verification, and rollback on failure.
//
// Two rules shape this module. Settings files belong to Pi, so a write touches
// only the one documented key the caller asked for and leaves every other key,
// and its order, exactly as found. Web access configuration holds provider
// credentials, so values never reach the webview, a log line, or an error
// message; see media/web-access-config.js for the redaction contract.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { checkDirectories, readFile, parseJson, replaceFile } = require("./settings-file.js");
const { agentDirectory } = require("./pi-defaults.js");
const subagentsConfig = require("../media/subagents-config.js");
const webAccessConfig = require("../media/web-access-config.js");

const MAX_BYTES = 256 * 1024;
const SETTINGS_KEY = "subagents";

// Targets are opaque identifiers chosen by the webview; each resolves to one
// file and one write shape. Nothing here accepts a caller-supplied path.
const TARGETS = ["subagents:extension", "subagents:global", "subagents:project", "webAccess"];

function messagesFor(label) {
    return {
        file: `${label} must be an unlinked regular file of at most 256 KiB.`,
        opening: `${label} changed while opening it. Reload settings.`,
        size: `${label} exceeds 256 KiB.`,
        encoding: `${label} must be UTF-8 text.`,
        link: `${label} must live in a real directory, not a link or special file.`,
        lock: `${label} is being saved elsewhere (or a stale .specpi-lock remains). Reload after that save finishes.`,
        changed: `${label} changed on disk. Reload settings before saving; your draft has not been written.`,
        backup: `${label} backup could not be verified.`,
        during: `${label} changed during the save. Reload settings before trying again.`,
        verify: `Saved ${label.toLowerCase()} could not be verified.`,
    };
}

const SUBAGENT_MESSAGES = messagesFor("Subagents configuration");
const SETTINGS_MESSAGES = messagesFor("Pi settings");
const WEB_MESSAGES = messagesFor("Web access configuration");

function expandHome(value, home) {
    if (value === "~") {
        return home;
    }

    if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
        return path.join(home, value.slice(2));
    }

    return value;
}

// pi-web-access resolves its own config path and Chat must match it exactly,
// or the UI would edit a file the package never reads. Precedence, from
// pi-web-access 0.29.0: PI_CODING_AGENT_DIR wins; otherwise XDG_CONFIG_HOME
// prefers an existing XDG file, then an existing legacy ~/.pi file, and
// targets the XDG path when neither exists; with neither variable set the
// default is ~/.pi/agent/web-search.json.
function webAccessPath({ workspace, env = process.env, home = os.homedir() } = {}) {
    if (env.PI_CODING_AGENT_DIR) {
        return path.join(agentDirectory({ workspace, env, home }), "web-search.json");
    }

    if (env.XDG_CONFIG_HOME) {
        const xdg = path.join(expandHome(env.XDG_CONFIG_HOME, home), "pi", "web-search.json");
        const legacy = path.join(home, ".pi", "web-search.json");
        if (fs.existsSync(xdg)) {
            return xdg;
        }

        return fs.existsSync(legacy) ? legacy : xdg;
    }

    return path.join(home, ".pi", "agent", "web-search.json");
}

function targetPath(target, options = {}) {
    const { workspace } = options;
    if (target === "subagents:extension") {
        return path.join(agentDirectory(options), "extensions", "subagent", "config.json");
    }

    if (target === "subagents:global") {
        return path.join(agentDirectory(options), "settings.json");
    }

    if (target === "subagents:project") {
        if (!path.isAbsolute(workspace || "")) {
            throw new Error("Open a workspace folder before editing project subagent settings.");
        }

        return path.join(workspace, ".pi", "settings.json");
    }

    if (target === "webAccess") {
        return webAccessPath(options);
    }

    throw new Error("Choose a package configuration to edit.");
}

// Paths under the agent directory are resolved before inspection: a relocated
// home or a junctioned Windows profile puts a link above every file there.
// Workspace paths are not, because an opened repository could ship a link of
// its own to redirect the write.
function inspect(target, filename, messages, create = false) {
    checkDirectories(path.dirname(filename), {
        create,
        resolve: target !== "subagents:project",
        link: messages.link,
    });
}

function readSnapshot(filename, messages) {
    return readFile(filename, { maxBytes: MAX_BYTES, missingText: "{}\n", messages });
}

function parseObject(filename, text, label) {
    let value;
    try {
        value = parseJson(text);
    } catch {
        throw new Error(`${label} (${filename}) is not valid JSON. Fix or remove the file, then try again.`);
    }

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} (${filename}) must contain a JSON object.`);
    }

    return value;
}

function isSettingsTarget(target) {
    return target === "subagents:global" || target === "subagents:project";
}

// Pi settings hold the subagents block beside unrelated configuration. The
// draft the webview edits is only that block, never the whole file.
function loadSettingsBlock(target, options) {
    const filename = targetPath(target, options);
    inspect(target, filename, SETTINGS_MESSAGES);
    const snapshot = readSnapshot(filename, SETTINGS_MESSAGES);
    const settings = snapshot.exists ? parseObject(filename, snapshot.text, "Pi settings") : {};
    const block = settings[SETTINGS_KEY];
    if (block !== undefined && (block === null || typeof block !== "object" || Array.isArray(block))) {
        throw new Error(`Pi settings field '${SETTINGS_KEY}' must be an object. Fix the file manually.`);
    }

    return {
        target,
        path: filename,
        exists: snapshot.exists,
        revision: snapshot.revision,
        text: `${JSON.stringify(block === undefined ? {} : block, null, 4)}\n`,
        keys: Object.keys(settings).filter((key) => key !== SETTINGS_KEY),
    };
}

function loadWholeFile(target, messages, options) {
    const filename = targetPath(target, options);
    inspect(target, filename, messages);

    return { target, path: filename, ...readSnapshot(filename, messages) };
}

// Web access configuration never leaves the host with its credentials intact.
function loadWebAccess(options) {
    const snapshot = loadWholeFile("webAccess", WEB_MESSAGES, options);
    const stored = snapshot.exists ? parseObject(snapshot.path, snapshot.text, "Web access configuration") : {};
    const { config, credentials } = webAccessConfig.redact(stored);

    return {
        target: "webAccess",
        path: snapshot.path,
        exists: snapshot.exists,
        revision: snapshot.revision,
        text: `${JSON.stringify(config, null, 4)}\n`,
        credentials,
    };
}

function loadPackageSettings(target, options = {}) {
    if (!TARGETS.includes(target)) {
        throw new Error("Choose a package configuration to edit.");
    }

    if (target === "webAccess") {
        return loadWebAccess(options);
    }

    if (isSettingsTarget(target)) {
        return loadSettingsBlock(target, options);
    }

    return loadWholeFile(target, SUBAGENT_MESSAGES, options);
}

function sameJson(text, next, filename, label) {
    try {
        return JSON.stringify(parseObject(filename, text, label)) === JSON.stringify(next);
    } catch {
        return false;
    }
}

function commit({ filename, text, messages, revision, unchanged, snapshot, extra = {} }) {
    const result = replaceFile({
        filename,
        text,
        read: () => readSnapshot(filename, messages),
        revision,
        unchanged,
        messages,
    });

    return {
        target: snapshot.target,
        path: filename,
        exists: true,
        revision: result.saved.revision,
        changed: result.changed,
        backup: result.backup,
        ...extra,
    };
}

// Writes the subagents block into a Pi settings file. Unrelated keys and their
// order survive; an empty block removes the key rather than leaving `{}`.
function saveSettingsBlock(snapshot, draft) {
    const filename = snapshot.path;
    inspect(snapshot.target, filename, SETTINGS_MESSAGES, true);
    const current = readSnapshot(filename, SETTINGS_MESSAGES);
    if (current.revision !== snapshot.revision) {
        throw new Error(SETTINGS_MESSAGES.changed);
    }

    const settings = current.exists ? parseObject(filename, current.text, "Pi settings") : {};
    const next = { ...settings };
    if (Object.keys(draft).length > 0) {
        next[SETTINGS_KEY] = draft;
    } else {
        delete next[SETTINGS_KEY];
    }

    const text = `${JSON.stringify(next, null, 4)}\n`;

    return commit({
        filename,
        text,
        messages: SETTINGS_MESSAGES,
        revision: snapshot.revision,
        unchanged: (previous) => sameJson(previous.text, next, filename, "Pi settings"),
        snapshot,
        extra: {
            text: `${JSON.stringify(draft, null, 4)}\n`,
            keys: Object.keys(next).filter((key) => key !== SETTINGS_KEY),
        },
    });
}

// Restores redacted credentials from disk, then writes. The draft text is
// never written verbatim: a value the person did not retype is taken from the
// file that is already there.
function saveWebAccess(snapshot, draft) {
    const filename = snapshot.path;
    inspect("webAccess", filename, WEB_MESSAGES, true);
    const current = readSnapshot(filename, WEB_MESSAGES);
    if (current.revision !== snapshot.revision) {
        throw new Error(WEB_MESSAGES.changed);
    }

    const stored = current.exists ? parseObject(filename, current.text, "Web access configuration") : {};
    const missing = webAccessConfig.unresolved(draft, stored);
    if (missing.length > 0) {
        throw new Error(
            `No stored credential behind the placeholder for ${missing.slice(0, 5).join(", ")}. Type the value or remove the key.`,
        );
    }

    const next = webAccessConfig.restore(draft, stored);
    const text = `${JSON.stringify(next, null, 4)}\n`;
    const result = commit({
        filename,
        text,
        messages: WEB_MESSAGES,
        revision: snapshot.revision,
        unchanged: (previous) => sameJson(previous.text, next, filename, "Web access configuration"),
        snapshot,
    });
    const { config, credentials } = webAccessConfig.redact(next);

    return { ...result, text: `${JSON.stringify(config, null, 4)}\n`, credentials };
}

function saveWholeFile(snapshot, draft) {
    const filename = snapshot.path;
    inspect(snapshot.target, filename, SUBAGENT_MESSAGES, true);
    const text = `${JSON.stringify(draft, null, 4)}\n`;

    return commit({
        filename,
        text,
        messages: SUBAGENT_MESSAGES,
        revision: snapshot.revision,
        unchanged: (previous) => sameJson(previous.text, draft, filename, "Subagents configuration"),
        snapshot,
        extra: { text },
    });
}

// The caller rechecks human and runtime authority immediately before this
// call; the revision detects ordinary edits by terminals and other windows in
// between. `text` is the draft the webview holds, already validated there and
// validated again here so the host never trusts the view.
function savePackageSettings(snapshot, text) {
    if (!snapshot || typeof snapshot.path !== "string" || typeof snapshot.revision !== "string") {
        throw new Error("Reload package settings before saving; the previous read is unusable.");
    }

    if (!TARGETS.includes(snapshot.target)) {
        throw new Error("Choose a package configuration to edit.");
    }

    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BYTES) {
        throw new Error("Configuration exceeds 256 KiB.");
    }

    if (snapshot.target === "webAccess") {
        return saveWebAccess(snapshot, webAccessConfig.validate(text).config);
    }

    const target = isSettingsTarget(snapshot.target) ? subagentsConfig.SETTINGS : subagentsConfig.EXTENSION;
    const draft = subagentsConfig.validate(text, target).config;

    return isSettingsTarget(snapshot.target) ? saveSettingsBlock(snapshot, draft) : saveWholeFile(snapshot, draft);
}

module.exports = { TARGETS, webAccessPath, targetPath, loadPackageSettings, savePackageSettings };
