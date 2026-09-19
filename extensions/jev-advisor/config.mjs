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
export const SYSTEM_NAMES = Object.freeze([
    "retention",
    "compaction",
    "gap",
    "sources",
    "progress",
    "untrusted",
    "capability",
]);

/**
 * What a confident stuck verdict is allowed to do. `notify` tells the person and cannot be wrong in
 * a way that costs anything; `message` appends a fixed line the model reads before its next
 * request, which changes behaviour.
 *
 * It ships on `notify`. Not because the gate cannot tell the cases apart -- it demonstrably can: on
 * the recorded fixtures a session repeating one failing call scores 0.89 for stuck with the mode at
 * 0.99 confidence, and a session working steadily scores 0.30 and reports "unknown" below the gate.
 * The missing number is the false-positive rate on real sessions, and the two things that bear on it
 * point the other way: running the same taxonomy over the 24 recorded failures left 14 of them
 * ungated, and a wrong nudge costs a turn, which is the exact quantity this system exists to save.
 *
 * So the condition for changing this default is a measurement, not an opinion, and the eval suite
 * is where it comes from: `--harness=specpi-jev` sets `message` and discloses it, because a
 * notification in a headless run reaches nobody and would measure the cost of the system with none
 * of its effect.
 */
export const NUDGE_MODES = Object.freeze(["notify", "message"]);

const MAX_SETTINGS_BYTES = 4096;
const MAX_CALL_BUDGET = 64;
const MAX_TOTAL_BUDGET = 128;

/**
 * One shared budget could not survive a turn-level system. A system that fires once per turn would
 * reach a shared ceiling of 8 inside the first few turns and starve retention for the rest of the
 * session, and which one won would be decided by event ordering rather than by anyone's policy.
 *
 * So the ceiling is two-level: each system gets its own, and the total is a real constraint because
 * it is deliberately less than their sum. Running out of one system's budget stops that system and
 * nothing else.
 *
 * The per-system numbers follow how often each one can fire: retention on every large read-only
 * result, compaction once or twice in a long session, gap per report, sources per delegation batch.
 */
export const DEFAULT_BUDGETS = Object.freeze({
    total: 30,
    retention: 12,
    compaction: 3,
    gap: 6,
    sources: 4,
    // Turn-level, but gated behind local signals, so it only spends on sessions that already look
    // wrong. The ceiling is what stops a genuinely thrashing session from spending the total on
    // being told it is thrashing.
    progress: 12,
    // Usually free: when retention is on, system 7's question rides the call retention was already
    // making against the same state. This ceiling only binds when retention is off, or when the
    // fetched result is too small for retention to be interested in it.
    untrusted: 8,
    // Once per session by construction, and only when local signals already suggest it. Two rather
    // than one so a retried first turn is not silently un-served.
    capability: 2,
});

/** 0 is a real budget meaning no calls. Switching a system off is what `systems[name] = false` is for. */
export const MAX_BUDGETS = Object.freeze({ system: MAX_CALL_BUDGET, total: MAX_TOTAL_BUDGET });

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
        schema: 2,
        master: false,
        startup: false,
        systems: Object.fromEntries(SYSTEM_NAMES.map((name) => [name, false])),
        budgets: { ...DEFAULT_BUDGETS },
        progressNudge: "notify",
        // The guard is a separate package with its own gate, so it carries its own switch rather
        // than riding the advisor's master. Both ship off: nothing in the Jev layer is active on a
        // fresh install, and `startup` is how a user chooses to default one on.
        guard: { enabled: false, startup: false },
    };
}

function clamp(value, fallback, ceiling) {
    return Number.isInteger(value) ? Math.min(Math.max(value, 0), ceiling) : fallback;
}

function normalizeBudgets(raw) {
    const budgets = { total: clamp(raw?.total, DEFAULT_BUDGETS.total, MAX_TOTAL_BUDGET) };
    for (const name of SYSTEM_NAMES) {
        budgets[name] = clamp(raw?.[name], DEFAULT_BUDGETS[name] ?? 0, MAX_CALL_BUDGET);
    }

    return budgets;
}

/**
 * Schema 1 carried one `callBudgetPerSession`. Reading it as an unknown shape would switch the
 * layer off for anyone who had turned it on, which is a reset the user never asked for -- "unknown
 * shapes collapse to all-off" is a rule for corrupt input, not for our own previous version. The
 * one number becomes the total, and each system gets the smaller of its default and that total, so
 * a user who set a deliberately tight ceiling keeps it.
 */
function migrate(raw) {
    // Schema 1 read 0 as "no ceiling"; schema 2 reads it as "no calls", because a per-system 0 that
    // silently meant unlimited is the wrong way for a budget to fail. Carrying the old meaning
    // forward here is what stops the bump from inverting a user's intent.
    const stored = raw?.callBudgetPerSession === 0 ? MAX_TOTAL_BUDGET : raw?.callBudgetPerSession;
    const total = clamp(stored, DEFAULT_BUDGETS.total, MAX_TOTAL_BUDGET);
    const budgets = { total };
    for (const name of SYSTEM_NAMES) {
        budgets[name] = Math.min(DEFAULT_BUDGETS[name] ?? 0, total);
    }

    return { ...raw, schema: 2, budgets, callBudgetPerSession: undefined };
}

function normalize(raw) {
    const source = raw?.schema === 1 ? migrate(raw) : raw;
    if (source?.schema !== 2) {
        return defaultSettings();
    }

    const systems = Object.fromEntries(SYSTEM_NAMES.map((name) => [name, source.systems?.[name] === true]));

    return {
        schema: 2,
        master: source.master === true,
        startup: source.startup === true,
        systems,
        budgets: normalizeBudgets(source.budgets),
        progressNudge: NUDGE_MODES.includes(source.progressNudge) ? source.progressNudge : "notify",
        guard: { enabled: source.guard?.enabled === true, startup: source.guard?.startup === true },
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
    // A caller handing back a schema-1 shape is migrated rather than reset, so a round trip through
    // an old reader cannot quietly disable the layer.
    const next = normalize(settings?.schema === 1 ? settings : { ...settings, schema: 2 });
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
