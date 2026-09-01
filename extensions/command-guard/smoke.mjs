#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decideCommand, decidePath } from "./core.mjs";

export async function runCommandGuardSmoke() {
    const checks = [
        [
            "safe listing",
            decideCommand("printf '%s\\n' hello", { shell: "bash", mode: "guard", cwd: process.cwd(), hasUI: false }),
            "allow",
        ],
        [
            "root deletion",
            decideCommand("rm -rf /", { shell: "bash", mode: "guard", cwd: process.cwd(), hasUI: false }),
            "deny",
        ],
        [
            "malformed quote",
            decideCommand("printf 'unterminated", { shell: "bash", mode: "guard", cwd: process.cwd(), hasUI: false }),
            "deny",
        ],
        [
            "protected write",
            decidePath("/etc/passwd", "write", { mode: "guard", cwd: "/work", platform: "linux", hasUI: false }),
            "deny",
        ],
        [
            "wrapped root deletion",
            decideCommand("sudo -u root bash -lc 'rm -rf /*'", {
                shell: "bash",
                mode: "guard",
                cwd: process.cwd(),
                hasUI: true,
            }),
            "deny",
        ],
        [
            "nested fork bomb",
            decideCommand("bash -c ':(){ :|:& };:'", { shell: "bash", mode: "guard", cwd: process.cwd(), hasUI: true }),
            "deny",
        ],
        [
            "wrapped executable heredoc",
            decideCommand("env sh <<EOF\nrm -rf /\nEOF", {
                shell: "bash",
                mode: "guard",
                cwd: process.cwd(),
                hasUI: true,
            }),
            "deny",
        ],
        [
            "decoded catastrophic interpreter pipe",
            decideCommand("printf cm0gLXJmIC8K | base64 -d | sh", {
                shell: "bash",
                mode: "guard",
                cwd: process.cwd(),
                hasUI: true,
            }),
            "deny",
        ],
        [
            "decoded benign interpreter pipe",
            decideCommand("printf cHJpbnRmIHNhZmU= | base64 -d | sh", {
                shell: "bash",
                mode: "guard",
                cwd: process.cwd(),
                hasUI: true,
            }),
            "allow",
        ],
        [
            "sed shell escape",
            decideCommand("sed '1e rm -rf /' /etc/hosts", {
                shell: "bash",
                mode: "guard",
                cwd: process.cwd(),
                hasUI: true,
            }),
            "deny",
        ],
        [
            "xargs input uncertainty",
            decideCommand("printf / | xargs rm -rf", { shell: "bash", mode: "guard", cwd: process.cwd(), hasUI: true }),
            "ask",
        ],
        [
            "Bash cmd cleanup syntax mismatch",
            decideCommand("rmdir /s /q F:\\Temp\\case", {
                shell: "bash",
                mode: "guard",
                cwd: "C:\\work",
                platform: "win32",
                hasUI: true,
            }),
            "deny",
        ],
        [
            "Bash ordinary temporary cleanup",
            decideCommand("rm -rf -- F:/Temp/case", {
                shell: "bash",
                mode: "guard",
                cwd: "C:\\work",
                platform: "win32",
                hasUI: true,
            }),
            "allow",
        ],
        [
            "nested cmd deletion",
            decideCommand('cmd /c "cmd /c rd /s /q C:\\\\Windows"', {
                shell: "cmd",
                mode: "guard",
                cwd: "C:\\\\work",
                platform: "win32",
                hasUI: true,
            }),
            "deny",
        ],
        [
            "attached cmd deletion",
            decideCommand('cmd /c"rd /s /q C:/Windows"', {
                shell: "cmd",
                mode: "guard",
                cwd: "C:\\work",
                platform: "win32",
                hasUI: true,
            }),
            "deny",
        ],
        [
            "quoted cmd metacharacters",
            decideCommand('cmd /c echo "safe & rd /s /q C:/Windows"', {
                shell: "cmd",
                mode: "guard",
                cwd: "C:\\work",
                platform: "win32",
                hasUI: true,
            }),
            "allow",
        ],
        [
            "START ignores later host-looking data",
            decideCommand("start cmd /c echo powershell.exe -Command Remove-Item -Recurse -Force C:/Windows", {
                shell: "cmd",
                mode: "guard",
                cwd: "C:\\work",
                platform: "win32",
                hasUI: true,
            }),
            "allow",
        ],
        [
            "Bash to cmd PowerShell deletion",
            decideCommand("cmd /c powershell.exe -Command Remove-Item -Recurse -Force C:/Windows", {
                shell: "bash",
                mode: "guard",
                cwd: "C:\\work",
                platform: "win32",
                hasUI: false,
            }),
            "deny",
        ],
        [
            "implicit PowerShell host",
            decideCommand("cmd /c powershell.exe -NoProfile", {
                shell: "cmd",
                mode: "guard",
                cwd: "C:\\work",
                platform: "win32",
                hasUI: true,
            }),
            "ask",
        ],
        [
            "strict workspace mutation without UI",
            decidePath("file.txt", "write", { mode: "strict", cwd: process.cwd(), hasUI: false }),
            "deny",
        ],
        [
            "guard package install",
            decideCommand("npm install lodash", { shell: "bash", mode: "guard", cwd: process.cwd(), hasUI: true }),
            "allow",
        ],
        [
            "strict package install",
            decideCommand("npm install lodash", { shell: "bash", mode: "strict", cwd: process.cwd(), hasUI: true }),
            "ask",
        ],
        [
            "guard force push",
            decideCommand("git push --force", {
                shell: "bash",
                mode: "guard",
                cwd: process.cwd(),
                platform: "linux",
                hasUI: true,
            }),
            "ask",
        ],
        [
            "strict force push",
            decideCommand("git push --force", {
                shell: "bash",
                mode: "strict",
                cwd: process.cwd(),
                platform: "linux",
                hasUI: true,
            }),
            "ask",
        ],
        [
            "guard ordinary push",
            decideCommand("git push origin main", {
                shell: "bash",
                mode: "guard",
                cwd: process.cwd(),
                platform: "linux",
                hasUI: true,
            }),
            "allow",
        ],
        [
            "guard destructive git",
            decideCommand("git reset --hard", {
                shell: "bash",
                mode: "guard",
                cwd: process.cwd(),
                platform: "linux",
                hasUI: true,
            }),
            "ask",
        ],
        [
            "guard remote ref deletion",
            decideCommand("git push --delete origin topic", {
                shell: "bash",
                mode: "guard",
                cwd: process.cwd(),
                platform: "linux",
                hasUI: true,
            }),
            "ask",
        ],
        [
            "guard bounded system-tree write",
            decidePath("/etc/unused-review-note", "write", {
                mode: "guard",
                cwd: "/work",
                platform: "linux",
                hasUI: true,
            }),
            "allow",
        ],
        [
            "strict bounded system-tree write",
            decidePath("/etc/unused-review-note", "write", {
                mode: "strict",
                cwd: "/work",
                platform: "linux",
                hasUI: true,
            }),
            "ask",
        ],
        [
            "argv-prefix runner laundering",
            decideCommand("setsid rm -rf /etc", {
                shell: "bash",
                mode: "guard",
                cwd: "/home/pi/work",
                platform: "linux",
                hasUI: true,
            }),
            "deny",
        ],
        [
            "command-string runner laundering",
            decideCommand("watch 'rm -rf /etc'", {
                shell: "bash",
                mode: "guard",
                cwd: "/home/pi/work",
                platform: "linux",
                hasUI: true,
            }),
            "deny",
        ],
        [
            "guard environment enumeration",
            decideCommand("printenv", {
                shell: "bash",
                mode: "guard",
                cwd: "/home/pi/work",
                platform: "linux",
                hasUI: true,
            }),
            "allow",
        ],
        [
            "strict environment enumeration",
            decideCommand("printenv", {
                shell: "bash",
                mode: "strict",
                cwd: "/home/pi/work",
                platform: "linux",
                hasUI: true,
            }),
            "ask",
        ],
        [
            "guard process environment pseudo-file",
            decideCommand("cat /proc/self/environ", {
                shell: "bash",
                mode: "guard",
                cwd: "/home/pi/work",
                platform: "linux",
                hasUI: true,
            }),
            "allow",
        ],
        [
            "strict process environment pseudo-file",
            decideCommand("cat /proc/self/environ", {
                shell: "bash",
                mode: "strict",
                cwd: "/home/pi/work",
                platform: "linux",
                hasUI: true,
            }),
            "ask",
        ],
        [
            "strict ordinary cat",
            decideCommand("cat README.md", { shell: "bash", mode: "strict", cwd: process.cwd(), hasUI: true }),
            "allow",
        ],
        [
            "critical survives leaf limit",
            decideCommand(`rm -rf /; ${Array.from({ length: 140 }, () => "true").join(";")}`, {
                shell: "bash",
                mode: "guard",
                cwd: process.cwd(),
                hasUI: true,
            }),
            "deny",
        ],
        [
            "macOS system root",
            decidePath("/Library/LaunchDaemons/x.plist", "write", {
                mode: "guard",
                cwd: "/Users/alice/work",
                platform: "darwin",
                hasUI: true,
            }),
            "deny",
        ],
        [
            "ordinary awk pipeline",
            decideCommand("printf 'a b\\n' | awk '{print $1}'", {
                shell: "bash",
                mode: "guard",
                cwd: "/home/pi/work",
                platform: "linux",
                hasUI: true,
            }),
            "allow",
        ],
        // hasUI:false so the check is deterministic: a host with a PowerShell parser denies this critically, one
        // without it can only reach "unresolved", and both must refuse without an approval prompt.
        [
            "abbreviated encoded command",
            decideCommand(
                `powershell.exe -enc ${Buffer.from("Remove-Item -Recurse -Force C:\\Windows", "utf16le").toString("base64")}`,
                { shell: "bash", mode: "guard", cwd: "C:\\work", platform: "win32", hasUI: false },
            ),
            "deny",
        ],
        [
            "plain find is read-only",
            decideCommand("find src -type f -print", {
                shell: "bash",
                mode: "guard",
                cwd: "/home/pi/work",
                platform: "linux",
                hasUI: true,
            }),
            "allow",
        ],
        [
            "find deletion on a protected root",
            decideCommand("find /etc -delete", {
                shell: "bash",
                mode: "guard",
                cwd: "/home/pi/work",
                platform: "linux",
                hasUI: true,
            }),
            "deny",
        ],
    ];
    for (const [name, result, expected] of checks) {
        if (result.action !== expected) {
            throw new Error(`${name} expected ${expected}, got ${result.action}`);
        }
    }

    return `command-guard-smoke passed: ${checks.length} inert policy checks`;
}

const invokedDirectly =
    Boolean(process.argv[1]) &&
    (process.platform === "win32"
        ? path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
        : path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (invokedDirectly) {
    runCommandGuardSmoke()
        .then((message) => console.log(message))
        .catch((error) => {
            console.error(`command-guard-smoke failed: ${error instanceof Error ? error.message : String(error)}`);
            process.exitCode = 1;
        });
}
