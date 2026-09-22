// Jev is the first thing in SpecPi that talks to a third party, so its switch is the first thing
// every other module in this directory consults. Master off means no key value read, no consent
// read, no network call and no prompt injection: the harness behaves exactly as it did before the
// extension existed. `/jev status` still reports whether a key exists while the layer is off, by
// name and never by value, because "how do I configure this" is a question asked before enabling
// anything -- see key-source.mjs.
//
// The command guard is not here at all. It is a separate pinned package that keeps its own
// configuration and its own switch, and nothing in this file tracks it -- see scripts/jev-guard.mjs
// for the one place SpecPi touches it, which is install time.
//
// The file is SpecPi's own, hardened the same way as web-access and capability-policy: atomic
// write, mode 0600, symlinks refused, and a missing or unreadable file read as off.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Systems that may run inside a session. Offline scripts are not gated here. */
export const SYSTEM_NAMES = Object.freeze(["retention", "gap", "sources", "progress", "untrusted", "capability"]);

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
const MAX_CALL_BUDGET = 1024;
const MAX_TOTAL_BUDGET = 2048;

/**
 * One shared budget could not survive a turn-level system. A system that fires once per turn would
 * reach a shared ceiling of 8 inside the first few turns and starve retention for the rest of the
 * session, and which one won would be decided by event ordering rather than by anyone's policy.
 *
 * So the ceiling is two-level: each system gets its own, and the total is a real constraint because
 * it is deliberately less than their sum -- 2048 against 2274. That relationship is the invariant,
 * not either number: raising the total without raising the per-system ceilings would leave a total
 * no combination of systems could ever reach, which is a limit that reads as a limit and is not
 * one. `tests/jev-advisor.test.mjs` pins the inequality so a future change to one has to consider
 * the other. Running out of one system's budget stops that system and nothing else.
 *
 * The per-system numbers follow how often each one can fire: retention on every large read-only
 * result, gap per report, sources per delegation batch.
 */
export const DEFAULT_BUDGETS = Object.freeze({
    // A backstop, not a working limit, and the number says which. Measured, a full tier-3 task -- a
    // 120-step repair chain over about 25 model requests -- spends 4 to 7 calls, and the busiest
    // attempt ever recorded spent 12. A session would have to run for days before 2048 bound
    // anything a person was actually doing, which is the point: the ceiling should only ever be hit
    // by a loop, and hitting it should therefore be information rather than an inconvenience.
    //
    // The earlier 120 was sized against eval attempts, which is the wrong reference. An attempt
    // runs for two minutes; an interactive session runs for a day, and a turn-level system at one
    // call every four turns reaches 120 somewhere in the afternoon and then goes quiet without
    // having found anything wrong. A ceiling that a normal long session reaches is not protecting
    // anyone, it is just failing later than it looks. 512 was the same mistake one order of
    // magnitude further out, and the long-session evals are what showed it: a session long enough
    // to compact several times spends in the hundreds, so the backstop sat close enough to real
    // use to be reachable by a session that was working correctly.
    //
    // Cost is not what these are for. A call is about $0.00003, so the whole total is about six
    // cents. They bound two things that do not get cheaper with scale: how much digest leaves the
    // machine for a third party, at up to 1 KB a call, and how much awaited latency a runaway loop
    // can add before something stops it. Two megabytes of digest and an announced stop is the shape
    // of the trade.
    total: 2048,
    // The per-system numbers move with the total, because a total the per-system ceilings can never
    // add up to is not a constraint at all -- see below. They are scaled rather than re-derived:
    // each one's rationale is a firing frequency, and none of those frequencies changed.
    retention: 832,
    gap: 192,
    sources: 128,
    // Turn-level, but gated behind local signals and a four-turn cooldown, so it only spends on
    // sessions that already look wrong. The ceiling is what stops a genuinely thrashing session
    // from spending the total on being told it is thrashing.
    progress: 704,
    // Usually free: when retention is on, system 7's question rides the call retention was already
    // making against the same state. This ceiling only binds when retention is off, or when the
    // fetched result is too small for retention to be interested in it.
    untrusted: 416,
    // Once per session by construction, and only when local signals already suggest it. Two rather
    // than one so a retried first turn is not silently un-served. The one number here that does not
    // scale with the total, because it is not sized by a frequency: the system asks once and then
    // never again, so a larger ceiling would buy nothing and would only misdescribe what it does.
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
        schema: 5,
        master: false,
        startup: false,
        systems: Object.fromEntries(SYSTEM_NAMES.map((name) => [name, false])),
        budgets: { ...DEFAULT_BUDGETS },
        progressNudge: "notify",
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

/**
 * Schema 4 removes every trace of the command guard from this file, from either shape it took.
 *
 * Schema 2 kept a `guard: { enabled, startup }` pair, from when SpecPi re-asserted the package's
 * switch at every session start; schema 3 made the guard the layer's eighth system under
 * `systems.guard`. Both keys go, because neither answer is SpecPi's to hold any more: the package
 * owns its switch in its own file, and a stale copy here could only ever disagree with it.
 *
 * Dropping them changes nothing about whether anyone's guard is on. A schema-2 file's preference
 * had already been written through to the package's own configuration by the last session that
 * read it, and schema 3 shipped with no guard package installed at all.
 */
function migrateToFour(raw) {
    const { guard: _pair, ...rest } = raw ?? {};
    const { guard: _system, ...systems } = rest.systems ?? {};

    return { ...rest, schema: 4, systems };
}

/**
 * Schema 5 removes compaction guidance, which was withdrawn rather than fixed.
 *
 * Two tier-6 runs, on SpecPi 0.28.0 and 0.29.0, both measured the arm carrying it solving fewer
 * long-session tasks than plain SpecPi: 14/16 against 8/16 pooled, Fisher exact p = 0.054. Over the
 * same attempts compaction was 55 of 56 applied verdicts, so the arm's behaviour was almost entirely
 * this system's, and no other system in the layer applied enough to be a candidate.
 *
 * The evidence never reached significance and the mechanism was never isolated. The system was
 * removed anyway, because a system that steers a summary has to earn the risk it takes, and one
 * whose only measurement says it costs solve rate has not.
 *
 * Both the `systems.compaction` switch and the per-system `budgets.compaction` ceiling go. Dropping
 * them turns nothing off that a user had on in any meaningful sense: the hooks they gated no longer
 * exist, so a retained preference could only describe a system that cannot run.
 */
function migrateToFive(raw) {
    const { compaction: _system, ...systems } = raw?.systems ?? {};
    const { compaction: _budget, ...budgets } = raw?.budgets ?? {};

    return { ...raw, schema: 5, systems, budgets };
}

/**
 * What the advisor will read, given a settings object, without writing it anywhere.
 *
 * Exported for callers that compose a settings file for somewhere other than this process's own
 * agent directory -- the eval harness writes one into a disposable home -- and need to check what
 * they composed. Building a literal and trusting it is how the harness came to run every published
 * tier with a system it believed it had enabled switched off: it hardcoded a schema number, the
 * migration for that number read a preference from a key that shape does not have, and nothing ever
 * compared the result to the ask. Compose, then normalize, then assert -- not compose and trust.
 */
export function normalizeSettings(raw) {
    return normalize(raw);
}

function normalize(raw) {
    const one = raw?.schema === 1 ? migrate(raw) : raw;
    const four = one?.schema === 2 || one?.schema === 3 ? migrateToFour(one) : one;
    const source = four?.schema === 4 ? migrateToFive(four) : four;
    if (source?.schema !== 5) {
        return defaultSettings();
    }

    const systems = Object.fromEntries(SYSTEM_NAMES.map((name) => [name, source.systems?.[name] === true]));

    return {
        schema: 5,
        master: source.master === true,
        startup: source.startup === true,
        systems,
        budgets: normalizeBudgets(source.budgets),
        progressNudge: NUDGE_MODES.includes(source.progressNudge) ? source.progressNudge : "notify",
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
    // A caller handing back an older shape is migrated rather than reset, so a round trip through
    // an old reader cannot quietly disable the layer.
    const next = normalize([1, 2, 3, 4].includes(settings?.schema) ? settings : { ...settings, schema: 5 });
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
