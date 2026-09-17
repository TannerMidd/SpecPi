// A human who always says yes to the same capability prompt is not making a decision, they are
// clearing an obstacle. This file stores the standing answer: capabilities the human has chosen
// to grant without being asked again.
//
// The preference is SpecPi's own file. It never reads Pi settings, credentials or session state,
// a missing or unreadable file means "ask about everything", and an unknown capability name in a
// stored file is ignored rather than trusted.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CAPABILITY_NAMES } from "./capabilities.mjs";

const MAX_SETTINGS_BYTES = 4096;

function agentDirectory() {
    const configured = process.env.PI_CODING_AGENT_DIR;

    return path.resolve(configured && configured.length > 0 ? configured : path.join(os.homedir(), ".pi", "agent"));
}

function settingsFile() {
    return path.join(agentDirectory(), "specpi", "capabilities", "settings.json");
}

/** Refuses links and irregular files so the preference cannot redirect a write. */
function regularFile(file) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) {
        return false;
    }

    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_SETTINGS_BYTES) {
        throw new Error("Unsupported capability settings file");
    }

    return true;
}

/**
 * Capabilities granted without a prompt. Names that no longer exist are dropped, so retiring a
 * capability cannot leave a stored grant pointing at a different one later.
 */
export function loadAutoAllowed() {
    try {
        const file = settingsFile();
        if (!regularFile(file)) {
            return [];
        }

        const settings = JSON.parse(fs.readFileSync(file, "utf8"));
        if (settings?.schema !== 1 || !Array.isArray(settings.autoAllow)) {
            return [];
        }

        return settings.autoAllow.filter((name) => CAPABILITY_NAMES.includes(name));
    } catch {
        return [];
    }
}

export function autoAllowed(capabilityId) {
    return loadAutoAllowed().includes(capabilityId);
}

export function saveAutoAllowed(names) {
    if (!Array.isArray(names) || names.some((name) => !CAPABILITY_NAMES.includes(name))) {
        throw new Error("Unknown capability");
    }

    const file = settingsFile();
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.existsSync(file)) {
        regularFile(file);
    }

    const autoAllow = [...new Set(names)].sort();
    const temporary = path.join(directory, `.settings.${randomUUID()}.tmp`);
    try {
        fs.writeFileSync(temporary, `${JSON.stringify({ schema: 1, autoAllow })}\n`, {
            mode: 0o600,
            flag: "wx",
        });
        fs.renameSync(temporary, file);
    } finally {
        fs.rmSync(temporary, { force: true });
    }

    return autoAllow;
}

/** Add one capability to the standing grants. Returns the stored list. */
export function allowCapability(capabilityId) {
    return saveAutoAllowed([...loadAutoAllowed(), capabilityId]);
}

/** Return one capability to prompting. Returns the stored list. */
export function askCapability(capabilityId) {
    if (!CAPABILITY_NAMES.includes(capabilityId)) {
        throw new Error("Unknown capability");
    }

    return saveAutoAllowed(loadAutoAllowed().filter((name) => name !== capabilityId));
}

export function policyPath() {
    return settingsFile();
}
