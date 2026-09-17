// pi-web-access registers four network tools (web_search, source_check, fetch_content,
// get_search_content). Pi sends every active tool's schema on every request, so a project
// that never searches would pay for them on every call. SpecPi therefore hides them behind
// a saved preference that ships off, and `/webaccess on` turns them on for a session.
//
// This file is SpecPi's own control: it never modifies the installed package, never reads
// Pi settings, credentials or session state, and a missing or unreadable file means off.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const WEB_TOOL_NAMES = Object.freeze(["web_search", "source_check", "fetch_content", "get_search_content"]);

const MAX_SETTINGS_BYTES = 4096;

function agentDirectory() {
    const configured = process.env.PI_CODING_AGENT_DIR;

    return path.resolve(configured && configured.length > 0 ? configured : path.join(os.homedir(), ".pi", "agent"));
}

function settingsFile() {
    return path.join(agentDirectory(), "specpi", "web-access", "settings.json");
}

/** Refuses links and irregular files so the preference cannot redirect a write. */
function regularFile(file) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) {
        return false;
    }

    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_SETTINGS_BYTES) {
        throw new Error("Unsupported web access settings file");
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
        throw new Error("Web access startup activation must be on or off.");
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
 * Add or remove the web tools from Pi's active set without disturbing any other
 * extension's tools, including built-ins and the other first-party gates.
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
