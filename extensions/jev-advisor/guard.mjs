// Integration seam for specpi-jev-guard, the Jev-scored command gate.
//
// The guard is pinned in the base set but ships **inert**, the way web access ships installed but
// withdrawn. Its own `DEFAULT_SETTINGS.enabled` is `true`, so leaving it alone would mean a fresh
// SpecPi install started gating shell and file calls through a third-party service on day one.
// SpecPi writes `enabled: false` instead, and `/jev guard on` is how a human opts in.
//
// One key for the whole layer: `OPENROUTER_API_KEY`. Jev is published on OpenRouter, the guard
// reaches it that way by default, and the advisor now does too, so the guard's backend is left
// alone rather than re-pinned.
//
// Be precise about what this cannot do. The guard is fail-closed by design: with no key, an
// unreachable endpoint, or a middle-band verdict in a session with no UI, it blocks the call and
// says so. There is no setting that hands the decision back to @gotgenes/pi-permission-system
// instead. So the honest posture is:
//
//   - off (the default) -> the guard is not in the tool path at all, and the permission system
//     decides every call exactly as it did before this package existed;
//   - on -> the guard decides first, asks a human in the middle band when there is a UI, and
//     blocks when it cannot reach Jev. An outage stops gated work until it is switched off.
//
// That trade is the user's to make, which is why it ships off and why /jev status says plainly
// what is in force.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentDirectory, regularFile, writeFileAtomic } from "./config.mjs";

export const GUARD_PACKAGE = "specpi-jev-guard";
export const FALLBACK_PACKAGE = "@gotgenes/pi-permission-system";

/** Must match the pin in templates/settings.json. */
export const GUARD_PIN = "npm:specpi-jev-guard@0.1.0";

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
 * default, so its risk rules, protected paths and thresholds stay the package's business.
 */
export function desiredConfig(enabled = false) {
    return {
        // Off means the guard never enters the tool path, so no key is needed and nothing is sent.
        enabled: enabled === true,
        // Left at the guard's own default. Both halves use OpenRouter, so one OPENROUTER_API_KEY
        // serves the guard and the advisor together.
        backend: "openrouter",
        // With a UI, a middle-band verdict asks rather than deciding on its own. Without one the
        // guard fails closed; that is the package's design, disclosed rather than configured away.
        uncertain: "ask",
    };
}

/**
 * The environment variable specpi-jev-guard will actually read, derived from the backend SpecPi
 * writes into its configuration rather than from the advisor's own `JEV_BACKEND`.
 *
 * Those two are not the same thing and assuming they were produced the exact failure this layer
 * exists to avoid. `desiredConfig` pins `backend: "openrouter"` unconditionally, so on a session
 * running the advisor against the direct TypeSafe API, checking `TYPESAFE_API_KEY` would find a key,
 * report the guard armed, and leave a fail-closed gate looking for an `OPENROUTER_API_KEY` that was
 * never set -- blocking every shell and file call in the session. Deriving the name from the config
 * that is about to be written is what keeps the check honest if that pin ever changes.
 */
export function keyEnvName(enabled = false) {
    return desiredConfig(enabled).backend === "typesafe" ? "TYPESAFE_API_KEY" : "OPENROUTER_API_KEY";
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
 * Merge SpecPi's fields into whatever is already there rather than replacing the file. A user who
 * set their own thresholds, safe-command globs or protected paths keeps them; only the three fields
 * above are asserted. Idempotent, and reports what changed so a caller can say so.
 */
export function applyConfig(enabled = false) {
    if (!installed().installed) {
        return { applied: false, reason: "not-installed" };
    }

    const desired = desiredConfig(enabled);
    const current = readConfig();
    if (current && Object.entries(desired).every(([key, value]) => current[key] === value)) {
        return { applied: false, reason: "already-current" };
    }

    writeFileAtomic(guardConfigFile(), `${JSON.stringify({ ...(current ?? {}), ...desired }, null, 4)}\n`);

    return { applied: true, reason: current ? "updated" : "created" };
}

/** One line for `/jev status` and `specpi doctor`. Never prints a key. */
export function statusLine() {
    const state = installed();
    if (!state.installed) {
        return `guard: not installed (command policy stays with ${FALLBACK_PACKAGE})`;
    }

    const config = readConfig();
    if (config?.enabled !== true) {
        return `guard: ${GUARD_PACKAGE}@${state.version} installed but off (every call goes to ${FALLBACK_PACKAGE})`;
    }

    const backend = config.backend === "typesafe" ? "typesafe" : (config.backend ?? "openrouter");
    const variable = backend === "typesafe" ? "TYPESAFE_API_KEY" : "OPENROUTER_API_KEY";

    return `guard: ${GUARD_PACKAGE}@${state.version} ON via ${backend} (${variable} ${process.env[variable] ? "present" : "MISSING"}); it decides before ${FALLBACK_PACKAGE} and fails closed when Jev is unreachable`;
}

export function configPath() {
    return guardConfigFile();
}
