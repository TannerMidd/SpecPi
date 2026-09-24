// Install-time seam for @gotgenes/pi-permission-system: make it gate SpecPi's `background` tool
// exactly like `bash`.
//
// The permission system gates native `bash` through its full command stack -- decomposition,
// wrapper flooring, path and outside-directory checks, and every `bash:` rule. An extension tool
// that runs shell commands under another name gets none of that unless the permission system is
// told the tool is a shell; its documented `shellTools` setting does exactly that. Without it a
// background job could run a command a `bash` rule denies.
//
// So SpecPi records one entry, `shellTools.background = { commandArgument: "command" }`, in the
// permission system's global config at install and update, and removes it again at uninstall. The
// extension checks the effective mapping before every start and refuses without it, so a missing
// or altered entry turns background jobs off; it never leaves them ungated.
//
// Merged, never replaced: every other key in the file is the user's and survives unchanged. A file
// carrying comments is left alone, because rewriting it as plain JSON would delete them; the run
// says so and names the one line to add by hand.

import fs from "node:fs";
import path from "node:path";

export const PERMISSION_PACKAGE = "@gotgenes/pi-permission-system";
export const SHELL_TOOL = "background";
export const SHELL_TOOL_MAPPING = Object.freeze({ commandArgument: "command" });

export function permissionConfigFile(agentDir) {
    return path.join(agentDir, "extensions", "pi-permission-system", "config.json");
}

export function permissionInstalled(agentDir) {
    try {
        const manifest = path.join(agentDir, "npm", "node_modules", ...PERMISSION_PACKAGE.split("/"), "package.json");

        return JSON.parse(fs.readFileSync(manifest, "utf8"))?.name === PERMISSION_PACKAGE;
    } catch {
        return false;
    }
}

function sameMapping(value) {
    return (
        Boolean(value) &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === 1 &&
        value.commandArgument === SHELL_TOOL_MAPPING.commandArgument
    );
}

/** The file as plain JSON, `undefined` when absent, or `{ unreadable }` when it cannot be rewritten. */
function readConfig(file) {
    if (!fs.existsSync(file)) {
        return { config: undefined };
    }

    const stat = fs.lstatSync(file);
    if (!stat.isFile()) {
        return { unreadable: "it is not a regular file" };
    }

    try {
        const config = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!config || typeof config !== "object" || Array.isArray(config)) {
            return { unreadable: "it is not a JSON object" };
        }

        return { config };
    } catch {
        return {
            unreadable: "it is not plain JSON (comments are allowed there, but SpecPi will not rewrite them away)",
        };
    }
}

function writeConfig(file, config, mode) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(config, null, 4)}\n`, { mode });
    fs.renameSync(temporary, file);
}

export function manualInstruction(agentDir) {
    return `add "shellTools": { "${SHELL_TOOL}": { "commandArgument": "command" } } to ${permissionConfigFile(agentDir)} so bash rules apply to background jobs`;
}

/**
 * Record the mapping. Returns what happened so the installer can report the cases worth reporting:
 * a file it could not rewrite, or an existing `background` entry pointing somewhere else, which it
 * replaces because that entry would have left `command` ungated.
 */
export function applyShellToolMapping(agentDir) {
    if (!permissionInstalled(agentDir)) {
        return { applied: false, reason: "not-installed" };
    }

    const file = permissionConfigFile(agentDir);
    const { config, unreadable } = readConfig(file);
    if (unreadable) {
        return { applied: false, reason: "unreadable", detail: unreadable };
    }

    const current = config?.shellTools?.[SHELL_TOOL];
    if (sameMapping(current)) {
        return { applied: false, reason: "already-current" };
    }

    if (
        config?.shellTools !== undefined &&
        (typeof config.shellTools !== "object" || Array.isArray(config.shellTools))
    ) {
        return { applied: false, reason: "unreadable", detail: "its shellTools value is not an object" };
    }

    const next = {
        ...(config ?? {}),
        shellTools: { ...(config?.shellTools ?? {}), [SHELL_TOOL]: { ...SHELL_TOOL_MAPPING } },
    };
    writeConfig(file, next, config ? fs.statSync(file).mode & 0o777 : 0o600);

    return { applied: true, reason: config ? "updated" : "created", replaced: current !== undefined };
}

/** Remove SpecPi's entry, and the file too when that entry was all it held. */
export function removeShellToolMapping(agentDir) {
    const file = permissionConfigFile(agentDir);
    const { config, unreadable } = readConfig(file);
    if (unreadable || !config || !sameMapping(config.shellTools?.[SHELL_TOOL])) {
        return { removed: false };
    }

    const { [SHELL_TOOL]: _removed, ...shellTools } = config.shellTools;
    const next = { ...config, shellTools };
    if (Object.keys(shellTools).length === 0) {
        delete next.shellTools;
    }

    if (Object.keys(next).length === 0) {
        fs.rmSync(file);

        return { removed: true, deletedFile: true };
    }

    writeConfig(file, next, fs.statSync(file).mode & 0o777);

    return { removed: true, deletedFile: false };
}
