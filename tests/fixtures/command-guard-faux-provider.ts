import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function registerCommandGuardFauxProvider(pi: ExtensionAPI): Promise<void> {
    const piRoot = process.env.ZENPI_PI_PACKAGE_ROOT;
    if (!piRoot) {
        throw new Error("ZENPI_PI_PACKAGE_ROOT is required by the isolated fixture.");
    }

    const ai = await import(
        pathToFileURL(path.join(piRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js")).href
    );
    const faux = ai.fauxProvider({
        provider: "zenpi-guard-faux",
        models: [
            {
                id: "guard-test",
                name: "Guard test",
                reasoning: false,
                input: ["text"],
                contextWindow: 16000,
                maxTokens: 1024,
            },
        ],
    });
    const canary = process.env.ZENPI_COMMAND_GUARD_CANARY;
    if (!canary) {
        throw new Error("ZENPI_COMMAND_GUARD_CANARY is required by the isolated fixture.");
    }

    if (process.env.PI_SUBAGENT_CHILD === "1") {
        const started = process.env.ZENPI_COMMAND_GUARD_CHILD_STARTED;
        if (!started) {
            throw new Error("ZENPI_COMMAND_GUARD_CHILD_STARTED is required by the isolated fixture.");
        }

        const bindings = JSON.parse(process.env.PI_SUBAGENT_EXTENSION_BINDINGS || "{}");
        fs.writeFileSync(started, JSON.stringify({ child: true, binding: bindings["zenpi.command-guard/1"] }));
        const command =
            process.platform === "win32"
                ? `Set-Content -LiteralPath '${canary.replaceAll("'", "''")}' -Value executed`
                : `printf executed > '${canary.replaceAll("'", "'\\''")}'`;
        faux.setResponses([
            ai.fauxAssistantMessage(
                ai.fauxToolCall(process.platform === "win32" ? "powershell" : "bash", { command }),
                { stopReason: "toolUse" },
            ),
            ai.fauxAssistantMessage("CHILD_GUARD_COMPLETED"),
        ]);
    } else {
        faux.setResponses([
            ai.fauxAssistantMessage(
                ai.fauxToolCall("subagent", {
                    agent: "researcher",
                    task: "Attempt the inert protected-path canary and report completion.",
                    context: "fresh",
                    async: false,
                }),
                { stopReason: "toolUse" },
            ),
            ai.fauxAssistantMessage("PARENT_GUARD_COMPLETED"),
        ]);
    }

    pi.registerProvider(faux.provider);
}
