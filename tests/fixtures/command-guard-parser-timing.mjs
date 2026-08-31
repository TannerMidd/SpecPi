// Diagnostic: reports how long the PowerShell parser helper actually takes on this host, so a parse bound is
// chosen from measurement rather than guesswork. Prints one line per spawn and never fails the build.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const helper = path.resolve("extensions/command-guard/powershell-parser.ps1");
const executable = process.env.ZENPI_TEST_POWERSHELL_EXE;
if (!executable || !fs.existsSync(helper)) {
    console.log(`PARSER_TIMING skipped: executable=${Boolean(executable)} helper=${fs.existsSync(helper)}`);
    process.exit(0);
}

const samples = [
    "Get-ChildItem C:\\work",
    "Remove-Item -Recurse -Force C:\\Windows",
    "powershell.exe -Command 'Remove-Item -Recurse -Force C:\\Windows'",
    "Get-ChildItem C:\\work",
    "iex 'Remove-Item -Recurse -Force C:\\Windows'",
];
console.log(`PARSER_TIMING host=${executable}`);
for (const [index, input] of samples.entries()) {
    const started = Date.now();
    const result = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", helper], {
        input,
        encoding: "utf8",
        timeout: 60000,
        maxBuffer: 256 * 1024,
        shell: false,
        windowsHide: true,
        env: {
            SystemRoot: process.env.SystemRoot || "C:\\Windows",
            PATH: process.env.PATH || "",
            TEMP: process.env.TEMP || "",
        },
    });
    const elapsed = Date.now() - started;
    const state = result.error
        ? `error=${result.error.code}`
        : `status=${result.status} stderr=${(result.stderr || "").length}b`;
    console.log(`PARSER_TIMING sample=${index} ms=${elapsed} ${state} out=${(result.stdout || "").length}b`);
}

// Same again with a fuller environment, to test whether the sanitized env is what costs the time.
console.log("PARSER_TIMING --- with PSModulePath/APPDATA passed through ---");
for (const [index, input] of samples.entries()) {
    const started = Date.now();
    const result = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", helper], {
        input,
        encoding: "utf8",
        timeout: 60000,
        maxBuffer: 256 * 1024,
        shell: false,
        windowsHide: true,
        env: {
            SystemRoot: process.env.SystemRoot || "C:\\Windows",
            PATH: process.env.PATH || "",
            TEMP: process.env.TEMP || "",
            PSModulePath: process.env.PSModulePath || "",
            APPDATA: process.env.APPDATA || "",
            LOCALAPPDATA: process.env.LOCALAPPDATA || "",
            USERPROFILE: process.env.USERPROFILE || "",
            PATHEXT: process.env.PATHEXT || "",
            ComSpec: process.env.ComSpec || "",
        },
    });
    const elapsed = Date.now() - started;
    const state = result.error ? `error=${result.error.code}` : `status=${result.status}`;
    console.log(`PARSER_TIMING env sample=${index} ms=${elapsed} ${state}`);
}
