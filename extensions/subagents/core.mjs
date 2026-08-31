import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const ROLE_DEFAULTS = Object.freeze({
    scout: Object.freeze({ model: "inherit", thinking: "low" }),
    researcher: Object.freeze({ model: "inherit", thinking: "medium" }),
    worker: Object.freeze({ model: "inherit", thinking: "medium" }),
    reviewer: Object.freeze({ model: "inherit", thinking: "high" }),
    oracle: Object.freeze({ model: "inherit", thinking: "high" }),
});

export const CAPACITY_DEFAULTS = Object.freeze({
    maxSubagentSpawnsPerRun: 8,
    maxSubagentSpawnsPerSession: 24,
    maxActiveAsyncRunsPerSession: 2,
});

export const THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high"]);
export const SUPPORTED_ROLES = Object.freeze(Object.keys(ROLE_DEFAULTS));

const MODEL_REF_MAX_LENGTH = 1024;
const LEAF_BACKUP_MAX_BYTES = 256 * 1024;

const CAPACITY_BOUNDS = Object.freeze({
    maxSubagentSpawnsPerRun: Object.freeze({ min: 1, max: 1000 }),
    maxSubagentSpawnsPerSession: Object.freeze({ min: 0, max: 10000 }),
    maxActiveAsyncRunsPerSession: Object.freeze({ min: 0, max: 64 }),
});

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPath(value, parts) {
    let current = value;
    for (const part of parts) {
        if (!isRecord(current) || !Object.hasOwn(current, part)) {
            return { exists: false };
        }

        current = current[part];
    }

    return { exists: true, value: current };
}

function setPath(value, parts, next) {
    let current = value;
    for (const part of parts.slice(0, -1)) {
        if (!isRecord(current[part])) {
            current[part] = {};
        }

        current = current[part];
    }

    current[parts.at(-1)] = clone(next);
}

function readJsonFile(file, fallback = {}) {
    if (!fs.existsSync(file)) {
        return clone(fallback);
    }

    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
        throw new Error(`ZenPi refuses a symlinked configuration target: ${file}`);
    }

    if (!stat.isFile()) {
        throw new Error(`ZenPi configuration target is not a file: ${file}`);
    }

    let value;
    try {
        value = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
        throw new Error(`Cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!isRecord(value)) {
        throw new Error(`Expected a JSON object in ${file}.`);
    }

    return value;
}

function existingMode(file, fallback = 0o600) {
    try {
        return fs.statSync(file).mode & 0o777;
    } catch {
        return fallback;
    }
}

function atomicWrite(file, data, mode = 0o600) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const current = (() => {
        try {
            return fs.lstatSync(file);
        } catch (error) {
            if (error.code === "ENOENT") {
                return undefined;
            }

            throw error;
        }
    })();
    if (current?.isSymbolicLink()) {
        throw new Error(`ZenPi refuses a symlinked configuration target: ${file}`);
    }

    const temp = path.join(
        path.dirname(file),
        `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
        fs.writeFileSync(temp, data, { mode, flag: "wx" });
        fs.chmodSync(temp, mode);
        fs.renameSync(temp, file);
    } finally {
        fs.rmSync(temp, { force: true });
    }
}

function writeJson(file, value, mode = 0o600) {
    atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function resolveAgentDir(explicit) {
    return path.resolve(explicit || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
}

export function configurationPaths(agentDir) {
    const root = resolveAgentDir(agentDir);

    return {
        agentDir: root,
        settingsPath: path.join(root, "settings.json"),
        configPath: path.join(root, "extensions", "subagent", "config.json"),
        stateDir: path.join(root, "zenpi"),
        lockPath: path.join(root, "zenpi", "install.lock"),
        backupDir: path.join(root, "zenpi", "subagent-backups"),
        profilePath: path.join(root, "zenpi", "subagent-provider-profiles.json"),
        leasePath: path.join(root, "zenpi", "subagent-provider-leases.json"),
    };
}

function assertSafeParentComponents(file, agentDir) {
    const root = path.resolve(agentDir);
    const target = path.resolve(file);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`ZenPi configuration path escapes the agent directory: ${file}`);
    }

    let current = path.dirname(target);
    while (current !== root) {
        try {
            if (fs.lstatSync(current).isSymbolicLink()) {
                throw new Error(`ZenPi refuses a symlinked configuration parent: ${current}`);
            }
        } catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
        }

        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }

        current = parent;
    }
}

function assertNotSymlink(file, label) {
    try {
        if (fs.lstatSync(file).isSymbolicLink()) {
            throw new Error(`ZenPi refuses a symlinked ${label}: ${file}`);
        }
    } catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }
    }
}

function assertSafeConfigurationPaths(paths) {
    for (const file of [
        paths.settingsPath,
        paths.configPath,
        paths.lockPath,
        paths.backupDir,
        paths.profilePath,
        paths.leasePath,
    ]) {
        assertSafeParentComponents(file, paths.agentDir);
    }

    assertNotSymlink(paths.settingsPath, "configuration target");
    assertNotSymlink(paths.configPath, "configuration target");
    assertNotSymlink(paths.lockPath, "lock target");
    assertNotSymlink(paths.backupDir, "backup directory");
    assertNotSymlink(paths.profilePath, "provider profile target");
    assertNotSymlink(paths.leasePath, "provider lease target");
}

function processState(pid) {
    try {
        process.kill(pid, 0);

        return "active";
    } catch (error) {
        if (error?.code === "ESRCH") {
            return "absent";
        }

        throw error;
    }
}

export function acquireZenPiLock(agentDir) {
    const paths = configurationPaths(agentDir);
    assertSafeParentComponents(paths.lockPath, paths.agentDir);
    assertNotSymlink(paths.lockPath, "lock target");
    const { stateDir, lockPath } = paths;
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const token = `${process.pid}:${randomBytes(12).toString("hex")}`;
    const payload = `${JSON.stringify({ pid: process.pid, token })}\n`;
    let fd;
    try {
        fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
        if (error.code !== "EEXIST") {
            throw error;
        }

        const raw = fs.readFileSync(lockPath, "utf8").trim();
        let pid;
        let existingToken;
        if (/^[1-9]\d*$/.test(raw)) {
            pid = Number(raw);
            existingToken = raw;
        } else {
            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch {
                throw new Error(`ZenPi lock is malformed and was not reclaimed: ${lockPath}`);
            }

            if (
                !isRecord(parsed) ||
                !Number.isInteger(parsed.pid) ||
                parsed.pid <= 0 ||
                typeof parsed.token !== "string" ||
                !parsed.token
            ) {
                throw new Error(`ZenPi lock is malformed and was not reclaimed: ${lockPath}`);
            }

            pid = parsed.pid;
            existingToken = parsed.token;
        }

        if (processState(pid) === "active") {
            throw new Error(`Another ZenPi operation appears active: ${lockPath}`);
        }

        const verify = fs.readFileSync(lockPath, "utf8").trim();
        if (verify !== raw) {
            throw new Error(`ZenPi lock changed during recovery and was not reclaimed: ${lockPath}`);
        }

        fs.rmSync(lockPath);
        fd = fs.openSync(lockPath, "wx", 0o600);
        void existingToken;
    }

    fs.writeFileSync(fd, payload);
    fs.closeSync(fd);

    return () => {
        try {
            const current = fs.readFileSync(lockPath, "utf8");
            if (current === payload) {
                fs.rmSync(lockPath);
            }
        } catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
        }
    };
}

export function providerScope(provider) {
    if (typeof provider !== "string" || !provider.trim() || provider.includes("*")) {
        throw new Error("An active provider is required to configure same-provider subagents.");
    }

    return { enforce: true, strict: true, allow: [`${provider}/*`] };
}

export function isSafeProviderScope(scope, provider) {
    if (
        !isRecord(scope) ||
        scope.enforce !== true ||
        scope.strict !== true ||
        !Array.isArray(scope.allow) ||
        scope.allow.length === 0
    ) {
        return false;
    }

    const safePattern = `${provider}/`;

    return scope.allow.every(
        (entry) =>
            entry === "inherit" ||
            (typeof entry === "string" &&
                entry.startsWith(safePattern) &&
                !entry.slice(safePattern.length).includes("/../")),
    );
}

export function splitModelRef(value) {
    if (value === "inherit") {
        return { inherit: true };
    }

    if (typeof value !== "string") {
        return undefined;
    }

    const slash = value.indexOf("/");
    if (slash <= 0 || slash === value.length - 1) {
        return undefined;
    }

    return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

export function validateRoleModel(value, provider) {
    if (typeof value !== "string" || value.length > MODEL_REF_MAX_LENGTH) {
        throw new Error(`Model references must be strings no longer than ${MODEL_REF_MAX_LENGTH} characters.`);
    }

    const parsed = splitModelRef(value);
    if (!parsed) {
        throw new Error(`Invalid model reference: ${String(value)}`);
    }

    if (!parsed.inherit && parsed.provider !== provider) {
        throw new Error(`Role model '${value}' is outside the active provider '${provider}'.`);
    }

    return value;
}

export function validateThinking(value) {
    if (!THINKING_LEVELS.includes(value)) {
        throw new Error(`Unsupported thinking level: ${String(value)}`);
    }

    return value;
}

export function validateCapacity(name, value) {
    const bounds = CAPACITY_BOUNDS[name];
    if (!bounds) {
        throw new Error(`Unsupported capacity setting: ${name}`);
    }

    if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
        throw new Error(`${name} must be an integer from ${bounds.min} through ${bounds.max}.`);
    }

    return value;
}

export function modelChoices(models, provider) {
    const seen = new Set();
    const result = [];
    for (const model of models || []) {
        if (!model || model.provider !== provider || typeof model.id !== "string") {
            continue;
        }

        const value = `${model.provider}/${model.id}`;
        if (seen.has(value)) {
            continue;
        }

        seen.add(value);
        result.push({
            value,
            label: model.name && model.name !== model.id ? `${model.id} — ${model.name}` : model.id,
            model,
        });
    }

    return result.sort((a, b) => a.label.localeCompare(b.label));
}

export function supportedThinkingLevels(model, ceiling = "high") {
    if (!model?.reasoning) {
        return ["off"];
    }

    const ceilingIndex = THINKING_LEVELS.indexOf(ceiling);
    const maxIndex = ceilingIndex < 0 ? THINKING_LEVELS.length - 1 : ceilingIndex;

    return THINKING_LEVELS.filter((level, index) => {
        if (index > maxIndex) {
            return false;
        }

        const mapped = model.thinkingLevelMap?.[level];

        return mapped !== null;
    });
}

export function readSubagentState(agentDir) {
    const paths = configurationPaths(agentDir);
    const settings = readJsonFile(paths.settingsPath, {});
    const config = readJsonFile(paths.configPath, {});
    const roles = {};
    for (const role of SUPPORTED_ROLES) {
        const override = readPath(settings, ["subagents", "agentOverrides", role]);
        const value = isRecord(override.value) ? override.value : {};
        roles[role] = {
            model: typeof value.model === "string" ? value.model : ROLE_DEFAULTS[role].model,
            thinking: typeof value.thinking === "string" ? value.thinking : ROLE_DEFAULTS[role].thinking,
        };
    }

    const capacity = {};
    for (const [name, fallback] of Object.entries(CAPACITY_DEFAULTS)) {
        capacity[name] = Number.isSafeInteger(config[name]) ? config[name] : fallback;
    }

    return {
        paths,
        settings,
        config,
        roles,
        capacity,
        modelScope: readPath(settings, ["subagents", "modelScope"]).value,
    };
}

function controlledSnapshot(settings, config) {
    const roles = {};
    for (const role of SUPPORTED_ROLES) {
        roles[role] = {
            model: clone(readPath(settings, ["subagents", "agentOverrides", role, "model"]).value),
            thinking: clone(readPath(settings, ["subagents", "agentOverrides", role, "thinking"]).value),
        };
    }

    const capacity = {};
    for (const name of Object.keys(CAPACITY_DEFAULTS)) {
        capacity[name] = clone(config[name]);
    }

    return {
        modelScope: clone(readPath(settings, ["subagents", "modelScope"]).value),
        defaultThinking: clone(readPath(settings, ["subagents", "defaultThinking"]).value),
        roles,
        capacity,
    };
}

function pruneBackups(directory, keep = 5) {
    const files = fs
        .readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .sort();
    for (const name of files.slice(0, Math.max(0, files.length - keep))) {
        fs.rmSync(path.join(directory, name), { force: true });
    }
}

function writeLeafBackup(paths, before, after, reason) {
    const value = { schema: 1, createdAt: new Date().toISOString(), reason, before, after };
    const bytes = Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`);
    if (bytes > LEAF_BACKUP_MAX_BYTES) {
        throw new Error(`Subagent leaf backup exceeds its ${LEAF_BACKUP_MAX_BYTES}-byte limit.`);
    }

    fs.mkdirSync(paths.backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const file = path.join(paths.backupDir, `${stamp}-${process.pid}.json`);
    writeJson(file, value, 0o600);
    pruneBackups(paths.backupDir);

    return file;
}

function writeConfigurationTransaction(paths, settings, config, beforeBytes, modes) {
    try {
        writeJson(paths.settingsPath, settings, modes.settings);
        writeJson(paths.configPath, config, modes.config);
        readJsonFile(paths.settingsPath);
        readJsonFile(paths.configPath);
    } catch (error) {
        try {
            if (beforeBytes.settings === undefined) {
                fs.rmSync(paths.settingsPath, { force: true });
            } else {
                atomicWrite(paths.settingsPath, beforeBytes.settings, modes.settings);
            }

            if (beforeBytes.config === undefined) {
                fs.rmSync(paths.configPath, { force: true });
            } else {
                atomicWrite(paths.configPath, beforeBytes.config, modes.config);
            }
        } catch (rollbackError) {
            throw new Error(
                `${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            );
        }

        throw error;
    }
}

export function applySubagentConfiguration({
    agentDir,
    provider,
    roles,
    capacity,
    reset = false,
    reason = "configure",
}) {
    const paths = configurationPaths(agentDir);
    assertSafeConfigurationPaths(paths);
    const release = acquireZenPiLock(agentDir);
    try {
        const state = readSubagentState(agentDir);
        const { paths, settings, config } = state;
        const beforeBytes = {
            settings: fs.existsSync(paths.settingsPath) ? fs.readFileSync(paths.settingsPath) : undefined,
            config: fs.existsSync(paths.configPath) ? fs.readFileSync(paths.configPath) : undefined,
        };
        const modes = {
            settings: existingMode(paths.settingsPath, 0o600),
            config: existingMode(paths.configPath, 0o600),
        };
        const before = controlledSnapshot(settings, config);
        setPath(settings, ["subagents", "modelScope"], providerScope(provider));
        for (const role of SUPPORTED_ROLES) {
            const next = reset ? ROLE_DEFAULTS[role] : { ...state.roles[role], ...(roles?.[role] || {}) };
            setPath(settings, ["subagents", "agentOverrides", role, "model"], validateRoleModel(next.model, provider));
            setPath(settings, ["subagents", "agentOverrides", role, "thinking"], validateThinking(next.thinking));
        }

        for (const [name, fallback] of Object.entries(CAPACITY_DEFAULTS)) {
            const next = reset
                ? fallback
                : capacity && Object.hasOwn(capacity, name)
                  ? capacity[name]
                  : state.capacity[name];
            config[name] = validateCapacity(name, next);
        }

        const after = controlledSnapshot(settings, config);
        if (JSON.stringify(before) === JSON.stringify(after)) {
            return { changed: false, backup: undefined, before, after };
        }

        const backup = writeLeafBackup(paths, before, after, reason);
        writeConfigurationTransaction(paths, settings, config, beforeBytes, modes);

        return { changed: true, backup, before, after };
    } finally {
        release();
    }
}

export function syncProviderScope(agentDir, provider) {
    const paths = configurationPaths(agentDir);
    assertSafeConfigurationPaths(paths);
    const release = acquireZenPiLock(agentDir);
    try {
        const settings = readJsonFile(paths.settingsPath, {});
        const next = providerScope(provider);
        const current = readPath(settings, ["subagents", "modelScope"]).value;
        if (JSON.stringify(current) === JSON.stringify(next)) {
            return false;
        }

        const before = controlledSnapshot(settings, {});
        setPath(settings, ["subagents", "modelScope"], next);
        const after = controlledSnapshot(settings, {});
        writeLeafBackup(paths, before, after, "provider-sync");
        writeJson(paths.settingsPath, settings, existingMode(paths.settingsPath, 0o600));

        return true;
    } finally {
        release();
    }
}

export function staleRoleModels(roles, provider, availableValues = undefined) {
    const available = availableValues ? new Set(availableValues) : undefined;
    const stale = [];
    for (const role of SUPPORTED_ROLES) {
        const value = roles?.[role]?.model;
        if (value === "inherit") {
            continue;
        }

        const parsed = splitModelRef(value);
        if (!parsed || parsed.provider !== provider || (available && !available.has(value))) {
            stale.push({ role, model: value || "invalid" });
        }
    }

    return stale;
}

export function formatSubagentStatus(state, provider, availableValues = undefined) {
    const lines = [
        `Provider: ${provider || "unavailable"}`,
        `Model scope: ${provider && isSafeProviderScope(state.modelScope, provider) ? `${provider}/* (strict)` : "needs synchronization"}`,
        `Run child budget: ${state.capacity.maxSubagentSpawnsPerRun}`,
        `Session child budget: ${state.capacity.maxSubagentSpawnsPerSession}`,
        `Active top-level async runs: ${state.capacity.maxActiveAsyncRunsPerSession}`,
        "Roles:",
    ];
    for (const role of SUPPORTED_ROLES) {
        lines.push(`  ${role}: ${state.roles[role].model} · ${state.roles[role].thinking}`);
    }

    const stale = provider ? staleRoleModels(state.roles, provider, availableValues) : [];
    if (stale.length) {
        lines.push(`Reconfigure stale roles: ${stale.map((item) => `${item.role} (${item.model})`).join(", ")}`);
    }

    return lines.join("\n");
}

const PROFILE_SCHEMA = 1;
const PROFILE_MAX_BYTES = 256 * 1024;
const LEASE_MAX_BYTES = 64 * 1024;
const MAX_PROVIDERS = 64;

function exactKeys(value, allowed, label) {
    const keys = Object.keys(value);
    const unexpected = keys.filter((key) => !allowed.includes(key));
    if (unexpected.length) {
        throw new Error(`${label} contains unsupported keys: ${unexpected.join(", ")}`);
    }
}

function validateProviderId(provider) {
    if (
        typeof provider !== "string" ||
        provider !== provider.trim() ||
        !provider ||
        provider.length > 128 ||
        provider.includes("/") ||
        provider.includes("*") ||
        /[\x00-\x1f\x7f]/.test(provider)
    ) {
        throw new Error(`Invalid exact provider ID: ${String(provider)}`);
    }

    return provider;
}

function canonicalTimestamp(value, label) {
    if (
        typeof value !== "string" ||
        value.length > 40 ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString() !== value
    ) {
        throw new Error(`${label} must be a canonical ISO timestamp.`);
    }

    return value;
}

export function validateProviderProfiles(value) {
    if (!isRecord(value)) {
        throw new Error("Provider profile state must be an object.");
    }

    exactKeys(value, ["schema", "providers"], "Provider profile state");
    if (value.schema !== PROFILE_SCHEMA || !isRecord(value.providers)) {
        throw new Error("Unsupported provider profile schema.");
    }

    const entries = Object.entries(value.providers);
    if (entries.length > MAX_PROVIDERS) {
        throw new Error(`Provider profiles are limited to ${MAX_PROVIDERS} providers.`);
    }

    const providers = Object.create(null);
    for (const [provider, record] of entries) {
        validateProviderId(provider);
        if (!isRecord(record)) {
            throw new Error(`Profile '${provider}' must be an object.`);
        }

        exactKeys(record, ["updatedAt", "origin", "roles"], `Profile '${provider}'`);
        canonicalTimestamp(record.updatedAt, `Profile '${provider}' updatedAt`);
        if (!["default", "configured", "migrated", "reset"].includes(record.origin)) {
            throw new Error(`Profile '${provider}' has an invalid origin.`);
        }

        if (!isRecord(record.roles)) {
            throw new Error(`Profile '${provider}' roles must be an object.`);
        }

        exactKeys(record.roles, SUPPORTED_ROLES, `Profile '${provider}' roles`);
        if (Object.keys(record.roles).length !== SUPPORTED_ROLES.length) {
            throw new Error(`Profile '${provider}' must contain every supported role.`);
        }

        const roles = Object.create(null);
        for (const role of SUPPORTED_ROLES) {
            const fields = record.roles[role];
            if (!isRecord(fields)) {
                throw new Error(`Profile '${provider}' role '${role}' must be an object.`);
            }

            exactKeys(fields, ["model", "thinking"], `Profile '${provider}' role '${role}'`);
            if (Object.keys(fields).length !== 2) {
                throw new Error(`Profile '${provider}' role '${role}' must contain model and thinking.`);
            }

            roles[role] = {
                model: validateRoleModel(fields.model, provider),
                thinking: validateThinking(fields.thinking),
            };
        }

        Object.defineProperty(providers, provider, {
            value: { updatedAt: record.updatedAt, origin: record.origin, roles },
            enumerable: true,
            writable: true,
            configurable: true,
        });
    }

    const canonical = { schema: PROFILE_SCHEMA, providers };
    const bytes = Buffer.byteLength(`${JSON.stringify(canonical, null, 2)}\n`);
    if (bytes > PROFILE_MAX_BYTES) {
        throw new Error(`Provider profile state exceeds its ${PROFILE_MAX_BYTES}-byte limit.`);
    }

    return canonical;
}

function boundedRawBytes(file, maxBytes, fallback = undefined) {
    let stat;
    try {
        stat = fs.lstatSync(file);
    } catch (error) {
        if (error.code === "ENOENT") {
            return clone(fallback);
        }

        throw error;
    }

    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`ZenPi refuses an unsafe state target: ${file}`);
    }

    if (stat.size > maxBytes) {
        throw new Error(`ZenPi state file exceeds its ${maxBytes}-byte limit: ${file}`);
    }

    return fs.readFileSync(file);
}

function boundedJson(file, maxBytes, fallback) {
    const bytes = boundedRawBytes(file, maxBytes);
    if (bytes === undefined) {
        return clone(fallback);
    }

    try {
        return JSON.parse(bytes.toString("utf8"));
    } catch (error) {
        throw new Error(`Cannot parse ${file}: ${error.message}`);
    }
}

export function readProviderProfiles(agentDir) {
    const paths = configurationPaths(agentDir);
    assertSafeParentComponents(paths.profilePath, paths.agentDir);
    assertNotSymlink(paths.profilePath, "provider profile target");

    return validateProviderProfiles(
        boundedJson(paths.profilePath, PROFILE_MAX_BYTES, { schema: PROFILE_SCHEMA, providers: {} }),
    );
}

export function profileForProvider(profiles, provider) {
    validateProviderId(provider);

    return profiles?.providers && Object.hasOwn(profiles.providers, provider)
        ? clone(profiles.providers[provider])
        : undefined;
}

function defaultRoles() {
    return clone(ROLE_DEFAULTS);
}

function makeProfile(roles, provider, origin = "configured", now = new Date().toISOString()) {
    const record = { updatedAt: now, origin, roles: {} };
    for (const role of SUPPORTED_ROLES) {
        record.roles[role] = {
            model: validateRoleModel(roles[role].model, provider),
            thinking: validateThinking(roles[role].thinking),
        };
    }

    return record;
}

function legacyRoles(state) {
    const roles = {};
    const providers = new Set();
    for (const role of SUPPORTED_ROLES) {
        const modelLeaf = readPath(state.settings, ["subagents", "agentOverrides", role, "model"]);
        const thinkingLeaf = readPath(state.settings, ["subagents", "agentOverrides", role, "thinking"]);
        const fields = {
            model: modelLeaf.exists ? modelLeaf.value : ROLE_DEFAULTS[role].model,
            thinking: thinkingLeaf.exists ? thinkingLeaf.value : ROLE_DEFAULTS[role].thinking,
        };
        if (typeof fields.thinking !== "string") {
            return { diagnostic: `Legacy role '${role}' has a non-string thinking level.` };
        }

        try {
            validateThinking(fields.thinking);
        } catch {
            return { diagnostic: `Legacy role '${role}' has an unsupported thinking level.` };
        }

        if (typeof fields.model !== "string") {
            return { diagnostic: `Legacy role '${role}' has a non-string model reference.` };
        }

        const parsed = splitModelRef(fields.model);
        if (!parsed || fields.model.length > MODEL_REF_MAX_LENGTH) {
            return { diagnostic: `Legacy role '${role}' has a non-canonical model reference.` };
        }

        if (!parsed.inherit) {
            providers.add(parsed.provider);
        }

        roles[role] = clone(fields);
    }

    if (providers.size > 1) {
        return {
            diagnostic: "Legacy builtin roles contain mixed providers; run /zen-subagents to repair them explicitly.",
        };
    }

    return { roles, inferredProvider: [...providers][0] };
}

export function migrateLegacyProfile(state, activeProvider) {
    validateProviderId(activeProvider);
    const legacy = legacyRoles(state);
    if (legacy.diagnostic) {
        return { state: "migration-needed", diagnostic: legacy.diagnostic };
    }

    const inferred = legacy.inferredProvider || activeProvider;
    for (const role of SUPPORTED_ROLES) {
        try {
            validateRoleModel(legacy.roles[role].model, inferred);
        } catch (error) {
            return { state: "migration-needed", diagnostic: error.message };
        }
    }

    const providers = Object.create(null);
    Object.defineProperty(providers, inferred, {
        value: makeProfile(legacy.roles, inferred, "migrated"),
        enumerable: true,
        writable: true,
    });
    if (inferred !== activeProvider) {
        Object.defineProperty(providers, activeProvider, {
            value: makeProfile(defaultRoles(), activeProvider, "default"),
            enumerable: true,
            writable: true,
        });
    }

    return { state: "migrated", profiles: { schema: PROFILE_SCHEMA, providers }, inferredProvider: inferred };
}

function readLeaseState(paths) {
    const value = boundedJson(paths.leasePath, LEASE_MAX_BYTES, { schema: 1, leases: [] });
    if (!isRecord(value)) {
        throw new Error("Provider lease state must be an object.");
    }

    exactKeys(value, ["schema", "leases"], "Provider lease state");
    if (value.schema !== 1 || !Array.isArray(value.leases) || value.leases.length > 128) {
        throw new Error("Malformed provider lease state.");
    }

    const seen = new Set();
    for (const lease of value.leases) {
        if (!isRecord(lease)) {
            throw new Error("Malformed provider lease record.");
        }

        exactKeys(lease, ["token", "pid", "provider", "updatedAt"], "Provider lease record");
        if (typeof lease.token !== "string" || !/^[a-f0-9]{32,128}$/.test(lease.token) || seen.has(lease.token)) {
            throw new Error("Malformed provider lease token.");
        }

        seen.add(lease.token);
        if (!Number.isSafeInteger(lease.pid) || lease.pid <= 0) {
            throw new Error("Malformed provider lease PID.");
        }

        validateProviderId(lease.provider);
        canonicalTimestamp(lease.updatedAt, "Provider lease updatedAt");
    }

    return value;
}

export function readProviderLeases(agentDir) {
    const paths = configurationPaths(agentDir);
    assertSafeParentComponents(paths.leasePath, paths.agentDir);
    assertNotSymlink(paths.leasePath, "provider lease target");

    return clone(readLeaseState(paths));
}

function liveLeases(leases) {
    const kept = [];
    for (const lease of leases) {
        const state = processState(lease.pid);
        if (state === "active") {
            kept.push(lease);
        }
    }

    return kept;
}

function writeLeases(paths, value) {
    assertSafeParentComponents(paths.leasePath, paths.agentDir);
    assertNotSymlink(paths.leasePath, "provider lease target");
    if (!value.leases.length) {
        fs.rmSync(paths.leasePath, { force: true });
    } else {
        writeJson(paths.leasePath, value, existingMode(paths.leasePath, 0o600));
    }
}

function registerLeaseLocked(paths, { token, pid = process.pid, provider }) {
    validateProviderId(provider);
    if (typeof token !== "string" || !/^[a-f0-9]{32,128}$/.test(token)) {
        throw new Error("Invalid provider lease token.");
    }

    const initialBytes = boundedRawBytes(paths.leasePath, LEASE_MAX_BYTES);
    const state = readLeaseState(paths);
    const leases = liveLeases(state.leases);
    const verifyBytes = boundedRawBytes(paths.leasePath, LEASE_MAX_BYTES);
    if (
        initialBytes === undefined
            ? verifyBytes !== undefined
            : verifyBytes === undefined || !verifyBytes.equals(initialBytes)
    ) {
        throw new Error("Provider lease state changed during recovery.");
    }

    const conflicts = [
        ...new Set(
            leases.filter((item) => item.token !== token && item.provider !== provider).map((item) => item.provider),
        ),
    ];
    if (conflicts.length) {
        const withoutObsoleteToken = leases.filter((item) => item.token !== token);
        if (withoutObsoleteToken.length !== leases.length) {
            writeLeases(paths, { schema: 1, leases: withoutObsoleteToken });
        }

        return { blocked: true, conflictProvider: conflicts[0], changed: false };
    }

    const now = new Date().toISOString();
    const next = leases.filter((item) => item.token !== token);
    next.push({ token, pid, provider, updatedAt: now });
    writeLeases(paths, { schema: 1, leases: next });

    return { blocked: false, changed: true };
}

export function registerOrRefreshProviderLease({ agentDir, token, pid = process.pid, provider }) {
    const paths = configurationPaths(agentDir);
    assertSafeConfigurationPaths(paths);
    const release = acquireZenPiLock(agentDir);
    try {
        return registerLeaseLocked(paths, { token, pid, provider });
    } finally {
        release();
    }
}

export function releaseProviderLease({ agentDir, token }) {
    const paths = configurationPaths(agentDir);
    assertSafeConfigurationPaths(paths);
    const release = acquireZenPiLock(agentDir);
    try {
        const before = boundedRawBytes(paths.leasePath, LEASE_MAX_BYTES);
        if (before === undefined) {
            return false;
        }

        const state = readLeaseState(paths);
        const next = state.leases.filter((item) => item.token !== token);
        if (next.length === state.leases.length) {
            return false;
        }

        const verify = boundedRawBytes(paths.leasePath, LEASE_MAX_BYTES);
        if (verify === undefined || !verify.equals(before)) {
            throw new Error("Provider lease state was substituted during release.");
        }

        writeLeases(paths, { schema: 1, leases: next });

        return true;
    } finally {
        release();
    }
}

function controlledRoles(settings) {
    const roles = {};
    for (const role of SUPPORTED_ROLES) {
        const value = readPath(settings, ["subagents", "agentOverrides", role]).value;
        roles[role] = {
            model: typeof value?.model === "string" ? value.model : ROLE_DEFAULTS[role].model,
            thinking: typeof value?.thinking === "string" ? value.thinking : ROLE_DEFAULTS[role].thinking,
        };
    }

    return roles;
}

function mirrorProfile(settings, profile, provider) {
    setPath(settings, ["subagents", "modelScope"], providerScope(provider));
    for (const role of SUPPORTED_ROLES) {
        setPath(settings, ["subagents", "agentOverrides", role, "model"], profile.roles[role].model);
        setPath(settings, ["subagents", "agentOverrides", role, "thinking"], profile.roles[role].thinking);
    }
}

function runtimeFingerprint(provider, profile, settings) {
    return JSON.stringify({
        provider,
        profile,
        mirror: { modelScope: readPath(settings, ["subagents", "modelScope"]).value, roles: controlledRoles(settings) },
    });
}

function restoreFile(file, bytes, mode) {
    if (bytes === undefined) {
        fs.rmSync(file, { force: true });
    } else {
        atomicWrite(file, bytes, mode);
    }
}

function serializedBytes(value) {
    return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function fileWillChange(item) {
    return item.before === undefined || !serializedBytes(item.value).equals(item.before);
}

function logicalWrite(files) {
    const changed = [];
    try {
        for (const item of files) {
            const next = serializedBytes(item.value);
            if (item.before !== undefined && next.equals(item.before)) {
                continue;
            }

            atomicWrite(item.file, next, item.mode);
            changed.push(item);
            const check = item.maxBytes ? boundedRawBytes(item.file, item.maxBytes) : fs.readFileSync(item.file);
            if (check === undefined || !check.equals(next)) {
                throw new Error(`Verification failed for ${item.file}`);
            }
        }
    } catch (error) {
        try {
            for (const item of changed.reverse()) {
                restoreFile(item.file, item.before, item.mode);
            }
        } catch (rollback) {
            throw new Error(`${error.message}; rollback failed: ${rollback.message}`);
        }

        throw error;
    }

    return changed.length > 0;
}

function loadProfilesForChange(paths, state, provider, repairLegacy = false) {
    const profileBefore = boundedRawBytes(paths.profilePath, PROFILE_MAX_BYTES);
    if (profileBefore !== undefined) {
        return { profiles: readProviderProfiles(paths.agentDir), profileBefore, migrated: false };
    }

    const migration = migrateLegacyProfile(state, provider);
    if (migration.state === "migration-needed") {
        if (!repairLegacy) {
            return migration;
        }

        return {
            profiles: { schema: PROFILE_SCHEMA, providers: Object.create(null) },
            profileBefore,
            migrated: false,
            repaired: true,
        };
    }

    return { profiles: migration.profiles, profileBefore, migrated: true };
}

function activateLocked({ paths, provider, leaseToken, reason = "activation", availableValues }) {
    validateProviderId(provider);
    const state = readSubagentState(paths.agentDir);
    const loaded = loadProfilesForChange(paths, state, provider);
    if (loaded.state === "migration-needed") {
        return { ...loaded, changed: false };
    }

    const profiles = loaded.profiles;
    if (leaseToken) {
        const lease = registerLeaseLocked(paths, { token: leaseToken, provider });
        if (lease.blocked) {
            return { state: "blocked", changed: false, conflictProvider: lease.conflictProvider };
        }
    }

    let profile = profileForProvider(profiles, provider);
    let profileCreated = false;
    if (!profile) {
        if (Object.keys(profiles.providers).length >= MAX_PROVIDERS) {
            throw new Error(`Provider profiles are limited to ${MAX_PROVIDERS} providers.`);
        }

        profile = makeProfile(defaultRoles(), provider, "default");
        profiles.providers[provider] = profile;
        profileCreated = true;
    }

    const settings = clone(state.settings);
    mirrorProfile(settings, profile, provider);
    const files = [
        {
            file: paths.profilePath,
            value: validateProviderProfiles(profiles),
            before: loaded.profileBefore,
            mode: existingMode(paths.profilePath, 0o600),
            maxBytes: PROFILE_MAX_BYTES,
        },
        {
            file: paths.settingsPath,
            value: settings,
            before: fs.existsSync(paths.settingsPath) ? fs.readFileSync(paths.settingsPath) : undefined,
            mode: existingMode(paths.settingsPath, 0o600),
        },
    ];
    const predictedChange = files.some(fileWillChange);
    const backup = predictedChange
        ? writeLeafBackup(
              paths,
              controlledSnapshot(state.settings, state.config),
              controlledSnapshot(settings, state.config),
              `${reason}:${provider}`,
          )
        : undefined;
    const changed = logicalWrite(files);
    const staleRoles = staleProfileRoles(profile, provider, availableValues);

    return {
        state: staleRoles.length ? "stale" : profile.origin === "default" ? "default" : "saved",
        changed,
        backup,
        profileCreated,
        migrated: loaded.migrated,
        mirrorChanged:
            JSON.stringify(controlledRoles(state.settings)) !== JSON.stringify(profile.roles) ||
            !isSafeProviderScope(state.modelScope, provider),
        profile: clone(profile),
        providers: Object.keys(profiles.providers).sort(),
        staleRoles,
        reason,
        fingerprint: runtimeFingerprint(provider, profile, settings),
    };
}

export function activateProviderProfile({ agentDir, provider, leaseToken, reason, availableValues }) {
    const paths = configurationPaths(agentDir);
    assertSafeConfigurationPaths(paths);
    const release = acquireZenPiLock(agentDir);
    try {
        return activateLocked({ paths, provider, leaseToken, reason, availableValues });
    } finally {
        release();
    }
}

export function applyProviderConfiguration({
    agentDir,
    provider,
    roles,
    capacity,
    leaseToken,
    reset = false,
    repairLegacy = false,
    reason = "configure",
}) {
    const paths = configurationPaths(agentDir);
    assertSafeConfigurationPaths(paths);
    const release = acquireZenPiLock(agentDir);
    try {
        validateProviderId(provider);
        const state = readSubagentState(paths.agentDir);
        const loaded = loadProfilesForChange(paths, state, provider, repairLegacy);
        if (loaded.state === "migration-needed") {
            return { ...loaded, changed: false };
        }

        const profiles = loaded.profiles;
        const beforeProfile = profileForProvider(profiles, provider);
        const nextRoles = reset ? defaultRoles() : clone(roles || beforeProfile?.roles || defaultRoles());
        profiles.providers[provider] = makeProfile(nextRoles, provider, reset ? "reset" : "configured");
        const settings = clone(state.settings);
        mirrorProfile(settings, profiles.providers[provider], provider);
        const config = clone(state.config);
        if (!reset && capacity) {
            for (const name of Object.keys(CAPACITY_DEFAULTS)) {
                if (Object.hasOwn(capacity, name)) {
                    config[name] = validateCapacity(name, capacity[name]);
                }
            }
        }

        const configBefore = fs.existsSync(paths.configPath) ? fs.readFileSync(paths.configPath) : undefined;
        const files = [
            {
                file: paths.profilePath,
                value: validateProviderProfiles(profiles),
                before: loaded.profileBefore,
                mode: existingMode(paths.profilePath),
                maxBytes: PROFILE_MAX_BYTES,
            },
            {
                file: paths.settingsPath,
                value: settings,
                before: fs.existsSync(paths.settingsPath) ? fs.readFileSync(paths.settingsPath) : undefined,
                mode: existingMode(paths.settingsPath),
            },
        ];
        if (configBefore !== undefined || (!reset && capacity)) {
            files.push({
                file: paths.configPath,
                value: config,
                before: configBefore,
                mode: existingMode(paths.configPath),
            });
        }

        if (leaseToken) {
            const lease = registerLeaseLocked(paths, { token: leaseToken, provider });
            if (lease.blocked) {
                return { state: "blocked", changed: false, conflictProvider: lease.conflictProvider };
            }
        }

        const changed = files.some(fileWillChange);
        const before = controlledSnapshot(state.settings, state.config);
        const after = controlledSnapshot(settings, config);
        const backup = changed ? writeLeafBackup(paths, before, after, `${reason}:${provider}`) : undefined;
        logicalWrite(files);

        return {
            state: "saved",
            changed,
            backup,
            profile: clone(profiles.providers[provider]),
            providers: Object.keys(profiles.providers).sort(),
            staleRoles: [],
        };
    } finally {
        release();
    }
}

export function staleProfileRoles(profile, provider, availableValues) {
    return staleRoleModels(profile?.roles || {}, provider, availableValues);
}

export function formatProviderSubagentStatus(result, state, provider, availableValues) {
    const stale =
        result?.staleRoles || staleRoleModels(result?.profile?.roles || state.roles, provider, availableValues);
    const lines = [
        `Provider: ${provider}`,
        `Profile: ${result?.state || "migration-needed"}`,
        `Model scope: ${isSafeProviderScope(state.modelScope, provider) ? `${provider}/* (strict)` : "needs synchronization"}`,
        `Saved providers: ${(result?.providers || []).join(", ") || "none"}`,
        "Global capacity:",
        `  Run child budget: ${state.capacity.maxSubagentSpawnsPerRun}`,
        `  Session child budget: ${state.capacity.maxSubagentSpawnsPerSession}`,
        `  Active top-level async runs: ${state.capacity.maxActiveAsyncRunsPerSession}`,
        "Active provider roles:",
    ];
    const roles = result?.profile?.roles || state.roles;
    for (const role of SUPPORTED_ROLES) {
        lines.push(`  ${role}: ${roles[role].model} · ${roles[role].thinking}`);
    }

    if (stale.length) {
        lines.push(`Stale roles: ${stale.map((x) => `${x.role} (${x.model})`).join(", ")}`);
    }

    return lines.join("\n");
}
