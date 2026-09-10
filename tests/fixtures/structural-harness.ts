import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import registerGuard from "../../extensions/command-guard/index.ts";
import registerStructural from "../../extensions/structural-search/index.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR!;
const requestedRoot = path.join(path.dirname(agentDir), "structural-project");
fs.mkdirSync(requestedRoot, { recursive: true });
// CI temporary directories can have platform aliases; select their canonical fixture root.
const workingRoot = fs.realpathSync.native(requestedRoot);
fs.writeFileSync(path.join(workingRoot, "demo.ts"), "target(42);");
fs.mkdirSync(path.join(agentDir, "specpi"), { recursive: true });
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
const integrations = path.join(agentDir, "specpi", "tool-integrations.json");
for (const content of ['{"schema":1,"structuralSearch":{"enabled":false}}', "{ broken"]) {
    fs.writeFileSync(integrations, content);
    registerStructural(pi);
    assert.equal(tools.size, 0, "disabled or malformed configuration must not register a tool");
    assert.equal(handlers.size, 0, "disabled registration must not attach lifecycle handlers");
}

fs.rmSync(integrations);
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
async function call(signal?: AbortSignal, timeoutMs = 10000) {
    const value = await tools.get("structural_search").execute("test", { ...input, timeoutMs }, signal, undefined, ctx);

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
        const select = ctx.ui.select;
        try {
            for (const cause of ["timeout", "cancel", "policy", "session"]) {
                await commands.get("guard").handler("strict", ctx);
                const controller = new AbortController();
                let dialogOpen = false;
                let approvalCount = 0;
                ctx.ui.select = async (
                    _title: string,
                    _choices: string[],
                    options?: { signal?: AbortSignal; timeout?: number },
                ) => {
                    assert.ok(options?.signal, "Strict approval must receive the operation cancellation signal");
                    assert.ok(Number.isInteger(options.timeout) && options.timeout! > 0);
                    if (++approvalCount > 1) {
                        assert.ok(
                            options.timeout! <= 2500,
                            "queued RPC approval must subtract the first call's wait from its 3000ms deadline",
                        );

                        return "Deny";
                    }

                    assert.ok(
                        options.timeout! <= 1000,
                        "RPC approval expiry must fit the remaining operation deadline",
                    );
                    dialogOpen = true;
                    const prompt = new Promise<undefined>((resolve) => {
                        const dismiss = () => {
                            dialogOpen = false;
                            resolve(undefined);
                        };

                        options.signal!.addEventListener("abort", dismiss, { once: true });
                        if (options.signal!.aborted) {
                            dismiss();
                        }
                    });
                    if (cause === "cancel") {
                        controller.abort();
                    } else if (cause === "policy") {
                        await commands.get("guard").handler("off", ctx);
                    } else if (cause === "session") {
                        await event("session_tree");
                    }

                    return prompt;
                };

                const active = call(controller.signal, 1000);
                const queued = cause === "timeout" ? call(undefined, 3000) : undefined;
                const result = await active;
                assert.equal(result.status, cause === "timeout" ? "timed_out" : "cancelled", cause);
                assert.equal(dialogOpen, false, `${cause} must dismiss the approval before returning`);
                if (queued) {
                    assert.equal((await queued).status, "denied");
                    assert.equal(approvalCount, 2);
                }
            }

            // A remote client can ignore signal-driven dismissal and reply after cancellation.
            const remoteAnswer = Promise.withResolvers<string>();
            const opened = Promise.withResolvers<void>();
            ctx.ui.select = () => {
                opened.resolve();

                return remoteAnswer.promise;
            };

            const controller = new AbortController();
            const pending = call(controller.signal);
            await opened.promise;
            controller.abort();
            const cancelled = await pending;
            remoteAnswer.resolve("Allow once");
            await remoteAnswer.promise;
            assert.equal(cancelled.status, "cancelled", "late remote approval cannot revive the call");
        } finally {
            ctx.ui.select = select;
        }

        answer = "Lock session";
        source = path.join(workingRoot, "spoof.ts");
        await event("tool_call", { toolName: "structural_search", input });
        source = fileURLToPath(new URL("../../extensions/structural-search/index.ts", import.meta.url));
        assert.equal((await call()).status, "denied");
        await event("session_shutdown");
        console.log("STRUCTURAL_EXTENSION=passed");
    });
}
