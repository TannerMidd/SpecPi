import type { RuntimeEvent } from "../../../shared/rpc";

export interface TranscriptItem {
    id: string;
    kind: "message" | "tool" | "notice" | "entry";
    role?: "user" | "assistant" | "tool";
    content: unknown;
    title?: string;
    status?: "running" | "success" | "error";
    toolCallId?: string;
    timestamp: number;
}

export interface ConversationState {
    items: TranscriptItem[];
    streaming?: {
        id: string;
        blocks: Array<{ type: "text" | "thinking" | "tool"; text: string }>;
    };
    queue: { steering: string[]; followUp: string[] };
    turnCount: number;
    toolCount: number;
}

const MAX_TRANSCRIPT_ITEMS = 10_000;
const boundedItems = (items: TranscriptItem[]) => items.slice(-MAX_TRANSCRIPT_ITEMS);

export const emptyConversation = (): ConversationState => ({
    items: [],
    queue: { steering: [], followUp: [] },
    turnCount: 0,
    toolCount: 0,
});

function textFromContent(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .map((block) => {
            if (!block || typeof block !== "object") {
                return "";
            }

            const value = block as Record<string, unknown>;
            if (value.type === "text" && typeof value.text === "string") {
                return value.text;
            }

            if (value.type === "thinking" && typeof value.thinking === "string") {
                return value.thinking;
            }

            return "";
        })
        .filter(Boolean)
        .join("\n");
}

export function messagesToItems(messages: unknown[]): TranscriptItem[] {
    return messages.flatMap((message, index) => {
        if (!message || typeof message !== "object") {
            return [];
        }

        const value = message as Record<string, unknown>;
        const role = value.role;
        if (role !== "user" && role !== "assistant" && role !== "toolResult" && role !== "bashExecution") {
            return [];
        }

        return [
            {
                id: `loaded-${index}-${String(value.timestamp ?? "")}`,
                kind: "message" as const,
                role: role === "toolResult" || role === "bashExecution" ? ("tool" as const) : role,
                content: value.content ?? value.output ?? "",
                title: role === "toolResult" ? String(value.toolName ?? "Tool result") : undefined,
                status: value.isError === true ? ("error" as const) : undefined,
                timestamp: typeof value.timestamp === "number" ? value.timestamp : index,
            },
        ];
    });
}

function messageItem(message: Record<string, unknown>): TranscriptItem | undefined {
    const role = message.role;
    if (role !== "user" && role !== "assistant") {
        return undefined;
    }

    return {
        id: `message-${String(message.timestamp ?? Date.now())}-${Math.random()}`,
        kind: "message",
        role,
        content: message.content ?? "",
        timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
    };
}

export function reduceRuntimeEvent(state: ConversationState, event: RuntimeEvent): ConversationState {
    const record = event.record;
    if (record.type === "desktop_clear") {
        return emptyConversation();
    }

    if (record.type === "desktop_replace" && Array.isArray(record.items)) {
        return { ...emptyConversation(), items: boundedItems(record.items as TranscriptItem[]) };
    }

    if (record.type === "turn_start") {
        return { ...state, turnCount: state.turnCount + 1 };
    }

    if (record.type === "queue_update") {
        return {
            ...state,
            queue: {
                steering: Array.isArray(record.steering)
                    ? record.steering.filter((item): item is string => typeof item === "string")
                    : [],
                followUp: Array.isArray(record.followUp)
                    ? record.followUp.filter((item): item is string => typeof item === "string")
                    : [],
            },
        };
    }

    if (
        record.type === "message_update" &&
        record.assistantMessageEvent &&
        typeof record.assistantMessageEvent === "object"
    ) {
        const update = record.assistantMessageEvent as Record<string, unknown>;
        const updateType = String(update.type ?? "");
        if (!/^(?:text|thinking|toolcall)_(?:start|delta|end)$/u.test(updateType)) {
            return state;
        }

        const contentIndex = typeof update.contentIndex === "number" ? update.contentIndex : 0;
        const streaming = state.streaming ?? { id: `stream-${Date.now()}`, blocks: [] };
        const blocks = [...streaming.blocks];

        if (updateType.startsWith("toolcall_")) {
            const toolCall =
                update.toolCall && typeof update.toolCall === "object"
                    ? (update.toolCall as Record<string, unknown>)
                    : undefined;
            const partial =
                update.partial && typeof update.partial === "object"
                    ? (update.partial as Record<string, unknown>)
                    : undefined;
            const partialContent = Array.isArray(partial?.content) ? partial.content[contentIndex] : undefined;
            const partialToolCall =
                partialContent && typeof partialContent === "object"
                    ? (partialContent as Record<string, unknown>)
                    : undefined;
            const toolName =
                typeof toolCall?.name === "string"
                    ? toolCall.name
                    : typeof partialToolCall?.name === "string"
                      ? partialToolCall.name
                      : undefined;
            const currentTool = blocks[contentIndex]?.type === "tool" ? blocks[contentIndex] : undefined;
            blocks[contentIndex] = {
                type: "tool",
                text: toolName ? `Preparing ${toolName}…` : (currentTool?.text ?? "Preparing tool call…"),
            };

            return { ...state, streaming: { ...streaming, blocks } };
        }

        const type: "thinking" | "text" = updateType.startsWith("thinking_") ? "thinking" : "text";
        const existing = blocks[contentIndex];
        const current: { type: "thinking" | "text"; text: string } =
            existing?.type === type ? { type, text: existing.text } : { type, text: "" };
        if (updateType.endsWith("_delta") && typeof update.delta === "string") {
            blocks[contentIndex] = { type, text: `${current.text}${update.delta}` };
        } else if (updateType.endsWith("_end") && typeof update.content === "string") {
            blocks[contentIndex] = { type, text: update.content };
        } else if (!blocks[contentIndex]) {
            blocks[contentIndex] = current;
        }

        return { ...state, streaming: { ...streaming, blocks } };
    }

    if (record.type === "message_end" && record.message && typeof record.message === "object") {
        const item = messageItem(record.message as Record<string, unknown>);
        if (!item) {
            return state;
        }

        return {
            ...state,
            streaming: item.role === "assistant" ? undefined : state.streaming,
            items: boundedItems([...state.items, item]),
        };
    }

    if (record.type === "tool_execution_start") {
        const toolCallId = String(record.toolCallId ?? `tool-${Date.now()}`);
        const remainingBlocks = state.streaming?.blocks.filter((block) => block.type !== "tool") ?? [];

        return {
            ...state,
            streaming: state.streaming
                ? remainingBlocks.length > 0
                    ? { ...state.streaming, blocks: remainingBlocks }
                    : undefined
                : undefined,
            toolCount: state.toolCount + 1,
            items: boundedItems([
                ...state.items,
                {
                    id: `tool-${toolCallId}`,
                    kind: "tool",
                    title: String(record.toolName ?? "tool"),
                    content: record.args ?? {},
                    status: "running",
                    toolCallId,
                    timestamp: Date.now(),
                },
            ]),
        };
    }

    if (record.type === "tool_execution_update" || record.type === "tool_execution_end") {
        const toolCallId = String(record.toolCallId ?? "");

        return {
            ...state,
            items: state.items.map((item) =>
                item.toolCallId === toolCallId
                    ? {
                          ...item,
                          content:
                              record.type === "tool_execution_end"
                                  ? (record.result ?? item.content)
                                  : (record.partialResult ?? item.content),
                          status:
                              record.type === "tool_execution_end"
                                  ? record.isError === true
                                      ? "error"
                                      : "success"
                                  : "running",
                      }
                    : item,
            ),
        };
    }

    if (
        record.type === "extension_ui_request" &&
        record.method === "notify" &&
        (record.notifyType === "warning" || record.notifyType === "error")
    ) {
        return {
            ...state,
            items: boundedItems([
                ...state.items,
                {
                    id: `notice-extension-${String(record.id ?? Date.now())}`,
                    kind: "notice",
                    content: typeof record.message === "string" ? record.message : "Extension notification",
                    status: record.notifyType === "error" ? "error" : undefined,
                    timestamp: Date.now(),
                },
            ]),
        };
    }

    if (["auto_compaction_start", "auto_compaction_end", "auto_retry_start", "auto_retry_end"].includes(record.type)) {
        const labels: Record<string, string> = {
            auto_compaction_start: "Automatic compaction started",
            auto_compaction_end: "Automatic compaction completed",
            auto_retry_start: `Provider retry ${String(record.attempt ?? "")}`.trim(),
            auto_retry_end: record.success === false ? "Provider retry failed" : "Provider retry completed",
        };

        return {
            ...state,
            items: boundedItems([
                ...state.items,
                {
                    id: `notice-${record.type}-${Date.now()}`,
                    kind: "notice",
                    content: labels[record.type],
                    status: record.success === false ? "error" : undefined,
                    timestamp: Date.now(),
                },
            ]),
        };
    }

    if (record.type === "entry_appended") {
        const entry = record.entry as Record<string, unknown> | undefined;
        if (!entry || entry.customType === "spec-mode") {
            return state;
        }

        return {
            ...state,
            items: boundedItems([
                ...state.items,
                {
                    id: `entry-${String(entry.id ?? Date.now())}`,
                    kind: "entry",
                    title: String(entry.customType ?? entry.type ?? "Session entry"),
                    content: entry.data ?? entry,
                    timestamp: Date.now(),
                },
            ]),
        };
    }

    return state;
}

export function contentText(content: unknown): string {
    return textFromContent(content);
}
