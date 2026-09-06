#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { packageExtension } from "./package.mjs";
import {
    createHostEnvironment,
    extensionDirectory,
    findCodeCli,
    findCodeExecutable,
    removeHostEnvironment,
} from "./host-environment.mjs";

if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--vsix")) {
    throw new Error("Use no arguments for source tests, or --vsix to test an isolated VSIX installation");
}

const executable = findCodeExecutable();
const environment = createHostEnvironment();

if (process.argv[2] === "--vsix") {
    const packaged = packageExtension();
    const archivePath = path.join(environment.directory, "specpi-chat.vsix");
    fs.writeFileSync(archivePath, packaged.archive);
    const cliScript = findCodeCli(executable);
    const hasCliScript = Boolean(cliScript);
    const installArguments = [
        ...(hasCliScript ? [cliScript] : []),
        "--install-extension",
        archivePath,
        `--user-data-dir=${environment.userData}`,
        `--extensions-dir=${environment.extensions}`,
        "--do-not-sync",
    ];
    const installed = await promisify(execFile)(executable, installArguments, {
        env: { ...environment.env, ...(hasCliScript ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
        windowsHide: true,
        shell: false,
        timeout: 60000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: "utf8",
    });
    process.stdout.write(installed.stdout);
    const installedDirectory = fs
        .readdirSync(environment.extensions)
        .map((name) => path.join(environment.extensions, name))
        .find((directory) => {
            const manifestPath = path.join(directory, "package.json");
            if (!fs.existsSync(manifestPath)) {
                return false;
            }

            const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

            return (
                manifest.name === packaged.manifest.name &&
                manifest.publisher === packaged.manifest.publisher &&
                manifest.version === packaged.manifest.version
            );
        });
    if (!installedDirectory) {
        throw new Error(
            `VS Code did not install SpecPi Chat in the isolated extensions directory: ${environment.directory}`,
        );
    }

    const developmentArgument = environment.args.findIndex((argument) =>
        argument.startsWith("--extensionDevelopmentPath="),
    );
    environment.args[developmentArgument] = `--extensionDevelopmentPath=${installedDirectory}`;
}

environment.args.unshift(`--extensionTestsPath=${path.join(extensionDirectory, "tests", "host.js")}`);
process.stdout.write(`Testing SpecPi Chat in an isolated VS Code extension host: ${environment.directory}\n`);
const child = spawn(executable, environment.args, {
    env: environment.env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
});
let timedOut = false;
let output = "";
for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
        const text = chunk.toString();
        output = (output + text).slice(-128 * 1024);
    });
}

const timeout = setTimeout(() => {
    timedOut = true;
    if (process.platform === "win32" && child.pid) {
        const taskkill = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            shell: false,
            windowsHide: true,
            stdio: "ignore",
        });
        taskkill.on("error", () => child.kill());
    } else {
        child.kill("SIGTERM");
    }
}, 120_000);
let exitCode;
try {
    exitCode = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
    });
} finally {
    clearTimeout(timeout);
}

const reportPath = path.join(environment.directory, "host-result.json");
const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : undefined;
if (timedOut || exitCode !== 0 || report?.passed !== true) {
    fs.writeFileSync(path.join(environment.directory, "launcher.log"), output);
    process.stderr.write(
        `${report?.error || output.slice(-4000) || "VS Code exited before reporting a test result."}\n`,
    );
    process.stderr.write(
        `Extension host tests failed${timedOut ? " (timeout)" : ""}; isolated artifacts: ${environment.directory}\n`,
    );
    process.exitCode = 1;
} else {
    try {
        await removeHostEnvironment(environment.directory);
        process.stdout.write(`PASS: ${report.checks.join("; ")}; isolated profile cleanup\n`);
    } catch (error) {
        process.stderr.write(
            `Host assertions passed, but bounded isolated profile cleanup failed (${error.code || "error"}). ` +
                `Remaining artifacts: ${environment.directory}\n`,
        );
        process.exitCode = 1;
    }
}
