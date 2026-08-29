import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CAPACITY_DEFAULTS,
  ROLE_DEFAULTS,
  SUPPORTED_ROLES,
  THINKING_LEVELS,
  activateProviderProfile,
  applyProviderConfiguration,
  formatProviderSubagentStatus,
  isSafeProviderScope,
  modelChoices,
  readSubagentState,
  staleRoleModels,
  supportedThinkingLevels,
  releaseProviderLease,
} from "./core.mjs";

const CAPACITY_LABELS: Record<string, string> = {
  maxSubagentSpawnsPerRun: "Run child budget (cumulative)",
  maxSubagentSpawnsPerSession: "Session child budget (cumulative; 0 = unlimited)",
  maxActiveAsyncRunsPerSession: "Active top-level async runs (0 = unlimited)",
};

function activeProvider(ctx: ExtensionContext): string | undefined {
  return ctx.model?.provider;
}

async function availableModels(ctx: ExtensionContext): Promise<any[]> {
  if (ctx.scopedModels.length > 0) return ctx.scopedModels.map((entry) => entry.model);
  return [...await ctx.modelRegistry.getAvailable()];
}

function isDirectory(directory: string): boolean {
  try { return fs.statSync(directory).isDirectory(); } catch { return false; }
}

function projectRootCandidates(cwd: string): string[] {
  const roots: string[] = [];
  let current = path.resolve(cwd);
  while (true) {
    if (isDirectory(path.join(current, CONFIG_DIR_NAME)) || isDirectory(path.join(current, ".agents"))) roots.push(current);
    const parent = path.dirname(current);
    if (parent === current) return roots;
    current = parent;
  }
}

function readProjectSettings(root: string): any {
  const file = path.join(root, CONFIG_DIR_NAME, "settings.json");
  if (!fs.existsSync(file)) return undefined;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { subagents: { modelScope: { invalid: true } } }; }
}

function projectRootResolution(root: string): "nearest" | "git-root" | undefined {
  const value = readProjectSettings(root)?.subagents?.projectRootResolution;
  return value === "nearest" || value === "git-root" ? value : undefined;
}

function nearestGitRoot(cwd: string): string | undefined {
  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function configuredProjectRoot(cwd: string): string | undefined {
  const candidates = projectRootCandidates(cwd);
  const nearest = candidates[0];
  if (!nearest) return undefined;
  let policyRoot: string | undefined;
  let policyIndex = -1;
  for (const [index, candidate] of candidates.entries()) {
    const mode = projectRootResolution(candidate);
    if (mode === "nearest") return nearest;
    if (mode === "git-root") {
      policyRoot = candidate;
      policyIndex = index;
      break;
    }
  }
  if (!policyRoot) return nearest;
  const gitRoot = nearestGitRoot(cwd);
  const configuredGitRoot = gitRoot
    ? candidates.slice(policyIndex).find((candidate) => path.resolve(candidate) === path.resolve(gitRoot))
    : undefined;
  return configuredGitRoot ?? (fs.existsSync(path.join(policyRoot, ".git")) ? policyRoot : nearest);
}

function projectScopeWarning(cwd: string, provider: string): string | undefined {
  const root = configuredProjectRoot(cwd);
  if (!root) return undefined;
  const scope = readProjectSettings(root)?.subagents?.modelScope;
  if (scope === undefined || isSafeProviderScope(scope, provider)) return undefined;
  const file = path.join(root, CONFIG_DIR_NAME, "settings.json");
  return `Project ${file} replaces ZenPi's same-provider model scope. Remove or tighten that project subagents.modelScope before launching native children.`;
}

function effectiveLaunchCwd(input: any, sessionCwd: string): string {
  return typeof input?.cwd === "string" && input.cwd.trim()
    ? path.resolve(sessionCwd, input.cwd)
    : path.resolve(sessionCwd);
}

function unverifiableWorkflowCwd(input: any): boolean {
  if (typeof input?.workflowScriptPath === "string" && input.workflowScriptPath.trim()) return true;
  return typeof input?.workflowScript === "string" && /\bcwd\b/.test(input.workflowScript);
}

function shouldGuardLaunch(input: any): boolean {
  const action = typeof input?.action === "string" ? input.action : undefined;
  return action === undefined || action === "resume" || action === "schedule.create";
}

function cloneDraft(state: ReturnType<typeof readSubagentState>) {
  return {
    roles: structuredClone(state.roles),
    capacity: structuredClone(state.capacity),
  };
}

function changedSummary(before: any, after: any): string {
  const lines: string[] = [];
  for (const name of Object.keys(CAPACITY_DEFAULTS)) {
    if (before.capacity[name] !== after.capacity[name]) lines.push(`${CAPACITY_LABELS[name]}: ${before.capacity[name]} → ${after.capacity[name]}`);
  }
  for (const role of SUPPORTED_ROLES) {
    if (before.roles[role].model !== after.roles[role].model) lines.push(`${role} model: ${before.roles[role].model} → ${after.roles[role].model}`);
    if (before.roles[role].thinking !== after.roles[role].thinking) lines.push(`${role} thinking: ${before.roles[role].thinking} → ${after.roles[role].thinking}`);
  }
  return lines.length ? lines.join("\n") : "No user-tunable values changed. The active provider scope will still be verified.";
}

async function chooseCapacity(ctx: any, draft: any): Promise<void> {
  const keys = Object.keys(CAPACITY_DEFAULTS);
  const labels = keys.map((name) => `${CAPACITY_LABELS[name]} · ${draft.capacity[name]}`);
  const selected = await ctx.ui.select("Configure subagent capacity", labels);
  if (!selected) return;
  const name = keys[labels.indexOf(selected)];
  const value = await ctx.ui.input(CAPACITY_LABELS[name], String(draft.capacity[name]));
  if (value === undefined) return;
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed)) throw new Error("Capacity must be a whole number.");
  draft.capacity[name] = parsed;
}

async function chooseRoleModel(ctx: any, draft: any, catalogue: any[], provider: string): Promise<void> {
  const role = await ctx.ui.select("Choose a role", [...SUPPORTED_ROLES]);
  if (!role) return;
  const choices = modelChoices(catalogue, provider);
  const labels = ["inherit parent model", ...choices.map((choice) => choice.label)];
  const selected = await ctx.ui.select(`${role} model · ${provider}`, labels);
  if (!selected) return;
  draft.roles[role].model = selected === labels[0] ? "inherit" : choices[labels.indexOf(selected) - 1].value;
}

async function chooseRoleThinking(ctx: any, draft: any, catalogue: any[], provider: string): Promise<void> {
  const role = await ctx.ui.select("Choose a role", [...SUPPORTED_ROLES]);
  if (!role) return;
  const configured = draft.roles[role].model;
  const model = configured === "inherit"
    ? ctx.model
    : catalogue.find((entry) => `${entry.provider}/${entry.id}` === configured);
  const supported = supportedThinkingLevels(model, "high").filter((level) => THINKING_LEVELS.includes(level));
  const choices = supported.length ? supported : [...THINKING_LEVELS];
  const selected = await ctx.ui.select(`${role} thinking · ceiling high`, choices);
  if (selected) draft.roles[role].thinking = selected;
}

export default function registerZenSubagents(pi: ExtensionAPI) {
  const leaseToken = randomBytes(24).toString("hex");
  let runtimeProvider: string | undefined;
  let runtimeFingerprint: string | undefined;
  let reloadRequired = false;

  const activate = async (provider: string, ctx: ExtensionContext, reason: string, lifecycle = false) => {
    const catalogue = await availableModels(ctx);
    const availableValues = modelChoices(catalogue, provider).map((choice) => choice.value);
    const result = activateProviderProfile({ provider, leaseToken, reason, availableValues });
    if (result.state === "blocked") {
      runtimeProvider = undefined;
      runtimeFingerprint = undefined;
      ctx.ui.notify(`Subagent activation blocked by a live '${result.conflictProvider}' provider session.`, "warning");
      return result;
    }
    if (result.state === "migration-needed") {
      runtimeProvider = undefined;
      runtimeFingerprint = undefined;
      ctx.ui.notify(`Subagent profile migration needs attention: ${result.diagnostic}`, "warning");
      return result;
    }
    if (result.profileCreated) ctx.ui.notify(`Created inherited subagent defaults for '${provider}'.`, "info");
    if (result.staleRoles?.length) ctx.ui.notify(`Saved '${provider}' roles are stale: ${result.staleRoles.map((item: any) => item.role).join(", ")}. Run /zen-subagents.`, "warning");
    if (result.changed) {
      runtimeProvider = undefined;
      runtimeFingerprint = undefined;
      reloadRequired = true;
      if (lifecycle) {
        // Lifecycle handlers receive ExtensionContext, while reload() is only
        // available on command contexts. Keep launches fail-closed until the
        // user runs the built-in command and a fresh session_start verifies
        // the runtime mapping.
        ctx.ui.notify(`Restored the '${provider}' subagent profile. Run /reload before launching subagents.`, "warning");
      }
    } else if (lifecycle && reason === "session-start" && !reloadRequired) {
      // Only a fresh extension's post-load session_start proves what the
      // pi-subagents runtime loaded; commands and guards cannot clear a latch.
      runtimeProvider = provider;
      runtimeFingerprint = result.fingerprint;
    }
    return result;
  };

  pi.on("session_start", async (_event, ctx) => {
    const provider = activeProvider(ctx);
    if (!provider) return;
    try { await activate(provider, ctx, "session-start", true); }
    catch (error) { runtimeProvider = undefined; runtimeFingerprint = undefined; ctx.ui.notify(`Could not activate the subagent provider profile: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
  });

  pi.on("model_select", async (event, ctx) => {
    if (!reloadRequired && runtimeFingerprint && runtimeProvider === event.model.provider) return;
    try { await activate(event.model.provider, ctx, "model-select", true); }
    catch (error) { runtimeProvider = undefined; runtimeFingerprint = undefined; ctx.ui.notify(`Could not activate the subagent provider profile: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
  });

  pi.on("session_shutdown", async () => {
    try { releaseProviderLease({ token: leaseToken }); } catch { /* A substituted or unverifiable lease fails closed and is retained. */ }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "subagent" || !shouldGuardLaunch(event.input)) return;
    const provider = activeProvider(ctx);
    if (!provider) return { block: true, reason: "ZenPi cannot verify the parent provider for this subagent launch." };
    if (unverifiableWorkflowCwd(event.input)) return { block: true, reason: "ZenPi cannot verify provider policy for file-authored workflows or inline workflows containing a literal child cwd. Use the top-level cwd; dynamically constructed workflow code remains trusted user input." };
    const warning = projectScopeWarning(effectiveLaunchCwd(event.input, ctx.cwd), provider);
    if (warning) return { block: true, reason: warning };
    try {
      const result = await activate(provider, ctx, "guarded-launch");
      if (result.state === "blocked") return { block: true, reason: `A live '${result.conflictProvider}' provider session prevents safe activation of the shared subagent mirror.` };
      if (result.state === "migration-needed") return { block: true, reason: `Subagent profile migration needs repair: ${result.diagnostic}` };
      if (result.changed || reloadRequired || runtimeProvider !== provider || !runtimeFingerprint || result.fingerprint !== runtimeFingerprint) return { block: true, reason: "The provider profile changed on disk but the pi-subagents runtime is not yet aligned. Reload Pi before launching." };
      const explicitModel = typeof event.input?.model === "string" && event.input.model.trim();
      const launchedRole = typeof event.input?.agent === "string" ? event.input.agent : undefined;
      const staleForLaunch = explicitModel
        ? []
        : (launchedRole ? (result.staleRoles || []).filter((item: any) => item.role === launchedRole) : (result.staleRoles || []));
      if (staleForLaunch.length) return { block: true, reason: `Saved defaults are unavailable for ${staleForLaunch.map((item: any) => item.role).join(", ")}; run /zen-subagents or supply an explicit same-provider model for this run.` };
      const state = readSubagentState();
      if (!isSafeProviderScope(state.modelScope, provider)) return { block: true, reason: `ZenPi could not establish strict same-provider scope for '${provider}'.` };
    } catch (error) {
      return { block: true, reason: `ZenPi could not verify subagent provider state: ${error instanceof Error ? error.message : String(error)}` };
    }
  });

  pi.registerCommand("zen-subagents", {
    description: "Configure active-provider role profile and global subagent capacity",
    getArgumentCompletions: (prefix: string) => {
      const values = ["status", "reset"].filter((value) => value.startsWith(prefix.trim().toLowerCase()));
      return values.length ? values.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action && action !== "status" && action !== "reset") { ctx.ui.notify("Usage: /zen-subagents [status|reset]", "error"); return; }
      const provider = activeProvider(ctx);
      if (!provider) { ctx.ui.notify("Select a parent model before configuring subagents.", "error"); return; }
      const catalogue = await availableModels(ctx);
      const availableValues = modelChoices(catalogue, provider).map((choice) => choice.value);
      let active;
      try { active = await activate(provider, ctx, `command-${action || "configure"}`); } catch (error) { ctx.ui.notify(String(error), "error"); return; }
      const state = readSubagentState();
      const projectWarning = projectScopeWarning(ctx.cwd, provider);
      if (action === "status") {
        const diagnostic = active.state === "blocked"
          ? `\nDiagnostic: blocked by a live '${active.conflictProvider}' provider session.`
          : active.state === "migration-needed" ? `\nDiagnostic: ${active.diagnostic}` : "";
        ctx.ui.notify(`${formatProviderSubagentStatus(active, state, provider, availableValues)}${diagnostic}${active.changed || reloadRequired ? "\nActivation changed disk state; reload is required before launch." : ""}${projectWarning ? `\nWarning: ${projectWarning}` : ""}`, projectWarning || active.state === "blocked" || active.state === "migration-needed" ? "warning" : "info");
        return;
      }
      if (active.state === "blocked") return;
      const repairingLegacy = active.state === "migration-needed";
      const profileState = { ...state, roles: repairingLegacy ? structuredClone(ROLE_DEFAULTS) : active.profile.roles };
      if (ctx.hasUI === false) { ctx.ui.notify("Interactive configuration requires a UI. Use /zen-subagents status in this mode.", "error"); return; }
      if (action === "reset") {
        if (!await ctx.ui.confirm("Reset active provider profile?", `Reset '${provider}' role models and thinking to inherited defaults.\nGlobal capacity is unchanged.\nOther provider profiles are unchanged.`)) return;
        const result = applyProviderConfiguration({ provider, leaseToken, reset: true, repairLegacy: repairingLegacy, reason: "reset" });
        runtimeProvider = undefined;
        runtimeFingerprint = undefined;
        reloadRequired = result.changed || reloadRequired;
        ctx.ui.notify(result.changed ? `The '${provider}' profile was reset. Reload Pi before launching subagents.` : "The active profile already matches defaults.", "info");
        return;
      }
      if (repairingLegacy) ctx.ui.notify(`Legacy profile repair required: ${active.diagnostic} Explicit apply will replace the unresolved mirror for '${provider}'.`, "warning");
      const draft = cloneDraft(profileState);
      while (true) {
        const choice = await ctx.ui.select(`ZenPi subagents · ${provider} · ${repairingLegacy ? "repair required" : active.profileCreated ? "new default profile" : "saved profile"}`, ["Configure global capacity", "Configure active-provider role models", "Configure active-provider role thinking", "Review and apply", "Cancel"]);
        if (!choice || choice === "Cancel") return;
        try {
          if (choice === "Configure global capacity") await chooseCapacity(ctx, draft);
          else if (choice === "Configure active-provider role models") await chooseRoleModel(ctx, draft, catalogue, provider);
          else if (choice === "Configure active-provider role thinking") await chooseRoleThinking(ctx, draft, catalogue, provider);
          else if (choice === "Review and apply") {
            const preview = changedSummary(profileState, draft);
            const stale = staleRoleModels(draft.roles, provider, availableValues);
            if (stale.length || projectWarning) { ctx.ui.notify(stale.length ? `Unavailable saved models: ${stale.map((x) => x.role).join(", ")}. No replacement was selected.` : projectWarning!, "warning"); return; }
            const notes = `${preview}\n\nActive exact provider: ${provider}\nStrict scope: ${provider}/*\nRole changes apply only to this provider profile; capacity changes are global.`;
            if (!await ctx.ui.confirm("Apply ZenPi subagent profile?", notes)) return;
            const result = applyProviderConfiguration({ provider, roles: draft.roles, capacity: draft.capacity, leaseToken, repairLegacy: repairingLegacy, reason: "configure" });
            runtimeProvider = undefined;
            runtimeFingerprint = undefined;
            reloadRequired = result.changed || reloadRequired;
            ctx.ui.notify(result.changed ? `Profile, active mirror, and global capacity applied atomically. Reload Pi before launching subagents.` : "No subagent settings changed.", "info");
            return;
          }
        } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
      }
    },
  });
}
