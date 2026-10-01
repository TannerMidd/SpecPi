import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

// The script the fixture model sends to codemode: one nested read that succeeds, one nested bash
// call that the fixture blocks, and a little output of its own.
export const CODEMODE_SCRIPT = [
    'const source = await tools.read({ path: "note.txt" });',
    'text("note says " + source.trim());',
    "try {",
    '    await tools.bash({ command: "echo blocked-by-fixture" });',
    "} catch (error) {",
    '    text("bash refused: " + error.message);',
    "}",
    'return { lines: source.split("\\n").length };',
].join("\n");

/** In-memory deterministic provider: no HTTP client, credential lookup, or external service. */
export default function codemodeProviderFixture(pi: ExtensionAPI) {
    let toolSequence = 0;
    pi.on("tool_call", (event: any) => {
        if (event.toolName === "bash") {
            return { block: true, reason: "fixture blocks bash" };
        }

        return undefined;
    });
    pi.registerProvider("specpi-codemode-fixture", {
        baseUrl: "https://specpi-codemode-fixture.invalid",
        apiKey: "synthetic-unused-credential",
        api: "specpi-codemode-fixture-api",
        models: [
            {
                id: "offline-codemode",
                name: "Offline synthetic codemode fixture",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32_000,
                maxTokens: 4_096,
            },
        ],
        streamSimple(model, context) {
            const stream = createAssistantMessageEventStream();
            const previous = context.messages.at(-1);
            const callTool = previous?.role !== "toolResult";
            const content: AssistantMessage["content"] = callTool
                ? [
                      {
                          type: "toolCall",
                          id: `fixture-codemode-${++toolSequence}`,
                          name: "codemode",
                          arguments: { code: CODEMODE_SCRIPT },
                      },
                  ]
                : [{ type: "text", text: "Script finished." }];
            const message: AssistantMessage = {
                role: "assistant",
                api: model.api,
                provider: model.provider,
                model: model.id,
                content,
                stopReason: callTool ? "toolUse" : "stop",
                timestamp: Date.now(),
                usage: {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 2,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
            };
            stream.push({ type: "start", partial: { ...message, content: [] } });
            if (callTool) {
                stream.push({
                    type: "toolcall_delta",
                    contentIndex: 0,
                    delta: JSON.stringify({ code: CODEMODE_SCRIPT }),
                    partial: message,
                });
            } else {
                stream.push({ type: "text_delta", contentIndex: 0, delta: "Script finished.", partial: message });
            }

            stream.push({ type: "done", reason: callTool ? "toolUse" : "stop", message });

            return stream;
        },
    });
}
