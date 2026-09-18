// Jev is the first thing in SpecPi that talks to a third party, so its switch is the first thing
// every other module in this directory consults. Master off means no key read, no consent read, no
// network call and no prompt injection: the harness behaves exactly as it did before the extension
// existed.
//
// The file is SpecPi's own, hardened the same way as web-access and capability-policy: atomic
// write, mode 0600, symlinks refused, and a missing or unreadable file read as off.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Systems that may run inside a session. Offline scripts are not gated here. */
export const SYSTEM_NAMES = Object.freeze(["retention", "compaction", "gap", "sources"]);

const MAX_SETTINGS_BYTES = 4096;
const DEFAULT_CALL_BUDGET = 8;
const MAX_CALL_BUDGET = 64;

export function agentDirectory() {
    const configured = process.env.PI_CODING_AGENT_DIR;

    return path.resolve(configured && configured.length > 0 ? configured : path.join(os.homedir(), ".pi", "agent"));
}

export function jevDirectory() {
    return path.join(agentDirectory(), "specpi", "jev");
}

function settingsFile() {
    return path.join(jevDirectory(), "settings.json");
}

/** Refuses links and irregular files so the preference cannot redirect a write. */
export function regularFile(file, label) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) {
        return false;
    }

    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_SETTINGS_BYTES) {
        throw new Error(`Unsupported ${label} file`);
    }

    return true;
}

/** Every unknown shape collapses to the same all-off default rather than a partial enable. */
export function defaultSettings() {
    return {
        schema: 1,
        master: false,
        startup: false,
        systems: Object.fromEntries(SYSTEM_NAMES.map((name) => [name, false])),
        callBudgetPerSession: DEFAULT_CALL_BUDGET,
        // The guard is a separate package with its own gate, so it carries its own switch rather
        // than riding the advisor's master. Both ship off: nothing in the Jev layer is active on a
        // fresh install, and `startup` is how a user chooses to default one on.
        guard: { enabled: false, startup: false },
    };
}

function normalize(raw) {
    if (raw?.schema !== 1) {
        return defaultSettings();
    }

    const systems = Object.fromEntries(SYSTEM_NAMES.map((name) => [name, raw.systems?.[name] === true]));
    const budget = Number.isInteger(raw.callBudgetPerSession) ? raw.callBudgetPerSession : DEFAULT_CALL_BUDGET;

    return {
        schema: 1,
        master: raw.master === true,
        startup: raw.startup === true,
        systems,
        callBudgetPerSession: Math.min(Math.max(budget, 0), MAX_CALL_BUDGET),
        guard: { enabled: raw.guard?.enabled === true, startup: raw.guard?.startup === true },
    };
}

export function loadSettings() {
    try {
        const file = settingsFile();
        if (!regularFile(file, "Jev settings")) {
            return defaultSettings();
        }

        return normalize(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
        return defaultSettings();
    }
}

/** Shared atomic write for every file this extension owns. */
export function writeFileAtomic(file, contents) {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
    try {
        fs.writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, file);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

export function saveSettings(settings) {
    const next = normalize({ ...settings, schema: 1 });
    const file = settingsFile();
    if (fs.existsSync(file)) {
        regularFile(file, "Jev settings");
    }

    writeFileAtomic(file, `${JSON.stringify(next, null, 4)}\n`);

    return next;
}

export function settingsPath() {
    return settingsFile();
}

/**
 * The key is never read into any structure that gets logged or serialized. Callers only ever ask
 * whether one is present; the client reads it directly at call time.
 */
export function keyPresent() {
    // OPENROUTER_API_KEY on the default path, TYPESAFE_API_KEY on the direct one; see client.mjs.
    for (const name of ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY"]) {
        const value = process.env[name];
        if (typeof value === "string" && value.trim().length > 0) {
            return true;
        }
    }

    return false;
}
