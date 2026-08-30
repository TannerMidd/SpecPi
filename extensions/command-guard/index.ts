import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  clearAnalysisCache, decideCommand, decidePath, injectBinding, readChildBinding,
  validateBinding, bindingForChild, SUPPORTED_SUBAGENT_CONTRACT,
} from "./core.mjs";
import { boundedReason } from "./redact.mjs";
import { POLICY_VERSION } from "./rules.mjs";

const BINDING_NAME = "zenpi.command-guard/1";
const SAFE_SUBAGENT_ACTIONS = new Set(["list", "get", "models", "guide", "status", "children.list", "mission", "mission.list", "mission.show", "watchdog.status", "diagnostics", "doctor", "interrupt", "stop"]);
let preflightModule: Promise<any> | undefined;
type Mode = "guard" | "strict" | "off" | "locked";
type State = { mode: Mode; baseMode: "guard" | "strict" | "off"; childBound: boolean; generation: number; ready: boolean; startupFailed: boolean; nonce: string; blocks: number; approvals: number; sessionApprovals: Set<string>; categories: Record<string, number>; rules: Record<string, number>; criticalRule?: string };

function validRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function launchFingerprint(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 1024 * 1024) return undefined;
    return crypto.createHash("sha256").update(serialized).digest("hex");
  } catch { return undefined; }
}
function toolFingerprint(name: string, input: unknown, cwd: string, mode: Mode): string | undefined {
  try {
    const serialized = JSON.stringify({ name, input, cwd: path.resolve(cwd), mode, policyVersion: POLICY_VERSION });
    if (typeof serialized !== "string") return undefined;
    return crypto.createHash("sha256").update(serialized).digest("hex");
  } catch { return undefined; }
}
function rememberApproval(state: State, fingerprint: string): void {
  if (state.sessionApprovals.has(fingerprint)) state.sessionApprovals.delete(fingerprint);
  while (state.sessionApprovals.size >= 128) state.sessionApprovals.delete(state.sessionApprovals.values().next().value!);
  state.sessionApprovals.add(fingerprint);
}
function agentDirectory(): string { return path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")); }
function packageRootFrom(start: string | undefined, expectedName: string): string | undefined {
  if (!start) return undefined;
  let current = path.resolve(fs.existsSync(start) && fs.statSync(start).isDirectory() ? start : path.dirname(start));
  while (true) {
    const manifest = path.join(current, "package.json");
    try { if (JSON.parse(fs.readFileSync(manifest, "utf8")).name === expectedName) return current; } catch { /* keep walking */ }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
async function loadSubagentPreflight(): Promise<any> {
  if (preflightModule) return preflightModule;
  preflightModule = (async () => {
    const npmRoot = path.join(agentDirectory(), "npm");
    const requireFromAgent = createRequire(path.join(npmRoot, "package.json"));
    const piRoot = packageRootFrom(process.env.ZENPI_PI_PACKAGE_ROOT || process.argv[1], "@earendil-works/pi-coding-agent");
    if (!piRoot) throw new Error("Pi package root could not be verified.");
    const peerRoot = path.join(piRoot, "node_modules", "@earendil-works");
    const aliases = {
      "@earendil-works/pi-coding-agent": path.join(piRoot, "dist", "index.js"),
      "@earendil-works/pi-ai": path.join(peerRoot, "pi-ai", "dist", "index.js"),
      "@earendil-works/pi-agent-core": path.join(peerRoot, "pi-agent-core", "dist", "index.js"),
      "@earendil-works/pi-tui": path.join(peerRoot, "pi-tui", "dist", "index.js"),
    };
    if (Object.values(aliases).some((file) => !fs.existsSync(file))) throw new Error("Pi peer modules could not be verified.");
    const { createJiti } = await import(requireFromAgent.resolve("jiti"));
    const jiti = createJiti(import.meta.url, { interopDefault: true, alias: aliases });
    const loaded = await jiti.import(requireFromAgent.resolve("pi-subagents/preflight"));
    if (typeof loaded?.resolveSubagentLaunchContract !== "function") throw new Error("pi-subagents preflight API is unavailable.");
    return loaded;
  })();
  try { return await preflightModule; } catch (error) { preflightModule = undefined; throw error; }
}
function canonicalPath(value: string): string {
  let normalized = path.resolve(value);
  try { normalized = fs.realpathSync.native(normalized); } catch { /* The managed target can be checked lexically before install completion. */ }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
export async function verifySubagentLaunch(input: Record<string, any>, ctx: ExtensionContext, mode: "guard" | "strict", nonce: string, resolver?: (value: any) => Promise<any>) {
  if (typeof input.agent !== "string" || !input.agent.trim()) return { ok: false, reason: "Protected subagent launches require one explicit native agent." };
  const injected = injectBinding(input, mode, nonce);
  const effectiveCwd = typeof input.cwd === "string" && input.cwd.trim() ? path.resolve(ctx.cwd, input.cwd) : path.resolve(ctx.cwd);
  const preflight = resolver || (await loadSubagentPreflight()).resolveSubagentLaunchContract;
  const request: any = {
    agent: input.agent,
    cwd: effectiveCwd,
    extensionBindings: injected.extensionBindings,
    ...(typeof input.task === "string" ? { task: input.task } : {}),
    ...(typeof input.agentScope === "string" ? { agentScope: input.agentScope } : {}),
    ...(input.context === "fresh" || input.context === "fork" ? { context: input.context } : {}),
    ...(typeof input.model === "string" ? { model: input.model } : {}),
    ...(typeof input.fast === "boolean" ? { fast: input.fast } : {}),
    ...(typeof input.thinking === "string" || input.thinking === false ? { thinking: input.thinking } : {}),
    ...(typeof input.skill === "string" || Array.isArray(input.skill) || typeof input.skill === "boolean" ? { skill: input.skill } : {}),
    ...(typeof input.output === "string" || typeof input.output === "boolean" ? { output: input.output } : {}),
    ...(typeof input.outputMode === "string" ? { outputMode: input.outputMode } : {}),
    ...(validRecord(input.outputSchema) ? { outputSchema: input.outputSchema } : {}),
    ...(validRecord(input.turnBudget) ? { turnBudget: input.turnBudget } : {}),
    ...(typeof input.artifacts === "boolean" ? { artifacts: input.artifacts } : {}),
    ...(typeof input.artifactDir === "string" ? { artifactDir: input.artifactDir } : {}),
    ...(ctx.model ? { parentModel: { provider: ctx.model.provider, id: ctx.model.id } } : {}),
  };
  const result = await preflight(request);
  if (!result?.ok) return { ok: false, reason: `Native child preflight failed: ${boundedReason(result?.message || "unverifiable launch")}` };
  if (result.contract?.version !== SUPPORTED_SUBAGENT_CONTRACT.version || result.contract?.protocol?.packageVersion !== SUPPORTED_SUBAGENT_CONTRACT.packageVersion) {
    return { ok: false, reason: `The native child preflight contract is unsupported; this guard accepts ${SUPPORTED_SUBAGENT_CONTRACT.packageName}@${SUPPORTED_SUBAGENT_CONTRACT.packageVersion}. Run zenpi doctor.` };
  }
  const expected = canonicalPath(path.join(agentDirectory(), "extensions", "command-guard", "index.ts"));
  const extensions = result.contract?.tools?.extensionArgs;
  if (!Array.isArray(extensions) || !extensions.some((entry: unknown) => typeof entry === "string" && canonicalPath(entry) === expected)) return { ok: false, reason: "The native child launch does not include the managed command guard." };
  return { ok: true, input: injected, contract: result.contract };
}
function validCommandInput(input: unknown): input is { command: string; timeout?: number } {
  if (!validRecord(input) || typeof input.command !== "string") return false;
  return input.timeout === undefined || (typeof input.timeout === "number" && Number.isFinite(input.timeout) && input.timeout > 0);
}
function validPathInput(input: unknown, toolName: string): input is Record<string, any> {
  if (!validRecord(input) || typeof input.path !== "string" || !input.path) return false;
  if (toolName === "read") return (input.offset === undefined || Number.isInteger(input.offset) && input.offset >= 1) && (input.limit === undefined || Number.isInteger(input.limit) && input.limit >= 1);
  if (toolName === "write") return typeof input.content === "string";
  return Array.isArray(input.edits) && input.edits.length > 0 && input.edits.every((edit: any) => validRecord(edit) && typeof edit.oldText === "string" && typeof edit.newText === "string");
}
async function withTimeout<T>(promise: Promise<T>, fallback: T, milliseconds = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise.catch(() => fallback), new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function startupChoice(ctx: ExtensionContext, milliseconds = 3000): Promise<string | undefined> {
  return withTimeout(ctx.ui.select("ZenPi command guard", ["Guard (Recommended)", "Strict", "Off for this session"]), undefined, milliseconds);
}
function updateStatus(ctx: ExtensionContext, state: State): void {
  const label = state.mode === "off" ? "Guard Off" : state.mode === "locked" ? "🛡 Locked" : `🛡 ${state.mode[0].toUpperCase()}${state.mode.slice(1)}`;
  try { ctx.ui.setStatus("zenpi-command-guard", label); } catch { /* Status is optional in older hosts. */ }
}
function recordDecision(state: State, decision: any): void {
  const category = String(decision?.category || "unknown").slice(0, 48);
  state.categories[category] = (state.categories[category] || 0) + 1;
  for (const id of Array.isArray(decision?.ruleIds) ? decision.ruleIds.slice(0, 32) : []) {
    const key = String(id).slice(0, 96); state.rules[key] = (state.rules[key] || 0) + 1;
  }
}
function decisionPrompt(decision: any, cwd: string, affected: string): string {
  const fields = `Severity: ${decision.severity}; category: ${decision.category}; cwd: ${boundedReason(cwd, 180)}; affected: ${boundedReason(affected || "not resolved", 320)}; reason: ${boundedReason(decision.reason, 320)}; safer: ${boundedReason(decision.saferAlternative || "review and narrow the operation", 220)}`;
  return boundedReason(fields, 1200);
}
function deny(state: State, reason: string, critical = false): { block: true; reason: string } {
  state.blocks += 1;
  if (critical) { state.mode = "locked"; state.generation += 1; state.sessionApprovals.clear(); }
  return { block: true, reason: boundedReason(reason) };
}

export default function registerCommandGuard(pi: ExtensionAPI, dependencies: { resolveSubagentLaunchContract?: (value: any) => Promise<any>; promptTimeoutMs?: number; startupTimeoutMs?: number; approvalTimeoutMs?: number } = {}): void {
  // Startup only picks a default and falls back to the recommended Guard mode, so it stays short.
  // An approval waits on a person reading severity, category, cwd, affected paths, reason, and alternative;
  // withTimeout cannot cancel the underlying prompt, so a short bound would deny work mid-decision and leave
  // a live selector on screen. Both directions still fail closed, just on a human timescale.
  const startupTimeoutMs = dependencies.startupTimeoutMs ?? dependencies.promptTimeoutMs ?? 30_000;
  const approvalTimeoutMs = dependencies.approvalTimeoutMs ?? dependencies.promptTimeoutMs ?? 600_000;
  const state: State = { mode: "guard", baseMode: "guard", childBound: false, generation: 0, ready: false, startupFailed: true, nonce: "", blocks: 0, approvals: 0, sessionApprovals: new Set(), categories: {}, rules: {} };
  const reset = () => { clearAnalysisCache(); state.mode = "guard"; state.baseMode = "guard"; state.childBound = false; state.generation += 1; state.ready = false; state.startupFailed = true; state.nonce = ""; state.blocks = 0; state.approvals = 0; state.sessionApprovals.clear(); state.categories = {}; state.rules = {}; state.criticalRule = undefined; };

  pi.on("session_start", async (_event, ctx) => {
    reset();
    try {
      const child = readChildBinding(process.env);
      if (process.env.PI_SUBAGENT_CHILD === "1") {
        if (!child || !validateBinding(child)) return;
        state.mode = child.mode;
        state.baseMode = child.mode;
        state.childBound = true;
        state.nonce = child.nonce;
        state.ready = true;
        state.startupFailed = false;
        updateStatus(ctx, state);
        return;
      }
      const choice = ctx.hasUI ? await startupChoice(ctx, startupTimeoutMs) : undefined;
      if (choice === "Strict") state.mode = "strict";
      else if (choice === "Off for this session") {
        const confirmed = ctx.hasUI ? await withTimeout(ctx.ui.confirm("Turn command guard off for this session?", "This removes command-guard defense in depth until this session ends. It is not persisted or inherited by protected children."), false, startupTimeoutMs) : false;
        state.mode = confirmed ? "off" : "guard";
      }
      state.baseMode = state.mode;
      state.nonce = bindingForChild(state.mode).nonce;
      state.ready = true;
      state.startupFailed = false;
      updateStatus(ctx, state);
      ctx.ui.notify(state.mode === "off" ? "Command guard is off for this session; this is not a sandbox." : `Command guard active in ${state.mode} mode.`, state.mode === "off" ? "warning" : "info");
    } catch {
      state.startupFailed = true;
      state.ready = false;
      try { ctx.ui.notify("Command guard initialization failed; protected tool calls will be denied.", "error"); } catch { /* fail closed */ }
    }
  });
  pi.on("session_shutdown", (_event, ctx) => { reset(); try { ctx.ui.setStatus("zenpi-command-guard", undefined); } catch { /* optional */ } });

  pi.registerCommand("guard", {
    description: "Show or change the session command guard",
    getArgumentCompletions: (prefix: string) => ["status", "guard", "strict", "off", "unlock", "clear-approvals"].filter((value) => value.startsWith(prefix.trim().toLowerCase())).map((value) => ({ value, label: value })),
    handler: async (args: string, ctx: ExtensionContext) => {
      const action = args.trim().toLowerCase() || "status";
      if (action === "status") { ctx.ui.notify(`Mode: ${state.mode}; policy: ${POLICY_VERSION}; lock: ${state.mode === "locked" ? "locked" : "unlocked"}; blocks: ${state.blocks}; approvals: ${state.approvals}; session approvals: ${state.sessionApprovals.size}; categories: ${JSON.stringify(state.categories)}; rules: ${JSON.stringify(state.rules)}`, "info"); return; }
      if (state.mode === "locked" && action !== "unlock") { ctx.ui.notify("The command guard is locked. Use /guard unlock after reviewing the critical rule.", "warning"); return; }
      if (action === "clear-approvals") { state.sessionApprovals.clear(); state.generation += 1; ctx.ui.notify("Session approvals cleared.", "info"); return; }
      if (action === "unlock") {
        if (state.mode !== "locked") { ctx.ui.notify("The command guard is not locked.", "info"); return; }
        const ok = ctx.hasUI && await withTimeout(ctx.ui.confirm("Unlock command guard?", `The last critical rule was ${state.criticalRule || "unknown"}. Review it before continuing.`), false, approvalTimeoutMs);
        if (ok) { state.mode = state.baseMode; state.generation += 1; state.sessionApprovals.clear(); state.criticalRule = undefined; updateStatus(ctx, state); ctx.ui.notify(`Command guard unlocked in ${state.baseMode} mode.`, "warning"); }
        return;
      }
      if (action === "off") {
        if (state.childBound) { ctx.ui.notify("A native child cannot weaken or disable its supervisor-bound guard mode.", "error"); return; }
        if (!ctx.hasUI || !await withTimeout(ctx.ui.confirm("Turn command guard off?", "This applies only to the current top-level session and removes defense in depth."), false, approvalTimeoutMs)) return;
        state.mode = "off"; state.baseMode = "off"; state.generation += 1; state.sessionApprovals.clear(); updateStatus(ctx, state); return;
      }
      if (action === "strict" || action === "guard") {
        if (state.childBound && action === "guard" && state.baseMode === "strict") { ctx.ui.notify("A Strict native child cannot weaken its supervisor-bound mode.", "error"); return; }
        if (action === "guard" && state.mode === "strict" && (!ctx.hasUI || !await withTimeout(ctx.ui.confirm("Switch to Guard mode?", "This weakens protection for the rest of this session."), false, approvalTimeoutMs))) return;
        state.mode = action; state.baseMode = action; state.generation += 1; state.sessionApprovals.clear(); updateStatus(ctx, state); return;
      }
      ctx.ui.notify("Usage: /guard [status|guard|strict|off|unlock|clear-approvals]", "error");
    },
  });

  pi.on("tool_call", async (event: any, ctx: ExtensionContext) => {
    try {
    const name = typeof event?.toolName === "string" ? event.toolName : "";
    const input = event?.input;
    if (!name) return deny(state, "Malformed tool call.");
    if (!state.ready || state.startupFailed) return deny(state, "Command guard is not initialized; protected tool calls are denied.");
    if (state.mode === "locked") return deny(state, "The command guard is locked after a critical attempt.");
    if (name === "bash" || name === "powershell") {
      if (!validCommandInput(input)) return deny(state, `Malformed ${name} input is denied.`);
      const decision = decideCommand(input.command, { mode: state.mode, shell: name, cwd: ctx.cwd, platform: process.platform, hasUI: ctx.hasUI });
      recordDecision(state, decision);
      if (decision.action === "deny") { state.criticalRule = decision.ruleIds[0]; const critical = decision.severity === "critical" && !decision.ruleIds.includes("policy.integrity"); const result = deny(state, critical ? `${decision.reason} The session is locked; use /guard status and /guard unlock after review.` : decision.reason, critical); if (critical) updateStatus(ctx, state); return result; }
      if (decision.action === "ask") {
        const approvalFingerprint = toolFingerprint(name, input, ctx.cwd, state.mode);
        if (!approvalFingerprint) return deny(state, "Approval input is malformed or exceeds the safety bound.");
        if (state.sessionApprovals.has(approvalFingerprint)) return;
        if (!ctx.hasUI) return deny(state, decision.reason);
        const affected = decision.leaves.map((leaf: any) => leaf.redactedTarget).filter(Boolean).slice(0, 4).join(", ");
        const approvalGeneration = state.generation;
        const answer = await withTimeout(ctx.ui.select(`Command guard approval — ${decisionPrompt(decision, ctx.cwd, affected)}`, ["Deny (Recommended)", "Allow once", "Allow exact call for session", "Lock session"]), undefined, approvalTimeoutMs);
        if (state.generation !== approvalGeneration || state.mode === "locked" || toolFingerprint(name, input, ctx.cwd, state.mode) !== approvalFingerprint) return deny(state, "Command-guard state or input changed during approval; execution is denied.");
        if (answer === "Allow once") { state.approvals += 1; state.generation += 1; return; }
        if (answer === "Allow exact call for session") { state.approvals += 1; rememberApproval(state, approvalFingerprint); state.generation += 1; return; }
        if (answer === "Lock session") { state.mode = "locked"; state.generation += 1; state.sessionApprovals.clear(); updateStatus(ctx, state); return deny(state, "The session was locked by command-guard approval."); }
        return deny(state, decision.reason);
      }
      return;
    }
    if (name === "write" || name === "edit" || name === "read") {
      if (!validPathInput(input, name)) return deny(state, `Malformed ${name} input is denied.`);
      const decision = decidePath(input.path, name, { mode: state.mode, cwd: ctx.cwd, platform: process.platform, hasUI: ctx.hasUI });
      recordDecision(state, decision);
      // Refusing a read is enough on its own: nothing was changed, so latching the lock would strand the whole
      // session — every later command, including read-only ones — over one blocked file.
      if (decision.action === "deny") { state.criticalRule = decision.ruleIds[0]; const critical = decision.severity === "critical" && name !== "read"; const result = deny(state, critical ? `${decision.reason} The session is locked; use /guard status and /guard unlock after review.` : decision.reason, critical); if (critical) updateStatus(ctx, state); return result; }
      if (decision.action === "ask") {
        const approvalFingerprint = toolFingerprint(name, input, ctx.cwd, state.mode);
        if (!approvalFingerprint) return deny(state, "Approval input is malformed or exceeds the safety bound.");
        if (state.sessionApprovals.has(approvalFingerprint)) return;
        if (!ctx.hasUI) return deny(state, decision.reason);
        const approvalGeneration = state.generation;
        const answer = await withTimeout(ctx.ui.select(`Path mutation approval — ${decisionPrompt(decision, ctx.cwd, boundedReason(input.path, 180))}`, ["Deny (Recommended)", "Allow once", "Allow exact call for session", "Lock session"]), undefined, approvalTimeoutMs);
        if (state.generation !== approvalGeneration || state.mode === "locked" || toolFingerprint(name, input, ctx.cwd, state.mode) !== approvalFingerprint) return deny(state, "Command-guard state or input changed during approval; mutation is denied.");
        if (answer === "Allow once") { state.approvals += 1; state.generation += 1; return; }
        if (answer === "Allow exact call for session") { state.approvals += 1; rememberApproval(state, approvalFingerprint); state.generation += 1; return; }
        if (answer === "Lock session") { state.mode = "locked"; state.generation += 1; state.sessionApprovals.clear(); updateStatus(ctx, state); return deny(state, "The session was locked by command-guard approval."); }
        return deny(state, decision.reason);
      }
      return;
    }
    if (name === "subagent") {
      if (!validRecord(input)) return deny(state, "Malformed subagent input is denied.");
      const action = typeof input.action === "string" ? input.action.toLowerCase() : "";
      if (action) {
        if (SAFE_SUBAGENT_ACTIONS.has(action)) return;
        return deny(state, "Protected sessions allow only read-only or stop/interrupt subagent administration; launches, workflows, resumes, schedules, steering, and unknown actions are denied.");
      }
      if (input.workflowScript !== undefined || input.workflowScriptPath !== undefined || input.resume !== undefined || input.at !== undefined || input.every !== undefined || input.on !== undefined) {
        return deny(state, "Protected subagent workflows, file-authored launches, resumes, and schedules are denied because every child cannot be preflighted.");
      }
      let verified;
      const launchMode: "guard" | "strict" = state.mode === "strict" ? "strict" : "guard";
      const launchStateMode = state.mode;
      const launchNonce = state.nonce;
      const launchGeneration = state.generation;
      const launchInputFingerprint = launchFingerprint(input);
      if (!launchInputFingerprint) return deny(state, "The native child launch input is malformed or exceeds the preflight safety bound.");
      try { verified = await verifySubagentLaunch(input, ctx, launchMode, launchNonce, dependencies.resolveSubagentLaunchContract); }
      catch { return deny(state, "The native child preflight API is unavailable; protected subagents are denied."); }
      if (state.mode !== launchStateMode || state.nonce !== launchNonce || state.generation !== launchGeneration) return deny(state, "Command-guard state changed during child preflight; launch is denied.");
      if (launchFingerprint(input) !== launchInputFingerprint) return deny(state, "Native child launch input changed during preflight; launch is denied.");
      if (!verified.ok) return deny(state, verified.reason);
      // Pi requires in-place mutation; replacing event.input is not guaranteed to reach the executor.
      input.extensionBindings = verified.input.extensionBindings;
      return;
    }
    if (state.mode === "strict") {
      recordDecision(state, { category: "unknown", ruleIds: ["tool.unknown-capability"] });
      const approvalFingerprint = toolFingerprint(name, input, ctx.cwd, state.mode);
      if (!approvalFingerprint) return deny(state, "Unknown-tool approval input is malformed or exceeds the safety bound.");
      if (state.sessionApprovals.has(approvalFingerprint)) return;
      if (!ctx.hasUI) return deny(state, "Unknown tools requiring policy review are denied without approval UI.");
      const approvalGeneration = state.generation;
      const answer = await withTimeout(ctx.ui.select(`Unknown tool approval — name: ${boundedReason(name, 96)}; mode: ${state.mode}; capability is not in the reviewed command-guard catalog.`, ["Deny (Recommended)", "Allow once", "Allow exact call for session", "Lock session"]), undefined, approvalTimeoutMs);
      if (state.generation !== approvalGeneration || state.mode === "locked" || toolFingerprint(name, input, ctx.cwd, state.mode) !== approvalFingerprint) return deny(state, "Command-guard state or input changed during approval; execution is denied.");
      if (answer === "Allow once") { state.approvals += 1; state.generation += 1; return; }
      if (answer === "Allow exact call for session") { state.approvals += 1; rememberApproval(state, approvalFingerprint); state.generation += 1; return; }
      if (answer === "Lock session") { state.mode = "locked"; state.generation += 1; state.sessionApprovals.clear(); updateStatus(ctx, state); }
      return deny(state, "Unknown tool was not approved.");
    }
    } catch { return deny(state, "Command-guard policy or prompting failed; execution is denied."); }
  });
}
