import { describe, expect, it } from "vitest";
import { emptyConversation, reduceRuntimeEvent } from "../../src/renderer/src/state/conversation";

const event = (record: Record<string, unknown>) => ({
    generation: 1,
    record: { type: String(record.type), ...record },
});

describe("conversation projection", () => {
    it("assembles streaming blocks and replaces them with the final message", () => {
        let state = emptyConversation();
        state = reduceRuntimeEvent(
            state,
            event({
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
            }),
        );
        state = reduceRuntimeEvent(
            state,
            event({
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
            }),
        );
        expect(state.streaming?.blocks[0]?.text).toBe("Hello");
        state = reduceRuntimeEvent(
            state,
            event({
                type: "message_end",
                message: { role: "assistant", content: [{ type: "text", text: "Hello" }], timestamp: 1 },
            }),
        );
        expect(state.streaming).toBeUndefined();
        expect(state.items).toHaveLength(1);
    });

    it("shows a bounded tool-call placeholder instead of streamed argument JSON", () => {
        let state = reduceRuntimeEvent(
            emptyConversation(),
            event({
                type: "message_update",
                assistantMessageEvent: {
                    type: "toolcall_start",
                    contentIndex: 0,
                    partial: { content: [{ type: "toolCall", name: "bash", arguments: {} }] },
                },
            }),
        );
        expect(state.streaming?.blocks).toEqual([{ type: "tool", text: "Preparing bash…" }]);

        state = reduceRuntimeEvent(
            state,
            event({
                type: "message_update",
                assistantMessageEvent: {
                    type: "toolcall_delta",
                    contentIndex: 0,
                    delta: '{"command":"npm run check"}',
                },
            }),
        );
        expect(state.streaming?.blocks).toEqual([{ type: "tool", text: "Preparing bash…" }]);

        state = reduceRuntimeEvent(
            state,
            event({
                type: "message_update",
                assistantMessageEvent: {
                    type: "toolcall_end",
                    contentIndex: 0,
                    toolCall: { type: "toolCall", name: "bash", arguments: { command: "npm run check" } },
                },
            }),
        );
        expect(state.streaming?.blocks).toEqual([{ type: "tool", text: "Preparing bash…" }]);
        expect(state.streaming?.blocks[0]?.text).not.toContain("npm run check");
    });

    it("hands a prepared tool placeholder off to one compact execution card", () => {
        let state = reduceRuntimeEvent(
            emptyConversation(),
            event({
                type: "message_update",
                assistantMessageEvent: {
                    type: "toolcall_start",
                    contentIndex: 0,
                    partial: { content: [{ type: "toolCall", name: "bash", arguments: {} }] },
                },
            }),
        );
        state = reduceRuntimeEvent(
            state,
            event({ type: "tool_execution_start", toolCallId: "bash-a", toolName: "bash", args: { command: "x" } }),
        );
        expect(state.streaming).toBeUndefined();
        expect(state.items).toHaveLength(1);
        expect(state.items[0]).toMatchObject({
            kind: "tool",
            title: "bash",
            input: { command: "x" },
            status: "running",
        });
    });

    it("does not put internal Spec state records into the visible feed", () => {
        const state = reduceRuntimeEvent(
            emptyConversation(),
            event({ type: "entry_appended", entry: { id: "spec", customType: "spec-mode", data: { enabled: true } } }),
        );
        expect(state.items).toHaveLength(0);
    });

    it("replaces accumulated partial tool output", () => {
        let state = reduceRuntimeEvent(
            emptyConversation(),
            event({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "x" } }),
        );
        state = reduceRuntimeEvent(
            state,
            event({ type: "tool_execution_update", toolCallId: "a", partialResult: { content: "partial" } }),
        );
        state = reduceRuntimeEvent(
            state,
            event({ type: "tool_execution_end", toolCallId: "a", result: { content: "final" }, isError: false }),
        );
        expect(state.items).toHaveLength(1);
        expect(state.items[0]?.status).toBe("success");
        expect(state.items[0]?.content).toEqual({ content: "final" });
    });
});
