import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { delimiter } from "node:path";
import { spawn } from "node:child_process";

export interface PiLaunch {
    displayPath: string;
    executable: string;
    argsPrefix: string[];
    environment: NodeJS.ProcessEnv;
}

function pathCandidates(name: string): string[] {
    if (path.isAbsolute(name) || name.includes("/") || name.includes("\\")) {
        return [path.resolve(name)];
    }

    const extensions = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
    const directories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);

    return directories.flatMap((directory) =>
        extensions.map((extension) => path.join(directory, `${name}${extension}`)),
    );
}

async function firstAccessible(candidates: string[]): Promise<string> {
    for (const candidate of candidates) {
        try {
            await access(candidate);

            return realpath(candidate);
        } catch {
            // Continue searching the explicit PATH list.
        }
    }

    throw new Error("Pi executable was not found. Select the Pi executable in Settings.");
}

function bundledNodeEnvironment(): NodeJS.ProcessEnv {
    if (!process.versions.electron) {
        return { ...process.env };
    }

    return { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
}

async function resolveScript(candidate: string): Promise<PiLaunch | undefined> {
    let source: string;
    try {
        source = await readFile(candidate, { encoding: "utf8" });
    } catch {
        return undefined;
    }

    if (source.length > 64 * 1024) {
        return undefined;
    }

    const cmdMatch = source.match(
        /["']?%dp0%[\\/]([^"'\r\n]*?pi-coding-agent[\\/]+dist[\\/]+(?:bundle[\\/]+)?cli\.js)["']?/iu,
    );
    const posixMatch = source.match(/["']?([^"'\r\n\s]*?pi-coding-agent\/dist\/(?:bundle\/)?cli\.js)["']?/u);
    const relative = cmdMatch?.[1] ?? posixMatch?.[1];
    if (!relative) {
        return undefined;
    }

    const cliPath = path.isAbsolute(relative)
        ? relative
        : path.resolve(path.dirname(candidate), relative.replaceAll("\\", path.sep));
    await access(cliPath);

    return {
        displayPath: candidate,
        executable: process.execPath,
        argsPrefix: [cliPath],
        environment: bundledNodeEnvironment(),
    };
}

export async function resolvePiLaunch(requested?: string): Promise<PiLaunch> {
    const candidate = await firstAccessible(pathCandidates(requested?.trim() || "pi"));
    if (!candidate.toLowerCase().endsWith(".exe")) {
        const script = await resolveScript(candidate);
        if (script) {
            return script;
        }
    }

    return {
        displayPath: candidate,
        executable: candidate,
        argsPrefix: [],
        environment: { ...process.env },
    };
}

export async function probePi(launch: PiLaunch, timeoutMs = 10_000): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(launch.executable, [...launch.argsPrefix, "--version"], {
            env: launch.environment,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        let output = "";
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error("Timed out while checking the Pi version"));
        }, timeoutMs);
        const append = (chunk: Buffer) => {
            output = `${output}${chunk.toString("utf8")}`.slice(-8_192);
        };

        child.stdout.on("data", append);
        child.stderr.on("data", append);
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once("exit", (code) => {
            clearTimeout(timer);
            const version = output.trim();
            if (code !== 0 || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(version)) {
                reject(
                    new Error(
                        `Selected executable did not return a supported Pi version: ${version || `exit ${code}`}`,
                    ),
                );

                return;
            }

            resolve(version);
        });
    });
}

export function compatibilityWarning(version: string): string | undefined {
    return version === "0.84.4"
        ? undefined
        : `Pi ${version} is newer than the validated 0.84.4 contract. Continue only in compatibility mode.`;
}

export function assertSupportedPi(version: string): void {
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)/u);
    if (!match) {
        throw new Error(`Invalid Pi version: ${version}`);
    }

    const [, majorText, minorText, patchText] = match;
    const major = Number(majorText);
    const minor = Number(minorText);
    const patch = Number(patchText);
    if (version.includes("-") || major !== 0 || minor < 84 || (minor === 84 && patch < 4)) {
        throw new Error(`SpecPi Desktop requires Pi 0.84.4 or newer; found ${version}`);
    }
}
