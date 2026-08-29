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
    if (!isRecord(current) || !Object.hasOwn(current, part)) return { exists: false };
    current = current[part];
  }
  return { exists: true, value: current };
}

function setPath(value, parts, next) {
  let current = value;
  for (const part of parts.slice(0, -1)) {
    if (!isRecord(current[part])) current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = clone(next);
}

function readJsonFile(file, fallback = {}) {
  if (!fs.existsSync(file)) return clone(fallback);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error(`ZenPi refuses a symlinked configuration target: ${file}`);
  if (!stat.isFile()) throw new Error(`ZenPi configuration target is not a file: ${file}`);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error(`Expected a JSON object in ${file}.`);
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
    try { return fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  })();
  if (current?.isSymbolicLink()) throw new Error(`ZenPi refuses a symlinked configuration target: ${file}`);
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
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
  };
}

function assertSafeParentComponents(file, agentDir) {
  const root = path.resolve(agentDir);
  const target = path.resolve(file);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`ZenPi configuration path escapes the agent directory: ${file}`);
  let current = path.dirname(target);
  while (current !== root) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`ZenPi refuses a symlinked configuration parent: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function assertNotSymlink(file, label) {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`ZenPi refuses a symlinked ${label}: ${file}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function assertSafeConfigurationPaths(paths) {
  for (const file of [paths.settingsPath, paths.configPath, paths.lockPath, paths.backupDir]) {
    assertSafeParentComponents(file, paths.agentDir);
  }
  assertNotSymlink(paths.settingsPath, "configuration target");
  assertNotSymlink(paths.configPath, "configuration target");
  assertNotSymlink(paths.lockPath, "lock target");
  assertNotSymlink(paths.backupDir, "backup directory");
}

function processState(pid) {
  try {
    process.kill(pid, 0);
    return "active";
  } catch (error) {
    if (error?.code === "ESRCH") return "absent";
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
    if (error.code !== "EEXIST") throw error;
    const raw = fs.readFileSync(lockPath, "utf8").trim();
    let pid;
    let existingToken;
    if (/^[1-9]\d*$/.test(raw)) {
      pid = Number(raw);
      existingToken = raw;
    } else {
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw new Error(`ZenPi lock is malformed and was not reclaimed: ${lockPath}`); }
      if (!isRecord(parsed) || !Number.isInteger(parsed.pid) || parsed.pid <= 0 || typeof parsed.token !== "string" || !parsed.token) {
        throw new Error(`ZenPi lock is malformed and was not reclaimed: ${lockPath}`);
      }
      pid = parsed.pid;
      existingToken = parsed.token;
    }
    if (processState(pid) === "active") throw new Error(`Another ZenPi operation appears active: ${lockPath}`);
    const verify = fs.readFileSync(lockPath, "utf8").trim();
    if (verify !== raw) throw new Error(`ZenPi lock changed during recovery and was not reclaimed: ${lockPath}`);
    fs.rmSync(lockPath);
    fd = fs.openSync(lockPath, "wx", 0o600);
    void existingToken;
  }
  fs.writeFileSync(fd, payload);
  fs.closeSync(fd);
  return () => {
    try {
      const current = fs.readFileSync(lockPath, "utf8");
      if (current === payload) fs.rmSync(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
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
  if (!isRecord(scope) || scope.enforce !== true || scope.strict !== true || !Array.isArray(scope.allow) || scope.allow.length === 0) return false;
  const safePattern = `${provider}/`;
  return scope.allow.every((entry) => entry === "inherit" || (typeof entry === "string" && entry.startsWith(safePattern) && !entry.slice(safePattern.length).includes("/../")));
}

export function splitModelRef(value) {
  if (value === "inherit") return { inherit: true };
  if (typeof value !== "string") return undefined;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

export function validateRoleModel(value, provider) {
  const parsed = splitModelRef(value);
  if (!parsed) throw new Error(`Invalid model reference: ${String(value)}`);
  if (!parsed.inherit && parsed.provider !== provider) {
    throw new Error(`Role model '${value}' is outside the active provider '${provider}'.`);
  }
  return value;
}

export function validateThinking(value) {
  if (!THINKING_LEVELS.includes(value)) throw new Error(`Unsupported thinking level: ${String(value)}`);
  return value;
}

export function validateCapacity(name, value) {
  const bounds = CAPACITY_BOUNDS[name];
  if (!bounds) throw new Error(`Unsupported capacity setting: ${name}`);
  if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(`${name} must be an integer from ${bounds.min} through ${bounds.max}.`);
  }
  return value;
}

export function modelChoices(models, provider) {
  const seen = new Set();
  const result = [];
  for (const model of models || []) {
    if (!model || model.provider !== provider || typeof model.id !== "string") continue;
    const value = `${model.provider}/${model.id}`;
    if (seen.has(value)) continue;
    seen.add(value);
    result.push({ value, label: model.name && model.name !== model.id ? `${model.id} — ${model.name}` : model.id, model });
  }
  return result.sort((a, b) => a.label.localeCompare(b.label));
}

export function supportedThinkingLevels(model, ceiling = "high") {
  if (!model?.reasoning) return ["off"];
  const ceilingIndex = THINKING_LEVELS.indexOf(ceiling);
  const maxIndex = ceilingIndex < 0 ? THINKING_LEVELS.length - 1 : ceilingIndex;
  return THINKING_LEVELS.filter((level, index) => {
    if (index > maxIndex) return false;
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
  for (const name of Object.keys(CAPACITY_DEFAULTS)) capacity[name] = clone(config[name]);
  return {
    modelScope: clone(readPath(settings, ["subagents", "modelScope"]).value),
    defaultThinking: clone(readPath(settings, ["subagents", "defaultThinking"]).value),
    roles,
    capacity,
  };
}

function pruneBackups(directory, keep = 5) {
  const files = fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  for (const name of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(directory, name), { force: true });
}

function writeLeafBackup(paths, before, after, reason) {
  fs.mkdirSync(paths.backupDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const file = path.join(paths.backupDir, `${stamp}-${process.pid}.json`);
  writeJson(file, { schema: 1, createdAt: new Date().toISOString(), reason, before, after }, 0o600);
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
      if (beforeBytes.settings === undefined) fs.rmSync(paths.settingsPath, { force: true });
      else atomicWrite(paths.settingsPath, beforeBytes.settings, modes.settings);
      if (beforeBytes.config === undefined) fs.rmSync(paths.configPath, { force: true });
      else atomicWrite(paths.configPath, beforeBytes.config, modes.config);
    } catch (rollbackError) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
    throw error;
  }
}

export function applySubagentConfiguration({ agentDir, provider, roles, capacity, reset = false, reason = "configure" }) {
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
      const next = reset ? fallback : (capacity && Object.hasOwn(capacity, name) ? capacity[name] : state.capacity[name]);
      config[name] = validateCapacity(name, next);
    }
    const after = controlledSnapshot(settings, config);
    if (JSON.stringify(before) === JSON.stringify(after)) return { changed: false, backup: undefined, before, after };
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
    if (JSON.stringify(current) === JSON.stringify(next)) return false;
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
    if (value === "inherit") continue;
    const parsed = splitModelRef(value);
    if (!parsed || parsed.provider !== provider || (available && !available.has(value))) stale.push({ role, model: value || "invalid" });
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
  for (const role of SUPPORTED_ROLES) lines.push(`  ${role}: ${state.roles[role].model} · ${state.roles[role].thinking}`);
  const stale = provider ? staleRoleModels(state.roles, provider, availableValues) : [];
  if (stale.length) lines.push(`Reconfigure stale roles: ${stale.map((item) => `${item.role} (${item.model})`).join(", ")}`);
  return lines.join("\n");
}
