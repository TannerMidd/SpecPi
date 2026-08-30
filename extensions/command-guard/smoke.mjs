#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decideCommand, decidePath } from "./core.mjs";

export async function runCommandGuardSmoke() {
  const checks = [
    ["safe listing", decideCommand("printf '%s\\n' hello", { shell: "bash", mode: "guard", cwd: process.cwd(), hasUI: false }), "allow"],
    ["root deletion", decideCommand("rm -rf /", { shell: "bash", mode: "guard", cwd: process.cwd(), hasUI: false }), "deny"],
    ["malformed quote", decideCommand("printf 'unterminated", { shell: "bash", mode: "guard", cwd: process.cwd(), hasUI: false }), "deny"],
    ["protected write", decidePath("/etc/passwd", "write", { mode: "guard", cwd: process.cwd(), hasUI: false }), "deny"],
    ["wrapped root deletion", decideCommand("sudo -u root bash -lc 'rm -rf /*'", { shell: "bash", mode: "guard", cwd: process.cwd(), hasUI: true }), "deny"],
    ["decoded interpreter pipe", decideCommand("printf cm0gLXJmIC8K | base64 -d | sh", { shell: "bash", mode: "guard", cwd: process.cwd(), hasUI: true }), "deny"],
    ["nested cmd deletion", decideCommand('cmd /c "cmd /c rd /s /q C:\\\\Windows"', { shell: "cmd", mode: "guard", cwd: "C:\\\\work", platform: "win32", hasUI: true }), "deny"],
    ["strict workspace mutation without UI", decidePath("file.txt", "write", { mode: "strict", cwd: process.cwd(), hasUI: false }), "deny"],
    ["argv-prefix runner laundering", decideCommand("setsid rm -rf /etc", { shell: "bash", mode: "guard", cwd: "/home/pi/work", platform: "linux", hasUI: true }), "deny"],
    ["command-string runner laundering", decideCommand("watch 'rm -rf /etc'", { shell: "bash", mode: "guard", cwd: "/home/pi/work", platform: "linux", hasUI: true }), "deny"],
    ["environment enumeration", decideCommand("printenv", { shell: "bash", mode: "guard", cwd: "/home/pi/work", platform: "linux", hasUI: true }), "deny"],
    ["process environment pseudo-file", decideCommand("cat /proc/self/environ", { shell: "bash", mode: "guard", cwd: "/home/pi/work", platform: "linux", hasUI: true }), "deny"],
    ["macOS system root", decidePath("/Library/LaunchDaemons/x.plist", "write", { mode: "guard", cwd: "/Users/alice/work", platform: "darwin", hasUI: true }), "deny"],
    ["ordinary awk pipeline", decideCommand("printf 'a b\\n' | awk '{print $1}'", { shell: "bash", mode: "guard", cwd: "/home/pi/work", platform: "linux", hasUI: true }), "allow"],
    ["abbreviated encoded command", decideCommand(`powershell.exe -enc ${Buffer.from("Remove-Item -Recurse -Force C:\\Windows", "utf16le").toString("base64")}`, { shell: "bash", mode: "guard", cwd: "C:\\work", platform: "win32", hasUI: true }), "deny"],
    ["plain find is read-only", decideCommand("find src -type f -print", { shell: "bash", mode: "guard", cwd: "/home/pi/work", platform: "linux", hasUI: true }), "allow"],
    ["find deletion on a protected root", decideCommand("find /etc -delete", { shell: "bash", mode: "guard", cwd: "/home/pi/work", platform: "linux", hasUI: true }), "deny"],
  ];
  for (const [name, result, expected] of checks) {
    if (result.action !== expected) throw new Error(`${name} expected ${expected}, got ${result.action}`);
  }
  return `command-guard-smoke passed: ${checks.length} inert policy checks`;
}

const invokedDirectly = Boolean(process.argv[1]) && (
  process.platform === "win32"
    ? path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
    : path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
);
if (invokedDirectly) {
  runCommandGuardSmoke().then((message) => console.log(message)).catch((error) => {
    console.error(`command-guard-smoke failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
