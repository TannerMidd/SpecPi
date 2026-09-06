import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFElEQVR4AWKSi5r2H4SZGKAAzgAAAAD//+cbP58AAAAGSURBVAMAWfEEIZxk5/sAAAAASUVORK5CYII=";

/** In-memory deterministic provider: no HTTP client, credential lookup, or external service. */
export default function imageProviderFixture(pi: ExtensionAPI) {
    let toolSequence = 0;
    pi.registerTool({
        name: "fixture_image",
        label: "Synthetic image",
        description: "Returns a fixed synthetic 2 by 3 pixel image for RPC integration tests.",
        parameters: Type.Object({}),
        async execute() {
            return {
                content: [{ type: "image", data: PNG, mimeType: "image/png" }],
                details: { fixture: true },
            };
        },
    });
    pi.on("session_start", () => {
        pi.setActiveTools(["fixture_image"]);
    });
    pi.registerProvider("specpi-image-fixture", {
        baseUrl: "https://specpi-image-fixture.invalid",
        apiKey: "synthetic-unused-credential",
        api: "specpi-image-fixture-api",
        models: [
            {
                id: "offline-vision",
                name: "Offline synthetic vision fixture",
                reasoning: false,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32_000,
                maxTokens: 4_096,
            },
        ],
        streamSimple(model, context) {
            const stream = createAssistantMessageEventStream();
            const user = context.messages.findLast((message) => message.role === "user");
            const userContent =
                typeof user?.content === "string" ? [{ type: "text", text: user.content }] : (user?.content ?? []);
            const text = userContent
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");
            const previous = context.messages.at(-1);
            const callTool = text === "return a tool image" && previous?.role !== "toolResult";
            const content: AssistantMessage["content"] = callTool
                ? [{ type: "toolCall", id: `fixture-image-${++toolSequence}`, name: "fixture_image", arguments: {} }]
                : [
                      {
                          type: "text",
                          text: JSON.stringify({
                              fixture: true,
                              text,
                              received: userContent.filter((part) => part.type === "image"),
                              toolReceived:
                                  previous?.role === "toolResult"
                                      ? previous.content.filter((part) => part.type === "image")
                                      : [],
                          }),
                      },
                  ];
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
                stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "{}", partial: message });
            } else {
                stream.push({
                    type: "text_delta",
                    contentIndex: 0,
                    delta: content[0].type === "text" ? content[0].text : "",
                    partial: message,
                });
            }

            stream.push({ type: "done", reason: callTool ? "toolUse" : "stop", message });

            return stream;
        },
    });
}
