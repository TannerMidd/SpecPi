// What `/jev on` and `/jev off` actually do, as functions a test can call.
//
// This logic used to live in closures inside index.ts, which no test imports -- every test in the
// suite reaches for a `.mjs` module, so the whole feature was covered only by prose. Two review
// rounds found the consequences: a guard preference destroyed on a path that had decided nothing, a
// fail-closed gate armed by a headless session that was told nothing had changed, a message
// reporting the guard "left off" while it was on and blocking, and a rollback that never happened
// because the flag was set before the write. None of those were visible to a green suite, because
// the suite could not see them at all.
//
// So the shape here is deliberate: no module state, no reads of `process` beyond an injected `env`,
// and every effect either returned as data or performed through an injected dependency. The caller
// owns the session; this decides what should happen to it and says so.

import { SYSTEM_NAMES } from "./config.mjs";

/**
 * Decide what a layer switch means, and report it honestly.
 *
 * `state` is `{ settings }` and is never mutated -- the next state comes back in the result. `deps`
 * supplies the outside world, which is now only `keySources`: the command guard used to need a
 * package's global configuration file arbitrated here, and as the eighth system it needs nothing.
 *
 * Scope belongs to `layerScopeLine`, not here, so this takes `{ on }` and nothing else. It used to
 * be handed `sessionOnly` and `interactive` as well and read neither, which reads as a decision
 * being made from them.
 */
export function applyLayer({ on }, state, deps) {
    if (!on) {
        return { settings: { ...state.settings, master: false }, lines: [offLine()] };
    }

    // Resolved inside the on branch only. `offLine` never names a key, so doing this first meant
    // every `/jev off` paid for a stat, read and parse of Pi's credential store to discard it --
    // the one file this layer reads under a narrow, stated exception.
    const active = deps.keySources().find((item) => item.present)?.name;
    const settings = enableSystems(state.settings);

    return { settings, lines: onLines(state.settings, settings, active) };
}

/**
 * What arming the command guard means, in the words every path that arms it has to use.
 *
 * Seven of the eight systems only ever add advice; this one can refuse a tool call. Saying so is a
 * rule rather than a nicety, and it lives here because it was a rule `/jev on` honoured alone while
 * `/jev enable guard` and `/jev startup on` armed the same system in silence.
 */
export function guardWarning() {
    return (
        "guard is the only system that can refuse a tool call: it blocks a call it reads as " +
        "destructive and not what was asked for, asks you about the uncertain ones, and hands " +
        "everything else to the permission system unchanged. Turn it off with /jev disable guard."
    );
}

/**
 * Enabling the layer enables its systems, because a layer with none on runs and does nothing -- the
 * state people kept arriving at, with the notification cheerfully reporting "0 of 8".
 *
 * Only when none are on. Someone deliberately running retention alone has expressed a preference,
 * and `/jev off` then `/jev on` must not hand back the seven they turned off.
 *
 * The command guard is one of the eight, and it is the only system that can refuse a tool call. That
 * is a deliberate answer to a question this file and `config.mjs` resolve differently on purpose:
 * `/jev on` is a person acting now, so it arms everything and `onLines` says in as many words that
 * one of them can refuse a command; `migrateToThree` runs without anyone present, so it arms
 * nothing new. Silence is the difference -- an unattended migration must not change what a session
 * is allowed to run, and an explicit command that reports what it did may.
 */
export function enableSystems(settings) {
    const chosen = SYSTEM_NAMES.filter((name) => settings.systems[name]);

    return {
        ...settings,
        master: true,
        systems: chosen.length > 0 ? settings.systems : Object.fromEntries(SYSTEM_NAMES.map((name) => [name, true])),
    };
}

function onLines(before, after, activeSource) {
    const chosen = SYSTEM_NAMES.filter((name) => before.systems[name]);
    const active = SYSTEM_NAMES.filter((name) => after.systems[name]);
    const lines = [`Jev layer on with ${active.length} of ${SYSTEM_NAMES.length} systems: ${active.join(", ")}.`];
    if (chosen.length === 0) {
        lines.push("No system was enabled, so all of them were. Turn any back off with /jev disable <system>.");
    }

    // Said out loud every time, because seven of the eight only ever add advice and this one can
    // take a command away. Nobody should discover that from a blocked call.
    if (after.systems.guard) {
        lines.push(guardWarning());
    }

    lines.push(keyLine(activeSource));

    return lines;
}

function offLine() {
    return "Jev layer off. No state leaves this machine, and every tool call goes to the permission system.";
}

/**
 * Where the key is coming from, by name and never by value. Takes the already-resolved source name
 * rather than looking it up, so one command cannot read the credential store twice.
 */
export function keyLine(source) {
    if (source) {
        return `Key: found in ${source === "auth.json" ? "Pi's credential store (auth.json)" : source}.`;
    }

    return (
        "Key: none found, so every system will report no advice and the harness runs exactly as it did before. " +
        "Run /login openrouter to store one, or set OPENROUTER_API_KEY."
    );
}

/**
 * The settings to write so that turning the layer on is remembered.
 *
 * `master` and `startup` always move together. Storing them apart is what made the Chat panel's
 * "enabled" checkbox do nothing on its own: `session_start` zeroes a stored master whenever
 * `startup` is false, so `master: true, startup: false` describes a layer that is on and never runs.
 *
 * The stored file is the base, so budgets and the nudge mode written by Chat while this session was
 * running survive -- including any system the panel enabled since this session started, which is why
 * `systems` is merged rather than written over.
 */
export function layerToPersist({ settings }, stored) {
    return {
        ...stored,
        master: settings.master,
        startup: settings.master,
        // Merged onto the stored map, not written over it. This session's copy may predate systems
        // enabled on disk since it started -- by the Chat panel, or by another session -- and
        // writing it whole turned those back off with nothing reporting it.
        systems: { ...stored.systems, ...settings.systems },
    };
}

/** What the change applies to: this session, or every session from now on. */
export function layerScopeLine({ sessionOnly, interactive, persisted, stored, settingsFile }) {
    if (sessionOnly) {
        return `This session only, as asked. New sessions still start ${stored.startup && stored.master ? "on" : "off"}.`;
    }

    if (!interactive) {
        return "This session only: writing the startup preference needs an interactive command.";
    }

    if (!persisted) {
        return `This session only: ${settingsFile} could not be written.`;
    }

    return `Remembered -- new Pi sessions start this way too. Preference: ${settingsFile}`;
}

/**
 * `/jev startup on|off`, which was the last command still writing one half of the pair -- the exact
 * trap this module exists to remove, left in the command named after it, while reporting that new
 * sessions would start on when they would not.
 */
export function startupToPersist(wanted, stored) {
    // Delegates to `enableSystems` rather than restating the rule. Three copies of "what enabling
    // the layer means" -- here, there, and `couple` in the Chat panel -- is precisely how the
    // advisor and the panel drift apart, which is the class of bug this module was extracted over.
    return wanted ? { ...enableSystems(stored), startup: true } : { ...stored, master: false, startup: false };
}
