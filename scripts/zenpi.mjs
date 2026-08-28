#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AGENTS_END,
  AGENTS_START,
  SHELL_END,
  SHELL_START,
  deepEqual,
  deletePath,
  mergePackages,
  packageIdentity,
  readPath,
  removeManagedBlock,
  restorePackageChanges,
  setPath,
  sha256,
  upsertManagedBlock,
} from "./lib.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const VERSION = packageJson.version;
const agentDir = path.resolve(
  process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
);
const stateDir = path.join(agentDir, "zenpi");
const manifestPath = path.join(stateDir, "manifest.json");
const lockPath = path.join(stateDir, "install.lock");
const settingsPath = path.join(agentDir, "settings.json");
const agentsPath = path.join(agentDir, "AGENTS.md");
const browserRuntimeSourceDir = path.join(repoRoot, "browser-runtime");
const browserRuntimeDir = path.join(stateDir, "browser-runtime");
const browserRuntimeMarker = path.join(browserRuntimeDir, "zenpi-runtime.json");
const browserSmokePath = path.join(agentDir, "extensions", "browser", "smoke.mjs");

const PACKAGES = [
  "npm:pi-web-access@0.25.0",
  "npm:pi-subagents@0.58.0",
  "npm:@juicesharp/rpiv-ask-user-question@2.7.1",
  "npm:@llblab/pi-codex-usage@0.9.3",
  "npm:@tunnckocore/pi-gpt-fast-mode@0.4.0",
  "npm:@narumitw/pi-goal@0.54.3",
  "npm:@tmustier/pi-files-widget@0.2.0",
];

function usage() {
  console.log(`ZenPi ${VERSION}

Usage:
  ./zenpi plan
  ./zenpi install [--yes] [--skip-package-install] [--skip-browser-install] [--skip-shell]
  ./zenpi update [--yes] [--force] [--skip-package-install] [--skip-browser-install] [--skip-shell]
  ./zenpi doctor
  ./zenpi uninstall [--yes]

Options:
  --yes                   Do not ask for confirmation.
  --force                 Replace locally modified ZenPi-managed files during update.
  --skip-package-install  Write pinned package settings without installing external packages (also skips the browser runtime).
  --skip-browser-install  Install browser tools but skip the managed Playwright/Chromium runtime.
  --skip-shell            Do not install shell profile functions or edit a shell rc file.

Environment:
  PI_CODING_AGENT_DIR     Override the Pi agent directory (default: ~/.pi/agent).
`);
}

function parseArgs(argv) {
  const command = argv[0] || "help";
  const known = new Set([
    "--yes",
    "--force",
    "--skip-package-install",
    "--skip-browser-install",
    "--skip-shell",
  ]);
  for (const arg of argv.slice(1)) {
    if (!known.has(arg)) throw new Error(`Unknown option: ${arg}`);
  }
  return {
    command,
    yes: argv.includes("--yes"),
    force: argv.includes("--force"),
    skipPackageInstall: argv.includes("--skip-package-install"),
    skipBrowserInstall:
      argv.includes("--skip-browser-install") || argv.includes("--skip-package-install"),
    skipShell: argv.includes("--skip-shell"),
  };
}

function timestamp() {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
}

function commandExists(command) {
  const result = spawnSync("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", command]);
  return result.status === 0;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || os.homedir(),
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stderr || result.stdout || ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}${detail}`);
  }
  return result;
}

function browserRuntimeLockHash() {
  return sha256(fs.readFileSync(path.join(browserRuntimeSourceDir, "package-lock.json")));
}

function browserRuntimeStatus() {
  if (!fs.existsSync(browserRuntimeMarker)) return { installed: false, reason: "runtime marker is missing" };
  try {
    const marker = readJson(browserRuntimeMarker, {});
    const playwright = readJson(path.join(browserRuntimeDir, "node_modules", "playwright", "package.json"), {});
    const browsersDir = path.join(browserRuntimeDir, "browsers");
    const hasBrowser = fs.existsSync(browsersDir) && fs.readdirSync(browsersDir).some((entry) => !entry.startsWith("."));
    if (marker.schema !== 1 || marker.lockHash !== browserRuntimeLockHash()) {
      return { installed: false, reason: "runtime lock does not match this ZenPi release" };
    }
    if (playwright.version !== "1.62.1") return { installed: false, reason: "Playwright 1.62.1 is not installed" };
    if (!hasBrowser) return { installed: false, reason: "managed Chromium is missing" };
    return { installed: true, version: playwright.version, lockHash: marker.lockHash };
  } catch (error) {
    return { installed: false, reason: error.message };
  }
}

function smokeBrowserRuntime(directory) {
  try {
    return run(process.execPath, [path.join(repoRoot, "extensions", "browser", "smoke.mjs"), directory], {
      capture: true,
    });
  } catch (error) {
    throw new Error(`${error.message}\nChromium could not launch. Verify the host satisfies Playwright Chromium system dependencies; ZenPi does not install apt/system packages.`);
  }
}

function installBrowserRuntime(warnings) {
  const current = browserRuntimeStatus();
  if (current.installed) {
    try {
      smokeBrowserRuntime(browserRuntimeDir);
      console.log("Managed browser runtime is current and passed its launch smoke; reusing Playwright 1.62.1 and Chromium.");
      return { commit() {}, rollback() { return []; }, changed: false };
    } catch (error) {
      warnings.push(`Existing managed browser runtime failed validation and will be replaced: ${error.message}`);
    }
  }

  const operationStamp = `${process.pid}-${Date.now()}`;
  const stage = path.join(stateDir, `.browser-runtime-stage-${operationStamp}`);
  const previous = path.join(stateDir, `.browser-runtime-previous-${operationStamp}`);
  const failed = path.join(stateDir, `.browser-runtime-failed-${operationStamp}`);
  let promoted = false;
  try {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(previous, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(browserRuntimeSourceDir, "package.json"), path.join(stage, "package.json"));
    fs.copyFileSync(path.join(browserRuntimeSourceDir, "package-lock.json"), path.join(stage, "package-lock.json"));
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage });
    const browsersPath = path.join(stage, "browsers");
    run(process.execPath, [path.join(stage, "node_modules", "playwright", "cli.js"), "install", "chromium"], {
      cwd: stage,
      env: { PLAYWRIGHT_BROWSERS_PATH: browsersPath },
    });
    writeJson(
      path.join(stage, "zenpi-runtime.json"),
      { schema: 1, playwrightVersion: "1.62.1", lockHash: browserRuntimeLockHash() },
      0o600,
    );

    if (fs.existsSync(browserRuntimeDir)) fs.renameSync(browserRuntimeDir, previous);
    fs.renameSync(stage, browserRuntimeDir);
    promoted = true;
    smokeBrowserRuntime(browserRuntimeDir);
  } catch (error) {
    const cleanupErrors = [];
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch (cleanupError) { cleanupErrors.push(cleanupError.message); }
    if (promoted && fs.existsSync(browserRuntimeDir)) {
      try { fs.renameSync(browserRuntimeDir, failed); } catch (cleanupError) { cleanupErrors.push(`quarantine failed runtime: ${cleanupError.message}`); }
    }
    if (fs.existsSync(previous) && !fs.existsSync(browserRuntimeDir)) {
      try { fs.renameSync(previous, browserRuntimeDir); } catch (cleanupError) { cleanupErrors.push(`restore previous runtime: ${cleanupError.message}`); }
    }
    if (fs.existsSync(failed)) {
      try { fs.rmSync(failed, { recursive: true, force: true }); } catch (cleanupError) { cleanupErrors.push(`remove failed runtime: ${cleanupError.message}`); }
    }
    throw new Error(`${error.message}${cleanupErrors.length ? `\nRuntime cleanup also failed: ${cleanupErrors.join("; ")}` : ""}`);
  }

  let settled = false;
  return {
    changed: true,
    commit() {
      if (settled) return;
      settled = true;
      try {
        fs.rmSync(previous, { recursive: true, force: true });
      } catch (error) {
        warnings.push(`Could not remove retired browser runtime ${previous}: ${error.message}`);
      }
    },
    rollback() {
      if (settled) return [];
      settled = true;
      const errors = [];
      if (fs.existsSync(browserRuntimeDir)) {
        try { fs.renameSync(browserRuntimeDir, failed); } catch (error) { errors.push(`quarantine new runtime: ${error.message}`); }
      }
      if (fs.existsSync(previous) && !fs.existsSync(browserRuntimeDir)) {
        try { fs.renameSync(previous, browserRuntimeDir); } catch (error) { errors.push(`restore previous runtime: ${error.message}`); }
      }
      if (fs.existsSync(failed)) {
        try { fs.rmSync(failed, { recursive: true, force: true }); } catch (error) { errors.push(`remove rolled-back runtime: ${error.message}`); }
      }
      return errors;
    },
  };
}

function readJson(file, fallback = {}) {
  if (!fs.existsSync(file)) return structuredClone(fallback);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse ${file}: ${error.message}`);
  }
}

function lstatMaybe(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function pathExists(file) {
  return lstatMaybe(file) !== undefined;
}

function assertNoBrokenSymlinks(files) {
  for (const file of files) {
    const stat = lstatMaybe(file);
    if (stat?.isSymbolicLink() && !fs.existsSync(file)) {
      throw new Error(`Broken symlink is unsupported: ${file}`);
    }
  }
}

function atomicWrite(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let destination = file;
  if (lstatMaybe(file)?.isSymbolicLink()) {
    if (!fs.existsSync(file)) throw new Error(`Broken symlink is unsupported: ${file}`);
    destination = fs.realpathSync(file);
  }
  const temp = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.tmp`,
  );
  fs.writeFileSync(temp, data, { mode });
  fs.chmodSync(temp, mode);
  fs.renameSync(temp, destination);
}

function writeJson(file, value, mode = 0o600) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

function existingMode(file, fallback) {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return fallback;
  }
}

function detectShellRc() {
  if (process.env.ZENPI_SHELL_RC) return path.resolve(process.env.ZENPI_SHELL_RC);
  const shell = path.basename(process.env.SHELL || "");
  if (shell === "bash") return path.join(os.homedir(), ".bashrc");
  if (shell === "zsh") return path.join(os.homedir(), ".zshrc");
  return undefined;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function desiredSettingsOperations() {
  const webExtension = path.join(agentDir, "npm", "node_modules", "pi-web-access", "index.ts");
  return [
    { path: ["theme"], value: "tea-house" },
    { path: ["subagents", "defaultModel"], delete: true },
    { path: ["subagents", "defaultThinking"], value: "medium" },
    { path: ["subagents", "defaultExtensions"], value: [] },
    { path: ["subagents", "maxThinking"], value: "high" },
    {
      path: ["subagents", "modelScope"],
      value: { enforce: true, strict: true, allow: ["inherit"] },
    },
    { path: ["subagents", "agentOverrides", "codex-exec", "disabled"], value: true },
    { path: ["subagents", "agentOverrides", "codex-exec-writer", "disabled"], value: true },
    { path: ["subagents", "agentOverrides", "scout", "model"], value: "inherit" },
    { path: ["subagents", "agentOverrides", "scout", "thinking"], value: "low" },
    { path: ["subagents", "agentOverrides", "researcher", "model"], value: "inherit" },
    { path: ["subagents", "agentOverrides", "researcher", "thinking"], value: "medium" },
    {
      path: ["subagents", "agentOverrides", "researcher", "extensions"],
      value: [webExtension],
    },
    { path: ["subagents", "agentOverrides", "worker", "model"], value: "inherit" },
    { path: ["subagents", "agentOverrides", "worker", "thinking"], value: "medium" },
    { path: ["subagents", "agentOverrides", "reviewer", "model"], value: "inherit" },
    { path: ["subagents", "agentOverrides", "reviewer", "thinking"], value: "high" },
    { path: ["subagents", "agentOverrides", "oracle", "model"], value: "inherit" },
    { path: ["subagents", "agentOverrides", "oracle", "thinking"], value: "high" },
  ];
}

function managedFiles(includeShell) {
  const files = [
    [path.join(repoRoot, "extensions", "zen.ts"), path.join(agentDir, "extensions", "zen.ts"), 0o644],
    [
      path.join(repoRoot, "extensions", "browser", "index.ts"),
      path.join(agentDir, "extensions", "browser", "index.ts"),
      0o644,
    ],
    [
      path.join(repoRoot, "extensions", "browser", "core.mjs"),
      path.join(agentDir, "extensions", "browser", "core.mjs"),
      0o644,
    ],
    [
      path.join(repoRoot, "extensions", "browser", "smoke.mjs"),
      path.join(agentDir, "extensions", "browser", "smoke.mjs"),
      0o755,
    ],
    [
      path.join(repoRoot, "extensions", "tool-wishlist", "index.ts"),
      path.join(agentDir, "extensions", "tool-wishlist", "index.ts"),
      0o644,
    ],
    [
      path.join(repoRoot, "extensions", "tool-wishlist", "core.mjs"),
      path.join(agentDir, "extensions", "tool-wishlist", "core.mjs"),
      0o644,
    ],
    [
      path.join(repoRoot, "skills", "donsetch", "SKILL.md"),
      path.join(agentDir, "skills", "donsetch", "SKILL.md"),
      0o644,
    ],
    [
      path.join(repoRoot, "themes", "tea-house.json"),
      path.join(agentDir, "themes", "tea-house.json"),
      0o644,
    ],
    [
      path.join(repoRoot, "templates", "subagent-config.json"),
      path.join(agentDir, "extensions", "subagent", "config.json"),
      0o644,
    ],
  ];
  if (includeShell) {
    files.push([
      path.join(repoRoot, "shell", "pi-profiles.sh"),
      path.join(stateDir, "pi-profiles.sh"),
      0o644,
    ]);
  }
  return files;
}

function snapshot(files) {
  const result = new Map();
  for (const file of files) {
    if (result.has(file)) continue;
    if (fs.existsSync(file)) {
      result.set(file, {
        exists: true,
        data: fs.readFileSync(file),
        mode: fs.statSync(file).mode & 0o777,
      });
    } else result.set(file, { exists: false });
  }
  return result;
}

function restoreSnapshot(items) {
  for (const [file, prior] of items) {
    if (prior.exists) atomicWrite(file, prior.data, prior.mode);
    else fs.rmSync(file, { force: true });
  }
}

function createOriginalFileRecord(target, backupDir, existingRecord, index) {
  if (existingRecord) return structuredClone(existingRecord);
  if (!fs.existsSync(target)) return { existed: false };
  const backup = path.join(backupDir, "original", `${String(index).padStart(3, "0")}-${path.basename(target)}`);
  fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
  fs.copyFileSync(target, backup);
  fs.chmodSync(backup, 0o600);
  return {
    existed: true,
    backup: path.relative(stateDir, backup),
    mode: fs.statSync(target).mode & 0o777,
  };
}

function applySettings(settings, operations, previousChanges = []) {
  const changesByPath = new Map(previousChanges.map((change) => [change.path.join("."), change]));
  const changes = [];
  for (const operation of operations) {
    const key = operation.path.join(".");
    const existingChange = changesByPath.get(key);
    const before = existingChange || (() => {
      const current = readPath(settings, operation.path);
      return {
        path: operation.path,
        beforeExists: current.exists,
        ...(current.exists ? { before: current.value } : {}),
      };
    })();

    if (operation.delete) deletePath(settings, operation.path);
    else setPath(settings, operation.path, operation.value);

    changes.push({
      ...before,
      installedExists: !operation.delete,
      ...(!operation.delete ? { installed: structuredClone(operation.value) } : {}),
    });
  }
  return changes;
}

function retireSettings(settings, previousChanges, operations, warnings) {
  const desired = new Set(operations.map((operation) => operation.path.join(".")));
  const retired = previousChanges.filter((change) => !desired.has(change.path.join(".")));
  restoreSettingChanges(settings, retired, warnings);
}

function buildPackageChanges(packagesBeforeOperation, previousChanges = []) {
  return PACKAGES.map((installed) => {
    const identity = packageIdentity(installed);
    const previous = previousChanges.find((change) => change.identity === identity);
    if (previous) return { ...structuredClone(previous), installed };
    const before = (packagesBeforeOperation || []).find(
      (entry) => packageIdentity(entry) === identity,
    );
    return {
      identity,
      beforeExists: before !== undefined,
      ...(before !== undefined ? { before: structuredClone(before) } : {}),
      installed,
    };
  });
}

function restoreFileRecord(target, record, warnings, reason) {
  if (!fs.existsSync(target)) return;
  if (sha256(fs.readFileSync(target)) !== record.installedHash) {
    warnings.push(`Preserved modified file during ${reason}: ${target}`);
    return;
  }
  if (record.existed) {
    const backup = path.join(stateDir, record.backup);
    if (!fs.existsSync(backup)) throw new Error(`Missing original backup: ${backup}`);
    atomicWrite(target, fs.readFileSync(backup), record.mode || 0o644);
  } else fs.rmSync(target, { force: true });
}

function makeAgentsBlock() {
  const template = fs.readFileSync(path.join(repoRoot, "templates", "AGENTS.md"), "utf8").trim();
  return `_ZenPi-managed guidance, version ${VERSION}._\n\n${template}`;
}

function makeShellBlock() {
  const profile = path.join(stateDir, "pi-profiles.sh");
  return `[ -f ${shellQuote(profile)} ] && . ${shellQuote(profile)}`;
}

function finishManagedBlockRemoval(file, result, existedBefore) {
  const isSymlink = lstatMaybe(file)?.isSymbolicLink() || false;
  if (result.trim() || existedBefore || isSymlink) {
    atomicWrite(file, result, existingMode(file, 0o644));
  } else fs.rmSync(file, { force: true });
}

function readManifest(required = false) {
  if (!fs.existsSync(manifestPath)) {
    if (required) throw new Error("ZenPi is not installed. Run ./zenpi install first.");
    return undefined;
  }
  const manifest = readJson(manifestPath);
  if (manifest.schema !== 1) throw new Error(`Unsupported manifest schema in ${manifestPath}`);
  return manifest;
}

function acquireLock() {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = fs.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stalePid = Number.parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
    let active = Number.isInteger(stalePid) && stalePid > 0;
    if (active) {
      try {
        process.kill(stalePid, 0);
      } catch (probeError) {
        if (probeError.code === "ESRCH") active = false;
        else throw probeError;
      }
    }
    if (active) throw new Error(`Another ZenPi operation appears active: ${lockPath}`);
    fs.rmSync(lockPath, { force: true });
    fd = fs.openSync(lockPath, "wx", 0o600);
  }
  fs.writeFileSync(fd, `${process.pid}\n`);
  fs.closeSync(fd);
  return () => fs.rmSync(lockPath, { force: true });
}

async function confirm(message, yes) {
  if (yes) return;
  if (!process.stdin.isTTY) throw new Error("Confirmation requires a TTY; inspect ./zenpi plan, then pass --yes.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${message} [y/N] `)).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") throw new Error("Cancelled.");
}

function assertSources() {
  const required = [
    "extensions/zen.ts",
    "extensions/browser/index.ts",
    "extensions/browser/core.mjs",
    "extensions/browser/smoke.mjs",
    "browser-runtime/package.json",
    "browser-runtime/package-lock.json",
    "extensions/tool-wishlist/index.ts",
    "extensions/tool-wishlist/core.mjs",
    "skills/donsetch/SKILL.md",
    "themes/tea-house.json",
    "templates/AGENTS.md",
    "templates/subagent-config.json",
    "shell/pi-profiles.sh",
  ];
  for (const relative of required) {
    if (!fs.existsSync(path.join(repoRoot, relative))) throw new Error(`Missing repository source: ${relative}`);
  }
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 19)) {
    throw new Error(`Node 22.19 or newer is required; found ${process.versions.node}`);
  }
  readJson(settingsPath, {});
}

function printPlan(options) {
  const shellRc = detectShellRc();
  const manageShell = !options.skipShell && Boolean(shellRc);
  console.log(`ZenPi ${VERSION} installation plan

Pi agent directory:
  ${agentDir}

Managed files:`);
  for (const [, target] of managedFiles(manageShell)) console.log(`  ${target}`);
  console.log(`  ${agentsPath} (managed block only)`);
  if (!options.skipShell && shellRc) console.log(`  ${shellRc} (managed source block only)`);
  else if (!options.skipShell) console.log("  shell integration skipped (only bash and zsh are supported)");
  console.log(`  ${manifestPath}`);

  console.log("\nSettings ownership:");
  console.log("  theme = tea-house");
  console.log("  pinned package entries (merged by npm package identity)");
  console.log("  bounded subagent defaults and role overrides");
  console.log("  strict modelScope allow = [inherit]");
  console.log("  codex-exec and codex-exec-writer disabled");
  console.log("  provider, default model, authentication, trust, sessions, and history are untouched");
  console.log("  capability-gap events use sanitized summaries and salted session/project hashes");
  console.log("  isolated browser contexts never reuse the user's Chrome profile or cookies");

  console.log("\nManaged browser runtime:");
  if (options.skipBrowserInstall) {
    console.log("  skipped by explicit flag (browser tools remain installed but unavailable without an existing runtime)");
  } else {
    console.log(`  ${browserRuntimeDir}`);
    console.log("  Playwright 1.62.1 + matching managed Chromium");
    console.log("  staged before atomic promotion; no global executable installation");
  }

  console.log("\nPinned packages:");
  for (const spec of PACKAGES) console.log(`  ${spec}`);

  console.log("\nExternal prerequisites checked but not installed by default:");
  console.log("  bat (or batcat), delta, glow, donsetch");
  console.log("  Chromium is installed by default inside the managed browser runtime");
  console.log("\nEvery install/update creates timestamped backups under:");
  console.log(`  ${path.join(stateDir, "backups")}`);
}

function validateManagedUpdate(manifest, files, force) {
  if (!manifest || force) return;
  for (const [, target] of files) {
    const record = manifest.files?.[target];
    if (!record || !fs.existsSync(target)) continue;
    const currentHash = sha256(fs.readFileSync(target));
    if (currentHash !== record.installedHash) {
      throw new Error(`Managed file was modified after installation: ${target}\nUse --force to replace it.`);
    }
  }
}

async function installOrUpdate(options, update) {
  assertSources();
  if (!options.skipPackageInstall && !commandExists("pi")) {
    throw new Error("pi is not available on PATH.");
  }
  if (!options.skipBrowserInstall && !commandExists("npm")) {
    throw new Error("npm is required to install the managed browser runtime.");
  }

  const releaseLock = acquireLock();
  let transaction;
  let browserRuntimeTransaction;
  let backupDir;
  try {
    const previousManifest = readManifest(update);
    if (!update && previousManifest) {
      throw new Error("ZenPi is already installed. Run ./zenpi update.");
    }

    const shellRc = previousManifest?.shellRc || (options.skipShell ? undefined : detectShellRc());
    const manageShellNow = Boolean(shellRc) && !options.skipShell;
    if (!options.skipShell && !shellRc) {
      console.warn("Shell integration skipped: ZenPi currently supports bash and zsh only.");
    }
    const files = managedFiles(manageShellNow);
    validateManagedUpdate(previousManifest, files, options.force);
    printPlan({ ...options, skipShell: !manageShellNow });
    await confirm(`${update ? "Update" : "Install"} ZenPi ${VERSION}?`, options.yes);

    const watched = [
      settingsPath,
      agentsPath,
      manifestPath,
      ...(shellRc ? [shellRc] : []),
      ...files.map(([, target]) => target),
      ...Object.keys(previousManifest?.files || {}),
    ];
    assertNoBrokenSymlinks(watched);
    transaction = snapshot(watched);
    backupDir = path.join(stateDir, "backups", timestamp());
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

    const settingsBeforeOperation = readJson(settingsPath, {});
    const warnings = [];
    const blockFiles = structuredClone(previousManifest?.blockFiles || {});
    blockFiles.agents ||= { existed: pathExists(agentsPath) };
    if (shellRc) blockFiles.shell ||= { existed: pathExists(shellRc) };
    const packageChanges = buildPackageChanges(
      settingsBeforeOperation.packages || [],
      previousManifest?.packageChanges || [],
    );

    if (!options.skipBrowserInstall) {
      browserRuntimeTransaction = installBrowserRuntime(warnings);
    } else if (!browserRuntimeStatus().installed) {
      warnings.push("Managed browser runtime installation was explicitly skipped; browser tools will be unavailable.");
    }

    if (!options.skipPackageInstall) {
      for (const spec of PACKAGES) run("pi", ["install", spec]);
    }

    const settings = readJson(settingsPath, {});
    const desiredPackageIds = new Set(PACKAGES.map(packageIdentity));
    const retiredPackageChanges = (previousManifest?.packageChanges || []).filter(
      (change) => !desiredPackageIds.has(change.identity),
    );
    settings.packages = restorePackageChanges(
      settings.packages,
      retiredPackageChanges,
      warnings,
    );
    settings.packages = mergePackages(settings.packages, PACKAGES);

    const operations = desiredSettingsOperations();
    retireSettings(settings, previousManifest?.settingsChanges || [], operations, warnings);
    const settingsChanges = applySettings(
      settings,
      operations,
      previousManifest?.settingsChanges || [],
    );
    writeJson(settingsPath, settings, existingMode(settingsPath, 0o600));

    const fileRecords = structuredClone(previousManifest?.files || {});
    const desiredTargets = new Set(files.map(([, target]) => target));
    if (update && options.skipShell && previousManifest?.shellRc) {
      desiredTargets.add(path.join(stateDir, "pi-profiles.sh"));
    }
    for (const [target, record] of Object.entries(fileRecords)) {
      if (desiredTargets.has(target)) continue;
      restoreFileRecord(target, record, warnings, "update retirement");
      delete fileRecords[target];
    }

    let fileIndex = Object.keys(fileRecords).length;
    for (const [source, target, mode] of files) {
      const record = createOriginalFileRecord(target, backupDir, fileRecords[target], fileIndex++);
      const data = fs.readFileSync(source);
      atomicWrite(target, data, mode);
      record.installedHash = sha256(data);
      fileRecords[target] = record;
    }

    const existingAgents = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, "utf8") : "";
    atomicWrite(
      agentsPath,
      upsertManagedBlock(existingAgents, AGENTS_START, AGENTS_END, makeAgentsBlock()),
      existingMode(agentsPath, 0o644),
    );

    if (manageShellNow) {
      const existingShell = fs.existsSync(shellRc) ? fs.readFileSync(shellRc, "utf8") : "";
      atomicWrite(
        shellRc,
        upsertManagedBlock(existingShell, SHELL_START, SHELL_END, makeShellBlock()),
        existingMode(shellRc, 0o644),
      );
    }

    const manifest = {
      schema: 1,
      version: VERSION,
      installedAt: previousManifest?.installedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      agentDir,
      shellRc,
      blockFiles,
      packagesKeyBeforeExists:
        previousManifest?.packagesKeyBeforeExists ?? Object.hasOwn(settingsBeforeOperation, "packages"),
      packageChanges,
      settingsChanges,
      browserRuntime: browserRuntimeStatus(),
      files: fileRecords,
      backups: [...(previousManifest?.backups || []), path.relative(stateDir, backupDir)],
    };
    writeJson(manifestPath, manifest, 0o600);

    if (!options.skipPackageInstall) {
      run("pi", ["--offline", "--list-models", "gpt"], { capture: true });
    }

    browserRuntimeTransaction?.commit();
    console.log(`\nZenPi ${update ? "updated" : "installed"} successfully.`);
    console.log(`Manifest: ${manifestPath}`);
    for (const warning of warnings) console.warn(`Warning: ${warning}`);
    console.log("Run ./zenpi doctor, then /reload in active Pi sessions.");
  } catch (error) {
    const rollbackErrors = [];
    try { rollbackErrors.push(...(browserRuntimeTransaction?.rollback() || [])); } catch (rollbackError) { rollbackErrors.push(`browser runtime rollback: ${rollbackError.message}`); }
    if (transaction) {
      try { restoreSnapshot(transaction); } catch (rollbackError) { rollbackErrors.push(`configuration rollback: ${rollbackError.message}`); }
    }
    if (backupDir) {
      try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch (rollbackError) { rollbackErrors.push(`backup cleanup: ${rollbackError.message}`); }
    }
    throw new Error(`${transaction ? "Installation rolled back: " : ""}${error.message}${rollbackErrors.length ? `\nSecondary rollback errors: ${rollbackErrors.join("; ")}` : ""}`);
  } finally {
    releaseLock();
  }
}

function restoreSettingChanges(settings, changes, warnings) {
  for (const change of changes) {
    const current = readPath(settings, change.path);
    const matchesInstalled = change.installedExists
      ? current.exists && deepEqual(current.value, change.installed)
      : !current.exists;
    if (!matchesInstalled) {
      warnings.push(`Preserved modified setting: ${change.path.join(".")}`);
      continue;
    }
    if (change.beforeExists) setPath(settings, change.path, change.before);
    else deletePath(settings, change.path);
  }
}

async function uninstall(options) {
  const releaseLock = acquireLock();
  let transaction;
  let retiredBrowserRuntime;
  try {
    const manifest = readManifest(true);
    await confirm(`Uninstall ZenPi ${manifest.version}?`, options.yes);
    const watched = [
      settingsPath,
      agentsPath,
      manifestPath,
      ...(manifest.shellRc ? [manifest.shellRc] : []),
      ...Object.keys(manifest.files || {}),
    ];
    assertNoBrokenSymlinks(watched);
    transaction = snapshot(watched);
    const warnings = [];

    const settings = readJson(settingsPath, {});
    restoreSettingChanges(settings, manifest.settingsChanges || [], warnings);
    settings.packages = restorePackageChanges(
      settings.packages,
      manifest.packageChanges || [],
      warnings,
    );
    if (!manifest.packagesKeyBeforeExists && settings.packages.length === 0) {
      delete settings.packages;
    }
    writeJson(settingsPath, settings, existingMode(settingsPath, 0o600));

    for (const [target, record] of Object.entries(manifest.files || {})) {
      restoreFileRecord(target, record, warnings, "uninstall");
    }

    if (fs.existsSync(agentsPath)) {
      const result = removeManagedBlock(fs.readFileSync(agentsPath, "utf8"), AGENTS_START, AGENTS_END);
      finishManagedBlockRemoval(
        agentsPath,
        result,
        manifest.blockFiles?.agents?.existed ?? true,
      );
    }

    if (manifest.shellRc && fs.existsSync(manifest.shellRc)) {
      const result = removeManagedBlock(fs.readFileSync(manifest.shellRc, "utf8"), SHELL_START, SHELL_END);
      finishManagedBlockRemoval(
        manifest.shellRc,
        result,
        manifest.blockFiles?.shell?.existed ?? true,
      );
    }

    if (fs.existsSync(browserRuntimeDir)) {
      retiredBrowserRuntime = path.join(stateDir, `.browser-runtime-uninstall-${process.pid}-${Date.now()}`);
      fs.renameSync(browserRuntimeDir, retiredBrowserRuntime);
    }
    fs.rmSync(manifestPath, { force: true });
    if (retiredBrowserRuntime) {
      try {
        fs.rmSync(retiredBrowserRuntime, { recursive: true, force: true });
      } catch (error) {
        warnings.push(`Could not remove retired browser runtime ${retiredBrowserRuntime}: ${error.message}`);
      }
    }
    retiredBrowserRuntime = undefined;
    console.log("ZenPi configuration and managed browser runtime uninstalled.");
    console.log("Browser artifacts and downloaded Pi package caches were preserved as user state or inert caches.");
    for (const warning of warnings) console.warn(`Warning: ${warning}`);
  } catch (error) {
    const rollbackErrors = [];
    if (retiredBrowserRuntime && fs.existsSync(retiredBrowserRuntime) && !fs.existsSync(browserRuntimeDir)) {
      try { fs.renameSync(retiredBrowserRuntime, browserRuntimeDir); } catch (rollbackError) { rollbackErrors.push(`browser runtime restore: ${rollbackError.message}`); }
    }
    if (transaction) {
      try { restoreSnapshot(transaction); } catch (rollbackError) { rollbackErrors.push(`configuration rollback: ${rollbackError.message}`); }
    }
    throw new Error(`${transaction ? "Uninstall rolled back: " : ""}${error.message}${rollbackErrors.length ? `\nSecondary rollback errors: ${rollbackErrors.join("; ")}` : ""}`);
  } finally {
    releaseLock();
  }
}

function doctor() {
  assertSources();
  const manifest = readManifest(true);
  const errors = [];
  const warnings = [];
  const settings = readJson(settingsPath, {});

  for (const operation of desiredSettingsOperations()) {
    const current = readPath(settings, operation.path);
    const valid = operation.delete ? !current.exists : current.exists && deepEqual(current.value, operation.value);
    if (!valid) errors.push(`Setting drift: ${operation.path.join(".")}`);
  }

  for (const spec of PACKAGES) {
    const found = (settings.packages || []).find((entry) => packageIdentity(entry) === packageIdentity(spec));
    if (!deepEqual(found, spec)) errors.push(`Missing or unpinned package setting: ${spec}`);
  }

  for (const [target, record] of Object.entries(manifest.files || {})) {
    if (!fs.existsSync(target)) errors.push(`Missing managed file: ${target}`);
    else if (sha256(fs.readFileSync(target)) !== record.installedHash) warnings.push(`Modified managed file: ${target}`);
  }

  const agents = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, "utf8") : "";
  if (!agents.includes(AGENTS_START) || !agents.includes(AGENTS_END)) errors.push("Missing ZenPi AGENTS.md block");
  if (manifest.shellRc) {
    const shell = fs.existsSync(manifest.shellRc) ? fs.readFileSync(manifest.shellRc, "utf8") : "";
    if (!shell.includes(SHELL_START) || !shell.includes(SHELL_END)) errors.push("Missing ZenPi shell block");
  }

  const runtimeStatus = browserRuntimeStatus();
  let browserSmoke;
  if (!runtimeStatus.installed) {
    const message = `Managed browser runtime unavailable: ${runtimeStatus.reason}`;
    if (manifest.browserRuntime?.installed === false) warnings.push(`${message} (installation was skipped)`);
    else errors.push(message);
  } else if (!fs.existsSync(browserSmokePath)) {
    errors.push(`Browser smoke probe is missing: ${browserSmokePath}`);
  } else {
    try {
      const result = smokeBrowserRuntime(browserRuntimeDir);
      browserSmoke = (result.stdout || "").trim();
    } catch (error) {
      errors.push(`Browser smoke failed: ${error.message}`);
    }
  }

  if (!commandExists("pi")) errors.push("pi is not available on PATH");
  if (!commandExists("bat") && !commandExists("batcat")) warnings.push("bat/batcat is missing (files widget prerequisite)");
  if (!commandExists("delta")) warnings.push("delta is missing (files widget prerequisite)");
  if (!commandExists("glow")) warnings.push("glow is missing (files widget prerequisite)");
  if (!commandExists("donsetch")) warnings.push("donsetch is missing (optional skill prerequisite)");

  console.log(`ZenPi ${manifest.version} doctor`);
  console.log(`Agent directory: ${agentDir}`);
  if (browserSmoke) console.log(`BROWSER ${browserSmoke}`);
  for (const warning of warnings) console.warn(`WARN  ${warning}`);
  for (const error of errors) console.error(`ERROR ${error}`);
  if (errors.length) {
    console.error(`\nDoctor failed with ${errors.length} error(s).`);
    process.exitCode = 1;
  } else console.log(`\nOK (${warnings.length} warning${warnings.length === 1 ? "" : "s"})`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  switch (options.command) {
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    case "plan":
      assertSources();
      printPlan(options);
      break;
    case "install":
      await installOrUpdate(options, false);
      break;
    case "update":
      await installOrUpdate(options, true);
      break;
    case "doctor":
      doctor();
      break;
    case "uninstall":
      await uninstall(options);
      break;
    default:
      throw new Error(`Unknown command: ${options.command}`);
  }
}

main().catch((error) => {
  console.error(`ZenPi: ${error.message}`);
  process.exitCode = 1;
});
