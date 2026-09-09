import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import registerGuard from "../../extensions/command-guard/index.ts";
import registerStructural from "../../extensions/structural-search/index.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR!;
const workingRoot = path.join(path.dirname(agentDir), "structural-project");
fs.mkdirSync(workingRoot, { recursive: true });
fs.writeFileSync(path.join(workingRoot, "demo.ts"), "target(42);");
fs.mkdirSync(path.join(agentDir, "specpi"), { recursive: true });
fs.writeFileSync(
    path.join(agentDir, "specpi", "tool-integrations.json"),
    '{"schema":1,"structuralSearch":{"enabled":true}}',
);
if (process.env.SPECPI_STRUCTURAL_RUNTIME) {
    fs.symlinkSync(
        process.env.SPECPI_STRUCTURAL_RUNTIME,
        path.join(agentDir, "specpi", "structural-runtime"),
        process.platform === "win32" ? "junction" : "dir",
    );
}

const events = new EventEmitter();
const handlers = new Map<string, any[]>();
const commands = new Map<string, any>();
const tools = new Map<string, any>();
let source = fileURLToPath(new URL("../../extensions/structural-search/index.ts", import.meta.url));
let answer = "Deny";
let prompts = 0;
let duringPrompt: (() => Promise<void>) | undefined;
const pi: any = {
    events: {
        on(name: string, fn: any) {
            events.on(name, fn);

            return () => events.off(name, fn);
        },
        emit(name: string, value: unknown) {
            events.emit(name, value);
        },
    },
    on(name: string, fn: any) {
        handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerCommand(name: string, command: any) {
        commands.set(name, command);
    },
    registerTool(tool: any) {
        tools.set(tool.name, tool);
    },
    getAllTools() {
        return [...tools.keys()].map((name) => ({ name, sourceInfo: { path: source } }));
    },
};
registerGuard(pi, { promptTimeoutMs: 100 });
registerStructural(pi);
const ctx: any = {
    cwd: workingRoot,
    hasUI: true,
    ui: {
        setStatus() {},
        notify() {},
        async confirm() {
            return true;
        },
        async select() {
            prompts += 1;
            await duringPrompt?.();

            return answer;
        },
    },
};
async function event(name: string, payload = {}) {
    let result;
    for (const handler of handlers.get(name) ?? []) {
        result = (await handler(payload, ctx)) ?? result;
    }

    return result;
}

const input = { language: "typescript", pattern: "target($A)", paths: ["demo.ts"] };
async function call(signal?: AbortSignal) {
    const value = await tools.get("structural_search").execute("test", input, signal, undefined, ctx);

    return JSON.parse(value.content[0].text);
}

export default function harness(host: any) {
    host.on("session_start", async () => {
        await event("session_start", { reason: "startup" });
        assert.equal(tools.size, 1);
        await commands.get("guard").handler("strict", ctx);
        assert.equal(await event("tool_call", { toolName: "structural_search", input }), undefined);
        assert.equal((await call()).status, "denied");
        answer = "Allow once";
        if (process.env.SPECPI_STRUCTURAL_RUNTIME) {
            const success = await call();
            assert.equal(success.status, "complete", JSON.stringify(success));
            assert.equal(success.matches[0].snippet, "target(42)");
        }

        ctx.hasUI = false;
        assert.equal((await call()).status, "denied");
        ctx.hasUI = true;
        source = path.join(workingRoot, "spoof.ts");
        answer = "Deny";
        assert.equal((await event("tool_call", { toolName: "structural_search", input })).block, true);
        source = fileURLToPath(new URL("../../extensions/structural-search/index.ts", import.meta.url));
        answer = "Allow once";
        duringPrompt = async () => {
            await commands.get("guard").handler("off", ctx);
        };

        assert.ok(["cancelled", "denied"].includes((await call()).status));
        duringPrompt = undefined;
        const before = prompts;
        if (process.env.SPECPI_STRUCTURAL_RUNTIME) {
            const allowed = await call();
            assert.equal(allowed.status, "complete", JSON.stringify(allowed));
            assert.equal(prompts, before);
        }

        const controller = new AbortController();
        controller.abort();
        assert.equal((await call(controller.signal)).status, "cancelled");
        await commands.get("guard").handler("strict", ctx);
        duringPrompt = async () => {
            ctx.cwd = path.dirname(workingRoot);
        };

        assert.equal((await call()).status, "denied");
        ctx.cwd = workingRoot;
        duringPrompt = undefined;
        answer = "Lock session";
        source = path.join(workingRoot, "spoof.ts");
        await event("tool_call", { toolName: "structural_search", input });
        source = fileURLToPath(new URL("../../extensions/structural-search/index.ts", import.meta.url));
        assert.equal((await call()).status, "denied");
        await event("session_shutdown");
        console.log("STRUCTURAL_EXTENSION=passed");
    });
}
