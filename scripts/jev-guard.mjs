// Install-time seam for specpi-jev-guard, the Jev-scored command gate.
//
// The guard is pinned in the base set but ships **inert**. Its own `DEFAULT_SETTINGS.enabled` is
// `true`, so leaving it alone would mean a fresh SpecPi install started gating shell and file calls
// through a third-party service on day one. SpecPi writes `enabled: false` instead.
//
// That is the whole of SpecPi's involvement, and the file lives under `scripts/` to say so. The
// guard is its own thing: it ships its own `/jev-guard setup | on | off [--global] | check | model
// | backend`, keeps its own configuration, resolves its own key, and is not part of the Jev layer.
// The advisor imports nothing from here, `/jev` does not mention it, and no switch in SpecPi turns
// it on. One command does -- the package's own.
//
// Be precise about what this cannot do. The guard is fail-closed by design: with no key, an
// unreachable endpoint, or an answer it cannot parse, the call does not go through, and in a
// session with no UI its `uncertain` default blocks the middle band too. There is no setting that
// hands the decision back to @gotgenes/pi-permission-system instead. So the honest posture is:
//
//   - off (what SpecPi installs) -> the guard is not in the tool path at all, and the permission
//     system decides every call exactly as it did before this package existed;
//   - on -> the guard decides first, asks a human in the middle band when there is a UI, and
//     blocks when it cannot reach Jev. An outage stops gated work until it is switched off.
//
// That trade is the user's to make, which is why SpecPi only ever writes the off side of it.
//
// ONE KEY, and not one SpecPi supplies. Since 0.3.0 the package reads Pi's saved login first and
// the environment second -- the same order the Jev advisor uses for the same provider entry -- so
// `/login openrouter` serves both without either knowing about the other.
//
// `auditDisplay` is deliberately not asserted below, although SpecPi Chat renders the counter that
// setting controls. It defaults to `status`, which is what publishes the line, and it is the user's
// to change: pinning it here would take a display preference away from them to guarantee a readout
// in one frontend. A session with it set to `off` simply shows no counter, which is what they
// asked for.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentDirectory, regularFile, writeFileAtomic } from "../extensions/jev-advisor/config.mjs";

export const GUARD_PACKAGE = "specpi-jev-guard";

/** Must match the pin in templates/settings.json. */
export const GUARD_PIN = "npm:specpi-jev-guard@0.4.0";

// The guard reads `<homedir>/.pi/jev-guard.json` globally, and a project copy under `<cwd>/.pi/`
// when the project is trusted. SpecPi writes only the global file: a project-local override is the
// user's to make, and writing one would put a security setting inside whatever repository happened
// to be open at the time.
const CONFIG_DIR_NAME = ".pi";
const SETTINGS_FILE = "jev-guard.json";

function guardRoot() {
    return path.join(agentDirectory(), "npm", "node_modules", GUARD_PACKAGE);
}

function guardConfigFile() {
    return path.join(os.homedir(), CONFIG_DIR_NAME, SETTINGS_FILE);
}

export function installed() {
    try {
        const manifest = path.join(guardRoot(), "package.json");
        if (!fs.existsSync(manifest)) {
            return { installed: false };
        }

        const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
        if (parsed?.name !== GUARD_PACKAGE) {
            return { installed: false };
        }

        return { installed: true, version: typeof parsed.version === "string" ? parsed.version : "unknown" };
    } catch {
        return { installed: false };
    }
}

/**
 * The fields SpecPi owns, in the guard's own schema. Anything absent here keeps the package's
 * default, so its thresholds, command lists, protected paths and model settings stay its business.
 *
 * There is no `enabled: true` form of this, deliberately. SpecPi has no command that arms the
 * guard, so a function that could produce an armed configuration would have no caller and one
 * obvious wrong use.
 */
export function desiredConfig() {
    return {
        // Off means the guard never enters the tool path, so no key is needed and nothing is sent.
        enabled: false,
        // Left at the guard's own default, and asserted so the two halves of the Jev story resolve
        // the same credential: one `/login openrouter` serves the advisor and the guard.
        backend: "openrouter",
        // With a UI, a middle-band verdict asks rather than deciding on its own. Without one the
        // guard fails closed; that is the package's design, disclosed rather than configured away.
        uncertain: "ask",
    };
}

export function readConfig() {
    try {
        const file = guardConfigFile();
        if (!regularFile(file, "Jev guard settings")) {
            return undefined;
        }

        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return undefined;
    }
}

/**
 * Write the inert posture, merged into whatever is already there.
 *
 * Merged, not replaced: a user's own thresholds, safe-command globs and protected paths survive,
 * and only the three fields above are asserted. Idempotent, and it reports what it changed so the
 * installer can say so.
 *
 * It runs on install and on update, and it always asserts `enabled: false`. Not only when the file
 * is absent, which is the version of this that looks safer and is not: an install carrying a stale
 * `enabled: true` from before this package was last unpinned would arm a fail-closed gate the
 * moment the package came back, with nobody present to be told. So the rule is the blunt one --
 * SpecPi never leaves an armed gate behind an installer run -- and `disarmed` is returned so the
 * run can report the one case where that took something away from someone.
 *
 * This is an occasional, human-initiated act, which is what makes the blunt rule affordable. It
 * deliberately does not run at session start: the package owns its switch between installs, and a
 * per-session rewrite would mean `/jev-guard on --global` never survived a restart.
 */
export function applyInertConfig() {
    if (!installed().installed) {
        return { applied: false, reason: "not-installed" };
    }

    const desired = desiredConfig();
    const current = readConfig();
    if (current && Object.entries(desired).every(([key, value]) => current[key] === value)) {
        return { applied: false, reason: "already-current" };
    }

    writeFileAtomic(guardConfigFile(), `${JSON.stringify({ ...(current ?? {}), ...desired }, null, 4)}\n`);

    return {
        applied: true,
        reason: current ? "updated" : "created",
        // The one change worth announcing: everything else here is establishing a default, and this
        // is switching off a gate a human had switched on.
        disarmed: current?.enabled === true,
    };
}

export function configPath() {
    return guardConfigFile();
}
