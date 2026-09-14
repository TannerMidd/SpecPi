import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { packageIdentity, packageSource } from "./lib.mjs";

export const basePackages = JSON.parse(
    fs.readFileSync(new URL("../templates/settings.json", import.meta.url), "utf8"),
).packages;

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
            env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
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
