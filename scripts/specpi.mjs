#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
    AGENTS_END,
    AGENTS_START,
    SHELL_END,
    SHELL_START,
    deepEqual,
    deletePath,
    readPath,
    removeManagedBlock,
    restorePackageChanges,
    setPath,
    sha256,
    upsertManagedBlock,
} from "./lib.mjs";
import { validateCapabilityRegistry } from "../extensions/tool-wishlist/registry.mjs";
import { runValidator } from "../extensions/tool-wishlist/validators.mjs";
import { acquireSpecPiLock } from "./lock.mjs";
import { basePackages, checkBasePackages, installBasePackages, packageChanges } from "./packages.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
const CLI = "specpi";
const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
const stateDir = path.join(agentDir, "specpi");
const manifestPath = path.join(stateDir, "manifest.json");
const settingsPath = path.join(agentDir, "settings.json");
const agentsPath = path.join(agentDir, "AGENTS.md");
const resourcePaths = [
    "extensions/workflow-controls/index.ts",
    "extensions/workflow-controls/scope.mjs",
    "extensions/workflow-controls/task-contract.mjs",
    "extensions/workflow-controls/smoke.mjs",
    "extensions/tool-wishlist/index.ts",
    "extensions/tool-wishlist/core.mjs",
    "extensions/tool-wishlist/verification.mjs",
    "extensions/tool-wishlist/registry.mjs",
    "extensions/tool-wishlist/validators.mjs",
    "extensions/tool-wishlist/capabilities.json",
    "skills/specpi-improve/SKILL.md",
];

function usage() {
    console.log(`SpecPi ${VERSION}

Usage:
  specpi plan
  specpi install [--yes]
  specpi update [--yes] [--force]
  specpi doctor
  specpi uninstall [--yes]

Installs /scope, the harness improvement loop, and six pinned upstream packages.
The base is tested with Pi 0.84.4. Run specpi plan to see package versions.
--skip-package-install installs only the core, or preserves an existing base on update.
--force replaces modified retained resources after backing them up.
SPECPI_PI selects a Pi CLI path instead of pi on PATH.
PI_CODING_AGENT_DIR overrides the default ~/.pi/agent destination.`);
}

function parseArgs(argv) {
    const command = argv[0] || "help";
    // Obsolete browser/tool/shell flags remain accepted for older automation.
    const known = new Set([
        "--yes",
        "--force",
        "--skip-package-install",
        "--skip-browser-install",
        "--skip-tool-install",
        "--skip-shell",
    ]);
    for (const flag of argv.slice(1)) {
        if (!known.has(flag)) {
            throw new Error(`Unknown option: ${flag}`);
        }
    }

    return {
        command,
        yes: argv.includes("--yes"),
        force: argv.includes("--force"),
        skipPackages: argv.includes("--skip-package-install"),
    };
}

function injectTestFailure(point) {
    if (process.env.SPECPI_TESTING === "1" && process.env.SPECPI_TEST_FAIL_POINT === point) {
        throw new Error(`Injected test failure at ${point}`);
    }
}

function managedFiles() {
    return resourcePaths.map((relative) => [path.join(repoRoot, relative), path.join(agentDir, relative), 0o644]);
}

function assertSources() {
    for (const relative of [...resourcePaths, "templates/AGENTS.md"]) {
        if (!fs.statSync(path.join(repoRoot, relative)).isFile()) {
            throw new Error(`Missing repository source: ${relative}`);
        }
    }

    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 19)) {
        throw new Error("Node 22.19 or newer is required");
    }
}

function assertLocalPath(file, root) {
    const relative = path.relative(root, file);
    if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
        throw new Error(`Managed path is outside its expected directory: ${file}`);
    }

    let current = file;
    while (current !== path.dirname(root)) {
        if (lstatMaybe(current)?.isSymbolicLink()) {
            throw new Error(`Managed paths must not be symlinks: ${current}`);
        }

        if (current === root) {
            break;
        }

        current = path.dirname(current);
    }
}

function validateManifestPaths(manifest) {
    for (const [target, record] of Object.entries(manifest?.files || {})) {
        assertLocalPath(target, agentDir);
        const relative = path.relative(agentDir, target).replaceAll("\\", "/");
        if (
            !/^(extensions\/(?:workflow-controls|tool-wishlist|browser|command-guard|delegation|background-tasks|structural-search|files|spec|specpi-ui-refresh)\/[^/]+|extensions\/spec\.ts|skills\/(?:specpi-improve|donsetch)\/SKILL\.md|themes\/(?:tea-house|specpi-spec)\.json|specpi\/pi-profiles\.sh)$/.test(
                relative,
            )
        ) {
            throw new Error(`Unrecognized managed resource: ${target}`);
        }

        if (record.existed) {
            assertLocalPath(path.resolve(stateDir, record.backup || ""), path.join(stateDir, "backups"));
        }
    }

    for (const change of manifest?.settingsChanges || []) {
        if (
            !Array.isArray(change.path) ||
            !["theme", "disabledExtensions", "models"].includes(change.path[0]) ||
            change.path.some((part) => ["__proto__", "constructor", "prototype"].includes(part))
        ) {
            throw new Error("Unrecognized legacy settings ownership; review the manifest before updating");
        }
    }
}

function printPlan(options = {}) {
    const manifest = readManifest();
    console.log(
        `SpecPi ${VERSION}: /scope and the harness improvement loop\nPi agent directory: ${agentDir}\nManaged files:`,
    );
    for (const [, target] of managedFiles()) {
        console.log(`  ${target}`);
    }

    console.log(`  ${agentsPath} (SpecPi marker block only)\n  ${manifestPath}`);
    const wanted = new Set(managedFiles().map(([, target]) => target));
    for (const target of Object.keys(manifest?.files || {})) {
        if (!wanted.has(target)) {
            console.log(`Retire with backup: ${target}`);
        }
    }

    if (manifest) {
        console.log(
            "Restore previously managed settings and remove the old shell marker block. Preserve unrelated configuration and local evidence.",
        );
    }

    console.log(
        options.skipPackages
            ? "Package installation skipped; existing base packages are preserved."
            : "Default packages (pi install):",
    );
    if (!options.skipPackages) {
        for (const source of basePackages) {
            console.log(`  ${source}`);
        }
    }

    console.log(
        "Only package settings are merged. No SpecPi theme, shell integration, or separate browser/tool bootstrap. Wishlist collection starts off. Backups precede mutation; downloaded packages and upstream script effects cannot be rolled back.",
    );
}

function restoreLegacySettings(manifest, warnings) {
    if (!(manifest?.settingsChanges?.length || manifest?.packageChanges?.length)) {
        return;
    }

    const settings = readJson(settingsPath, {});
    restoreSettingChanges(settings, manifest.settingsChanges || [], warnings);
    if (manifest.packageChanges?.length) {
        if (Array.isArray(settings.packages)) {
            settings.packages = restorePackageChanges(settings.packages, manifest.packageChanges, warnings);
            if (!manifest.packagesKeyBeforeExists && settings.packages.length === 0) {
                delete settings.packages;
            }
        } else {
            warnings.push("Preserved removed or non-array package setting during migration");
        }
    }

    writeJson(settingsPath, settings, existingMode(settingsPath, 0o600));
}

function removeLegacyShell(manifest) {
    if (manifest?.shellRc && fs.existsSync(manifest.shellRc)) {
        const result = removeManagedBlock(fs.readFileSync(manifest.shellRc, "utf8"), SHELL_START, SHELL_END);
        finishManagedBlockRemoval(manifest.shellRc, result, manifest.blockFiles?.shell?.existed ?? true);
    }
}

function backupTransaction(transaction, backupDir) {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const inventory = [];
    for (const [target, previous] of transaction) {
        const name = `${inventory.length}.backup`;
        if (previous.exists) {
            atomicWrite(path.join(backupDir, name), previous.data, 0o600);
        }

        inventory.push({
            target,
            existed: previous.exists,
            mode: previous.mode,
            ...(previous.exists ? { file: name, sha256: sha256(previous.data) } : {}),
        });
    }

    writeJson(path.join(backupDir, "inventory.json"), inventory);
}

async function mutate(options, operation) {
    assertSources();
    assertLocalPath(manifestPath, agentDir);
    if (operation !== "uninstall") {
        printPlan(options);
    }

    await confirm(`${operation} SpecPi ${VERSION}?`, options.yes);
    const releaseLock = acquireLock();
    let transaction;
    let acquisitionStarted = false;
    const moved = [];
    try {
        const previous = readManifest(operation !== "install");
        if (operation === "install" && previous) {
            throw new Error("SpecPi is already installed. Run specpi update.");
        }

        validateManifestPaths(previous);
        const files = operation === "uninstall" ? [] : managedFiles();
        validateManagedUpdate(previous, files, options.force);
        const watched = [
            agentsPath,
            manifestPath,
            ...files.map(([, target]) => target),
            ...Object.keys(previous?.files || {}),
        ];
        if (!options.skipPackages || previous?.settingsChanges?.length || previous?.packageChanges?.length) {
            watched.push(settingsPath);
        }

        if (previous?.shellRc) {
            watched.push(previous.shellRc);
        }

        for (const file of watched) {
            if (file !== previous?.shellRc) {
                assertLocalPath(file, agentDir);
            }
        }

        assertNoBrokenSymlinks(watched);
        transaction = snapshot(watched);
        const backupDir = path.join(stateDir, "backups", `${timestamp()}-${operation}`);
        backupTransaction(transaction, backupDir);
        const warnings = [];
        const preserveBase = operation !== "uninstall" && options.skipPackages && previous?.basePackages?.length;
        restoreLegacySettings(preserveBase ? { ...previous, packageChanges: [] } : previous, warnings);
        removeLegacyShell(previous);
        let packageState = preserveBase
            ? {
                  basePackages: previous.basePackages,
                  packageChanges: previous.packageChanges,
                  packagesKeyBeforeExists: previous.packagesKeyBeforeExists,
              }
            : { basePackages: [] };
        if (operation !== "uninstall" && !options.skipPackages) {
            const before = readJson(settingsPath, {});
            if (before.packages !== undefined && !Array.isArray(before.packages)) {
                throw new Error("settings.json packages must be an array; preserved existing configuration");
            }

            assertLocalPath(path.join(agentDir, "npm", "package.json"), agentDir);
            assertLocalPath(path.join(agentDir, "npm", "node_modules"), agentDir);
            acquisitionStarted = true;
            installBasePackages(agentDir);
            const after = readJson(settingsPath, {});
            const packageErrors = checkBasePackages(agentDir, after);
            if (packageErrors.length) {
                throw new Error(packageErrors.join("\n"));
            }

            packageState = {
                basePackages,
                packagesKeyBeforeExists: Object.hasOwn(before, "packages"),
                packageChanges: packageChanges(before.packages || [], after.packages || []),
            };
        }

        injectTestFailure("after-settings");
        const records = {};
        const wanted = new Set(files.map(([, target]) => target));
        for (const [target, record] of Object.entries(previous?.files || {})) {
            if (wanted.has(target)) {
                continue;
            }

            // A retired local edit is backed up outside Pi's resource discovery before deactivation.
            if (fs.existsSync(target) && sha256(fs.readFileSync(target)) !== record.installedHash) {
                warnings.push(`Retired modified resource; saved in ${backupDir}: ${target}`);
                if (record.existed) {
                    atomicWrite(target, fs.readFileSync(path.join(stateDir, record.backup)), record.mode || 0o644);
                } else {
                    fs.rmSync(target);
                }
            } else {
                restoreFileRecord(target, record, warnings, operation);
            }
        }

        for (const [source, target, mode] of files) {
            const record = createOriginalFileRecord(
                target,
                backupDir,
                previous?.files?.[target],
                Object.keys(records).length,
            );
            const data = fs.readFileSync(source);
            atomicWrite(target, data, mode);
            record.installedHash = sha256(data);
            records[target] = record;
            injectTestFailure("after-first-managed-file");
        }

        // Preserve legacy runtime bytes wholesale; never traverse private evidence or downloaded tool trees.
        const retiredRuntimes = [
            ["browser-runtime", previous?.browserRuntime?.installed === true],
            ["structural-runtime", previous?.structuralRuntime?.installed === true],
        ];
        for (const [name, owned] of retiredRuntimes) {
            const source = path.join(stateDir, name);
            if (!owned || !fs.existsSync(source)) {
                continue;
            }

            assertLocalPath(source, stateDir);
            const destination = path.join(backupDir, name);
            fs.renameSync(source, destination);
            moved.push({ source, destination });
        }

        injectTestFailure("after-retirement");
        if (operation === "uninstall") {
            if (fs.existsSync(agentsPath)) {
                finishManagedBlockRemoval(
                    agentsPath,
                    removeManagedBlock(fs.readFileSync(agentsPath, "utf8"), AGENTS_START, AGENTS_END),
                    previous.blockFiles?.agents?.existed ?? true,
                );
            }

            fs.rmSync(manifestPath);
        } else {
            const existing = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, "utf8") : "";
            atomicWrite(
                agentsPath,
                upsertManagedBlock(existing, AGENTS_START, AGENTS_END, makeAgentsBlock()),
                existingMode(agentsPath, 0o644),
            );
            writeJson(manifestPath, {
                schema: 1,
                version: VERSION,
                agentDir,
                installedAt: previous?.installedAt || new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                blockFiles: { agents: previous?.blockFiles?.agents || { existed: transaction.get(agentsPath).exists } },
                files: records,
                ...packageState,
                backups: [...(previous?.backups || []), path.relative(stateDir, backupDir)],
            });
        }

        injectTestFailure("after-manifest");
        console.log(`SpecPi ${operation} complete. Backup: ${backupDir}`);
        for (const warning of warnings) {
            console.warn(`Warning: ${warning}`);
        }

        console.log(
            "Local wishlist and other private evidence were preserved. Restart Pi to unload retired resources.",
        );
    } catch (error) {
        const failures = [];
        for (const { source, destination } of moved.reverse()) {
            try {
                fs.renameSync(destination, source);
            } catch (failure) {
                failures.push(failure.message);
            }
        }

        if (transaction) {
            try {
                restoreSnapshot(transaction);
            } catch (failure) {
                failures.push(failure.message);
            }
        }

        throw new Error(
            `${transaction ? "SpecPi-managed changes rolled back: " : ""}${error.message}${acquisitionStarted ? "; downloaded packages and upstream install-script effects may remain" : ""}${failures.length ? `; rollback errors: ${failures.join("; ")}` : ""}`,
        );
    } finally {
        releaseLock();
    }
}

async function installOrUpdate(options, update) {
    return mutate(options, update ? "update" : "install");
}

async function uninstall(options) {
    return mutate(options, "uninstall");
}

async function doctor() {
    const manifest = readManifest(true);
    validateManifestPaths(manifest);
    const errors = [];
    if (manifest.basePackages?.length) {
        errors.push(...checkBasePackages(agentDir, readJson(settingsPath, {})));
    } else {
        console.log("Core-only installation: default package installation was skipped.");
    }

    const wanted = new Set(managedFiles().map(([, target]) => target));
    for (const target of wanted) {
        const record = manifest.files?.[target];
        if (!record || !fs.existsSync(target) || sha256(fs.readFileSync(target)) !== record.installedHash) {
            errors.push(`Missing or modified managed file: ${target}`);
        }
    }

    for (const target of Object.keys(manifest.files || {})) {
        if (!wanted.has(target)) {
            errors.push(`Retired resource is still managed; run specpi update: ${target}`);
        }
    }

    if (!fs.existsSync(agentsPath) || !fs.readFileSync(agentsPath, "utf8").includes(makeAgentsBlock())) {
        errors.push("SpecPi working agreement is missing or outdated");
    }

    const registry = validateCapabilityRegistry(
        JSON.parse(fs.readFileSync(path.join(agentDir, "extensions/tool-wishlist/capabilities.json"), "utf8")),
    );
    for (const name of new Set(registry.capabilities.flatMap((item) => item.validations))) {
        const result = runValidator(name);
        if (result.code !== 0) {
            errors.push(`validator ${name} failed: ${result.stderr || result.stdout}`);
        } else {
            console.log(result.stdout.trim());
        }
    }

    for (const error of errors) {
        console.error(error);
    }

    console.log(
        errors.length ? `Doctor failed with ${errors.length} error(s).` : "OK: scope and improvement loop verified.",
    );
    if (errors.length) {
        process.exitCode = 1;
    }
}

function timestamp() {
    return new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
}

function readJson(file, fallback = {}) {
    if (!fs.existsSync(file)) {
        return structuredClone(fallback);
    }

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
        if (error.code === "ENOENT") {
            return undefined;
        }

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
        if (!fs.existsSync(file)) {
            throw new Error(`Broken symlink is unsupported: ${file}`);
        }

        destination = fs.realpathSync(file);
    }

    const temp = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.tmp`);
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

function validManagedModelScope(value) {
    return (
        value?.enforce === true &&
        value?.strict === true &&
        Array.isArray(value.allow) &&
        value.allow.length === 1 &&
        (value.allow[0] === "inherit" || /^[^/*]+\/\*$/.test(value.allow[0]))
    );
}

function snapshot(files) {
    const result = new Map();
    for (const file of files) {
        if (result.has(file)) {
            continue;
        }

        if (fs.existsSync(file)) {
            result.set(file, {
                exists: true,
                data: fs.readFileSync(file),
                mode: fs.statSync(file).mode & 0o777,
            });
        } else {
            result.set(file, { exists: false });
        }
    }

    return result;
}

function restoreSnapshot(items) {
    for (const [file, prior] of items) {
        if (prior.exists) {
            atomicWrite(file, prior.data, prior.mode);
        } else {
            fs.rmSync(file, { force: true });
        }
    }
}

function createOriginalFileRecord(target, backupDir, existingRecord, index) {
    if (existingRecord) {
        return structuredClone(existingRecord);
    }

    if (!fs.existsSync(target)) {
        return { existed: false };
    }

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

function restoreFileRecord(target, record, warnings, reason) {
    if (!fs.existsSync(target)) {
        return;
    }

    if (sha256(fs.readFileSync(target)) !== record.installedHash) {
        warnings.push(`Preserved modified file during ${reason}: ${target}`);

        return;
    }

    if (record.existed) {
        const backup = path.join(stateDir, record.backup);
        if (!fs.existsSync(backup)) {
            throw new Error(`Missing original backup: ${backup}`);
        }

        atomicWrite(target, fs.readFileSync(backup), record.mode || 0o644);
    } else {
        fs.rmSync(target, { force: true });
    }
}

function makeAgentsBlock() {
    const template = fs.readFileSync(path.join(repoRoot, "templates", "AGENTS.md"), "utf8").trim();

    return `_SpecPi-managed guidance, version ${VERSION}._\n\n${template}`;
}

function finishManagedBlockRemoval(file, result, existedBefore) {
    const isSymlink = lstatMaybe(file)?.isSymbolicLink() || false;
    if (result.trim() || existedBefore || isSymlink) {
        atomicWrite(file, result, existingMode(file, 0o644));
    } else {
        fs.rmSync(file, { force: true });
    }
}

function readManifest(required = false) {
    if (!fs.existsSync(manifestPath)) {
        if (required) {
            throw new Error(`SpecPi is not installed. Run ${CLI} install first.`);
        }

        return undefined;
    }

    const manifest = readJson(manifestPath);
    if (manifest.schema !== 1) {
        throw new Error(`Unsupported manifest schema in ${manifestPath}`);
    }

    return manifest;
}

function acquireLock() {
    return acquireSpecPiLock(agentDir);
}

async function confirm(message, yes) {
    if (yes) {
        return;
    }

    if (!process.stdin.isTTY) {
        throw new Error(`Confirmation requires a TTY; inspect ${CLI} plan, then pass --yes.`);
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`${message} [y/N] `)).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
        throw new Error("Cancelled.");
    }
}

function validateManagedUpdate(manifest, files, force) {
    if (!manifest || force) {
        return;
    }

    for (const [, target] of files) {
        const record = manifest.files?.[target];
        if (!record || !fs.existsSync(target)) {
            continue;
        }

        const currentHash = sha256(fs.readFileSync(target));
        if (currentHash !== record.installedHash) {
            throw new Error(`Managed file was modified after installation: ${target}\nUse --force to replace it.`);
        }
    }
}

function restoreSettingChanges(settings, changes, warnings) {
    for (const change of changes) {
        const current = readPath(settings, change.path);
        if (Array.isArray(change.managedArrayEntries)) {
            if (!current.exists || !Array.isArray(current.value)) {
                warnings.push(`Preserved modified setting: ${change.path.join(".")}`);
                continue;
            }

            if (change.beforeExists && !Array.isArray(change.before)) {
                if (change.installedExists && deepEqual(current.value, change.installed)) {
                    setPath(settings, change.path, structuredClone(change.before));
                } else {
                    warnings.push(
                        `Preserved modified setting instead of restoring non-array value: ${change.path.join(".")}`,
                    );
                }

                continue;
            }

            const originallyPresent = new Set(
                change.beforeExists && Array.isArray(change.before)
                    ? change.managedArrayEntries
                          .filter((entry) => change.before.some((value) => deepEqual(value, entry)))
                          .map((entry) => JSON.stringify(entry))
                    : [],
            );
            const restored = current.value.filter((value) => {
                const managed = change.managedArrayEntries.some((entry) => deepEqual(value, entry));

                return !managed || originallyPresent.has(JSON.stringify(value));
            });
            if (!change.beforeExists && restored.length === 0) {
                deletePath(settings, change.path);
            } else {
                setPath(settings, change.path, restored);
            }

            continue;
        }

        const matchesInstalled = change.dynamicPolicy
            ? current.exists && validManagedModelScope(current.value)
            : change.installedExists
              ? current.exists && deepEqual(current.value, change.installed)
              : !current.exists;
        if (!matchesInstalled) {
            warnings.push(`Preserved modified setting: ${change.path.join(".")}`);
            continue;
        }

        if (change.beforeExists) {
            setPath(settings, change.path, change.before);
        } else {
            deletePath(settings, change.path);
        }
    }
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
            await doctor();
            break;
        case "uninstall":
            await uninstall(options);
            break;
        default:
            throw new Error(`Unknown command: ${options.command}`);
    }
}

main().catch((error) => {
    console.error("SpecPi: " + error.message);
    process.exitCode = 1;
});
