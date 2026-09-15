"use strict";

// Save Pi startup defaults (default model, thinking level, per-model thinking
// overrides) into Pi's global settings.json. Only the documented keys from
// docs/settings.md are touched; every other key, its order, and unrelated
// configuration are preserved. The guarded write transaction lives in
// settings-file.js, shared with permission settings.

const os = require("node:os");
const path = require("node:path");
const { MISSING_REVISION, digest, checkDirectories, readFile, parseJson, replaceFile } = require("./settings-file.js");

const MAX_BYTES = 256 * 1024;
const MAX_VALUE = 256;

const MESSAGES = {
    file: "Pi settings must be an unlinked regular file of at most 256 KiB.",
    opening: "Pi settings changed while opening them. Try again.",
    size: "Pi settings exceed 256 KiB.",
    encoding: "Pi settings must be UTF-8 text.",
    link: "Pi settings must live in a real directory, not a link or special file.",
    lock: "Pi settings are being saved elsewhere (or a stale .specpi-lock remains). Try again after that save finishes.",
    changed: "Pi settings changed on disk. Retry saving the startup defaults.",
    backup: "Pi settings backup could not be verified.",
    during: "Pi settings changed during the save. Retry saving the startup defaults.",
    verify: "Saved Pi settings could not be verified.",
};

// Pi resolves a relative PI_CODING_AGENT_DIR against the workspace, so Chat
// must too; resolving against the extension host's cwd would read and write a
// different file than Pi and than permission-settings.js.
function agentDirectory({ workspace, env = process.env, home = os.homedir() } = {}) {
    let agent = env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
    if (agent === "~") {
        agent = home;
    } else if (agent.startsWith("~/") || (process.platform === "win32" && agent.startsWith("~\\"))) {
        agent = path.join(home, agent.slice(2));
    }

    if (path.isAbsolute(agent)) {
        return agent;
    }

    if (!path.isAbsolute(workspace || "")) {
        throw new Error("Open a workspace folder before saving Pi startup defaults.");
    }

    return path.resolve(workspace, agent);
}

function settingsPath(options) {
    return path.join(agentDirectory(options), "settings.json");
}

function checkSettingsDirectories(directory) {
    checkDirectories(directory, {
        resolve: true,
        link: MESSAGES.link,
        missing: (missing) =>
            new Error(`Pi settings directory ${missing} does not exist. Start Pi once, or check PI_CODING_AGENT_DIR.`),
    });
}

function readFileSnapshot(filename) {
    return readFile(filename, { maxBytes: MAX_BYTES, missingText: "{}", messages: MESSAGES });
}

function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSettings(filename, text) {
    let settings;
    try {
        settings = parseJson(text);
    } catch {
        throw new Error(`Pi settings (${filename}) are not valid JSON. Fix or remove the file, then try again.`);
    }

    if (!isPlainObject(settings)) {
        throw new Error(`Pi settings (${filename}) must contain a JSON object.`);
    }

    return settings;
}

function readDefaults(options) {
    const filename = settingsPath(options);
    checkSettingsDirectories(path.dirname(filename));
    const snapshot = readFileSnapshot(filename);

    return {
        ...snapshot,
        path: filename,
        settings: snapshot.exists ? parseSettings(filename, snapshot.text) : {},
    };
}

function boundedString(value, label) {
    if (typeof value !== "string" || !value.trim() || value.length > MAX_VALUE) {
        throw new Error(`${label} must be a non-empty string of at most ${MAX_VALUE} characters.`);
    }

    return value;
}

// Pi reports the levels it supports at runtime; validating against that list
// keeps Chat from refusing a level Pi has added and its own pickers accept.
function thinkingLevel(value, label, levels) {
    boundedString(value, label);
    if (!Array.isArray(levels) || levels.length === 0) {
        throw new Error("Connect Pi so it can report its thinking levels, then try again.");
    }

    if (!levels.includes(value)) {
        throw new Error(`${label} must be one of: ${levels.join(", ")}.`);
    }

    return value;
}

function modelThinkingOverride(settings, provider, modelId) {
    const map = settings?.modelThinkingLevels;
    if (map === undefined) {
        return undefined;
    }

    if (!isPlainObject(map)) {
        throw new Error("Pi settings field 'modelThinkingLevels' must be an object. Fix the file manually.");
    }

    const value = map[`${boundedString(provider, "Provider")}/${boundedString(modelId, "Model id")}`];

    return typeof value === "string" ? value : undefined;
}

// patch: { defaultProvider?, defaultModel?, defaultThinkingLevel?,
//          modelThinkingLevel?: { provider, modelId, level | null } }
// Returns the next settings object with unrelated keys and their order intact.
function nextSettings(settings, patch, levels) {
    const next = { ...settings };
    if (patch.defaultProvider !== undefined) {
        next.defaultProvider = boundedString(patch.defaultProvider, "defaultProvider");
    }

    if (patch.defaultModel !== undefined) {
        next.defaultModel = boundedString(patch.defaultModel, "defaultModel");
    }

    if (patch.defaultThinkingLevel !== undefined) {
        next.defaultThinkingLevel = thinkingLevel(patch.defaultThinkingLevel, "defaultThinkingLevel", levels);
    }

    if (patch.modelThinkingLevel !== undefined) {
        const entry = patch.modelThinkingLevel;
        if (!isPlainObject(entry)) {
            throw new Error("modelThinkingLevel must be an object with provider, modelId, and level.");
        }

        const provider = boundedString(entry.provider, "Provider");
        if (provider.includes("/")) {
            throw new Error("Provider must not contain a slash.");
        }

        const modelId = boundedString(entry.modelId, "Model id");
        const key = `${provider}/${modelId}`;
        if (entry.level !== null && entry.level !== undefined) {
            thinkingLevel(entry.level, "Thinking level", levels);
        }

        if (next.modelThinkingLevels !== undefined && !isPlainObject(next.modelThinkingLevels)) {
            throw new Error("Pi settings field 'modelThinkingLevels' must be an object. Fix the file manually.");
        }

        const map = { ...(next.modelThinkingLevels === undefined ? {} : next.modelThinkingLevels) };
        if (entry.level === null || entry.level === undefined) {
            delete map[key];
        } else {
            map[key] = entry.level;
        }

        if (Object.keys(map).length > 0) {
            next.modelThinkingLevels = map;
        } else {
            delete next.modelThinkingLevels;
        }
    }

    return next;
}

// Compare what the file means, not how it is spelled. A settings.json written
// with four-space indentation, or simply ending in a newline, must not be
// reformatted and backed up when it already holds the pinned value.
function sameSettings(text, next, filename) {
    let settings;
    try {
        settings = parseSettings(filename, text);
    } catch {
        return false;
    }

    return JSON.stringify(settings) === JSON.stringify(next);
}

// Synchronous, bounded transaction. The caller rechecks human and runtime
// authority immediately before this call; the revision detects ordinary edits
// by terminals and other windows in between.
function saveDefaults(snapshot, patch, levels) {
    if (!snapshot || typeof snapshot.path !== "string" || typeof snapshot.revision !== "string") {
        throw new Error("Reload startup defaults before saving; the previous read is unusable.");
    }

    if (!isPlainObject(snapshot.settings)) {
        throw new Error("Reload startup defaults before saving; the previous read is unusable.");
    }

    if (!isPlainObject(patch) || Object.keys(patch).length === 0) {
        throw new Error("Choose a startup default to save.");
    }

    const filename = snapshot.path;
    const next = nextSettings(snapshot.settings, patch, levels);
    const text = JSON.stringify(next, null, 2);
    checkSettingsDirectories(path.dirname(filename));
    const result = replaceFile({
        filename,
        text,
        read: () => readFileSnapshot(filename),
        revision: snapshot.revision,
        unchanged: (previous) => sameSettings(previous.text, next, filename),
        messages: MESSAGES,
    });

    return {
        path: filename,
        exists: true,
        text: result.changed ? text : result.saved.text,
        settings: next,
        revision: result.saved.revision,
        changed: result.changed,
        backup: result.backup,
    };
}

module.exports = {
    MISSING_REVISION,
    digest,
    agentDirectory,
    settingsPath,
    readDefaults,
    saveDefaults,
    modelThinkingOverride,
};
