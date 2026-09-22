#!/usr/bin/env node
// Harness adapters for evals. Each adapter knows how to run one harness
// against a workspace with the model pointed at the logging proxy.
// Real harnesses are judged by files, not transcripts: the checker decides
// pass/fail, the proxy log decides context, tokens and cost.
// Adapters never touch the live Pi directory; every run gets a disposable home.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_BUDGETS, defaultSettings, normalizeSettings } from "../extensions/jev-advisor/config.mjs";
import { summarize as summarizeLedger } from "../extensions/jev-advisor/ledger.mjs";
import { CONSENT_SCHEMA } from "../extensions/jev-advisor/consent.mjs";
import { runReferenceSolution } from "./eval-tasks.mjs";
import { prepareFaults, readFaults, withFaultPath } from "./eval-faults.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const piCli = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

function allowlistedEnv(homeDir, extra = {}) {
    const env = {};
    for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT"]) {
        if (process.env[name]) {
            env[name] = process.env[name];
        }
    }

    for (const name of ["HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR"]) {
        env[name] = homeDir;
    }

    for (const name of ["APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
        env[name] = path.join(homeDir, name);
        fs.mkdirSync(env[name], { recursive: true });
    }

    env.PI_CODING_AGENT_DIR = path.join(homeDir, "agent");
    fs.mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
    env.PI_OFFLINE = "1";

    return { ...env, ...extra };
}

/**
 * The window a task asked for, or null when it takes the suite default.
 *
 * Null means "write no window setting at all", which is what keeps tiers 1 to 5 producing the exact
 * config files their published runs used. Only tier 6 declares anything else.
 */
function declaredWindow(task) {
    return task?.contextWindow === 200000 ? null : (task?.contextWindow ?? null);
}

function providerConfig(proxyUrl, model, contextWindow) {
    return JSON.stringify({
        providers: {
            eval: {
                baseUrl: proxyUrl,
                api: "openai-completions",
                apiKey: "synthetic-only",
                models: [
                    {
                        id: model,
                        name: "Eval model",
                        reasoning: false,
                        input: ["text"],
                        contextWindow,
                        maxTokens: 8192,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    },
                ],
            },
        },
    });
}

// OpenCode reaches a provider through the AI SDK, so an OpenAI-compatible
// provider pointed at the logging proxy puts it on the same footing as the
// Pi family: its tool schema and offered-tool counts become visible, and its
// token accounting arrives in the same shape as everyone else's instead of
// being self-reported with cache read out separately.
function openCodeProxyConfig(proxyUrl, model, contextWindow = null) {
    return JSON.stringify(
        {
            $schema: "https://opencode.ai/config.json",
            provider: {
                eval: {
                    npm: "@ai-sdk/openai-compatible",
                    name: "Eval proxy",
                    options: { baseURL: proxyUrl, apiKey: "synthetic-only" },
                    // `limit` is added only for a task that asks for a non-default window, for the
                    // same reason Codex's is: the published OpenCode rows ran without one, and
                    // writing this suite's default into it would be a behaviour change disguised as
                    // a no-op.
                    models: {
                        [model]: {
                            name: "Eval model",
                            ...(contextWindow === null ? {} : { limit: { context: contextWindow, output: 8192 } }),
                        },
                    },
                },
            },
        },
        null,
        2,
    );
}

function waitForExit(child, timeoutMs) {
    return new Promise((resolve) => {
        const deadline = setTimeout(() => {
            child.kill();
            resolve({ timedOut: true });
        }, timeoutMs);
        child.once("close", (code) => {
            clearTimeout(deadline);
            resolve({ timedOut: false, code });
        });
        child.once("error", () => {
            clearTimeout(deadline);
            resolve({ timedOut: false, code: null });
        });
    });
}

// Oh My Pi is a Bun-based fork of Pi with its own tools and prompt. It takes
// a provider through an extension rather than models.json, so the proxy is
// registered the same way scripts/measure-context.mjs does it, and local
// rules and extensions are switched off so the bar measured is the harness
// as published rather than this machine's configuration.
function ohMyPiExtension(proxyUrl, model, contextWindow) {
    const spec = {
        baseUrl: proxyUrl,
        api: "openai-completions",
        apiKey: "synthetic-only",
        models: [
            {
                id: model,
                name: "Eval model",
                reasoning: false,
                input: ["text"],
                contextWindow,
                maxTokens: 8192,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
        ],
    };

    return `export default function (pi) {
    pi.registerProvider("eval", ${JSON.stringify(spec)});
    pi.on("session_start", async (_event, ctx) => {
        await pi.setModel(ctx.modelRegistry.find("eval", ${JSON.stringify(model)}));
    });
}
`;
}

async function runPiRpc({
    cli,
    task,
    workspaceDir,
    homeDir,
    proxyUrl,
    model,
    timeoutMs,
    setup,
    faults,
    runtime = process.execPath,
    buildArgs = null,
    // Variables an adapter must add on top of the allowlist. allowlistedEnv deliberately starts
    // from almost nothing so a harness cannot inherit the developer's environment; anything a
    // harness genuinely needs is named here by the adapter that needs it.
    extraEnv = {},
}) {
    const startedAt = Date.now();
    const agentDir = path.join(homeDir, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    let args = null;
    if (typeof buildArgs === "function") {
        args = await buildArgs({ cli, agentDir, homeDir, proxyUrl, model });
    } else {
        fs.writeFileSync(path.join(agentDir, "models.json"), providerConfig(proxyUrl, model, task.contextWindow));
        const settingsFile = path.join(agentDir, "settings.json");
        const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, "utf8")) : {};
        fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, defaultProvider: "eval", defaultModel: model }));
        args = [cli, "--mode", "rpc", "--no-session", "--provider", "eval", "--model", model];
    }

    if (typeof setup === "function") {
        await setup(agentDir);
    }

    const child = spawn(runtime, args, {
        cwd: workspaceDir,
        env: withFaultPath(allowlistedEnv(homeDir, extraEnv), faults),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });
    let output = "";
    let errors = "";
    const events = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => {
        errors += text;
    });
    child.stdout.on("data", (text) => {
        output += text;
        let newline = -1;
        while ((newline = output.indexOf("\n")) !== -1) {
            const line = output.slice(0, newline).trim();
            output = output.slice(newline + 1);
            try {
                events.push(JSON.parse(line));
            } catch {
                // Non-RPC diagnostics from packages are ignored.
            }
        }
    });
    const send = (payload) => {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
    };

    const deadline = Date.now() + timeoutMs;
    const untilAgentEnd = new Promise((resolve) => {
        const timer = setInterval(() => {
            const done = events.some((event) => event.type === "agent_end");
            const failed = events.find((event) => event.type === "extension_error");
            if (done || failed || Date.now() > deadline || child.exitCode !== null) {
                clearInterval(timer);
                resolve({ done, failed });
            }
        }, 50);
    });
    // Wait for the harness to become ready, then send one prompt.
    const readyDeadline = Date.now() + 30000;
    send({ id: "ready", type: "get_state" });
    while (Date.now() < readyDeadline) {
        if (events.some((event) => event.type === "response" && event.id === "ready")) {
            break;
        }

        if (child.exitCode !== null) {
            break;
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    send({ id: "eval", type: "prompt", message: task.prompt });
    const outcome = await untilAgentEnd;
    child.stdin.end();
    child.kill();
    await waitForExit(child, 10000);
    const eventCounts = {};
    for (const event of events) {
        eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
    }

    return {
        exitCode: outcome.failed ? 1 : 0,
        timedOut: !outcome.done && !outcome.failed,
        durationMs: Date.now() - startedAt,
        stderrTail: errors.slice(-2000),
        rpcEvents: eventCounts,
    };
}

export const OPENCODE_MODEL_MAP = {
    "deepseek-v4.1-flash": "opencode-go/deepseek-v4.1-flash",
    "muse-spark-1.3-contributor": "opencode-go/muse-spark-1.3-contributor",
};

// Logical eval model ids map onto the provider-qualified ids OpenCode
// expects. Anything already qualified (contains a slash) passes through
// untouched, so a model behind newly added credentials works without a
// code change once its frozen price is added to evals/prices.json.
export function resolveOpenCodeModel(model) {
    if (String(model).includes("/")) {
        return String(model);
    }

    const mapped = OPENCODE_MODEL_MAP[String(model)];
    if (!mapped) {
        throw new Error(
            `Unknown eval model for OpenCode: ${model}. Use a qualified id such as opencode-go/deepseek-v4.1-flash or add a mapping.`,
        );
    }

    return mapped;
}

// Codex CLI is a third-party harness like OpenCode: found where it is
// installed, never assumed. Its own home is redirected per attempt, so the
// machine's Codex config, sessions and credentials are untouched.
export function findCodexCli() {
    const configured = process.env.SPECPI_CODEX_CLI;
    if (configured && fs.existsSync(configured)) {
        return resolveWindowsBinary(configured);
    }

    const found = findOnPath("codex");

    return found ? resolveWindowsBinary(found) : undefined;
}

// Codex sends the model id to its provider verbatim, so the provider-
// qualified form the OpenCode CLI needs (opencode-go/<id>) is reduced to the
// provider's own id here. Every other id passes through untouched, which
// keeps a model behind new credentials runnable without a code change.
export function resolveCodexModel(model) {
    const qualifier = "opencode-go/";
    const text = String(model);

    return text.startsWith(qualifier) ? text.slice(qualifier.length) : text;
}

// Codex reads one TOML file for provider routing. The key named here is a
// placeholder the proxy swaps for the real credential at forward time, so no
// credential is written into the disposable home. `wire_api = "responses"`
// is the only protocol this Codex version speaks to a custom provider, which
// is why the eval proxy accepts the responses path.
export function codexConfig({ baseUrl, model, provider = "eval", contextWindow = null }) {
    return [
        `model = ${JSON.stringify(model)}`,
        `model_provider = ${JSON.stringify(provider)}`,
        'approval_policy = "never"',
        // Emitted only when a task asks for a window other than the default, so every tier below 6
        // writes the same config.toml it always has. Declaring 200000 explicitly here would be a
        // silent change to the published Codex rows -- Codex has its own idea of the window for a
        // model, and overriding it with a number that merely matches this suite's default would
        // change behaviour while looking like a no-op.
        ...(contextWindow === null ? [] : [`model_context_window = ${contextWindow}`]),
        "",
        `[model_providers.${provider}]`,
        'name = "Eval proxy"',
        `base_url = ${JSON.stringify(baseUrl)}`,
        'env_key = "CODEX_EVAL_API_KEY"',
        'wire_api = "responses"',
        "",
    ].join("\n");
}

// Windows npm installs land as .cmd shims, which Node cannot spawn without a
// shell. Only the prompt would need quoting through cmd.exe, and it travels
// on stdin, so the shim path keeps a fixed command line with no user content
// in it.
export function findClaudeCli() {
    const configured = process.env.SPECPI_CLAUDE_CLI;
    if (configured && fs.existsSync(configured)) {
        return resolveWindowsBinary(configured);
    }

    const found = findOnPath("claude");

    return found ? resolveWindowsBinary(found) : undefined;
}

/**
 * Claude Code, headless, pointed at the proxy.
 *
 * NO ANTHROPIC CREDENTIAL IS INVOLVED, and the disposable config directory is what guarantees it.
 * Claude Code normally authenticates against a stored subscription login, so a run against the
 * user's real configuration could fall back to it and bill a subscription for an eval. A fresh
 * `CLAUDE_CONFIG_DIR` has no stored login to fall back to, `ANTHROPIC_BASE_URL` points at the
 * proxy, and the proxy builds its own outbound headers and discards whatever the client sent -- so
 * the token below is a placeholder that never reaches anything. This is the same discipline the
 * Codex row uses with a disposable CODEX_HOME.
 *
 * `--dangerously-skip-permissions` is the equivalent of the SpecPi rows' yoloMode opt-in: headless
 * there is nobody to answer a prompt, and the report method discloses it rather than measuring it
 * away.
 *
 * The declared context window is absent on purpose. Claude Code exposes no setting for it -- its
 * compaction triggers off the model's own window -- so a tier that declares one cannot hold this
 * harness to it, and tier 6 reads the row as unwindowed rather than pretending otherwise.
 */
async function runClaudeCode({ task, workspaceDir, homeDir, proxyUrl, model, timeoutMs, faults }) {
    const startedAt = Date.now();
    const cli = findClaudeCli();
    if (!cli) {
        throw new Error("Claude Code CLI not found: set SPECPI_CLAUDE_CLI or put claude on PATH");
    }

    const configDir = path.join(homeDir, "claude-config");
    fs.mkdirSync(configDir, { recursive: true });
    const args = [
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--model",
        model,
    ];
    if (Number.isSafeInteger(task.turnCap) && task.turnCap > 0) {
        args.push("--max-turns", String(task.turnCap));
    }

    const child = spawnCodex(cli, args, {
        cwd: workspaceDir,
        env: withFaultPath(
            allowlistedEnv(homeDir, {
                CLAUDE_CONFIG_DIR: configDir,
                ANTHROPIC_BASE_URL: proxyUrl.replace(/\/v1$/u, ""),
                ANTHROPIC_AUTH_TOKEN: "eval-proxy",
                // Telemetry is not billing, but a disposable home has nowhere to put it and an
                // eval should not be measuring a network call it did not ask for.
                DISABLE_TELEMETRY: "1",
                DISABLE_ERROR_REPORTING: "1",
                DISABLE_AUTOUPDATER: "1",
            }),
            faults,
        ),
    });
    // Same reason as Codex: eval prompts are multi-line markdown and no Windows shell carries a
    // newline inside a quoted argument, so the prompt travels on stdin.
    child.stdin.end(task.prompt);
    let errors = "";
    child.stdout.resume();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => {
        errors += text;
    });
    const outcome = await waitForExit(child, timeoutMs);

    return {
        exitCode: outcome.timedOut ? 1 : (child.exitCode ?? 1),
        timedOut: outcome.timedOut,
        durationMs: Date.now() - startedAt,
        stderrTail: errors.slice(-2000),
    };
}

function spawnCodex(cli, args, { cwd, env }) {
    if (process.platform === "win32" && /\.(cmd|bat)$/iu.test(cli)) {
        const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
        const commandLine = [cli, ...args].map((value) => `"${value}"`).join(" ");

        return spawn(comspec, ["/d", "/s", "/c", commandLine], {
            cwd,
            env,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
    }

    return spawn(cli, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}

async function runCodex({ task, workspaceDir, homeDir, proxyUrl, model, timeoutMs, faults }) {
    const startedAt = Date.now();
    const cli = findCodexCli();
    if (!cli) {
        throw new Error("Codex CLI not found: set SPECPI_CODEX_CLI or put codex on PATH");
    }

    const codexHome = path.join(homeDir, "codex-home");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
        path.join(codexHome, "config.toml"),
        codexConfig({ baseUrl: proxyUrl, model: resolveCodexModel(model), contextWindow: declaredWindow(task) }),
    );
    // Codex's own sandbox denies every command on Windows, so the run uses
    // its full-access mode inside the attempt's disposable workspace: an
    // agent that cannot run a command cannot be measured at all. The report
    // method string discloses this, the same way it discloses the SpecPi
    // permission package's opt-in.
    const args = [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "danger-full-access",
        "-C",
        workspaceDir,
        "-",
    ];
    const child = spawnCodex(cli, args, {
        cwd: workspaceDir,
        env: withFaultPath(
            allowlistedEnv(homeDir, { CODEX_HOME: codexHome, CODEX_EVAL_API_KEY: "eval-proxy" }),
            faults,
        ),
    });
    // The prompt travels on stdin: eval prompts are multi-line markdown, and
    // no shell on Windows can carry a newline inside a quoted argument.
    child.stdin.end(task.prompt);
    let errors = "";
    child.stdout.resume();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => {
        errors += text;
    });
    const outcome = await waitForExit(child, timeoutMs);

    return {
        exitCode: outcome.timedOut ? 1 : (child.exitCode ?? 1),
        timedOut: outcome.timedOut,
        durationMs: Date.now() - startedAt,
        stderrTail: errors.slice(-2000),
    };
}

// OpenCode reports usage per step on its JSON event stream. This folds the
// stream into step counts, summed tokens, summed cost, tool-call counts and
// the session id (the first event carrying one).
export function parseOpenCodeJsonl(output) {
    const totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    let cost = 0;
    let steps = 0;
    let sessionId = null;
    const toolCalls = {};
    for (const line of String(output).split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) {
            continue;
        }

        let event = null;
        try {
            event = JSON.parse(trimmed);
        } catch {
            continue;
        }

        if (!sessionId && typeof event?.sessionID === "string") {
            sessionId = event.sessionID;
        }

        if (event?.type === "tool_use") {
            const name = event.part?.tool ?? "unknown";
            toolCalls[name] = (toolCalls[name] ?? 0) + 1;
        } else if (event?.type === "step_finish") {
            steps += 1;
            const tokens = event.part?.tokens ?? {};
            totals.input += tokens.input ?? 0;
            totals.output += tokens.output ?? 0;
            totals.reasoning += tokens.reasoning ?? 0;
            totals.cacheRead += tokens.cache?.read ?? 0;
            totals.cacheWrite += tokens.cache?.write ?? 0;
            if (Number.isFinite(event.part?.cost)) {
                cost += event.part.cost;
            }
        }
    }

    return { totals, cost, steps, toolCalls, sessionId };
}

// The CLI path comes from the flag or the environment, and both the
// availability check and the adapter read it the same way.
function findOhMyPiCli() {
    const flag = process.argv.find((argument) => argument.startsWith("--omp="));

    return flag ? flag.slice("--omp=".length) : process.env.SPECPI_OMP_CLI;
}

function findOnPath(command) {
    const directories = String(process.env.PATH ?? process.env.Path ?? "").split(path.delimiter);
    const suffixes =
        process.platform === "win32" && !path.extname(command)
            ? String(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
            : [""];
    for (const directory of directories) {
        for (const suffix of suffixes) {
            const candidate = path.join(directory || ".", `${command}${suffix}`);
            try {
                if (fs.statSync(candidate).isFile()) {
                    return candidate;
                }
            } catch {
                // Not here; keep looking.
            }
        }
    }

    return undefined;
}

export function findOpenCodeCli() {
    const configured = process.env.SPECPI_OPENCODE_CLI;
    if (configured && fs.existsSync(configured)) {
        return resolveWindowsBinary(configured);
    }

    const found = findOnPath("opencode");

    return found ? resolveWindowsBinary(found) : undefined;
}

// On Windows, global npm installs land as a .cmd shim beside a real exe
// one level down in the standard npm prefix layout. Spawning the exe
// directly keeps multi-line prompts intact; the shim path needs a shell
// and cmd.exe cannot carry newlines inside quoted arguments.
function resolveWindowsBinary(cli) {
    if (process.platform !== "win32" || !/\.(cmd|bat)$/iu.test(cli)) {
        return cli;
    }

    const directory = path.dirname(cli);
    const base = path.basename(cli, path.extname(cli));
    const siblings = [path.join(directory, `${base}.exe`)];
    if (base.toLowerCase() === "opencode") {
        siblings.push(path.join(directory, "node_modules", "opencode-ai", "bin", "opencode.exe"));
    }

    for (const candidate of siblings) {
        try {
            if (fs.statSync(candidate).isFile()) {
                return candidate;
            }
        } catch {
            // Keep looking.
        }
    }

    return cli;
}

async function runOpenCode({ task, workspaceDir, homeDir, proxyUrl, model, timeoutMs, faults, viaProxy = false }) {
    const startedAt = Date.now();
    const cli = findOpenCodeCli();
    if (!cli) {
        throw new Error("OpenCode binary not found: set SPECPI_OPENCODE_CLI or put opencode on PATH");
    }

    // Routed through the proxy the model id is ours, so the provider map that
    // exists to name OpenCode Go's ids is not consulted.
    const providerModel = viaProxy ? `eval/${model}` : resolveOpenCodeModel(model);
    // Ambient environment on purpose: OpenCode reads its own credentials
    // itself and this runner never inspects, copies or logs them. That
    // means eval sessions land in the normal OpenCode session store.
    // PWD is pinned to the workspace because OpenCode resolves its project
    // from $PWD when set, which would otherwise leak the invoker's
    // directory into the run.
    const childEnv = withFaultPath({ ...process.env, PWD: workspaceDir }, faults);
    if (viaProxy) {
        const configDir = homeDir ?? workspaceDir;
        fs.mkdirSync(configDir, { recursive: true });
        const configFile = path.join(configDir, "opencode.json");
        fs.writeFileSync(configFile, openCodeProxyConfig(proxyUrl, model, declaredWindow(task)));
        childEnv.OPENCODE_CONFIG = configFile;
    }

    // Windows npm shims (.cmd) are scripts, not executables, so they go
    // through ComSpec. Each argument travels in its own environment
    // variable, the same quoting trick the Pi harness helper uses, so
    // prompts with quotes or shell characters survive intact. (cmd.exe
    // still cannot carry newlines inside quotes, hence the .exe fast path
    // in resolveWindowsBinary above.)
    const windowsScript = process.platform === "win32" && /\.(cmd|bat)$/iu.test(cli);
    const args = ["run", task.prompt, "--model", providerModel, "--title", `Eval ${task.id}`, "--format", "json"];
    let child = null;
    if (windowsScript) {
        const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
        const env = { ...childEnv };
        const commandLine = [cli, ...args]
            .map((value, index) => {
                const name = `SPECPI_EVAL_ARG_${index}`;
                env[name] = String(value);

                return `"%${name}%"`;
            })
            .join(" ");
        child = spawn(commandLine, [], {
            cwd: workspaceDir,
            env,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            shell: comspec,
        });
    } else {
        child = spawn(cli, args, {
            cwd: workspaceDir,
            env: childEnv,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
    }

    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text) => {
        output += text;
    });
    child.stderr.on("data", (text) => {
        errors += text;
    });
    const outcome = await waitForExit(child, timeoutMs);
    const parsed = parseOpenCodeJsonl(output);
    const firstStepInput = (() => {
        for (const line of output.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("{")) {
                continue;
            }

            try {
                const event = JSON.parse(trimmed);
                if (event?.type === "step_finish" && Number.isFinite(event.part?.tokens?.input)) {
                    return event.part.tokens.input;
                }
            } catch {
                continue;
            }
        }

        return 0;
    })();

    const result = {
        exitCode: outcome.timedOut ? 1 : (child.exitCode ?? 1),
        timedOut: outcome.timedOut,
        durationMs: Date.now() - startedAt,
        stderrTail: errors.slice(-2000),
    };
    // Through the proxy there is nothing to self-report: the proxy saw every
    // request, and returning usage here would mark the attempt native and make
    // the runner prefer OpenCode's own numbers over the observed ones.
    if (viaProxy) {
        return result;
    }

    return {
        ...result,
        usage: {
            providerModel,
            steps: parsed.steps,
            inputTokens: parsed.totals.input,
            outputTokens: parsed.totals.output,
            reasoningTokens: parsed.totals.reasoning,
            cachedTokens: parsed.totals.cacheRead,
            cacheWriteTokens: parsed.totals.cacheWrite,
            nativeCost: parsed.cost,
            toolCalls: parsed.toolCalls,
            firstStepInputTokens: firstStepInput,
        },
    };
}

// The DeepSeek Harness composes its setup from stacked profile patch
// layers in its home directory. The eval adds one home-level layer that
// routes a provider at the logging proxy, mirroring the wiring proven in
// scripts/measure-context.mjs. Its auxiliary session-title request carries
// no tool schema, so reporting selects the conversation request (see
// conversationSummary in eval-proxy.mjs).
function dshPatch(proxyUrl, model, contextWindow) {
    return [
        "- id: llm-pi-ai",
        "  config:",
        "    providers:",
        "      eval:",
        "        displayName: Eval",
        "        api: openai-completions",
        `        baseURL: ${proxyUrl}`,
        "        apiKeyEnv: DSH_EVAL_API_KEY",
        "        models:",
        `          - id: ${model}`,
        "            name: Eval model",
        `            contextWindow: ${contextWindow}`,
        "- id: agent-default-model",
        "  config:",
        "    provider: eval",
        `    model: ${model}`,
        "",
    ].join("\n");
}

async function runDeepSeek({ task, workspaceDir, homeDir, proxyUrl, model, timeoutMs, faults }) {
    const startedAt = Date.now();
    const cli = process.env.SPECPI_DSH_CLI;
    if (!cli || !fs.existsSync(cli)) {
        throw new Error("DeepSeek Harness bin not found: set SPECPI_DSH_CLI to the installed bin");
    }

    const dshHome = path.join(homeDir, "dsh-home");
    fs.mkdirSync(dshHome, { recursive: true });
    fs.writeFileSync(path.join(dshHome, "cordis.patch.yml"), dshPatch(proxyUrl, model, task.contextWindow));
    // Ambient environment plus the harness home redirect: DSH reads its own
    // state under DSH_HOME and its key from the named variable, which the
    // runner sets to a proxy placeholder it never inspects.
    const child = spawn(process.execPath, [cli, "--profile", "headless", task.prompt], {
        cwd: workspaceDir,
        env: withFaultPath(
            { ...process.env, PWD: workspaceDir, DSH_HOME: dshHome, DSH_EVAL_API_KEY: "eval-proxy" },
            faults,
        ),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    let errors = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => {
        errors += text;
    });
    child.stdout.resume();
    const outcome = await waitForExit(child, timeoutMs);

    return {
        exitCode: outcome.timedOut ? 1 : (child.exitCode ?? 1),
        timedOut: outcome.timedOut,
        durationMs: Date.now() - startedAt,
        stderrTail: errors.slice(-2000),
    };
}

// The SpecPi base install (seven pinned packages) is identical for every
// attempt, so one install per runner process is cached and copied. The
// per-attempt models.json and settings are still written fresh by runPiRpc,
// which is what points each attempt at its own proxy.
let specpiBaseCache = null;

function ensureSpecpiBase() {
    if (specpiBaseCache && fs.existsSync(path.join(specpiBaseCache, "agent", "settings.json"))) {
        return { cached: true, agentDir: path.join(specpiBaseCache, "agent") };
    }

    specpiBaseCache = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-eval-base-")));
    const agentDir = path.join(specpiBaseCache, "agent");
    fs.mkdirSync(agentDir, { recursive: true });

    return { cached: false, agentDir };
}

/**
 * Everything the SpecPi rows share: one cached install of the base, a fresh copy of it into this
 * attempt's disposable home, and the permission package's explicit yoloMode opt-in. Unattended runs
 * cannot answer approval dialogs and the installed permission system fails closed to ask, so the
 * opt-in is scoped to the disposable home and disclosed in the report method rather than silently
 * measured away.
 *
 * Factored out because specpi-default, specpi-jev and the three cache-probe arms are five bodies
 * that have to agree on the install for their comparison to mean anything. Returns the agent
 * directory, or a finished attempt result when the install itself failed.
 */
/**
 * The two tools SpecPi's own extensions add over plain Pi, as a captured first request lists them.
 *
 * The install adds four. The other two, `create_goal` and `get_goal`, belong to pi-goal-x and are
 * not withdrawable this way: that package owns a tool profile and re-asserts it from its own hooks,
 * so anything taken out of the active set comes straight back. The `goal` target removes the
 * package instead.
 */
const SPECPI_ADDED_TOOLS = Object.freeze(["report_capability_gap", "request_capability"]);

const GOAL_PACKAGE_PREFIX = "npm:pi-goal-x@";

const ABLATION_EXTENSION = "specpi-eval-ablation";

/**
 * Withdraw the added tools by writing one extension into the disposable home.
 *
 * Withdrawn on `before_agent_start` as well as `session_start`, because workflow-controls sets the
 * active set at session_start for its own groups and extension load order is not ours to depend
 * on. The last hook before a request is built is the one that decides what ships.
 */
function writeToolWithdrawal(agentDir) {
    const source = [
        "// Written by the eval runner for SPECPI_EVAL_ABLATE=tools. Not part of any install.",
        `const WITHHELD = new Set(${JSON.stringify([...SPECPI_ADDED_TOOLS])});`,
        "",
        "export default function specpiEvalAblation(pi) {",
        "    const withdraw = () => {",
        '        if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") {',
        "            return;",
        "        }",
        "",
        "        const active = pi.getActiveTools();",
        "        pi.setActiveTools(active.filter((name) => !WITHHELD.has(name)));",
        "    };",
        "",
        '    pi.on("session_start", withdraw);',
        '    pi.on("before_agent_start", withdraw);',
        "}",
        "",
    ].join("\n");

    const dir = path.join(agentDir, "extensions", ABLATION_EXTENSION);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.ts"), source);
}

/**
 * Remove one or more named parts of the installed SpecPi layer, so a result can be attributed to
 * them.
 *
 * Off unless SPECPI_EVAL_ABLATE names something, so every ordinary run prepares the home exactly as
 * it always has. This exists because a SpecPi row and a plain Pi row differ by a whole installed
 * layer at once -- extensions, packages and a working agreement -- so a row that scores differently
 * cannot say which of those did it. Ablating one part and re-running can. Parts combine with
 * commas, because halves are only separately meaningful if they can also be removed together.
 *
 * `agents` drops the installed global AGENTS.md: the layer's working agreement, and on one captured
 * request 4.2 KB of the 8.5 KB SpecPi adds to a plain Pi request.
 *
 * `tools` withdraws the two tools SpecPi's own extensions add. Neither can act in an unattended run:
 * `request_capability` answers that restoring a group needs an interactive user, and
 * `report_capability_gap` that collection is undecided. Both register unconditionally, so a headless
 * session ships their schema and prompt guidance for nothing -- 3.7 KB of one captured request.
 *
 * It withdraws rather than deletes, and that is the whole reason this target can exist. Deleting
 * the extension directories does not work: `tool-wishlist` imports
 * `workflow-controls/task-contract.mjs`, so removing either fails the entire extension load and the
 * session makes no model calls -- a harness scoring zero, which reads like an ablation and is not
 * one. Withdrawing uses the same `setActiveTools` seam `/webaccess` and `/browser` already use, so
 * every extension still loads and only the tools leave the request.
 *
 * `goal` drops pi-goal-x from the home's package list, taking `create_goal` and `get_goal` with it.
 * A package rather than a withdrawal because that one re-asserts its own tool profile; see
 * SPECPI_ADDED_TOOLS. Together with `tools` it leaves exactly plain Pi's four-tool surface, which is
 * what makes a tool-surface result attributable rather than merely suggestive.
 *
 * There is still no `scope` target. /scope activates only when a human types the command and is not
 * exposed as a tool, so it is already inert in an unattended run: there is no on state to remove.
 *
 * Whether a withdrawal took effect is not taken on trust. The report's `toolsOffered` names the
 * tools the provider was actually sent, so an ablation that quietly did nothing is visible there.
 */
function ablateSpecpi(agentDir) {
    const requested = process.env.SPECPI_EVAL_ABLATE;
    if (!requested) {
        return;
    }

    const parts = requested
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    const known = new Set(["agents", "tools", "goal"]);
    for (const part of parts) {
        if (!known.has(part)) {
            throw new Error(`Unknown SPECPI_EVAL_ABLATE: ${part}. Use one or more of: ${[...known].join(", ")}`);
        }
    }

    if (parts.includes("agents")) {
        const target = path.join(agentDir, "AGENTS.md");
        if (!fs.existsSync(target)) {
            // Refuse rather than report an ablation that removed nothing: a row labelled "without
            // the working agreement" that still has it is worse than no row.
            throw new Error(`SPECPI_EVAL_ABLATE=agents found nothing to remove at ${target}`);
        }

        fs.rmSync(target, { recursive: true, force: true });
    }

    if (parts.includes("tools")) {
        // Same refusal, at the only point this one can check: the tools are registered by these two
        // extensions, so a home without them has nothing to withdraw and the row would be mislabelled.
        for (const owner of ["tool-wishlist", "workflow-controls"]) {
            const dir = path.join(agentDir, "extensions", owner);
            if (!fs.existsSync(dir)) {
                throw new Error(`SPECPI_EVAL_ABLATE=tools found no ${owner} extension at ${dir}`);
            }
        }

        writeToolWithdrawal(agentDir);
    }

    if (parts.includes("goal")) {
        const settingsFile = path.join(agentDir, "settings.json");
        const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
        const packages = Array.isArray(settings.packages) ? settings.packages : [];
        const kept = packages.filter((entry) => !String(entry).startsWith(GOAL_PACKAGE_PREFIX));
        if (kept.length === packages.length) {
            // The same refusal the other targets make: a row labelled "without the goal package"
            // that still has it is worse than no row.
            throw new Error(`SPECPI_EVAL_ABLATE=goal found no ${GOAL_PACKAGE_PREFIX}* entry in ${settingsFile}`);
        }

        fs.writeFileSync(settingsFile, `${JSON.stringify({ ...settings, packages: kept }, null, 4)}\n`);
    }
}

async function prepareSpecpiHome({ workspaceDir, homeDir }) {
    const { runPiFixture } = await import("./pi-test-harness.mjs");
    const base = ensureSpecpiBase();
    if (!base.cached) {
        // piCommand must be the installer itself: runPiFixture executes piCommand, and Pi has no
        // install --yes flag. The installer locates Pi through SPECPI_PI instead.
        const install = runPiFixture(path.join(root, "scripts", "specpi.mjs"), {
            piCommand: path.join(root, "scripts", "specpi.mjs"),
            cwd: workspaceDir,
            agentDir: base.agentDir,
            args: ["install", "--yes", "--skip-browser-install"],
            env: { SPECPI_PI: piCli },
            timeout: 300000,
        });
        if (install.status !== 0) {
            specpiBaseCache = null;

            return {
                failure: {
                    exitCode: 1,
                    timedOut: false,
                    durationMs: install.durationMs,
                    stderrTail: install.stderr.slice(-2000),
                },
            };
        }
    }

    const agentDir = path.join(homeDir, "agent");
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.cpSync(base.agentDir, agentDir, { recursive: true });
    ablateSpecpi(agentDir);
    const permissionDir = path.join(agentDir, "extensions", "pi-permission-system");
    fs.mkdirSync(permissionDir, { recursive: true });
    fs.writeFileSync(path.join(permissionDir, "config.json"), JSON.stringify({ yoloMode: true }));

    return { agentDir };
}

/**
 * Systems the specpi-jev row measures, and the one it deliberately does not.
 *
 * `capability` is off on purpose rather than by omission: turn-zero capability arming needs an
 * interactive human to confirm and refuses without one, exactly as `request_capability` does, so a
 * headless run that enabled it would spend nothing, do nothing, and still publish a row implying it
 * had been exercised.
 *
 * The command guard is absent because it is no longer part of the layer: it is the separate
 * `specpi-jev-guard` package, which these disposable homes do not install and which this row
 * therefore does not measure.
 *
 * Compaction guidance is absent because it was withdrawn. Two tier-6 runs measured the arm carrying
 * it solving fewer long-session tasks than plain SpecPi -- 14/16 against 8/16 pooled, Fisher exact
 * p = 0.054 -- while accounting for 55 of the 56 verdicts the layer applied over those attempts.
 * The runs that carried it are kept in the published tier-6 record rather than deleted, because a
 * measurement that led to a removal is the reason the removal can be defended.
 */
const JEV_EVAL_SYSTEMS = Object.freeze({
    retention: true,
    gap: true,
    sources: false,
    progress: true,
    untrusted: true,
    capability: false,
});

/**
 * The advisor settings for a disposable eval home, built from the advisor's own current default and
 * checked against what the advisor will actually read back.
 *
 * Composed rather than written as a literal, and then verified. A literal is how this file came to
 * run every published tier with a system it believed it had enabled switched off: it carried a
 * hardcoded `schema: 2` under a comment saying it had to track config.mjs, config.mjs moved on, and
 * the migration for that number read a preference from a key this shape has never had. Nothing
 * compared the result to the ask, so the row kept reporting a layer larger than the one it ran.
 *
 * The throw is the point. A settings file that silently resolves to less than it asked for measures
 * plain SpecPi in the specpi-jev row, and a run that does that should stop rather than publish.
 */
function jevSettings() {
    const settings = {
        ...defaultSettings(),
        master: true,
        startup: true,
        systems: { ...JEV_EVAL_SYSTEMS },
        // The shipped defaults, imported rather than copied. This row is meant to measure the
        // configuration a user actually gets, so a budget invented for the eval would measure
        // something nobody runs -- and a copy that drifted would do the same thing while still
        // looking correct.
        budgets: { ...DEFAULT_BUDGETS },
        // Ships on "notify" for users, because the calibration corpus does not yet support steering
        // a model on a mid-session verdict. The eval runs headless, where a notification reaches
        // nobody, so measuring the notify path would measure the cost of the system and none of its
        // effect. Set to "message" here and disclosed in the report method, exactly as yoloMode is:
        // this run is how the default earns the right to change.
        progressNudge: "message",
    };

    const resolved = normalizeSettings(settings);
    if (!resolved.master) {
        throw new Error("jev settings resolved with the master switch off");
    }

    for (const [name, wanted] of Object.entries(JEV_EVAL_SYSTEMS)) {
        if (resolved.systems[name] !== wanted) {
            throw new Error(
                `jev settings asked for ${name}=${wanted} but the advisor reads it as ` +
                    `${resolved.systems[name]} -- schema drift in extensions/jev-advisor/config.mjs`,
            );
        }
    }

    return resolved;
}

// Proxy harnesses (Pi family, DeepSeek Harness) reach the OpenCode Go
// subscription through the logging proxy, and that endpoint only routes
// requests carrying a live OpenCode session id. Minting one tiny session
// per attempt keeps every attempt independent; its usage is recorded on
// the attempt so the mint cost stays visible instead of silently
// subsidizing proxy harnesses next to OpenCode's self-managed sessions.
// Minting writes to OpenCode's own session store, which is a single database
// shared by every process on the machine. Running harnesses side by side made
// several mints land at once and SQLite rejected them with "database is
// locked", which surfaced as an attempt that never made a model call and was
// then scored as a task failure. Retrying with a spread-out backoff keeps a
// parallel run honest; the alternative is silently publishing launch failures
// as though the harness had tried and lost.
const MINT_ATTEMPTS = 5;

function isBusyError(message) {
    return /database is locked|SQLITE_BUSY|database table is locked/iu.test(String(message));
}

export async function mintOpenCodeSession(options) {
    let last = null;
    for (let attempt = 1; attempt <= MINT_ATTEMPTS; attempt += 1) {
        try {
            return await mintOnce(options);
        } catch (error) {
            last = error;
            if (!isBusyError(error?.message) || attempt === MINT_ATTEMPTS) {
                throw error;
            }

            // Jittered, so two processes that collide do not retry in step.
            const wait = 400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 400);
            await new Promise((resolve) => setTimeout(resolve, wait));
        }
    }

    throw last;
}

async function mintOnce({ workspaceDir, model, timeoutMs = 120000 }) {
    const startedAt = Date.now();
    const cli = findOpenCodeCli();
    if (!cli) {
        throw new Error("OpenCode binary not found: set SPECPI_OPENCODE_CLI or put opencode on PATH");
    }

    const providerModel = resolveOpenCodeModel(model);
    const windowsScript = process.platform === "win32" && /\.(cmd|bat)$/iu.test(cli);
    if (windowsScript) {
        throw new Error(`Refusing to mint through a shell shim (multi-line prompts do not survive cmd.exe): ${cli}`);
    }

    const child = spawn(
        cli,
        ["run", "Reply with ok.", "--model", providerModel, "--title", "Eval session", "--format", "json"],
        {
            cwd: workspaceDir,
            env: { ...process.env, PWD: workspaceDir },
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        },
    );
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text) => {
        output += text;
    });
    child.stderr.on("data", (text) => {
        errors += text;
    });
    const outcome = await waitForExit(child, timeoutMs);
    if (outcome.timedOut) {
        throw new Error("OpenCode session mint timed out");
    }

    const parsed = parseOpenCodeJsonl(output);
    if (!parsed.sessionId) {
        throw new Error(`OpenCode session mint produced no session: ${errors.slice(-500)}`);
    }

    return {
        sessionId: parsed.sessionId,
        durationMs: Date.now() - startedAt,
        inputTokens: parsed.totals.input,
        outputTokens: parsed.totals.output,
        reasoningTokens: parsed.totals.reasoning,
        cachedTokens: parsed.totals.cacheRead,
        cacheWriteTokens: parsed.totals.cacheWrite,
        nativeCost: parsed.cost,
    };
}

// Read off the recorded t3-cascade-ledger runs: the prefix is past 20k tokens by request 6, so a
// flip there has a large warm prefix to lose, and enough requests follow to watch it re-warm.
export const PROBE_FLIP_TURN = 6;

export const CACHE_PROBE_ARMS = Object.freeze({
    "probe-control": {
        label: "Cache probe: never armed",
        detail: "SpecPi base with Browser QA withdrawn for the whole session",
        prepare: () => {},
    },
    "probe-flip": {
        label: `Cache probe: armed at turn ${PROBE_FLIP_TURN}`,
        detail: "SpecPi base with a fixture extension that adds Browser QA's tools mid-session",
        prepare: (agentDir) => {
            // Pi auto-discovers <agent-dir>/extensions/<name>/index.ts. The fixture is copied in
            // rather than written inline so what ran is a reviewable file in the repository.
            const directory = path.join(agentDir, "extensions", "cache-probe");
            fs.mkdirSync(directory, { recursive: true });
            fs.copyFileSync(
                path.join(root, "evals", "lib", "cache-probe", "flip.ts"),
                path.join(directory, "index.ts"),
            );
        },
    },
    "probe-armed": {
        label: "Cache probe: armed from turn 1",
        detail: "SpecPi base with Browser QA's own startup preference switched on",
        prepare: (agentDir) => {
            // Browser QA's own documented preference file, which is what `/browser startup on`
            // writes. Nothing here reaches around the package to force its tools active.
            const directory = path.join(agentDir, "specpi", "browser-qa");
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(
                path.join(directory, "settings.json"),
                `${JSON.stringify({ schema: 1, startupActivation: true })}\n`,
            );
        },
    },
});

/**
 * Read the advisor's own audit trail out of an attempt's disposable home. Without this the only
 * evidence a system did anything is a cost delta it may not have caused, which for a layer whose
 * whole claim is "it pays for itself" is not evidence at all.
 *
 * The file is parsed here rather than through ledger.mjs's own reader because that reader resolves
 * its path from this process's PI_CODING_AGENT_DIR, which is the developer's directory, not the
 * attempt's. The rollup is still the ledger's own function so the line shape lives in one place.
 */
function readAdvisorLedger(homeDir) {
    try {
        const file = path.join(homeDir, "agent", "specpi", "jev", "transmissions.jsonl");
        if (!fs.existsSync(file)) {
            return null;
        }

        const entries = fs
            .readFileSync(file, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => {
                try {
                    return JSON.parse(line);
                } catch {
                    return undefined;
                }
            })
            .filter(Boolean);

        return summarizeLedger(entries);
    } catch {
        // The ledger is evidence, not plumbing. Losing it must never fail the attempt.
        return null;
    }
}

export const harnessAdapters = {
    fake: {
        id: "fake",
        label: "Fake (reference solution)",
        isAvailable: () => ({ available: true, detail: "built-in reference solver" }),
        run: async ({ task, workspaceDir }) => {
            const startedAt = Date.now();
            await runReferenceSolution(task, workspaceDir);

            return { exitCode: 0, timedOut: false, durationMs: Date.now() - startedAt, stderrTail: "" };
        },
    },
    "failing-fake": {
        id: "failing-fake",
        label: "Fake (always fails)",
        isAvailable: () => ({ available: true, detail: "built-in negative control" }),
        run: async () => {
            return { exitCode: 0, timedOut: false, durationMs: 1, stderrTail: "" };
        },
    },
    pi: {
        id: "pi",
        label: "Pi (stock)",
        needsProxySession: true,
        isAvailable: () => {
            if (!fs.existsSync(piCli)) {
                return { available: false, detail: `missing pinned Pi CLI at ${piCli}` };
            }

            return { available: true, detail: `pinned Pi CLI ${piCli}` };
        },
        run: async ({ task, workspaceDir, homeDir, proxyUrl, model, timeoutMs, faults }) => {
            const stockDir = path.join(homeDir, "agent");
            fs.mkdirSync(stockDir, { recursive: true });

            return runPiRpc({ cli: piCli, task, workspaceDir, homeDir, proxyUrl, model, timeoutMs, faults });
        },
    },
    "specpi-default": {
        id: "specpi-default",
        label: "SpecPi default",
        needsProxySession: true,
        isAvailable: () => {
            if (!fs.existsSync(piCli)) {
                return { available: false, detail: `missing pinned Pi CLI at ${piCli}` };
            }

            return { available: true, detail: "SpecPi base via installer into disposable home" };
        },
        run: async ({ task, workspaceDir, homeDir, proxyUrl, model, timeoutMs, faults }) => {
            const prepared = await prepareSpecpiHome({ workspaceDir, homeDir });
            if (prepared.failure) {
                return prepared.failure;
            }

            return runPiRpc({ cli: piCli, task, workspaceDir, homeDir, proxyUrl, model, timeoutMs, faults });
        },
    },
    // SpecPi with the Jev advisor switched on. Everything else is identical to specpi-default, so
    // the pair is a controlled comparison: same install, same model, same frozen prices, same
    // tasks, with only the advisor changing.
    //
    // The advisor is pointed at the eval proxy rather than straight at api.typesafe.ai, so its
    // calls land in the same log as the model's. That is what lets the cost column include the
    // advisor: a row whose advisor spend was invisible would look cheaper than the plain SpecPi
    // row for no reason other than where its traffic went.
    "specpi-jev": {
        id: "specpi-jev",
        label: "SpecPi + Jev",
        needsProxySession: true,
        isAvailable: () => {
            if (!fs.existsSync(piCli)) {
                return { available: false, detail: `missing pinned Pi CLI at ${piCli}` };
            }

            if (!process.env.OPENROUTER_API_KEY && !process.env.TYPESAFE_API_KEY) {
                return { available: false, detail: "OPENROUTER_API_KEY is not set" };
            }

            return { available: true, detail: "SpecPi base with the Jev advisor enabled, priced through the proxy" };
        },
        run: async ({ task, workspaceDir, homeDir, proxyUrl, model, timeoutMs, faults }) => {
            const prepared = await prepareSpecpiHome({ workspaceDir, homeDir });
            if (prepared.failure) {
                return prepared.failure;
            }

            const agentDir = prepared.agentDir;
            // The advisor asks a human before its first transmission and refuses without a UI, so
            // an unattended run would otherwise send nothing and measure the same thing twice. The
            // grant is written explicitly into the disposable home and disclosed in the report
            // method, exactly as yoloMode is, so the gate is never silently measured away.
            const jevDir = path.join(agentDir, "specpi", "jev");
            fs.mkdirSync(jevDir, { recursive: true });
            fs.writeFileSync(path.join(jevDir, "settings.json"), `${JSON.stringify(jevSettings(), null, 4)}\n`);
            fs.writeFileSync(
                path.join(jevDir, "consent.json"),
                JSON.stringify(
                    {
                        schema: CONSENT_SCHEMA,
                        granted: true,
                        origin: new URL(proxyUrl).origin,
                        // Must equal endpointLabel() in the advisor, which is the host of the base
                        // URL the advisor will actually post to. Here that is the eval proxy, not
                        // openrouter.ai. A mismatch makes the grant unreadable and the advisor
                        // silently sends nothing, which would measure plain SpecPi twice.
                        endpoint: new URL(proxyUrl.replace(/\/v1$/u, "")).host,
                        maxStateBytes: 1024,
                        grantedAt: new Date().toISOString(),
                    },
                    null,
                    4,
                ),
            );

            const outcome = await runPiRpc({
                cli: piCli,
                task,
                workspaceDir,
                homeDir,
                proxyUrl,
                model,
                timeoutMs,
                faults,
                extraEnv: {
                    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? process.env.TYPESAFE_API_KEY,
                    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
                    JEV_BACKEND: process.env.JEV_BACKEND,
                    // client.mjs appends /v1/systemone, and proxyUrl already ends in /v1, so the
                    // suffix is trimmed here rather than producing /v1/v1/systemone.
                    TYPESAFE_BASE_URL: proxyUrl.replace(/\/v1$/u, ""),
                },
            });

            // Read before the runner deletes the home. The proxy already counts the calls; this is
            // the half the proxy cannot see, because whether an answer was taken happens inside
            // the session.
            return { ...outcome, advisorLedger: readAdvisorLedger(homeDir) };
        },
    },
    // Phase 7 cache probe. Three arms that differ in exactly one thing: when Browser QA's fourteen
    // tools reach the request. Never (control), at one fixed mid-session turn (flip), or from the
    // first request (armed). Everything else -- install, model, prices, task, permission posture --
    // is the shared SpecPi base, because the whole point is to price one mechanism rather than to
    // rank three configurations.
    //
    // What each pair says:
    //   control vs armed  the standing cost of carrying a schema the session never uses
    //   control vs flip   what a mid-session activation actually costs, which is the number the
    //                     "no mid-session tool-set change" rule has always been asserted from
    //   flip vs armed     whether paying up front is cheaper than paying when the need appears
    //
    // Browser QA is the right subject and not an arbitrary one: it is the largest schema SpecPi
    // installs (about 8.7 KB), it is withdrawn by default, and it is the capability
    // `request_capability` exists to ask for.
    ...Object.fromEntries(
        Object.entries(CACHE_PROBE_ARMS).map(([id, arm]) => [
            id,
            {
                id,
                label: arm.label,
                needsProxySession: true,
                isAvailable: () => {
                    if (!fs.existsSync(piCli)) {
                        return { available: false, detail: `missing pinned Pi CLI at ${piCli}` };
                    }

                    return { available: true, detail: arm.detail };
                },
                run: async ({ task, workspaceDir, homeDir, proxyUrl, model, timeoutMs, faults }) => {
                    const prepared = await prepareSpecpiHome({ workspaceDir, homeDir });
                    if (prepared.failure) {
                        return prepared.failure;
                    }

                    arm.prepare(prepared.agentDir);

                    return runPiRpc({
                        cli: piCli,
                        task,
                        workspaceDir,
                        homeDir,
                        proxyUrl,
                        model,
                        timeoutMs,
                        faults,
                        // The fixture and the analysis have to agree on which turn flipped, so the
                        // number is passed rather than written down twice.
                        extraEnv: { SPECPI_PROBE_FLIP_TURN: String(PROBE_FLIP_TURN) },
                    });
                },
            },
        ]),
    ),
    omp: {
        id: "omp",
        label: "Oh My Pi",
        isAvailable: () => {
            const cli = findOhMyPiCli();
            if (!cli) {
                return { available: false, detail: "set --omp=<path to cli.js> or SPECPI_OMP_CLI" };
            }

            if (!fs.existsSync(cli)) {
                return { available: false, detail: `no Oh My Pi CLI at ${cli}` };
            }

            // It is a Bun fork, so an installed CLI without the runtime still
            // cannot run and should say which half is missing.
            const runtime = process.env.SPECPI_OMP_RUNTIME ?? "bun";
            if (!path.isAbsolute(runtime) && !findOnPath(runtime)) {
                return { available: false, detail: `Oh My Pi needs ${runtime} on PATH` };
            }

            return { available: true, detail: cli };
        },
        needsProxySession: true,
        run: async ({ task, workspaceDir, homeDir, proxyUrl, model, timeoutMs, faults }) => {
            const cli = findOhMyPiCli();

            return runPiRpc({
                cli,
                task,
                workspaceDir,
                homeDir,
                proxyUrl,
                model,
                timeoutMs,
                faults,
                runtime: process.env.SPECPI_OMP_RUNTIME ?? "bun",
                // The provider arrives as an extension, and local rules and
                // extensions are off so the row is the harness as published
                // rather than whatever this machine happens to have installed.
                buildArgs: async ({ agentDir }) => {
                    const helper = path.join(agentDir, "eval-provider.ts");
                    fs.writeFileSync(helper, ohMyPiExtension(proxyUrl, model, task.contextWindow));

                    return [cli, "--mode", "rpc", "--no-session", "--no-rules", "--no-extensions", "-e", helper];
                },
            });
        },
    },
    opencode: {
        id: "opencode",
        label: "OpenCode",
        needsProxySession: true,
        isAvailable: () => {
            const cli = findOpenCodeCli();
            if (!cli) {
                return { available: false, detail: "set SPECPI_OPENCODE_CLI or put opencode on PATH" };
            }

            return { available: true, detail: `${cli} (via proxy)` };
        },
        run: async (options) => runOpenCode({ ...options, viaProxy: true }),
    },
    // The self-reporting wiring is kept as its own harness rather than
    // deleted: it is the control that says whether routing OpenCode through
    // the proxy changed how it behaves, and it is the only row that can
    // cross-check the proxy's accounting against a provider's own invoice.
    "opencode-native": {
        id: "opencode-native",
        label: "OpenCode (native)",
        isAvailable: () => {
            const cli = findOpenCodeCli();
            if (!cli) {
                return { available: false, detail: "set SPECPI_OPENCODE_CLI or put opencode on PATH" };
            }

            return { available: true, detail: `${cli} (self-reported usage)` };
        },
        run: runOpenCode,
    },
    codex: {
        id: "codex",
        label: "Codex CLI",
        needsProxySession: true,
        isAvailable: () => {
            const cli = findCodexCli();
            if (!cli) {
                return { available: false, detail: "set SPECPI_CODEX_CLI or put codex on PATH" };
            }

            return { available: true, detail: cli };
        },
        run: runCodex,
    },
    "claude-code": {
        id: "claude-code",
        label: "Claude Code",
        needsProxySession: true,
        isAvailable: () => {
            const cli = findClaudeCli();
            if (!cli) {
                return { available: false, detail: "set SPECPI_CLAUDE_CLI or put claude on PATH" };
            }

            return { available: true, detail: cli };
        },
        run: runClaudeCode,
    },
    dsh: {
        id: "dsh",
        label: "DeepSeek Harness",
        needsProxySession: true,
        isAvailable: () => {
            const cli = process.env.SPECPI_DSH_CLI;
            if (!cli) {
                return { available: false, detail: "set SPECPI_DSH_CLI to the installed bin" };
            }

            if (!fs.existsSync(cli)) {
                return { available: false, detail: `no DeepSeek Harness bin at ${cli}` };
            }

            return { available: true, detail: cli };
        },
        run: runDeepSeek,
    },
};

export function resolveHarnesses(requested) {
    if (!requested || requested.length === 0) {
        return [harnessAdapters.fake, harnessAdapters["failing-fake"]];
    }

    return requested.map((id) => {
        const adapter = harnessAdapters[id];
        if (!adapter) {
            throw new Error(`Unknown harness: ${id}. Known: ${Object.keys(harnessAdapters).join(", ")}`);
        }

        return adapter;
    });
}

export function isolatedHome() {
    const homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-eval-")));

    return homeDir;
}
