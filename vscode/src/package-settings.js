"use strict";

// Read and write the configuration files of the pinned packages that expose
// one. Today that is pi-web-access alone: a provider credential store.
//
// Every write goes through the guarded transaction in settings-file.js, the
// same one behind permission settings and Pi startup defaults: bounded read
// with link and identity checks, lock, revision check, backup, atomic replace,
// verification, and rollback on failure.
//
// Web access configuration holds provider credentials, so values never reach
// the webview, a log line, or an error message; see media/web-access-config.js
// for the redaction contract.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { checkDirectories, readFile, parseJson, replaceFile } = require("./settings-file.js");
const { agentDirectory } = require("./pi-defaults.js");
const webAccessConfig = require("../media/web-access-config.js");
const jevConfig = require("../media/jev-config.js");

const MAX_BYTES = 256 * 1024;

// Targets are opaque identifiers chosen by the webview; each resolves to one
// file and one write shape. Nothing here accepts a caller-supplied path.
const TARGETS = ["webAccess", "jevLayer"];

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

const WEB_MESSAGES = messagesFor("Web access configuration");
const JEV_MESSAGES = messagesFor("Jev layer settings");

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

// The advisor resolves its own settings path from the agent directory, and Chat must match it
// exactly or this panel would edit a file the extension never reads. From
// extensions/jev-advisor/config.mjs: <agent-dir>/specpi/jev/settings.json, with no XDG variant.
function jevPath({ workspace, env = process.env, home = os.homedir() } = {}) {
    return path.join(agentDirectory({ workspace, env, home }), "specpi", "jev", "settings.json");
}

// The advisor's running call count for the session, beside its settings. Chat reads it and never
// writes it: it is the extension's own bookkeeping, and a panel that could edit a usage counter
// would be editing the evidence rather than reporting it. Derived from the settings path rather
// than resolved again, so the two can never end up pointing at different agent directories.
function jevUsagePath(options = {}) {
    return usageBeside(jevPath(options));
}

function usageBeside(settingsFile) {
    return path.join(path.dirname(settingsFile), "usage.json");
}

/**
 * Read the count, or nothing. A budget display is a convenience beside the switches, so no failure
 * here may stop the panel opening: an absent file, an unreadable one, a linked one and one written
 * by a newer advisor all come back the same way, and the panel says the layer has not run.
 *
 * The size bound is deliberately small. The file is counts for seven systems and nothing else, so
 * anything approaching the settings limit was not written by the advisor.
 */
function loadJevUsage(settingsFile) {
    try {
        const filename = usageBeside(settingsFile);
        const snapshot = readFile(filename, {
            maxBytes: 8 * 1024,
            missingText: "{}",
            messages: messagesFor("Jev usage"),
        });

        return snapshot.exists ? jevConfig.fromStoredUsage(parseJson(snapshot.text)) : undefined;
    } catch {
        return undefined;
    }
}

function targetPath(target, options = {}) {
    if (target === "webAccess") {
        return webAccessPath(options);
    }

    if (target === "jevLayer") {
        return jevPath(options);
    }

    throw new Error("Choose a package configuration to edit.");
}

// Paths under the agent directory are resolved before inspection: a relocated
// home or a junctioned Windows profile puts a link above every file there.
function inspect(filename, messages, create = false) {
    checkDirectories(path.dirname(filename), { create, resolve: true, link: messages.link });
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

// Web access configuration never leaves the host with its credentials intact.
function loadWebAccess(options) {
    const filename = targetPath("webAccess", options);
    inspect(filename, WEB_MESSAGES);
    const snapshot = readSnapshot(filename, WEB_MESSAGES);
    const stored = snapshot.exists ? parseObject(filename, snapshot.text, "Web access configuration") : {};
    const { config, credentials } = webAccessConfig.redact(stored);

    return {
        target: "webAccess",
        path: filename,
        exists: snapshot.exists,
        revision: snapshot.revision,
        text: `${JSON.stringify(config, null, 4)}\n`,
        credentials,
    };
}

// The Jev layer holds no credential, so unlike web access its file is shown as it is. The panel
// still sees the flattened form shape rather than the nested one on disk, because the systems
// nested under `systems`, the budgets under `budgets` and two switches under `guard` would render
// as JSON textareas otherwise, and the
// point of the panel is that they are toggles.
function loadJev(options) {
    const filename = targetPath("jevLayer", options);
    inspect(filename, JEV_MESSAGES);
    const snapshot = readSnapshot(filename, JEV_MESSAGES);
    const stored = snapshot.exists ? parseObject(filename, snapshot.text, "Jev layer settings") : {};

    return {
        target: "jevLayer",
        path: filename,
        exists: snapshot.exists,
        revision: snapshot.revision,
        text: `${JSON.stringify(jevConfig.fromStored(stored), null, 4)}
`,
        credentials: [],
        usage: loadJevUsage(filename),
    };
}

function saveJev(snapshot, draft) {
    const filename = snapshot.path;
    inspect(filename, JEV_MESSAGES, true);
    const current = readSnapshot(filename, JEV_MESSAGES);
    if (current.revision !== snapshot.revision) {
        throw new Error(JEV_MESSAGES.changed);
    }

    const next = jevConfig.toStored(draft);
    const text = `${JSON.stringify(next, null, 4)}
`;
    const result = commit({
        filename,
        text,
        messages: JEV_MESSAGES,
        revision: snapshot.revision,
        unchanged: (previous) => sameJson(previous.text, next, filename, "Jev layer settings"),
        snapshot,
    });

    return {
        ...result,
        text: `${JSON.stringify(jevConfig.fromStored(next), null, 4)}
`,
        credentials: [],
        // Re-read rather than carried over from the load: saving a budget and still seeing the old
        // ceiling beside the current spend is the kind of small lie that makes a panel untrustworthy.
        usage: loadJevUsage(filename),
    };
}

function loadPackageSettings(target, options = {}) {
    if (!TARGETS.includes(target)) {
        throw new Error("Choose a package configuration to edit.");
    }

    return target === "jevLayer" ? loadJev(options) : loadWebAccess(options);
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

// Restores redacted credentials from disk, then writes. The draft text is
// never written verbatim: a value the person did not retype is taken from the
// file that is already there.
function saveWebAccess(snapshot, draft) {
    const filename = snapshot.path;
    inspect(filename, WEB_MESSAGES, true);
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

    if (snapshot.target === "jevLayer") {
        return saveJev(snapshot, jevConfig.validate(text).config);
    }

    return saveWebAccess(snapshot, webAccessConfig.validate(text).config);
}

module.exports = {
    TARGETS,
    webAccessPath,
    jevPath,
    jevUsagePath,
    targetPath,
    loadPackageSettings,
    savePackageSettings,
};
