import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CAPACITY_DEFAULTS,
  ROLE_DEFAULTS,
  SUPPORTED_ROLES,
  THINKING_LEVELS,
  applySubagentConfiguration,
  formatSubagentStatus,
  isSafeProviderScope,
  modelChoices,
  readSubagentState,
  staleRoleModels,
  supportedThinkingLevels,
  syncProviderScope,
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
  const synchronize = (provider: string | undefined, ctx: ExtensionContext, notify = false) => {
    if (!provider) return;
    try {
      const changed = syncProviderScope(undefined, provider);
      if (changed && notify) ctx.ui.notify(`Subagent model scope synchronized to ${provider}/*.`, "info");
    } catch (error) {
      ctx.ui.notify(`Could not synchronize subagent provider scope: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    synchronize(activeProvider(ctx), ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    synchronize(event.model.provider, ctx, event.source !== "restore");
    try {
      const state = readSubagentState();
      const stale = staleRoleModels(state.roles, event.model.provider);
      if (stale.length) ctx.ui.notify(`Provider changed. Run /zen-subagents to reconfigure: ${stale.map((item) => item.role).join(", ")}.`, "warning");
    } catch {
      // Synchronization already reports configuration errors.
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "subagent" || !shouldGuardLaunch(event.input)) return;
    const provider = activeProvider(ctx);
    if (!provider) return { block: true, reason: "ZenPi cannot verify the parent provider for this subagent launch." };
    if (unverifiableWorkflowCwd(event.input)) {
      return { block: true, reason: "ZenPi cannot verify provider policy for file-authored workflows or inline workflows containing a literal child cwd. Use the top-level cwd; dynamically constructed workflow code remains trusted user input." };
    }
    const launchCwd = effectiveLaunchCwd(event.input, ctx.cwd);
    const warning = projectScopeWarning(launchCwd, provider);
    if (warning) return { block: true, reason: warning };
    try {
      synchronize(provider, ctx);
      const state = readSubagentState();
      if (!isSafeProviderScope(state.modelScope, provider)) {
        return { block: true, reason: `ZenPi could not establish strict same-provider scope for '${provider}'.` };
      }
    } catch (error) {
      return { block: true, reason: `ZenPi could not verify subagent provider scope: ${error instanceof Error ? error.message : String(error)}` };
    }
  });

  pi.registerCommand("zen-subagents", {
    description: "Configure subagent capacity and same-provider role models/thinking",
    getArgumentCompletions: (prefix: string) => {
      const values = ["status", "reset"].filter((value) => value.startsWith(prefix.trim().toLowerCase()));
      return values.length ? values.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action && action !== "status" && action !== "reset") {
        ctx.ui.notify("Usage: /zen-subagents [status|reset]", "error");
        return;
      }
      const provider = activeProvider(ctx);
      if (!provider) {
        ctx.ui.notify("Select a parent model before configuring subagents.", "error");
        return;
      }
      const catalogue = await availableModels(ctx);
      const sameProviderChoices = modelChoices(catalogue, provider);
      const availableValues = sameProviderChoices.map((choice) => choice.value);
      const state = readSubagentState();
      const projectWarning = projectScopeWarning(ctx.cwd, provider);

      if (action === "status") {
        ctx.ui.notify(`${formatSubagentStatus(state, provider, availableValues)}${projectWarning ? `\nWarning: ${projectWarning}` : ""}`, projectWarning ? "warning" : "info");
        return;
      }

      if (ctx.hasUI === false) {
        ctx.ui.notify("Interactive configuration requires a UI. Use /zen-subagents status in this mode.", "error");
        return;
      }

      if (action === "reset") {
        const preview = changedSummary(state, { roles: ROLE_DEFAULTS, capacity: CAPACITY_DEFAULTS });
        if (!await ctx.ui.confirm("Reset ZenPi subagents?", `${preview}\n\nProvider scope: ${provider}/*\nUnrelated settings are preserved.`)) return;
        const result = applySubagentConfiguration({ provider, reset: true, reason: "reset" });
        ctx.ui.notify(result.changed ? `Subagent defaults restored. Backup: ${result.backup}\nRun /reload after active subagent work settles.` : "Subagent settings already match ZenPi defaults.", "info");
        return;
      }

      const draft = cloneDraft(state);
      while (true) {
        const choice = await ctx.ui.select(
          `ZenPi subagents · ${provider}`,
          [
            "Configure capacity",
            "Configure role models",
            "Configure role thinking",
            "Review and apply",
            "Cancel",
          ],
        );
        if (!choice || choice === "Cancel") return;
        try {
          if (choice === "Configure capacity") await chooseCapacity(ctx, draft);
          else if (choice === "Configure role models") await chooseRoleModel(ctx, draft, catalogue, provider);
          else if (choice === "Configure role thinking") await chooseRoleThinking(ctx, draft, catalogue, provider);
          else if (choice === "Review and apply") {
            const preview = changedSummary(state, draft);
            const stale = staleRoleModels(draft.roles, provider, availableValues);
            const notes = [
              preview,
              `Provider scope: ${provider}/* (strict)`,
              "Run/session values are cumulative budgets; active async is top-level capacity.",
              "These values do not control modern runs.all child concurrency.",
              ...(stale.length ? [`Unavailable choices: ${stale.map((item) => item.role).join(", ")}`] : []),
              ...(projectWarning ? [`Warning: ${projectWarning}`] : []),
            ];
            if (stale.length || projectWarning) {
              ctx.ui.notify(notes.slice(-1)[0], "warning");
              return;
            }
            if (!await ctx.ui.confirm("Apply ZenPi subagent settings?", notes.join("\n"))) return;
            const result = applySubagentConfiguration({ provider, roles: draft.roles, capacity: draft.capacity, reason: "configure" });
            ctx.ui.notify(result.changed ? `Subagent settings applied. Backup: ${result.backup}\nRun /reload after active subagent work settles.` : "No subagent settings changed.", "info");
            return;
          }
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      }
    },
  });
}
