import fs from "node:fs";
import path from "node:path";
import registerZenSubagents from "../../extensions/subagents/index.ts";

export default async function subagentsExtensionHarness() {
  const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR!);
  const commands = new Map<string, any>();
  const events = new Map<string, any[]>();
  const notifications: any[] = [];
  const confirmations: any[] = [];
  const selections: any[] = [];
  const queue = [
    "Configure active-provider role models",
    "worker",
    "gpt-5.6-luna — Luna",
    "Configure active-provider role thinking",
    "worker",
    "high",
    "Configure global capacity",
    "Run child budget (cumulative) · 8",
    "Review and apply",
  ];
  const fakePi: any = {
    on(name: string, handler: any) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    registerCommand(name: string, command: any) { commands.set(name, command); },
  };
  registerZenSubagents(fakePi);

  const codexSol = { provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol", reasoning: true };
  const codexLuna = { provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna", reasoning: true };
  const openrouter = { provider: "openrouter", id: "vendor/model", name: "Router Model", reasoning: true };
  const anthropic = { provider: "anthropic", id: "claude-sonnet", name: "Sonnet", reasoning: true };
  const ctx: any = {
    cwd: path.join(agentDir, "project", "src"),
    hasUI: true,
    model: codexSol,
    scopedModels: [],
    modelRegistry: {
      async getAvailable() { return [codexSol, codexLuna, openrouter, anthropic]; },
      find(provider: string, id: string) { return [codexSol, codexLuna, openrouter, anthropic].find((model) => model.provider === provider && model.id === id); },
    },
    async reload() { notifications.push({ message: "ctx.reload", level: "reload" }); },
    ui: {
      async select(title: string, options: string[]) {
        const answer = queue.shift();
        selections.push({ title, options, answer });
        if (answer && !options.includes(answer)) throw new Error(`Harness answer '${answer}' missing from ${JSON.stringify(options)}`);
        return answer;
      },
      async input() { return "12"; },
      async confirm(title: string, message: string) {
        confirmations.push({ title, message });
        return true;
      },
      notify(message: string, level: string) { notifications.push({ message, level }); },
    },
  };
  fs.mkdirSync(path.join(agentDir, "extensions", "subagent"), { recursive: true });
  fs.mkdirSync(ctx.cwd, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    unrelated: true,
    subagents: {
      modelScope: { enforce: true, strict: true, allow: ["inherit"] },
      agentOverrides: {},
    },
  }));
  fs.writeFileSync(path.join(agentDir, "extensions", "subagent", "config.json"), JSON.stringify({
    maxSubagentSpawnsPerRun: 8,
    maxSubagentSpawnsPerSession: 24,
    maxActiveAsyncRunsPerSession: 2,
    unrelated: true,
  }));

  for (const handler of events.get("session_start") ?? []) await handler({}, ctx);
  await commands.get("zen-subagents").handler("", ctx);
  ctx.model = openrouter;
  for (const handler of events.get("model_select") ?? []) await handler({ model: openrouter, source: "user" }, ctx);
  ctx.model = codexSol;
  for (const handler of events.get("model_select") ?? []) await handler({ model: codexSol, source: "user" }, ctx);
  const beforeStatus = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
  beforeStatus.subagents.modelScope = { enforce: true, strict: true, allow: ["inherit"] };
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(beforeStatus));
  await commands.get("zen-subagents").handler("status", ctx);
  const statusNonMutating = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).subagents.modelScope.allow[0] === "inherit";
  for (const handler of events.get("session_start") ?? []) await handler({}, ctx);

  const projectRoot = path.dirname(ctx.cwd);
  fs.mkdirSync(path.join(projectRoot, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".pi", "settings.json"), JSON.stringify({ subagents: { modelScope: { enforce: false, allow: ["anthropic/*"] } } }));
  let guardResult;
  for (const handler of events.get("tool_call") ?? []) {
    guardResult = await handler({ toolName: "subagent", input: { agent: "worker", task: "test" } }, ctx) ?? guardResult;
  }

  const otherRoot = path.join(agentDir, "other-project");
  const otherChild = path.join(otherRoot, "nested");
  fs.mkdirSync(path.join(otherRoot, ".pi"), { recursive: true });
  fs.mkdirSync(otherChild, { recursive: true });
  fs.writeFileSync(path.join(otherRoot, ".pi", "settings.json"), JSON.stringify({ subagents: { modelScope: { enforce: false, allow: ["anthropic/*"] } } }));
  const monorepo = path.join(agentDir, "monorepo");
  const nestedProject = path.join(monorepo, "packages", "nested");
  fs.mkdirSync(path.join(monorepo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(monorepo, ".pi"), { recursive: true });
  fs.mkdirSync(path.join(nestedProject, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(monorepo, ".pi", "settings.json"), JSON.stringify({ subagents: { projectRootResolution: "git-root", modelScope: { enforce: false, allow: ["anthropic/*"] } } }));
  fs.writeFileSync(path.join(nestedProject, ".pi", "settings.json"), JSON.stringify({ subagents: {} }));

  let explicitCwdGuardResult;
  let gitRootGuardResult;
  let workflowCwdGuardResult;
  for (const handler of events.get("tool_call") ?? []) {
    explicitCwdGuardResult = await handler({ toolName: "subagent", input: { agent: "worker", task: "test", cwd: otherChild } }, ctx) ?? explicitCwdGuardResult;
    gitRootGuardResult = await handler({ toolName: "subagent", input: { agent: "worker", task: "test", cwd: nestedProject } }, ctx) ?? gitRootGuardResult;
    workflowCwdGuardResult = await handler({ toolName: "subagent", input: { workflowScript: "return runs.run('x', { agent: 'worker', task: 'x', cwd: '/tmp' })" } }, ctx) ?? workflowCwdGuardResult;
  }

  const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
  const config = JSON.parse(fs.readFileSync(path.join(agentDir, "extensions", "subagent", "config.json"), "utf8"));
  const savedProviders = Object.keys(JSON.parse(fs.readFileSync(path.join(agentDir, "zenpi", "subagent-provider-profiles.json"), "utf8")).providers).sort();
  process.stdout.write(`ZENPI_SUBAGENTS_HARNESS=${JSON.stringify({
    commandNames: [...commands.keys()],
    eventNames: [...events.keys()],
    settings,
    config,
    savedProviders,
    selections,
    confirmations,
    notifications,
    statusNonMutating,
    guardResult,
    explicitCwdGuardResult,
    gitRootGuardResult,
    workflowCwdGuardResult,
  })}\n`);
}
