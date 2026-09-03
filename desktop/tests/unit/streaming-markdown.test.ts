import { describe, expect, it } from "vitest";
import { stabilizeStreamingMarkdown } from "../../src/renderer/src/lib/streaming-markdown";

describe("streaming Markdown", () => {
    it("temporarily closes emphasis split across deltas", () => {
        expect(stabilizeStreamingMarkdown("**Refining session hydration")).toBe("**Refining session hydration**");
        expect(stabilizeStreamingMarkdown("**Refining session hydration**")).toBe("**Refining session hydration**");
        expect(stabilizeStreamingMarkdown("__Checking persistence")).toBe("__Checking persistence__");
    });

    it("temporarily closes inline and fenced code without changing complete Markdown", () => {
        expect(stabilizeStreamingMarkdown("Use `sessionName")).toBe("Use `sessionName`");
        expect(stabilizeStreamingMarkdown("```ts\nconst ready = true;")).toBe("```ts\nconst ready = true;\n```");
        expect(stabilizeStreamingMarkdown("```ts\nconst ready = true;\n```")).toBe("```ts\nconst ready = true;\n```");
    });

    it("does not treat escaped or code-contained markers as open emphasis", () => {
        expect(stabilizeStreamingMarkdown("Show \\** literally")).toBe("Show \\** literally");
        expect(stabilizeStreamingMarkdown("Use `**` around bold text")).toBe("Use `**` around bold text");
    });
});
