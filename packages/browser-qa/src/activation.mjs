// Browser QA declares fourteen tools. Their schemas are about 8.7 KB, and Pi sends every
// active tool's schema on every request of a session, so a project that never opens a
// browser would pay for them on every call. They are therefore gated behind a saved
// preference that ships off, and `/browser on` turns them on for a session.
//
// The preference is this package's own file. It never reads Pi settings, credentials or
// session state, and a missing or unreadable file means off.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_SETTINGS_BYTES = 4096;

function agentDirectory() {
    const configured = process.env.PI_CODING_AGENT_DIR;

    return path.resolve(configured && configured.length > 0 ? configured : path.join(os.homedir(), ".pi", "agent"));
}

function settingsFile() {
    return path.join(agentDirectory(), "specpi", "browser-qa", "settings.json");
}

/** Refuses links and irregular files so the preference cannot redirect a write. */
function regularFile(file) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) {
        return false;
    }

    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_SETTINGS_BYTES) {
        throw new Error("Unsupported Browser QA settings file");
    }

    return true;
}

export function loadStartupActivation() {
    try {
        const file = settingsFile();
        if (!regularFile(file)) {
            return false;
        }

        const settings = JSON.parse(fs.readFileSync(file, "utf8"));

        return settings?.schema === 1 && settings.startupActivation === true;
    } catch {
        return false;
    }
}

export function saveStartupActivation(enabled) {
    if (typeof enabled !== "boolean") {
        throw new Error("Browser QA startup activation must be on or off.");
    }

    const file = settingsFile();
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.existsSync(file)) {
        regularFile(file);
    }

    const temporary = path.join(directory, `.settings.${randomUUID()}.tmp`);
    try {
        fs.writeFileSync(temporary, `${JSON.stringify({ schema: 1, startupActivation: enabled })}\n`, {
            mode: 0o600,
            flag: "wx",
        });
        fs.renameSync(temporary, file);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

export function settingsPath() {
    return settingsFile();
}

/**
 * Add or remove this package's tools from Pi's active set without disturbing any other
 * extension's tools.
 */
export function syncActiveTools(pi, names, enabled) {
    if (typeof pi?.getActiveTools !== "function" || typeof pi?.setActiveTools !== "function") {
        return;
    }

    const owned = new Set(names);
    const active = pi.getActiveTools();
    const present = active.filter((name) => owned.has(name));
    if (enabled && present.length === owned.size) {
        return;
    }

    if (!enabled && present.length === 0) {
        return;
    }

    const others = active.filter((name) => !owned.has(name));
    pi.setActiveTools(enabled ? [...others, ...names] : others);
}
