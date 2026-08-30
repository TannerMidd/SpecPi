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
