import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const extensionDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function findCodeExecutable() {
    const candidates = [process.env.VSCODE_EXECUTABLE];
    if (process.platform === "win32") {
        candidates.push(
            path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "Code.exe"),
            path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft VS Code", "Code.exe"),
        );
    } else if (process.platform === "darwin") {
        candidates.push("/Applications/Visual Studio Code.app/Contents/MacOS/Electron");
    } else {
        candidates.push("/usr/share/code/code", "/usr/bin/code");
    }

    const executable = candidates.find((candidate) => {
        return typeof candidate === "string" && path.isAbsolute(candidate) && fs.existsSync(candidate);
    });
    if (!executable) {
        throw new Error(
            "VS Code was not found. Set VSCODE_EXECUTABLE to the absolute path of the installed VS Code executable.",
        );
    }

    return executable;
}

export function findCodeCli(executable) {
    const codeDirectory = path.dirname(executable);
    const direct =
        process.platform === "darwin"
            ? path.resolve(codeDirectory, "..", "Resources", "app", "out", "cli.js")
            : path.join(codeDirectory, "resources", "app", "out", "cli.js");
    if (fs.existsSync(direct)) {
        return direct;
    }

    // New Windows installations keep app files in a versioned subdirectory.
    // Read only the installed launcher's path, never any VS Code user profile.
    const launcher = path.join(codeDirectory, "bin", "code.cmd");
    if (process.platform === "win32" && fs.existsSync(launcher)) {
        const match = fs.readFileSync(launcher, "utf8").match(/"%~dp0\.\.\\([^"\r\n]*resources\\app\\out\\cli\.js)"/i);
        if (match) {
            const candidate = path.resolve(codeDirectory, match[1]);
            const relative = path.relative(codeDirectory, candidate);
            if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }

    return undefined;
}

export function createHostEnvironment() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-vscode-host-"));
    const workspace = path.join(directory, "workspace");
    const agentDirectory = path.join(directory, "pi-agent");
    const userData = path.join(directory, "user-data");
    const extensions = path.join(directory, "extensions");
    const portableDirectory = directory;
    for (const entry of [workspace, agentDirectory, path.join(userData, "User"), extensions, portableDirectory]) {
        fs.mkdirSync(entry, { recursive: true });
    }

    const fakePi = path.join(directory, "fake-pi.cjs");
    fs.copyFileSync(path.join(extensionDirectory, "tests", "fake-pi.js"), fakePi);
    fs.writeFileSync(path.join(workspace, "example.js"), 'export const greeting = "Hello from SpecPi";\n');
    fs.writeFileSync(
        path.join(userData, "User", "settings.json"),
        JSON.stringify(
            {
                "specpi.chat.piPath": fakePi,
                "specpi.chat.nodePath": process.execPath,
                "telemetry.telemetryLevel": "off",
                "workbench.enableExperiments": false,
                "workbench.startupEditor": "none",
                "workbench.tips.enabled": false,
                // Built-in agent hosts can create owner-only endpoint directories
                // independently of this ordinary Webview View extension.
                "chat.disableAIFeatures": true,
                "extensions.autoCheckUpdates": false,
                "extensions.autoUpdate": false,
                "update.mode": "none",
                "security.workspace.trust.enabled": false,
                "git.enabled": false,
            },
            null,
            4,
        ),
    );

    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (key.startsWith("VSCODE_") || key === "ELECTRON_RUN_AS_NODE") {
            delete env[key];
        }
    }

    env.PI_CODING_AGENT_DIR = agentDirectory;
    env.VSCODE_PORTABLE = portableDirectory;
    if (process.platform === "win32") {
        // User-install builds do not support portable mode. Isolate the OS
        // profile paths as well so Code's argv.json and caches stay in this run.
        env.USERPROFILE = path.join(directory, "home");
        env.APPDATA = path.join(directory, "appdata");
        env.LOCALAPPDATA = path.join(directory, "local-appdata");
        for (const location of [env.USERPROFILE, env.APPDATA, env.LOCALAPPDATA]) {
            fs.mkdirSync(location, { recursive: true });
        }
    }

    env.SPECPI_VSCODE_TEST_DIRECTORY = directory;
    env.SPECPI_VSCODE_TEST_NODE = process.execPath;
    env.SPECPI_VSCODE_TEST_PI = fakePi;
    const args = [
        "--new-window",
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-updates",
        "--disable-crash-reporter",
        "--skip-add-to-recently-opened",
        "--use-inmemory-secretstorage",
        "--disable-workspace-trust",
        "--disable-extensions",
        "--disable-telemetry",
        `--user-data-dir=${userData}`,
        `--extensions-dir=${extensions}`,
        `--shared-data-dir=${path.join(directory, "shared-data")}`,
        `--extensionDevelopmentPath=${extensionDirectory}`,
        workspace,
    ];

    return { directory, workspace, agentDirectory, userData, extensions, env, args };
}

function validatedHostDirectory(directory) {
    const resolved = path.resolve(directory);
    const temporaryRoot = path.resolve(os.tmpdir());
    if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith("specpi-vscode-host-")) {
        throw new Error("Refusing to remove a host directory outside the isolated test location");
    }

    return resolved;
}

export function removeHostEnvironment(
    directory,
    { pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) } = {},
) {
    validatedHostDirectory(directory);
    // Windows helpers can retain profile handles after Code's main process exits.
    // Retry only transient locks, without blocking or touching another process.
    const backoff = [100, 200, 400, 800, 1200, 1600, 2000];

    return (async () => {
        for (let attempt = 0; ; attempt += 1) {
            const resolved = validatedHostDirectory(directory);
            try {
                await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 0 });

                return;
            } catch (error) {
                if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes(error.code) || attempt >= backoff.length) {
                    throw error;
                }
            }

            await pause(backoff[attempt]);
        }
    })();
}
