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

function resolvePiCommand() {
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

    return candidates.find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
}

function runPi(command, args, options) {
    if (/\.[cm]?js$/i.test(command)) {
        return spawnSync(process.execPath, [command, ...args], options);
    }

    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
        // Environment expansion keeps paths with spaces and shell metacharacters one quoted argument.
        const env = { ...options.env };
        const line = [command, ...args]
            .map((value, index) => {
                if (/["\r\n]/.test(value)) {
                    throw new Error("Unsupported quote or newline in Pi command path");
                }

                const key = `SPECPI_PACKAGE_ARG_${index}`;
                env[key] = value;

                return `"%${key}%"`;
            })
            .join(" ");

        return spawnSync(line, [], {
            ...options,
            env,
            shell: process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
        });
    }

    return spawnSync(command, args, options);
}

// The version of the Pi CLI SpecPi would install with, or undefined when it cannot be read.
export function piVersion(agentDir) {
    const command = resolvePiCommand();
    if (!command) {
        return undefined;
    }

    try {
        const result = runPi(command, ["--version"], {
            cwd: agentDir,
            env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 30_000,
            windowsHide: true,
        });
        const match = result.status === 0 ? /^\s*v?(\d+)\.(\d+)\.(\d+)\b/u.exec(result.stdout || "") : null;

        return match ? match.slice(1, 4).map(Number) : undefined;
    } catch {
        return undefined;
    }
}

export function installBasePackages(agentDir) {
    const command = resolvePiCommand();
    if (!command) {
        throw new Error("Pi was not found. Install Pi, put pi on PATH, or set SPECPI_PI to its CLI path.");
    }

    for (const source of basePackages) {
        console.log(`Installing ${source}`);
        const result = runPi(command, ["install", source], {
            cwd: agentDir,
            // Later installs must not re-resolve earlier pins through npm's default caret ranges.
            env: {
                ...process.env,
                PI_CODING_AGENT_DIR: agentDir,
                npm_config_save_exact: "true",
                NPM_CONFIG_SAVE_EXACT: "true",
                // onnxruntime-node (the LANCET guard's runtime) bundles its CPU binaries, but on
                // Linux x64 its install script would also fetch CUDA libraries from NuGet. The guard
                // is CPU-only, so skip that download.
                ONNXRUNTIME_NODE_INSTALL: "skip",
            },
            stdio: "inherit",
            windowsHide: true,
        });
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
