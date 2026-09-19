import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { packageIdentity, packageSource } from "./lib.mjs";

export const basePackages = JSON.parse(
    fs.readFileSync(new URL("../templates/settings.json", import.meta.url), "utf8"),
).packages;

// Invoke only the installed, pinned package's Node bin; never npx, Bun, or OS dependency setup.
export function runBrowserQA(agentDir, command) {
    if (!["setup", "doctor"].includes(command)) {
        throw new Error(`Unsupported Browser QA command: ${command}`);
    }

    const root = path.join(agentDir, "npm", "node_modules", "specpi-browser-qa");
    try {
        const installed = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
        if (
            installed.name !== "specpi-browser-qa" ||
            installed.version !== "0.3.0" ||
            installed.bin?.["specpi-browser-qa"] !== "./bin/browser-qa.mjs"
        ) {
            throw new Error("Missing or changed pinned Browser QA bin metadata");
        }

        const bin = path.join(root, "bin", "browser-qa.mjs");
        const relative = path.relative(fs.realpathSync(root), fs.realpathSync(bin));
        if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
            throw new Error("Browser QA bin escapes its package directory");
        }

        const result = spawnSync(process.execPath, [bin, command], {
            cwd: agentDir,
            env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
            stdio: "inherit",
            windowsHide: true,
            timeout: command === "setup" ? 690_000 : 75_000,
        });
        if (result.error || result.status !== 0) {
            throw new Error(result.error?.message || `exit ${result.signal ?? result.status}`);
        }
    } catch (error) {
        throw new Error(
            `Browser QA ${command} failed: ${error.message}. Retry specpi install (or specpi update if already installed) for Chromium setup; install missing OS libraries manually. Doctor never downloads browsers.`,
        );
    }
}

/**
 * Packages a past SpecPi version pinned and this one no longer does.
 *
 * Dropping an entry from `templates/settings.json` stops new installs getting it and does nothing at
 * all to a machine that already has it: the entry stays in `settings.json` and Pi keeps loading it.
 * That is tolerable for a package that merely stopped being useful, and not tolerable for
 * `specpi-jev-guard`, which fails closed -- an install left holding it after SpecPi deleted both the
 * code that kept it inert and the `/jev guard off` command that could disarm it would block every
 * shell call the moment its key or its endpoint went away, with nothing left to turn it off.
 *
 * So retirement is explicit, and it removes the entry rather than waiting for the restore path to.
 */
export const retiredPackages = Object.freeze(["npm:specpi-jev-guard"]);

/**
 * Drop retired entries from a settings object, in place, reporting what was removed and what was not.
 *
 * Only an entry in the shape SpecPi writes -- a bare pinned source string -- is removed. An entry a
 * user has given filters of their own is theirs, which is the same ownership rule the restore path
 * applies to every other retired package, and it is reported rather than deleted. Version is not
 * consulted: the reason for retirement is the package.
 */
export function removeRetiredPackages(settings) {
    if (!Array.isArray(settings?.packages)) {
        return { removed: [], preserved: [] };
    }

    const removed = [];
    const preserved = [];
    settings.packages = settings.packages.filter((entry) => {
        if (!retiredPackages.includes(packageIdentity(entry))) {
            return true;
        }

        if (typeof entry !== "string") {
            preserved.push(packageSource(entry));

            return true;
        }

        removed.push(entry);

        return false;
    });

    return { removed, preserved };
}

export function packageChanges(before, after) {
    return basePackages.map((source) => {
        const identity = packageIdentity(source);
        const original = before.find((entry) => packageIdentity(entry) === identity);
        const installed = after.find((entry) => packageIdentity(entry) === identity);
        if (packageSource(installed) !== source) {
            throw new Error(`Pi did not save the requested package: ${source}`);
        }

        return {
            identity,
            beforeExists: original !== undefined,
            ...(original === undefined ? {} : { before: original }),
            installed,
        };
    });
}

export function installBasePackages(agentDir) {
    const requested = process.env.SPECPI_PI || "pi";
    const hasPath = path.isAbsolute(requested) || /[/\\]/.test(requested);
    const suffixes =
        process.platform === "win32" && !path.extname(requested)
            ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")
            : [""];
    const candidates = hasPath
        ? suffixes.map((suffix) => path.resolve(`${requested}${suffix}`))
        : (process.env.PATH || process.env.Path || "")
              .split(path.delimiter)
              .flatMap((directory) => suffixes.map((suffix) => path.resolve(directory, `${requested}${suffix}`)));
    const command = candidates.find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
    if (!command) {
        throw new Error("Pi was not found. Install Pi, put pi on PATH, or set SPECPI_PI to its CLI path.");
    }

    for (const source of basePackages) {
        console.log(`Installing ${source}`);
        const args = ["install", source];
        const options = {
            cwd: agentDir,
            // Later installs must not re-resolve earlier pins through npm's default caret ranges.
            env: {
                ...process.env,
                PI_CODING_AGENT_DIR: agentDir,
                npm_config_save_exact: "true",
                NPM_CONFIG_SAVE_EXACT: "true",
            },
            stdio: "inherit",
            windowsHide: true,
        };
        let result;
        if (/\.[cm]?js$/i.test(command)) {
            result = spawnSync(process.execPath, [command, ...args], options);
        } else if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
            // Environment expansion keeps paths with spaces and shell metacharacters one quoted argument.
            const values = [command, ...args];
            const line = values
                .map((value, index) => {
                    if (/["\r\n]/.test(value)) {
                        throw new Error("Unsupported quote or newline in Pi command path");
                    }

                    const key = `SPECPI_PACKAGE_ARG_${index}`;
                    options.env[key] = value;

                    return `"%${key}%"`;
                })
                .join(" ");
            result = spawnSync(line, [], {
                ...options,
                shell: process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
            });
        } else {
            result = spawnSync(command, args, options);
        }

        if (result.error || result.status !== 0) {
            throw new Error(
                `Pi installation failed for ${source}: ${result.error?.message || `exit ${result.status}`}`,
            );
        }
    }
}

export function checkBasePackages(agentDir, settings) {
    const errors = [];
    // Only the shape SpecPi writes. An entry the user has given filters of their own is theirs to
    // keep, and failing doctor forever over a deliberate choice would be the wrong report.
    for (const entry of Array.isArray(settings.packages) ? settings.packages : []) {
        if (typeof entry === "string" && retiredPackages.includes(packageIdentity(entry))) {
            errors.push(`Retired base package still configured: ${entry}. Run specpi update to unpin it.`);
        }
    }

    for (const source of basePackages) {
        const identity = packageIdentity(source);
        const entry =
            Array.isArray(settings.packages) && settings.packages.find((item) => packageIdentity(item) === identity);
        if (packageSource(entry) !== source) {
            errors.push(`Missing or changed base package setting: ${source}`);
        }

        const name = identity.slice(4);
        const version = source.slice(identity.length + 1);
        const file = path.join(agentDir, "npm", "node_modules", name, "package.json");
        try {
            const installed = JSON.parse(fs.readFileSync(file, "utf8"));
            if (installed.name !== name || installed.version !== version) {
                errors.push(`Base package version mismatch: ${source}`);
            }
        } catch {
            errors.push(`Missing or unreadable base package: ${source}`);
        }
    }

    return errors;
}
