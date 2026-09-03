import { describe, expect, it } from "vitest";
import { contentBlocks, imageSource } from "../../src/renderer/src/lib/content-blocks";

describe("transcript content blocks", () => {
    it("finds message arrays and nested tool-result content", () => {
        const image = { type: "image", data: "cG5n", mimeType: "image/png" };

        expect(contentBlocks([{ type: "text", text: "result" }, image])).toHaveLength(2);
        expect(contentBlocks({ content: [image], details: { source: "tool" } })).toEqual([image]);
        expect(contentBlocks({ content: [{ type: "unknown" }] })).toBeUndefined();
    });

    it("creates data URLs only for supported image formats", () => {
        expect(imageSource({ type: "image", data: "cG5n", mimeType: "image/png" })).toBe("data:image/png;base64,cG5n");
        expect(imageSource({ type: "image", data: "data:image/webp;base64,d2VicA==", mimeType: "image/webp" })).toBe(
            "data:image/webp;base64,d2VicA==",
        );
        expect(imageSource({ type: "image", data: "PHN2Zz4=", mimeType: "image/svg+xml" })).toBeUndefined();
        expect(
            imageSource({ type: "image", data: "https://example.com/image.png", mimeType: "text/html" }),
        ).toBeUndefined();
    });
});
