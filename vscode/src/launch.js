"use strict";

const { execFile } = require("node:child_process");
const { constants } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const runFile = promisify(execFile);
const PACKAGES = ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"];

async function isFile(candidate, executable = false) {
    try {
        if (!(await fs.stat(candidate)).isFile()) {
            return false;
        }

        await fs.access(candidate, executable ? constants.X_OK : constants.R_OK);

        return true;
    } catch {
        return false;
    }
}

function environmentPath(env) {
    const key = Object.keys(env).find((item) => item.toLowerCase() === "path");

    return key ? (env[key] ?? "") : "";
}

async function locateExecutable(value, env, platform, label) {
    if (
        typeof value !== "string" ||
        !value.trim() ||
        value.includes("\0") ||
        value.includes("\n") ||
        value.includes("\r")
    ) {
        throw new Error(`The ${label} setting must contain one executable path, without arguments.`);
    }

    const name = value.trim();
    if (path.isAbsolute(name)) {
        if (!(await isFile(name, platform !== "win32" && !/\.(?:[cm]?js|cmd|bat)$/i.test(name)))) {
            throw new Error(`The configured ${label} executable does not exist or cannot be read.`);
        }

        return name;
    }

    if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
        throw new Error(`Use an absolute path for the ${label} executable.`);
    }

    const suffixes = platform === "win32" && !path.extname(name) ? [".exe", ".com", ".cmd", ".bat", ""] : [""];
    for (const entry of environmentPath(env).split(platform === "win32" ? ";" : ":")) {
        const directory = entry.replace(/^"|"$/g, "").trim();
        // Empty and relative PATH entries would execute code from the workspace.
        if (!path.isAbsolute(directory)) {
            continue;
        }

        for (const suffix of suffixes) {
            const candidate = path.join(directory, name + suffix);
            if (await isFile(candidate, platform !== "win32")) {
                return candidate;
            }
        }
    }

    throw new Error(`${label} was not found on PATH. Set its absolute executable path in SpecPi Chat settings.`);
}

async function adjacentPiCli(shim) {
    const directory = path.dirname(shim);
    const roots = [
        path.join(directory, "node_modules"),
        path.resolve(directory, ".."),
        path.resolve(directory, "../lib/node_modules"),
    ];
    for (const root of roots) {
        for (const packageName of PACKAGES) {
            for (const entry of ["dist/bundle/cli.js", "dist/cli.js"]) {
                const candidate = path.join(root, packageName, entry);
                if (await isFile(candidate)) {
                    return candidate;
                }
            }
        }
    }

    throw new Error(
        "The Pi shell shim has no adjacent Pi installation. Set SpecPi Chat's Pi path to the package's dist/bundle/cli.js file.",
    );
}

async function hasShebang(filename) {
    const file = await fs.open(filename, "r");
    try {
        const prefix = Buffer.alloc(2);
        const { bytesRead } = await file.read(prefix, 0, 2, 0);

        return bytesRead === 2 && prefix[0] === 35 && prefix[1] === 33;
    } finally {
        await file.close();
    }
}

async function resolveNode(nodePath, env, platform) {
    const command = await locateExecutable(nodePath || "node", env, platform, "Node.js");
    if (/\.(?:cmd|bat|ps1|[cm]?js)$/i.test(command)) {
        throw new Error("The Node.js setting must point to a native Node.js executable, not a script or shell shim.");
    }

    let runtime;
    try {
        const { stdout } = await runFile(
            command,
            [
                "--eval",
                "process.stdout.write(JSON.stringify({node:process.versions.node,electron:Boolean(process.versions.electron)}))",
            ],
            {
                // Avoid opening Electron's GUI if its executable was configured by mistake.
                env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
                shell: false,
                windowsHide: true,
                timeout: 5000,
                maxBuffer: 256,
                encoding: "utf8",
            },
        );
        runtime = JSON.parse(stdout);
    } catch {
        throw new Error(
            "Node.js could not be verified. Install Node.js 22.19 or newer and configure its executable path.",
        );
    }

    const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(runtime?.node);
    if (
        runtime?.electron ||
        !version ||
        Number(version[1]) < 22 ||
        (Number(version[1]) === 22 && Number(version[2]) < 19)
    ) {
        throw new Error("SpecPi Chat requires an external Node.js 22.19 or newer installation.");
    }

    return command;
}

/** Resolve npm Pi shims without executing a shell or reading user Pi state. */
async function resolveLaunch({ piPath, nodePath, env = process.env, platform = process.platform } = {}) {
    const executable = await locateExecutable(piPath || "pi", env, platform, "Pi");
    const resolved = await fs.realpath(executable);
    if (/\.ps1$/i.test(resolved)) {
        throw new Error(
            "PowerShell launch scripts are unsupported. Select pi.cmd, a Pi executable, or Pi's CLI JavaScript file.",
        );
    }

    let cli;
    if (/\.(?:cmd|bat)$/i.test(resolved)) {
        cli = await adjacentPiCli(executable);
    } else if (/\.[cm]?js$/i.test(resolved)) {
        cli = resolved;
    } else if ((platform === "win32" && !/\.(?:exe|com)$/i.test(resolved)) || (await hasShebang(resolved))) {
        cli = await adjacentPiCli(executable);
    }

    if (cli) {
        const command = await resolveNode(nodePath, env, platform);

        return { command, args: [cli] };
    }

    return { command: resolved, args: [] };
}

module.exports = { resolveLaunch };
