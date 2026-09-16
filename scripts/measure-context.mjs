#!/usr/bin/env node
// Measure what SpecPi adds to Pi's first model call.
//
// HarnessTax (Pan, Yang, Arabzadeh, Chiang, Stoica and Zaharia, 16 September 2026,
// https://harnesstax.github.io/) traces much of a harness's cost premium to the first
// request: the instructions and tool schemas a harness sends before any work happens.
// It reports stock Pi at 4 tools, 2,873 characters of tool schema and 2,547 characters
// of instructions. SpecPi is a configured Pi, so that baseline is not its number.
//
// This script measures the same three quantities against a real Pi process, by pointing
// it at a local provider and reading the request it actually sends. Characters are
// counted the way the study defines them:
//
//   tool_count         tool definitions declared on the first main request
//   tool_schema_chars  characters of the compact JSON of those definitions
//   instruction_chars  characters of the system/developer instructions
//
// Provider-reported input tokens are deliberately not reported: a synthetic provider
// cannot count them honestly, and characters are the comparable measure.
//
// Usage: node scripts/measure-context.mjs [--json]

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const piCli = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const asJson = process.argv.includes("--json");
// Oh My Pi is a separate harness, not a SpecPi dependency: a Bun-based fork of Pi with its
// own tools and prompt. Point --omp at its installed cli.js to measure it on these same
// terms. Without it that row is skipped, so this script keeps working with no Bun present.
const ompFlag = process.argv.find((argument) => argument.startsWith("--omp="));
const ompCli = ompFlag ? path.resolve(ompFlag.slice("--omp=".length)) : process.env.SPECPI_OMP_CLI;
const ompRuntime = process.env.SPECPI_OMP_RUNTIME ?? "bun";

assert.ok(fs.existsSync(piCli), "Install development dependencies before measuring.");

// A provider that records the first request and answers it with the shortest valid
// stream, so Pi completes one turn and nothing else is measured.
function startProvider() {
    const requests = [];
    const server = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) {
            chunks.push(chunk);
        }

        let body;
        try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
            response.writeHead(400).end("{}");

            return;
        }

        requests.push(body);
        const event = (choices, usage) => ({
            id: "chatcmpl-measure",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices,
            ...(usage ? { usage } : {}),
        });
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        response.write(
            `data: ${JSON.stringify(event([{ index: 0, delta: { role: "assistant", content: "ok" } }]))}\n\n`,
        );
        response.write(`data: ${JSON.stringify(event([{ index: 0, delta: {}, finish_reason: "stop" }]))}\n\n`);
        response.write(
            `data: ${JSON.stringify(event([], { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }))}\n\n`,
        );
        response.end("data: [DONE]\n\n");
    });

    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/v1` });
        });
    });
}

// Registered from inside Pi so the measured process selects the model itself, exactly as
// a configured session would. It declares no tools and no commands of its own.
function providerExtension(url) {
    return `export default function (pi) {
    pi.registerProvider("measure", {
        baseUrl: ${JSON.stringify(url)},
        api: "openai-completions",
        apiKey: "synthetic-measurement-only",
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
    });
    pi.on("session_start", async (_event, ctx) => {
        await pi.setModel(ctx.modelRegistry.find("measure", "measure-model"));
        // Tools a package registers but Pi has not activated never reach the request. Report
        // them separately so a gated surface is neither counted as sent nor lost: both
        // delegation and Browser QA ship behind a saved preference that defaults to off.
        setTimeout(() => {
            const registered = (pi.getAllTools?.() ?? []).map((tool) => ({
                name: tool.name,
                description: tool.description ?? "",
                parameters: tool.parameters ?? {},
            }));
            console.log(\`SPECPI_PROBE=\${JSON.stringify({ registered, active: pi.getActiveTools?.() ?? [] })}\`);
        }, 1500);
    });
}
`;
}

// Pi sends OpenAI-shaped tool definitions, and the study counts the compact JSON of what
// is on the request. Serialize a registered-but-gated tool the same way so the two
// numbers are comparable.
function serializeTools(tools) {
    return JSON.stringify(
        tools.map((tool) => ({
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
    ).length;
}

// The study counts the system/developer instructions of the first main request. For the
// OpenAI completions shape that is every leading system or developer message.
function instructionChars(body) {
    return (body.messages || [])
        .filter((message) => message.role === "system" || message.role === "developer")
        .reduce((total, message) => total + String(message.content ?? "").length, 0);
}

async function measure({ label, extensions = [], skills = false, agentDir, cwd, runtime, cli, isolation }) {
    const provider = await startProvider();
    const helper = path.join(agentDir, "measure-provider.ts");
    fs.writeFileSync(helper, providerExtension(provider.url));
    // Pi resolves this after extensions register their providers, so the model is already
    // selected when startup-activating extensions look for one.
    fs.writeFileSync(
        path.join(agentDir, "settings.json"),
        `${JSON.stringify({ defaultModel: "measure/measure-model" }, null, 4)}\n`,
    );
    const args = [
        cli ?? piCli,
        "--mode",
        "rpc",
        "--no-session",
        // Neutralize whatever this machine has configured, so the row reflects the harness
        // under test. Each harness spells its own discovery flags differently.
        ...(isolation ?? ["--no-context-files", "--no-prompt-templates", "--no-themes"]),
        "--no-extensions",
        ...(skills ? [] : ["--no-skills"]),
        "-e",
        helper,
        ...extensions.flatMap((entry) => ["-e", entry]),
    ];
    const child = spawn(runtime ?? process.execPath, args, {
        cwd,
        env: {
            ...Object.fromEntries(
                Object.entries(process.env).filter(
                    ([name]) => !/^(PI_|SPECPI_)/u.test(name) && name !== "NODE_OPTIONS",
                ),
            ),
            PI_CODING_AGENT_DIR: agentDir,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });
    let stderr = "";
    let output = "";
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
        output += chunk;
    });
    child.stdout.on("data", (chunk) => {
        output += chunk;
    });

    try {
        child.stdin.write(`${JSON.stringify({ id: "m1", type: "prompt", message: "Reply with ok." })}\n`);
        const deadline = Date.now() + 60000;
        while (provider.requests.length === 0) {
            if (Date.now() > deadline) {
                throw new Error(`${label}: Pi sent no provider request within 60s. ${stderr.slice(-2000)}`);
            }

            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        const body = provider.requests[0];
        const tools = body.tools || [];
        const sent = new Set(tools.map((tool) => tool.function?.name ?? tool.name));

        // Give the probe its window, then read the gated surface from the same process.
        const probeDeadline = Date.now() + 5000;
        let probe;
        while (!probe && Date.now() < probeDeadline) {
            const line = output.split(/\r?\n/u).find((entry) => entry.includes("SPECPI_PROBE="));
            if (line) {
                probe = JSON.parse(line.slice(line.indexOf("SPECPI_PROBE=") + "SPECPI_PROBE=".length));
                break;
            }

            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        // Pi registers built-ins it does not activate (find, grep, ls, powershell). Those
        // belong to the baseline, so the caller subtracts them and keeps only what the
        // loaded packages added.
        const gated = (probe?.registered ?? []).filter((tool) => !sent.has(tool.name));

        return {
            label,
            toolCount: tools.length,
            toolSchemaChars: JSON.stringify(tools).length,
            instructionChars: instructionChars(body),
            toolNames: [...sent].sort(),
            gated,
        };
    } finally {
        child.stdin.end();
        child.kill();
        provider.server.close();
    }
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-measure-"));
const workspace = path.join(directory, "workspace");
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, "README.md"), "Measurement workspace.\n");

const configurations = [
    { label: "Pi (stock)", extensions: [], skills: false },
    {
        label: "SpecPi first-party",
        extensions: [
            path.join(root, "extensions", "workflow-controls", "index.ts"),
            path.join(root, "extensions", "tool-wishlist", "index.ts"),
        ],
        skills: true,
    },
    {
        label: "+ specpi-delegation",
        extensions: [
            path.join(root, "extensions", "workflow-controls", "index.ts"),
            path.join(root, "extensions", "tool-wishlist", "index.ts"),
            path.join(root, "packages", "delegation", "src", "index.ts"),
        ],
        skills: true,
    },
    {
        label: "+ specpi-experiments",
        extensions: [
            path.join(root, "extensions", "workflow-controls", "index.ts"),
            path.join(root, "extensions", "tool-wishlist", "index.ts"),
            path.join(root, "packages", "delegation", "src", "index.ts"),
            path.join(root, "packages", "experiments", "src", "index.ts"),
        ],
        skills: true,
    },
    {
        label: "+ specpi-browser-qa",
        extensions: [
            path.join(root, "extensions", "workflow-controls", "index.ts"),
            path.join(root, "extensions", "tool-wishlist", "index.ts"),
            path.join(root, "packages", "delegation", "src", "index.ts"),
            path.join(root, "packages", "experiments", "src", "index.ts"),
            path.join(root, "packages", "browser-qa", "src", "index.ts"),
        ],
        skills: true,
    },
];

// Oh My Pi ships its own tools, skills and prompt inside the binary, so its row is the
// harness as installed: nothing added, only this machine's own configuration excluded.
if (ompCli) {
    assert.ok(fs.existsSync(ompCli), `No Oh My Pi CLI at ${ompCli}`);
    configurations.push({
        label: "Oh My Pi",
        runtime: ompRuntime,
        cli: ompCli,
        isolation: ["--no-rules"],
        skills: true,
    });
}

const results = [];
try {
    for (const configuration of configurations) {
        const agentDir = path.join(directory, `agent-${results.length}`);
        fs.mkdirSync(agentDir, { recursive: true });
        results.push(await measure({ ...configuration, agentDir, cwd: workspace }));
    }
} finally {
    // A harness that keeps a database or log handle open can outlive its own kill on
    // Windows. Losing the scratch directory is not a reason to lose the measurement.
    try {
        fs.rmSync(directory, { recursive: true, force: true });
    } catch {
        console.error(`Left behind: ${directory}`);
    }
}

if (asJson) {
    console.log(JSON.stringify(results, null, 2));
} else {
    const base = results[0];
    const pad = (value, width) => String(value).padStart(width);
    console.log("First main request, measured against a real Pi process.\n");
    console.log("configuration            tools  tool schema  instructions   total chars   vs stock");
    for (const result of results) {
        const total = result.toolSchemaChars + result.instructionChars;
        const baseTotal = base.toolSchemaChars + base.instructionChars;
        console.log(
            `${result.label.padEnd(24)}${pad(result.toolCount, 5)}${pad(result.toolSchemaChars.toLocaleString(), 13)}` +
                `${pad(result.instructionChars.toLocaleString(), 14)}${pad(total.toLocaleString(), 14)}` +
                `${pad(result === base ? "—" : `${(total / baseTotal).toFixed(1)}x`, 11)}`,
        );
    }

    console.log(`\nStock Pi tools: ${base.toolNames.join(", ")}`);
    // Named rather than positional: another harness may follow SpecPi's rows.
    const last = results.find((result) => result.label === "+ specpi-browser-qa");
    const added = last.toolNames.filter((name) => !base.toolNames.includes(name));
    console.log(`Added by SpecPi: ${added.length ? added.join(", ") : "none"}`);

    const builtinGated = new Set(base.gated.map((tool) => tool.name));
    const gatedByPackages = last.gated.filter((tool) => !builtinGated.has(tool.name));
    if (gatedByPackages.length) {
        const chars = serializeTools(gatedByPackages);
        const full = last.toolSchemaChars + last.instructionChars + chars;
        const baseTotal = base.toolSchemaChars + base.instructionChars;
        console.log(
            `\nRegistered by a package but gated on this run: ${gatedByPackages.map((tool) => tool.name).join(", ")} ` +
                `(${chars.toLocaleString()} chars of schema).`,
        );
        console.log("These ship gated behind a saved preference, so a default session does not send them. Turning");
        console.log(
            `every gate on would send at least ${full.toLocaleString()} chars, about ${(full / baseTotal).toFixed(1)}x stock Pi;`,
        );
        console.log(
            "a floor, because a gated tool's prompt snippet is not counted in the instructions until it is active.",
        );
    }
}
