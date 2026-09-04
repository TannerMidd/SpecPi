import { access, open, realpath } from "node:fs/promises";
import path from "node:path";
import { delimiter } from "node:path";
import { spawn } from "node:child_process";
import { terminateProcessTree } from "./process-tree";

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

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new Error("Pi runtime start was cancelled");
    }
}

async function firstAccessible(candidates: string[], signal?: AbortSignal): Promise<string> {
    for (const candidate of candidates) {
        throwIfAborted(signal);
        try {
            await access(candidate);
            const resolved = await realpath(candidate);
            throwIfAborted(signal);

            return resolved;
        } catch (error) {
            if (signal?.aborted) {
                throw error;
            }

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
        const handle = await open(candidate, "r");
        try {
            const buffer = Buffer.alloc(64 * 1024 + 1);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (bytesRead > 64 * 1024) {
                return undefined;
            }

            source = buffer.subarray(0, bytesRead).toString("utf8");
        } finally {
            await handle.close();
        }
    } catch {
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

export async function resolvePiLaunch(requested?: string, signal?: AbortSignal): Promise<PiLaunch> {
    throwIfAborted(signal);
    const candidate = await firstAccessible(pathCandidates(requested?.trim() || "pi"), signal);
    if (!candidate.toLowerCase().endsWith(".exe")) {
        const script = await resolveScript(candidate);
        throwIfAborted(signal);
        if (script) {
            return script;
        }
    }

    throwIfAborted(signal);

    return {
        displayPath: candidate,
        executable: candidate,
        argsPrefix: [],
        environment: { ...process.env },
    };
}

export async function probePi(launch: PiLaunch, timeoutMs = 10_000, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);

    return new Promise((resolve, reject) => {
        const child = spawn(launch.executable, [...launch.argsPrefix, "--version"], {
            env: launch.environment,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            detached: process.platform !== "win32",
        });
        let output = "";
        let settled = false;
        let terminationError: Error | undefined;
        const finish = (error?: Error, version?: string) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            if (error) {
                reject(error);
            } else {
                resolve(version ?? "");
            }
        };

        const terminate = (error: Error) => {
            if (settled || terminationError) {
                return;
            }

            terminationError = error;
            void terminateProcessTree(child).then(
                () => finish(error),
                () => finish(error),
            );
        };

        const abort = () => terminate(new Error("Pi runtime start was cancelled"));

        const timer = setTimeout(() => {
            terminate(new Error("Timed out while checking the Pi version"));
        }, timeoutMs);
        const append = (chunk: Buffer) => {
            output = `${output}${chunk.toString("utf8")}`.slice(-8_192);
        };

        signal?.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        child.once("error", (error) => {
            if (!terminationError) {
                finish(error);
            }
        });
        child.once("exit", (code) => {
            if (terminationError) {
                return;
            }

            const version = output.trim();
            if (code !== 0 || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(version)) {
                finish(
                    new Error(
                        `Selected executable did not return a supported Pi version: ${version || `exit ${code}`}`,
                    ),
                );

                return;
            }

            finish(undefined, version);
        });
        if (signal?.aborted) {
            abort();
        }
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
