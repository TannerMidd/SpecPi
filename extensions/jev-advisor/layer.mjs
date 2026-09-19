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
 * `state` is `{ settings, guardEnabled }` and is never mutated -- the next state comes back in the
 * result. `deps` supplies the outside world: `guard` (installed/keyEnvName/apply/configPath),
 * `keySources` and `env`.
 *
 * Returns `{ settings, guardEnabled, guardChanged, lines }`. `guardChanged` means the guard's
 * configuration was actually written, not merely that the command was allowed to consider it; that
 * distinction is what stops a later persist from overwriting a preference nobody touched.
 */
export function applyLayer({ on, sessionOnly = false, interactive = true }, state, deps) {
    // One read of the credential store per command. Each lookup stats, reads and parses a file, and
    // both the key line and the guard's message want the same answer.
    const active = deps.keySources().find((item) => item.present)?.name;
    const settings = on ? enableSystems(state.settings) : { ...state.settings, master: false };
    const lines = on ? onLines(state.settings, settings, active) : [offLine()];
    const guard = decideGuard({ on, sessionOnly, interactive }, state, deps, active);

    return {
        settings,
        guardEnabled: guard.guardEnabled,
        guardChanged: guard.changed,
        lines: [...lines, ...guard.lines],
    };
}

/**
 * Enabling the layer enables its systems, because a layer with none on runs and does nothing -- the
 * state people kept arriving at, with the notification cheerfully reporting "0 of 7".
 *
 * Only when none are on. Someone deliberately running retention alone has expressed a preference,
 * and `/jev off` then `/jev on` must not hand back the six they turned off.
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
 * The command guard, which is unlike the seven advisor systems in three ways that all have to be
 * handled here rather than discovered later.
 *
 * It is fail-closed: with no key it blocks shell and file calls rather than standing aside. It reads
 * its key from the environment only, being a separate package with no knowledge of Pi's credential
 * store, so a key that serves the advisor perfectly well can be invisible to it. And its
 * configuration is one global file that every Pi session on the machine reads, so there is no such
 * thing as enabling it for a single session.
 *
 * Copying the resolved key into `process.env` so the guard could see it is refused deliberately: the
 * environment is inherited by every command the agent runs, so it would turn a credential scoped to
 * one file into one that any `env` in a shell tool can read. Enabling a security feature is not a
 * reason to widen the blast radius of a secret.
 */
function decideGuard({ on, sessionOnly, interactive }, state, deps, activeSource) {
    const unchanged = (lines) => ({ guardEnabled: state.guardEnabled, changed: false, lines });
    if (!deps.guard.installed()) {
        return unchanged(
            on ? [`Command guard: not installed, so command policy stays with ${deps.guard.fallbackPackage}.`] : [],
        );
    }

    // Its configuration is global, so `--session` cannot scope it. Saying so beats a silent
    // machine-wide change to a fail-closed gate made by a command that promised the opposite.
    if (sessionOnly) {
        return unchanged([
            `Command guard: unchanged. Its configuration is a global file (${deps.guard.configPath()}) that every Pi session reads, so --session cannot scope it. Use /jev guard on or off to change it deliberately.`,
        ]);
    }

    // Same reason, one step further: a headless run writing that global file would change every
    // other session on the machine while being told "this session only". Every other
    // startup-affecting branch of /jev already refuses without a human.
    if (!interactive) {
        return unchanged([
            "Command guard: unchanged. Switching a gate that every Pi session on this machine reads needs a human interactive command; run /jev guard on or off.",
        ]);
    }

    if (!on) {
        // Weakening a security gate machine-wide deserves at least the disclosure that strengthening
        // it gets. It said only "off" while arming said "for every Pi session on this machine".
        return writeGuard(false, state, deps, [
            `Command guard: off for every Pi session on this machine, not just this one (${deps.guard.configPath()}). Every tool call goes to ${deps.guard.fallbackPackage}.`,
        ]);
    }

    const variable = deps.guard.keyEnvName();
    const value = deps.env[variable];
    if (typeof value !== "string" || value.trim().length === 0) {
        const seen = activeSource === "auth.json" ? "the key in Pi's credential store" : "any key";

        // Whether it is already on decides which of these is true, and reporting the wrong one is
        // worst precisely here: telling someone the guard was "left off" while it is on and
        // blocking every call reads as reassurance at the moment their session is broken.
        return unchanged([
            state.guardEnabled
                ? `Command guard: ALREADY ON and cannot read ${variable}, so it is blocking calls it cannot score. Set ${variable} in the environment and restart Pi, or run /jev guard off.`
                : `Command guard: left off. It reads ${variable} from the environment and cannot see ${seen}, and it fails closed -- switching it on without a key it can read would block every shell and file call. Set ${variable} in the environment, then /jev guard on.`,
        ]);
    }

    return writeGuard(true, state, deps, [
        `Command guard: ON for every Pi session on this machine, not just this one (${deps.guard.configPath()}). ` +
            "It scores shell and file calls before the permission system sees them, and blocks them while Jev is " +
            `unreachable -- including if ${variable} is stale or revoked, which is not checked here. /jev guard off returns policy to the permission system.`,
    ]);
}

/**
 * Perform the write, and only claim the change if it happened.
 *
 * The flag used to be set before the write and never rolled back, so an unwritable settings file
 * left the session believing the guard was on and persisted a preference for a state that had just
 * been proved unreachable -- which the next session would then retry.
 */
function writeGuard(wanted, state, deps, lines) {
    const result = deps.guard.apply(wanted);
    if (result.applied || result.reason === "already-current") {
        return { guardEnabled: wanted, changed: result.applied, lines };
    }

    return {
        guardEnabled: state.guardEnabled,
        changed: false,
        lines: [
            `Command guard: unchanged -- its settings file could not be written (${result.reason}). Command policy stays with ${deps.guard.fallbackPackage}.`,
        ],
    };
}

/**
 * The settings to write so that turning the layer on is remembered.
 *
 * `master` and `startup` always move together. Storing them apart is what made the Chat panel's
 * "enabled" checkbox do nothing on its own: `session_start` zeroes a stored master whenever
 * `startup` is false, so `master: true, startup: false` describes a layer that is on and never runs.
 *
 * The stored file is the base, so budgets and the nudge mode written by Chat while this session was
 * running survive. The guard is carried over untouched unless this command actually wrote it --
 * `/jev guard startup on` explicitly promises to leave the session alone, and a later `/jev on` was
 * silently discarding that.
 */
export function layerToPersist({ settings, guardEnabled, guardChanged }, stored) {
    return {
        ...stored,
        master: settings.master,
        startup: settings.master,
        systems: { ...settings.systems },
        // `startup` follows only when the guard was armed. Turning the layer off disarms the guard
        // for this machine, which is a real change worth writing -- but it is not a statement about
        // whether the user wants it armed next time, and erasing a preference they set with
        // `/jev guard startup on` is not this command's business. The guard is a separate switch,
        // which is exactly why it has its own commands.
        guard: guardChanged
            ? { enabled: guardEnabled, startup: guardEnabled ? true : stored.guard.startup }
            : stored.guard,
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
