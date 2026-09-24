#!/usr/bin/env node
// Measure real first requests from stock Pi and the complete installed SpecPi base.
// Network is used only to acquire the exact default packages in a disposable home.
// No live Pi state or provider credentials are read. The model endpoint is localhost.
// Usage: node scripts/measure-context.mjs [--chart] [--json] [--omp=<path to Oh My Pi's cli.js>]
//          [--oc=<path to OpenCode's binary>] [--dsh=<path to the DeepSeek Harness bin>]
// --chart also saves the bounded measurement artifact used by the chart renderer, and requires
// --omp, --oc and --dsh because the chart carries the measured Oh My Pi, OpenCode and DeepSeek
// Harness rows.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runPiFixture } from "./pi-test-harness.mjs";
import { basePackages, checkBasePackages } from "./packages.mjs";
import { writeChart } from "./context-chart.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const piRoot = path.join(root, "node_modules/@earendil-works/pi-coding-agent");
const piCli = path.join(piRoot, "dist/cli.js");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version;
const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-context-")));
const workspace = path.join(directory, "workspace");
const agentDir = path.join(directory, "agent");
const stockDir = path.join(directory, "stock");
for (const dir of [workspace, agentDir, stockDir]) {
    fs.mkdirSync(dir);
}

// Oh My Pi is a separate harness with its own runtime, so it is opt-in rather than a
// dependency: point --omp at an installed cli.js to measure it on these same terms.
const ompFlag = process.argv.find((argument) => argument.startsWith("--omp="));
const ompCli = ompFlag ? path.resolve(ompFlag.slice("--omp=".length)) : process.env.SPECPI_OMP_CLI;
const ompRuntime = process.env.SPECPI_OMP_RUNTIME ?? "bun";
const ompVersion = ompCli ? readPackageVersion(path.resolve(ompCli, "..", "..")) : undefined;

// OpenCode is likewise a separate harness, published as a compiled Bun binary: opt-in via
// --oc or SPECPI_OPENCODE_CLI so it is measured where it is installed, never assumed.
const ocFlag = process.argv.find((argument) => argument.startsWith("--oc="));
const ocCli = ocFlag ? path.resolve(ocFlag.slice("--oc=".length)) : process.env.SPECPI_OPENCODE_CLI;
const ocVersion = ocCli ? readPackageVersion(path.resolve(ocCli, "..", "..")) : undefined;

// The DeepSeek Harness is a separate Node application with its own profile composition,
// reached the same way: --dsh or SPECPI_DSH_CLI point at its installed bin.
const dshFlag = process.argv.find((argument) => argument.startsWith("--dsh="));
const dshCli = dshFlag ? path.resolve(dshFlag.slice("--dsh=".length)) : process.env.SPECPI_DSH_CLI;
const dshVersion = dshCli ? readPackageVersion(path.resolve(dshCli, "..", "..")) : undefined;

const npmrc = path.join(directory, "npmrc");
fs.writeFileSync(npmrc, "");
const installEnv = {
    SPECPI_PI: piCli,
    NPM_CONFIG_USERCONFIG: npmrc,
    npm_config_cache: path.join(directory, "npm-cache"),
};
for (const name of Object.keys(process.env)) {
    if (name.toLowerCase() === "npm_config_cache") {
        installEnv[name] = installEnv.npm_config_cache;
    }
}

/** The installed version beside a harness CLI, so a row names what it measured. */
function readPackageVersion(packageRoot) {
    try {
        return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
    } catch {
        return undefined;
    }
}

function run(file, args) {
    const result = runPiFixture(file, {
        piCommand: file,
        cwd: workspace,
        agentDir,
        args,
        env: installEnv,
        timeout: 900_000,
    });
    assert.equal(result.status, 0, `${result.error?.message || ""}\n${result.stdout}\n${result.stderr}`);

    return result.stdout;
}

// An allowlisted environment prevents ambient provider settings and personal discovery.
function environment(selectedAgentDir) {
    const env = {};
    for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT"]) {
        if (process.env[name]) {
            env[name] = process.env[name];
        }
    }

    for (const name of ["HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR"]) {
        env[name] = directory;
    }

    for (const name of ["APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
        env[name] = path.join(directory, name);
        fs.mkdirSync(env[name], { recursive: true });
    }

    env.PI_CODING_AGENT_DIR = selectedAgentDir;
    env.PI_OFFLINE = "1";

    return env;
}

function providerSpec(url) {
    return {
        baseUrl: url,
        api: "openai-completions",
        apiKey: "synthetic-only",
        models: [
            {
                id: "measure-model",
                name: "Measurement model",
                reasoning: false,
                input: ["text"],
                contextWindow: 200000,
                maxTokens: 8192,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
        ],
    };
}

function providerConfig(url) {
    return JSON.stringify({ providers: { measure: providerSpec(url) } });
}

// Oh My Pi keeps Pi's extension API but not necessarily its settings schema, which this
// repository does not own. Registering the provider from inside the harness asks only for
// the documented extension surface, so the fork selects the model exactly as a configured
// session would.
function providerExtension(url) {
    return `export default function (pi) {
    pi.registerProvider("measure", ${JSON.stringify(providerSpec(url))});
    pi.on("session_start", async (_event, ctx) => {
        await pi.setModel(ctx.modelRegistry.find("measure", "measure-model"));
    });
}
`;
}

// Records the first request and answers it with the shortest valid stream, so the harness
// completes one turn and nothing after it is measured.
async function startProvider() {
    const requests = [];
    const server = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) {
            chunks.push(chunk);
        }

        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        requests.push(body);
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const event = (choices) => ({
            id: "measure",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices,
        });
        response.write(
            `data: ${JSON.stringify(event([{ index: 0, delta: { role: "assistant", content: "ok" } }]))}\n\n`,
        );
        response.write(`data: ${JSON.stringify(event([{ index: 0, delta: {}, finish_reason: "stop" }]))}\n\n`);
        response.end("data: [DONE]\n\n");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    return {
        requests,
        url: `http://127.0.0.1:${server.address().port}/v1`,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

/** Tool schemas and instruction text from one recorded request body. */
/**
 * Where a Pi request's instruction characters go, split at the section openings Pi's system prompt
 * builder emits: plain headings in the pinned Pi, XML-style tags in later releases. Each section runs
 * to the next one; the preamble and working directory are `other`. Pi rows only: foreign harnesses
 * structure their prompts differently, and a breakdown of theirs would be a guess.
 */
const SECTION_MARKERS = Object.freeze({
    tools: ["<tools>", "Available tools:"],
    guidelines: ["<rules>", "Guidelines:"],
    docs: ["<docs>", "Pi documentation ("],
    project_context: ["<project_context>"],
    skills: ["<skills>", "The following skills provide"],
    other: ["<cwd>", "Current working directory:"],
});

function instructionSections(text) {
    const starts = [];
    for (const [name, markers] of Object.entries(SECTION_MARKERS)) {
        const found = markers.map((marker) => text.indexOf(marker)).filter((index) => index !== -1);
        if (found.length > 0) {
            starts.push({ name, index: Math.min(...found) });
        }
    }

    starts.sort((a, b) => a.index - b.index);
    const sections = Object.fromEntries(Object.keys(SECTION_MARKERS).map((name) => [name, 0]));
    sections.other = starts[0]?.index ?? text.length;
    starts.forEach(({ name, index }, position) => {
        sections[name] += (starts[position + 1]?.index ?? text.length) - index;
    });

    return sections;
}

function summarize(body) {
    const tools = body.tools ?? [];
    const instructions = body.messages.filter((message) => ["system", "developer"].includes(message.role));
    assert.ok(
        instructions.every((message) => typeof message.content === "string"),
        "Unexpected instruction encoding",
    );
    const instructionText = instructions.map((message) => message.content).join("");

    return {
        tools,
        instructionText,
        toolCount: tools.length,
        toolNames: tools.map((tool) => tool.function.name).sort(),
        toolChars: Object.fromEntries(tools.map((tool) => [tool.function.name, JSON.stringify(tool).length])),
        toolSchemaChars: JSON.stringify(tools).length,
        instructionChars: instructionText.length,
        requestSha256: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    };
}

async function measure(label, selectedAgentDir, enabled = false) {
    const provider = await startProvider();
    const { requests } = provider;
    // Configured local model, not a parent-only runtime override: delegation must
    // be able to resolve the same provider through its normal isolated SDK path.
    fs.writeFileSync(path.join(selectedAgentDir, "models.json"), providerConfig(provider.url));
    const settingsFile = path.join(selectedAgentDir, "settings.json");
    const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile)) : {};
    fs.writeFileSync(
        settingsFile,
        JSON.stringify({ ...settings, defaultProvider: "measure", defaultModel: "measure-model" }),
    );
    const child = spawn(
        process.execPath,
        [piCli, "--mode", "rpc", "--no-session", "--provider", "measure", "--model", "measure-model"],
        {
            cwd: workspace,
            env: environment(selectedAgentDir),
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        },
    );
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
        let newline;
        while ((newline = output.indexOf("\n")) !== -1) {
            const line = output.slice(0, newline).trim();
            output = output.slice(newline + 1);
            try {
                events.push(JSON.parse(line));
            } catch {
                // Some packages print non-RPC startup diagnostics.
            }
        }
    });
    const closed = new Promise((resolve) => child.once("close", resolve));
    let launchError;
    child.on("error", (error) => {
        launchError = error;
    });
    async function until(predicate) {
        const deadline = Date.now() + 90_000;
        while (!predicate()) {
            assert.ok(!launchError, String(launchError));
            assert.equal(child.exitCode, null, `${label} exited: ${errors}`);
            assert.ok(Date.now() < deadline, `${label} timed out: ${errors}`);
            const failure = events.find(
                (event) => event.type === "extension_error" || (event.type === "response" && event.success === false),
            );
            assert.ok(!failure, JSON.stringify(failure));
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }

    async function command(id, type, extra = {}) {
        child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
        await until(() => events.some((event) => event.type === "response" && event.id === id));
        const result = events.find((event) => event.type === "response" && event.id === id);
        assert.equal(result.success, true, JSON.stringify(result));

        return result;
    }

    try {
        await command("ready", "get_state");
        if (enabled) {
            await command("browser", "prompt", { message: "/browser on" });
            await command("delegate", "prompt", { message: "/delegate on" });
            await command("webaccess", "prompt", { message: "/webaccess on" });
        }

        assert.equal(requests.length, 0, "Activation commands must not call a model");
        await command("measure", "prompt", { message: "Reply with ok." });
        await until(() => requests.length > 0);
        await until(() => events.some((event) => event.type === "agent_end"));
        assert.equal(requests.length, 1, "Exactly one model request expected");
        assert.ok(!events.some((event) => event.type === "extension_error"), "Extension failed during measurement");
        const { tools, instructionText, ...summary } = summarize(requests[0]);
        if (process.env.SPECPI_DEBUG_INSTRUCTIONS) {
            fs.writeFileSync(
                path.join(root, ".specpi-test", `instructions-${label.replace(/\W+/gu, "-")}.txt`),
                instructionText,
            );
        }

        const { toolNames } = summary;
        if (selectedAgentDir === agentDir) {
            assert.ok(instructionText.includes("SpecPi Working Agreement"), "Installed AGENTS guidance missing");
            // The improvement skill runs only from a /harness-improvement selection, so it is kept out
            // of the model's skill list; `check:pi-package` still proves Pi discovers it.
            assert.ok(!instructionText.includes("specpi-improve"), "Improvement skill leaked into the prompt");
            assert.equal(toolNames.includes("browser_open"), enabled);
            assert.equal(
                toolNames.includes("delegate"),
                enabled,
                JSON.stringify({ toolNames, events: events.filter((event) => event.type === "extension_ui_request") }),
            );
            // An interactive session with collection undecided can still be asked for consent, so the
            // observation tool and the capability request are offered. The authoring tools need a
            // human /harness-improvement selection, and there is none here. Optional capabilities
            // ship hidden: the enabled profile opted browser QA, delegation and web access in; the
            // default profile must contain none of them.
            for (const tool of ["report_capability_gap", "request_capability", "background"]) {
                assert.ok(toolNames.includes(tool), `Installed tool missing: ${tool}`);
            }

            for (const tool of ["record_harness_contract", "finish_harness_improvement"]) {
                assert.ok(!toolNames.includes(tool), `Authoring tool offered without a selection: ${tool}`);
            }

            for (const tool of ["web_search", "source_check", "fetch_content", "get_search_content"]) {
                assert.equal(toolNames.includes(tool), enabled, `${tool} visibility mismatch`);
            }
        }

        return {
            label,
            harness: "Pi",
            ...summary,
            instructionSections: instructionSections(instructionText),
            installedGuidance: selectedAgentDir === agentDir,
            browserAndDelegationEnabled: enabled,
        };
    } finally {
        child.stdin.end();
        child.kill();
        await closed;
        await provider.close();
    }
}

// Oh My Pi is a separate harness rather than a SpecPi dependency: a Bun-based fork of Pi
// with its own tools, skills and prompt built in. It is measured as installed, on the same
// terms as the rows above -- one synthetic provider, one empty workspace, this machine's own
// configuration excluded -- so its bar is ours and is never filled in from a published
// figure. Nothing is added to it; only local discovery is turned off.
async function measureForeign({ label, harness, runtime, cli, isolation }) {
    const provider = await startProvider();
    const foreignDir = path.join(directory, `foreign-${label.replace(/\W+/gu, "-")}`);
    fs.mkdirSync(foreignDir, { recursive: true });
    const helper = path.join(foreignDir, "measure-provider.ts");
    fs.writeFileSync(helper, providerExtension(provider.url));
    const child = spawn(runtime, [cli, "--mode", "rpc", "--no-session", ...isolation, "-e", helper], {
        cwd: workspace,
        env: environment(foreignDir),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });
    let errors = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => {
        errors += text;
    });
    child.stdout.resume();
    const closed = new Promise((resolve) => child.once("close", resolve));
    let launchError;
    child.on("error", (error) => {
        launchError = error;
    });
    try {
        child.stdin.write(`${JSON.stringify({ id: "measure", type: "prompt", message: "Reply with ok." })}\n`);
        const deadline = Date.now() + 180_000;
        while (provider.requests.length === 0) {
            assert.ok(!launchError, `${label} failed to launch: ${launchError}`);
            assert.ok(Date.now() < deadline, `${label} sent no provider request: ${errors.slice(-2000)}`);
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        const summary = summarize(provider.requests[0]);
        delete summary.tools;
        delete summary.instructionText;

        return { label, harness, ...summary };
    } finally {
        child.stdin.end();
        child.kill();
        await closed;
        await provider.close();
    }
}

// OpenCode is a separate harness built as a compiled Bun binary with its own config schema,
// which this repository does not own. It is measured as installed on the same terms as the
// rows above -- one synthetic provider, one empty workspace, this machine's own config,
// auth and data excluded through the XDG redirects -- so its bar is ours and is never
// filled in from a published figure. Nothing is added to it; only the provider is
// registered, through its documented config surface. `opencode run` normally fires a
// parallel small-model call to write a session title; pinning --title suppresses it, so the
// turn sends exactly one request and the recorded one is the conversation call.
async function measureOpenCode({ label, harness, cli }) {
    const provider = await startProvider();
    const configDir = path.join(directory, "XDG_CONFIG_HOME", "opencode");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.join(directory, "XDG_CACHE_HOME"), { recursive: true });
    fs.mkdirSync(path.join(directory, "XDG_STATE_HOME"), { recursive: true });
    fs.writeFileSync(
        path.join(configDir, "opencode.json"),
        JSON.stringify(
            {
                $schema: "https://opencode.ai/config.json",
                provider: {
                    measure: {
                        npm: "@ai-sdk/openai-compatible",
                        name: "Measure",
                        options: { baseURL: provider.url, apiKey: "synthetic-only" },
                        models: {
                            "measure-model": {
                                name: "Measurement model",
                                contextWindow: 200000,
                                maxTokens: 8192,
                                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                            },
                        },
                    },
                },
            },
            null,
            4,
        ),
    );
    const child = spawn(
        cli,
        ["run", "Reply with ok.", "--model", "measure/measure-model", "--title", "Measurement", "--port", "0"],
        {
            cwd: workspace,
            // Oh My Pi resolves its dependencies through Bun's install cache, which is part
            // of how it is installed, so only OpenCode gets the cache and state redirects.
            env: {
                ...environment(directory),
                XDG_CACHE_HOME: path.join(directory, "XDG_CACHE_HOME"),
                XDG_STATE_HOME: path.join(directory, "XDG_STATE_HOME"),
            },
            stdio: ["ignore", "ignore", "pipe"],
            windowsHide: true,
        },
    );
    let errors = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => {
        errors += text;
    });
    const closed = new Promise((resolve) => child.once("close", resolve));
    let launchError;
    child.on("error", (error) => {
        launchError = error;
    });
    try {
        const deadline = Date.now() + 180_000;
        while (child.exitCode === null && child.signalCode === null && !launchError && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        assert.ok(!launchError, `${label} failed to launch: ${launchError}`);
        assert.equal(child.exitCode, 0, `${label} exited: ${errors.slice(-2000)}`);
        assert.ok(Date.now() < deadline, `${label} timed out: ${errors.slice(-2000)}`);
        assert.equal(
            provider.requests.length,
            1,
            `${label} sent ${provider.requests.length} model requests, expected exactly one`,
        );
        const summary = summarize(provider.requests[0]);
        delete summary.tools;
        delete summary.instructionText;

        return { label, harness, ...summary };
    } finally {
        child.kill();
        await closed;
        await provider.close();
    }
}

// The DeepSeek Harness (`dsh`) is a separate Node application whose composition is a stack of
// profile patch layers, which this repository does not own. It is measured as installed on the
// same terms as the rows above: one synthetic provider, one empty workspace, this machine's own
// harness home excluded through DSH_HOME. Nothing is added to it; only the provider route and
// the default model are declared through its documented home-level patch layer. A headless run
// also fires a small auxiliary request to write the session title, which carries no tool
// schema, so the measured request is the one carrying the conversation's tools.
async function measureDeepSeek({ label, harness, cli }) {
    const provider = await startProvider();
    const dshHome = path.join(directory, "dsh-home");
    fs.mkdirSync(dshHome, { recursive: true });
    fs.writeFileSync(
        path.join(dshHome, "cordis.patch.yml"),
        `- id: llm-pi-ai
  config:
    providers:
      measure:
        displayName: Measure
        api: openai-completions
        baseURL: ${provider.url}
        apiKeyEnv: DSH_MEASURE_API_KEY
        models:
          - id: measure-model
            name: Measurement model
            contextWindow: 200000
- id: agent-default-model
  config:
    provider: measure
    model: measure-model
`,
    );
    const child = spawn(process.execPath, [cli, "--profile", "headless", "Reply with ok."], {
        cwd: workspace,
        env: {
            ...environment(directory),
            DSH_HOME: dshHome,
            DSH_MEASURE_API_KEY: "synthetic-only",
        },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
    });
    let errors = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => {
        errors += text;
    });
    const closed = new Promise((resolve) => child.once("close", resolve));
    let launchError;
    child.on("error", (error) => {
        launchError = error;
    });
    try {
        const deadline = Date.now() + 180_000;
        while (child.exitCode === null && child.signalCode === null && !launchError && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        assert.ok(!launchError, `${label} failed to launch: ${launchError}`);
        assert.equal(child.exitCode, 0, `${label} exited: ${errors.slice(-2000)}`);
        assert.ok(Date.now() < deadline, `${label} timed out: ${errors.slice(-2000)}`);
        const conversation = provider.requests.filter((body) => (body.tools ?? []).length > 0);
        assert.equal(
            conversation.length,
            1,
            `${label} sent ${conversation.length} requests carrying tools, expected exactly one`,
        );
        const summary = summarize(conversation[0]);
        delete summary.tools;
        delete summary.instructionText;

        return { label, harness, ...summary };
    } finally {
        child.kill();
        await closed;
        await provider.close();
    }
}

try {
    console.error(
        `Acquiring all ${basePackages.length} pinned packages in a disposable home; Chromium download skipped.`,
    );
    run(path.join(root, "scripts/specpi.mjs"), ["plan"]);
    run(path.join(root, "scripts/specpi.mjs"), ["install", "--yes", "--skip-browser-install"]);
    assert.deepEqual(
        checkBasePackages(agentDir, JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json")))),
        [],
    );
    // Verify combined resource loading independently: a missing extension must not make a cheaper bar.
    const probe = path.join(directory, "resources.mjs");
    fs.writeFileSync(
        probe,
        `import { DefaultResourceLoader } from ${JSON.stringify(pathToFileURL(path.join(piRoot, "dist/index.js")).href)};
const loader = new DefaultResourceLoader(${JSON.stringify({ cwd: workspace, agentDir })});
await loader.reload();
const result = loader.getExtensions();
console.log("RESOURCES=" + JSON.stringify({ errors: result.errors, count: result.extensions.length }));
process.exit(0);`,
    );
    const line = run(probe, [])
        .split("\n")
        .find((entry) => entry.startsWith("RESOURCES="));
    assert.ok(line, "Missing resource report");
    const resources = JSON.parse(line.slice("RESOURCES=".length));
    assert.deepEqual(resources.errors, []);
    // Every pinned package brings one extension, plus SpecPi's own first-party extension families.
    const firstParty = fs
        .readdirSync(path.join(root, "extensions"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).length;
    assert.equal(resources.count, basePackages.length + firstParty);
    const results = [];
    for (const [label, selected, enabled] of [
        ["Pi (stock)", stockDir, false],
        ["SpecPi default", agentDir, false],
        ["SpecPi enabled", agentDir, true],
    ]) {
        console.error(`Measuring ${label}...`);
        results.push(await measure(label, selected, enabled));
    }

    if (ompCli) {
        assert.ok(fs.existsSync(ompCli), `No Oh My Pi CLI at ${ompCli}`);
        console.error("Measuring Oh My Pi...");
        results.push(
            await measureForeign({
                label: "Oh My Pi",
                harness: `Oh My Pi ${ompVersion ?? "(unknown version)"}`,
                runtime: ompRuntime,
                cli: ompCli,
                isolation: ["--no-rules", "--no-extensions"],
            }),
        );
    }

    if (ocCli) {
        assert.ok(fs.existsSync(ocCli), `No OpenCode binary at ${ocCli}`);
        console.error("Measuring OpenCode...");
        results.push(
            await measureOpenCode({
                label: "OpenCode",
                harness: `OpenCode ${ocVersion ?? "(unknown version)"}`,
                cli: ocCli,
            }),
        );
    }

    if (dshCli) {
        assert.ok(fs.existsSync(dshCli), `No DeepSeek Harness bin at ${dshCli}`);
        console.error("Measuring the DeepSeek Harness...");
        results.push(
            await measureDeepSeek({
                label: "DeepSeek Harness",
                harness: `DeepSeek Harness ${dshVersion ?? "(unknown version)"}`,
                cli: dshCli,
            }),
        );
    }

    if (process.argv.includes("--chart")) {
        const missing = [
            !ompCli && "--omp=<path to Oh My Pi's cli.js>",
            !ocCli && "--oc=<path to OpenCode's binary>",
            !dshCli && "--dsh=<path to the DeepSeek Harness bin>",
        ].filter(Boolean);
        if (missing.length > 0) {
            throw new Error(
                `The chart carries measured Oh My Pi, OpenCode and DeepSeek Harness rows, so writing it needs ` +
                    `${missing.join(", ")}. Measure them or remove the rows from scripts/context-chart.mjs; ` +
                    "they must not be filled in from elsewhere.",
            );
        }
    }

    const report = {
        schema: 1,
        measuredAt: new Date().toISOString(),
        specpiVersion: version,
        piVersion: JSON.parse(fs.readFileSync(path.join(piRoot, "package.json"))).version,
        nodeVersion: process.version,
        platform: process.platform,
        packages: basePackages,
        loadedExtensionCount: resources.count,
        ...(ompCli ? { ohMyPiVersion: ompVersion } : {}),
        ...(ocCli ? { opencodeVersion: ocVersion } : {}),
        ...(dshCli ? { deepseekHarnessVersion: dshVersion } : {}),
        method: "Actual first OpenAI-completions request to a local synthetic provider. Compact tool JSON plus system/developer text, counted as JavaScript UTF-16 code units. User prompt and transport envelope excluded. Empty workspace, disposable home, all installed resources and AGENTS enabled. No personal settings or credentials. Optional capabilities ship hidden: browser QA, delegation and web access appear only after /browser on, /delegate on and /webaccess on. Pi runs in RPC mode, which is interactive, with wishlist collection undecided, so the observation tool, the capability request and background jobs are offered; a headless session omits all three, collection off omits the observation tool, and the authoring tools appear only during a human /harness-improvement selection. The enabled profile runs /browser on, /delegate on and /webaccess on; no goal, scope or improvement selection is active. Oh My Pi is a separate Bun-based fork of Pi, measured as installed on the same terms with only local rule and extension discovery disabled; nothing is added to it and its figure is ours, not a published one. OpenCode is a separate Bun-compiled binary, measured as installed on the same terms with this machine's own config, auth and data excluded through XDG redirects; its session title is pinned so the turn sends exactly one model call, the conversation request. The DeepSeek Harness is a separate Node application measured as installed on the same terms with this machine's own harness home excluded through DSH_HOME; only the provider route and default model are declared, through its own patch layer, and its auxiliary session-title request is excluded because it carries no tool schema. Counts include temporary path text and may vary with host, path lengths, date and provider encoding. Not a token, cost or task-quality measurement.",
        results,
    };
    console.log(
        process.argv.includes("--json")
            ? JSON.stringify(report, null, 4)
            : results
                  .map(
                      (row) =>
                          `${row.label}: ${row.toolCount} tools; ${row.toolSchemaChars} schema + ${row.instructionChars} instructions = ${row.toolSchemaChars + row.instructionChars} characters`,
                  )
                  .join("\n"),
    );
    if (process.argv.includes("--chart")) {
        fs.writeFileSync(
            path.join(root, "site/research/context-measurement.json"),
            `${JSON.stringify(report, null, 4)}\n`,
        );
        console.error(`Updated charts: ${writeChart(report).join(", ")}`);
    }
} finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
