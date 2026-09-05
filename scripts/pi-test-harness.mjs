import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const helperRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(helperRoot, "..");
const nodeScriptExtensions = new Set([".cjs", ".js", ".mjs"]);
const missingPathCodes = new Set(["ENOENT", "ENOTDIR"]);
const sensitiveEnvironmentName =
    /(?:ACCESS[_-]?KEY|API[_-]?KEY|AUTH(?:ORIZATION)?|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY)/iu;
const isolatedEnvironmentNames = new Set([
    "APPDATA",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "NPM_CONFIG_USERCONFIG",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "npm_config_userconfig",
]);

function isWindows() {
    return process.platform === "win32";
}

function isWindowsScript(filePath) {
    return isWindows() && [".bat", ".cmd"].includes(path.extname(filePath).toLowerCase());
}

function isMissingPathError(error) {
    return error && typeof error === "object" && missingPathCodes.has(error.code);
}

function statFile(candidate) {
    try {
        return fs.statSync(candidate).isFile() ? candidate : undefined;
    } catch (error) {
        if (isMissingPathError(error)) {
            return undefined;
        }

        throw error;
    }
}

function commandCandidates(command, cwd, environment) {
    const value = String(command);
    const hasPath = path.isAbsolute(value) || value.includes("/") || value.includes("\\");
    if (hasPath) {
        const resolved = path.isAbsolute(value) ? value : path.resolve(cwd, value);
        if (!isWindows()) {
            return [resolved];
        }

        const extension = path.extname(resolved).toLowerCase();
        const pathExtensions = String(environment.PATHEXT || ".COM;.EXE;.BAT;.CMD")
            .split(";")
            .filter(Boolean)
            .map((item) => item.toLowerCase());
        const suffixes = extension ? [""] : pathExtensions;

        return suffixes.map((suffix) => `${resolved}${suffix}`);
    }

    const pathValue = environment.PATH ?? environment.Path ?? "";
    const directories = String(pathValue).split(path.delimiter);
    const suffixes =
        isWindows() && !path.extname(value)
            ? String(environment.PATHEXT || ".COM;.EXE;.BAT;.CMD")
                  .split(";")
                  .filter(Boolean)
                  .map((item) => item.toLowerCase())
            : [""];

    return directories.flatMap((directory) => {
        const base = directory || cwd;

        return suffixes.map((suffix) => path.join(base, `${value}${suffix}`));
    });
}

function resolveExecutable(command, cwd, environment) {
    for (const candidate of commandCandidates(command, cwd, environment)) {
        const found = statFile(candidate);
        if (found) {
            return found;
        }
    }

    return undefined;
}

function getIsolationRoot(agentDir) {
    const temporaryDirectory = fs.realpathSync(os.tmpdir());
    const canonicalAgentDir = fs.realpathSync(agentDir);
    const relative = path.relative(temporaryDirectory, canonicalAgentDir);
    if (relative.split(path.sep).length < 2 || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Pi harness agentDir must be a dedicated directory under ${temporaryDirectory}`);
    }

    return path.dirname(canonicalAgentDir);
}

function createAgentDirectory(requestedAgentDir) {
    if (requestedAgentDir !== undefined) {
        const agentDir = path.resolve(String(requestedAgentDir));
        if (!fs.existsSync(agentDir) || !fs.statSync(agentDir).isDirectory()) {
            throw new Error(`Pi harness agentDir must already exist: ${agentDir}`);
        }

        return { agentDir, cleanupRoot: undefined, environmentRoot: getIsolationRoot(agentDir) };
    }

    const cleanupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-pi-harness-"));
    const agentDir = path.join(cleanupRoot, "agent");
    fs.mkdirSync(agentDir);

    return { agentDir, cleanupRoot, environmentRoot: cleanupRoot };
}

function createChildEnvironment(environmentRoot, agentDir, overrides) {
    const environment = {};
    for (const [name, value] of Object.entries(process.env)) {
        if (isolatedEnvironmentNames.has(name) || sensitiveEnvironmentName.test(name)) {
            continue;
        }

        environment[name] = value;
    }

    Object.assign(environment, overrides);
    environment.PI_CODING_AGENT_DIR = agentDir;
    environment.PI_OFFLINE = "1";
    fs.mkdirSync(environment.PI_CODING_AGENT_DIR, { recursive: true });
    environment.HOME = environmentRoot;
    environment.USERPROFILE = environmentRoot;
    environment.APPDATA = path.join(environmentRoot, "AppData", "Roaming");
    environment.LOCALAPPDATA = path.join(environmentRoot, "AppData", "Local");
    environment.XDG_CONFIG_HOME = path.join(environmentRoot, ".config");
    environment.XDG_DATA_HOME = path.join(environmentRoot, ".local", "share");
    if (isWindows()) {
        const driveRoot = path.parse(environmentRoot).root;
        environment.HOMEDRIVE = driveRoot.slice(0, 2);
        environment.HOMEPATH = environmentRoot.slice(2);
    }

    environment.TEMP = environmentRoot;
    environment.TMP = environmentRoot;
    fs.mkdirSync(environment.APPDATA, { recursive: true });
    fs.mkdirSync(environment.LOCALAPPDATA, { recursive: true });
    fs.mkdirSync(environment.XDG_CONFIG_HOME, { recursive: true });
    fs.mkdirSync(environment.XDG_DATA_HOME, { recursive: true });

    return environment;
}

function resolvePiCommand(options, cwd, environment) {
    const requested = options.piCommand ?? environment.SPECPI_TEST_PI ?? "pi";
    if (typeof requested !== "string" || requested.length === 0) {
        throw new TypeError("Pi harness piCommand must be a non-empty string");
    }

    return resolveExecutable(requested, cwd, environment);
}

function spawnPi(resolvedCommand, args, options) {
    const spawnOptions = {
        cwd: options.cwd,
        env: options.environment,
        encoding: "utf8",
        input: options.input,
        maxBuffer: options.maxBuffer,
        timeout: options.timeout,
        windowsHide: true,
    };

    if (nodeScriptExtensions.has(path.extname(resolvedCommand).toLowerCase())) {
        return {
            ...spawnSync(process.execPath, [resolvedCommand, ...args], spawnOptions),
            command: process.execPath,
            commandArgs: [resolvedCommand, ...args],
        };
    }

    if (isWindowsScript(resolvedCommand)) {
        const comspec = options.environment.ComSpec || options.environment.COMSPEC || "cmd.exe";
        const commandEnvironment = { ...options.environment };
        const commandValues = [resolvedCommand, ...args];
        const commandLine = commandValues
            .map((value, index) => {
                const name = `SPECPI_PI_HARNESS_ARG_${index}`;
                commandEnvironment[name] = String(value);

                return `"%${name}%"`;
            })
            .join(" ");

        return {
            ...spawnSync(commandLine, [], {
                ...spawnOptions,
                env: commandEnvironment,
                shell: comspec,
            }),
            command: comspec,
            commandArgs: [commandLine],
        };
    }

    return {
        ...spawnSync(resolvedCommand, args, spawnOptions),
        command: resolvedCommand,
        commandArgs: args,
    };
}

/**
 * Run a Pi TypeScript extension fixture without touching the user's Pi state.
 * The returned object is intentionally raw so callers decide which marker and assertions matter.
 */
export function runPiFixture(fixture, options = {}) {
    if (!path.isAbsolute(fixture)) {
        throw new TypeError(`Pi harness fixture must be an absolute path: ${fixture}`);
    }

    const cwd = path.resolve(options.cwd ?? repoRoot);
    const setup = createAgentDirectory(options.agentDir);
    const args = options.args ?? [
        "--mode",
        "rpc",
        "--offline",
        "--no-session",
        "--no-context-files",
        "--no-extensions",
        "--no-skills",
        "-e",
        fixture,
    ];
    const input = options.input ?? `${JSON.stringify({ type: "get_state" })}\n`;
    const environment = createChildEnvironment(setup.environmentRoot, setup.agentDir, options.env ?? {});
    const startedAt = Date.now();
    let resolvedCommand;

    try {
        resolvedCommand = resolvePiCommand(options, cwd, environment);
        if (!resolvedCommand) {
            const requested = options.piCommand ?? options.env?.SPECPI_TEST_PI ?? "pi";
            const error = new Error(`Pi executable is not available: ${requested}`);
            error.code = "ENOENT";

            return {
                unavailable: true,
                status: null,
                signal: null,
                error,
                stdout: "",
                stderr: "",
                command: requested,
                commandArgs: args,
                args,
                agentDir: setup.agentDir,
                durationMs: Date.now() - startedAt,
            };
        }

        const result = spawnPi(resolvedCommand, args, {
            cwd,
            environment,
            input,
            maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
            timeout: options.timeout ?? 120_000,
        });

        return {
            unavailable: false,
            status: result.status ?? null,
            signal: result.signal ?? null,
            error: result.error ?? null,
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
            command: result.command,
            commandArgs: result.commandArgs,
            args,
            agentDir: setup.agentDir,
            durationMs: Date.now() - startedAt,
        };
    } catch (error) {
        return {
            unavailable: false,
            status: null,
            signal: null,
            error,
            stdout: "",
            stderr: "",
            command: resolvedCommand ?? options.piCommand ?? "pi",
            commandArgs: args,
            args,
            agentDir: setup.agentDir,
            durationMs: Date.now() - startedAt,
        };
    } finally {
        if (setup.cleanupRoot) {
            fs.rmSync(setup.cleanupRoot, { recursive: true, force: true });
        }
    }
}
