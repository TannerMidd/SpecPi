import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function rpcFixture(pi: ExtensionAPI) {
    pi.registerProvider("specpi-rpc-fixture", {
        baseUrl: "https://specpi-fixture.invalid",
        apiKey: "synthetic-unused-credential",
        api: "specpi-rpc-fixture-api",
        models: [
            {
                id: "offline-fixture",
                name: "Offline RPC fixture",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32000,
                maxTokens: 4096,
            },
        ],
        streamSimple() {
            throw new Error("The RPC fixture must never make a model request");
        },
    });

    pi.on("session_start", () => {
        pi.appendEntry("specpi-completion-challenge", {
            kind: "result",
            markdown: "# Offline challenge\n\nSynthetic review evidence.",
            result: { verdict: "pass" },
        });
    });

    pi.registerCommand("rpc-usage-probe", {
        description: "Exercise installed usage plugin wire contracts without provider queries",
        handler: async (args, ctx) => {
            ctx.ui.setStatus("aa-codex-usage", args === "clear" ? undefined : "\u001b[36mcodex\u001b[0m ▀▀▀▄▄ 4d");
            ctx.ui.setStatus("provider-usage", args === "clear" ? undefined : "claude 25% 5h 40% 7d");
            ctx.ui.notify("Synthetic provider usage report; no model or provider call", "info");
        },
    });

    pi.registerCommand("rpc-dialog-probe", {
        description: "Exercise the real RPC dialog transport without model calls",
        handler: async (_args, ctx) => {
            const selected = await ctx.ui.select("RPC selection", ["First", "Second"]);
            const input = await ctx.ui.input("RPC input", "Text");
            const edited = await ctx.ui.editor("RPC editor", "Original\ntext");
            ctx.ui.notify(JSON.stringify({ selected, input, edited }), "info");
        },
    });
}
