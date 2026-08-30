import fs from "node:fs";
import path from "node:path";
import registerZenSubagents from "../../extensions/subagents/index.ts";
import {
    activateProviderProfile,
    applyProviderConfiguration,
    readSubagentState,
    releaseProviderLease,
} from "../../extensions/subagents/core.mjs";

const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR!);
fs.mkdirSync(path.join(agentDir, "extensions", "subagent"), { recursive: true });
fs.mkdirSync(path.join(agentDir, "project"), { recursive: true });
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ unrelated: true }));
fs.writeFileSync(path.join(agentDir, "extensions", "subagent", "config.json"), "{}\n");

const seedToken = "9".repeat(48);
activateProviderProfile({ agentDir, provider: "openai", leaseToken: seedToken });
const seededRoles = structuredClone(readSubagentState(agentDir).roles);
seededRoles.worker.model = "openai/worker";
applyProviderConfiguration({ agentDir, provider: "openai", leaseToken: seedToken, roles: seededRoles });
releaseProviderLease({ agentDir, token: seedToken });

const openai = { provider: "openai", id: "parent", name: "Parent", reasoning: true };
const openrouter = { provider: "openrouter", id: "parent", name: "Router", reasoning: true };
const notifications: any[] = [];
const ctx: any = {
    cwd: path.join(agentDir, "project"),
    hasUI: true,
    model: openai,
    scopedModels: [],
    modelRegistry: {
        async getAvailable() {
            return [openai, openrouter];
        },
    },
    ui: {
        notify(message: string, level: string) {
            notifications.push({ message, level });
        },
        async confirm() {
            return true;
        },
        async select() {
            throw new Error("unexpected selection");
        },
        async input() {
            throw new Error("unexpected input");
        },
    },
};

function runtime() {
    const commands = new Map<string, any>();
    const events = new Map<string, any[]>();
    registerZenSubagents({
        on(name: string, handler: any) {
            events.set(name, [...(events.get(name) ?? []), handler]);
        },
        registerCommand(name: string, command: any) {
            commands.set(name, command);
        },
    } as any);
    const emit = async (name: string, event: any) => {
        let result;
        for (const handler of events.get(name) ?? []) {
            result = (await handler(event, ctx)) ?? result;
        }

        return result;
    };

    return { commands, emit };
}

const first = runtime();
await first.emit("session_start", {});
await first.commands.get("zen-subagents").handler("reset", ctx);
await first.emit("model_select", { model: openai, source: "user" });
const preReloadGuard = await first.emit("tool_call", {
    toolName: "subagent",
    input: { agent: "worker", task: "test" },
});
await first.emit("session_shutdown", {});

const second = runtime();
await second.emit("session_start", {});
const postReloadGuard = await second.emit("tool_call", {
    toolName: "subagent",
    input: { agent: "worker", task: "test" },
});
const externallyChanged = structuredClone(readSubagentState(agentDir).roles);
externallyChanged.worker.model = "openai/worker";
applyProviderConfiguration({ agentDir, provider: "openai", roles: externallyChanged });
const externalDriftGuard = await second.emit("tool_call", {
    toolName: "subagent",
    input: { agent: "worker", task: "test" },
});
const beforeSwitch = notifications.length;
ctx.model = openrouter;
await second.emit("model_select", { model: openrouter, source: "user" });
await second.emit("model_select", { model: openrouter, source: "user" });
const providerSwitchNotifications = notifications.slice(beforeSwitch);
await second.emit("session_shutdown", {});

const third = runtime();
await third.emit("session_start", {});
const beforeSameProvider = notifications.length;
await third.emit("model_select", { model: openrouter, source: "user" });
const sameProviderNotifications = notifications.slice(beforeSameProvider);
await third.emit("session_shutdown", {});

process.stdout.write(
    `ZENPI_SUBAGENTS_RUNTIME=${JSON.stringify({ preReloadGuard, postReloadGuard, externalDriftGuard, providerSwitchNotifications, sameProviderNotifications })}\n`,
);
