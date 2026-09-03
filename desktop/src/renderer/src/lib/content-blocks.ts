const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type ContentBlock = Record<string, unknown>;

export function contentBlocks(content: unknown): ContentBlock[] | undefined {
    let candidate: unknown[];
    if (Array.isArray(content)) {
        candidate = content;
    } else if (content && typeof content === "object" && Array.isArray((content as ContentBlock).content)) {
        candidate = (content as ContentBlock).content as unknown[];
    } else {
        return undefined;
    }

    const blocks = candidate.filter((block): block is ContentBlock => Boolean(block) && typeof block === "object");

    return blocks.some((block) => ["text", "thinking", "image"].includes(String(block.type))) ? blocks : undefined;
}

export function imageSource(block: ContentBlock): string | undefined {
    if (
        block.type !== "image" ||
        typeof block.data !== "string" ||
        typeof block.mimeType !== "string" ||
        !IMAGE_MIME_TYPES.has(block.mimeType)
    ) {
        return undefined;
    }

    const prefix = `data:${block.mimeType};base64,`;

    return block.data.startsWith(prefix) ? block.data : `${prefix}${block.data}`;
}
